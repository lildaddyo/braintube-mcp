import { z } from 'zod';
import { dbAdmin, semanticSearch, adaptiveSearchRpc, incrementRetrievalStats, logMcpRetrieval } from '../db/supabase.js';
import { generateEmbedding, translateQueryToEnglish } from '../lib/openai.js';
import { rerankCache, hashKey, normaliseQuery } from '../lib/ttl-cache.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';
import { taintedListSchema, looseItemSchema } from '../schemas/output.js';
import type { AdaptiveResult } from '../db/supabase.js';
import { parseQueryFilter, queryTopic, applyFilterPrior, type QueryFilter } from '../lib/query-filter.js';
import { pickMoments, TIMED_SOURCES, type Moment } from '../lib/moments.js';
import { pickPassages, passageBudget, fallbackPassages, MIN_PASSAGE_CHARS, MAX_SPAN_SEGMENTS, type Passage, type PassageSegmentRow, type Neighbours } from '../lib/passages.js';
import { detectScript } from '../lib/script.js';
import { lexicalRpc } from '../lib/lexical-nl.js';

async function logRetrieval(
  userId: string,
  queryText: string,
  results: AdaptiveResult[]
): Promise<void> {
  try {
    await dbAdmin.from('retrieval_log').insert({
      user_id:             userId,
      query_text:          queryText,
      retrieved_item_ids:  results.map(r => r.id),
      rrf_scores:          results.map(r => r.similarity ?? null),
      match_types:         results.map(r => r.strategy ?? 'adaptive'),
      result_count:        results.length,
      search_method:       results[0]?.strategy ?? 'adaptive',
    });
  } catch (err) {
    console.error('[search] retrieval_log insert failed (non-fatal):', err);
  }
}


type Scored = AdaptiveResult & { rrf_score?: number | null };
const scoreOf = (r: Scored) => (r.rrf_score ?? r.similarity ?? 0);

/** Union two result lists by item id, keeping each item's best score, then re-rank. */
function mergeByBestScore(a: AdaptiveResult[], b: AdaptiveResult[], limit: number): AdaptiveResult[] {
  const best = new Map<string, Scored>();
  for (const r of [...a, ...b] as Scored[]) {
    const prev = best.get(r.id);
    if (!prev || scoreOf(r) > scoreOf(prev)) best.set(r.id, r);
  }
  return [...best.values()].sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, limit);
}

// -- JEV re-rank (cc-rrk1, 2026-09-25) ---------------------------------------------------------
// Re-orders the TOP 10 hybrid results by JEV relevance via the jev-rerank edge function
// (score = P(relevant) + 0.5 * P(partial)); rows after the 10th are appended unchanged. Same rows,
// same fields, same count - only the order can change. Fails open: on ANY problem (kill switch,
// missing env, non-200, timeout, bad/missing scores, id mismatch) the input array is returned as is.
// Kill switch: JEV_RERANK=off.
// `windowSize` = how many leading rows are scored (10; 20 for the cc-rrk3 phrase-recall pool). Contract that
// cc-rrk3 relies on: it returns the SAME array object when it did nothing and a fresh array when it re-ranked.
type RerankRow = AdaptiveResult & { summary_oneliner?: string | null };

async function jevRerank(query: string, rows: AdaptiveResult[], windowSize = 10, userId?: string, matched?: Map<string, string>): Promise<AdaptiveResult[]> {
  if (process.env.JEV_RERANK === 'off' || rows.length < 2) return rows;
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return rows;

  const top = rows.slice(0, windowSize) as RerankRow[];
  const passages = top.map(r => ({
    id: r.id,
    title: r.title ?? null,
    // A row found through its transcript text is judged on that passage first: its summary may not mention the word.
    text: [matched?.get(r.id), r.summary_oneliner, r.summary].filter(Boolean).join('\n').slice(0, 1200),
  }));

  // Scores are memoised per (query, ordered passage ids) - repeated agent queries skip the edge-function call.
  const cacheKey = hashKey('jev-rerank', normaliseQuery(query), top.map(r => r.id).join(','));
  try {
    const scoreById = await rerankCache.getOrCompute(cacheKey, async () => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/functions/v1/jev-rerank`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        // user_id + source let jev-rerank attribute its cost row (dark-n-cozy #158).
        body: JSON.stringify({ query, passages, source: 'mcp', ...(userId ? { user_id: userId } : {}) }),
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        console.error(`[jev-rerank] skipped: HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { model?: unknown; ms?: unknown; scores?: unknown };
      if (!Array.isArray(data?.scores)) {
        console.error('[jev-rerank] skipped: no scores in response');
        return null;
      }
      const scores = new Map<string, number>();
      for (const s of data.scores as Array<{ id?: unknown; score?: unknown }>) {
        if (typeof s?.id === 'string' && typeof s.score === 'number' && Number.isFinite(s.score)) scores.set(s.id, s.score);
      }
      if (top.some(r => !scores.has(r.id))) {
        console.error('[jev-rerank] skipped: scores do not cover every passage id');
        return null;
      }
      console.error(`[jev-rerank] scored ${top.length} (model=${String(data.model ?? '?').slice(0, 40)}, ms=${Number(data.ms) || '?'})`);
      return scores;
    });
    if (!scoreById) return rows;
    // Keep the score on each re-ranked row (relevance_score) so callers - and the low-confidence flag below - can use it.
    const ordered = top
      .map((r, i) => ({ r, i, s: scoreById.get(r.id) as number }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map(x => ({ ...x.r, relevance_score: Math.round(x.s * 1000) / 1000 }) as AdaptiveResult);
    const moved = ordered.filter((r, i) => r.id !== top[i].id).length;
    console.error(`[jev-rerank] top ${top.length} re-ranked (moved=${moved})`);
    return [...ordered, ...rows.slice(windowSize)];
  } catch (err) {
    console.error(`[jev-rerank] skipped: ${err instanceof Error ? err.name : 'error'}`);
    return rows;
  }
}

// -- Confidence recheck on the returned passages (calibration, 2026-11-19) ---------------------------------------
// The re-ranker judges most rows on their summary. A summary can leave out the very fact a question asks for ("how
// many days until ...") although the item's passages state it, so correct answers were flagged low confidence
// (3 of 26 in the Recall comparison: 0.475, 0.565, 0.28). When the best score is under the threshold, the top rows
// are judged once more on the passages this response returns; a row keeps the higher of its two scores and the top
// rows are re-sorted. A score can only go up, and only on text the caller is about to read. One extra jev-rerank call,
// made only for low-confidence answers. Fails open (scores unchanged). Kill switch: CONFIDENCE_RECHECK=off.
const RECHECK_ROWS = 3;

type ScoredRow = AdaptiveResult & { relevance_score?: number | null; passages?: Passage[] };

async function recheckOnPassages<T extends AdaptiveResult>(query: string, rows: T[], userId: string): Promise<T[]> {
  if (process.env.CONFIDENCE_RECHECK === 'off' || process.env.JEV_RERANK === 'off') return rows;
  const confidence = confidenceOf(rows as ScoredRow[]);
  if (!confidence?.low_confidence) return rows;
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return rows;
  const head = (rows.slice(0, RECHECK_ROWS) as ScoredRow[]).filter(r => typeof r.relevance_score === 'number' && Array.isArray(r.passages) && r.passages.length > 0);
  if (head.length === 0) return rows;
  const passages = head.map(r => ({
    id: r.id,
    title: r.title ?? null,
    text: (r.passages ?? []).slice(0, 3).map(p => p.text).join('\n').slice(0, 1400),
  }));
  const cacheKey = hashKey('jev-recheck', normaliseQuery(query), passages.map(p => `${p.id}:${p.text.length}`).join(','));
  try {
    const scoreById = await rerankCache.getOrCompute(cacheKey, async () => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/functions/v1/jev-rerank`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, passages, source: 'mcp', user_id: userId }),
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        console.error(`[confidence-recheck] skipped: HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { scores?: unknown };
      if (!Array.isArray(data?.scores)) return null;
      const scores = new Map<string, number>();
      for (const s of data.scores as Array<{ id?: unknown; score?: unknown }>) {
        if (typeof s?.id === 'string' && typeof s.score === 'number' && Number.isFinite(s.score)) scores.set(s.id, s.score);
      }
      return scores;
    });
    if (!scoreById) return rows;
    let raised = 0;
    const rechecked = (rows.slice(0, RECHECK_ROWS) as ScoredRow[]).map((r, i) => {
      const fresh = scoreById.get(r.id);
      const old = typeof r.relevance_score === 'number' ? r.relevance_score : null;
      if (typeof fresh !== 'number' || old === null || fresh <= old) return { r, i, s: old ?? -1 };
      raised++;
      return { r: { ...r, relevance_score: Math.round(fresh * 1000) / 1000 }, i, s: fresh };
    });
    if (raised === 0) return rows;
    rechecked.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    console.error(`[confidence-recheck] ${raised}/${head.length} top rows scored higher on their passages (top ${confidence.top_relevance} -> ${rechecked[0].s.toFixed(3)})`);
    return [...rechecked.map(x => x.r as unknown as T), ...rows.slice(RECHECK_ROWS)];
  } catch (err) {
    console.error(`[confidence-recheck] skipped: ${err instanceof Error ? err.name : 'error'}`);
    return rows;
  }
}

// -- Phrase recall (cc-rrk3, 2026-09-25) --------------------------------------------------------
// Extra CANDIDATES for the JEV re-ranker: items whose best "how would I search for this" phrase matches the
// query (RPC search_item_phrases, service_role only; it already drops archived, adult and taint>=3 items).
// Phrase-only rows are hydrated with the columns adaptive_search returns and are ONLY ever returned after
// jev-rerank has scored them - if the re-rank does not happen they are dropped (fail open = the adaptive result).
// Inert when JEV_RERANK=off; kill switch: PHRASE_RECALL=off. Cross-lingual queries run it on their English translation.

// Which queries also run in English. Default (Korean retrieval brief v2, Phase 1, on since 2026-10-24): every non-Latin
// query by the shared script detector (lib/script.ts, the same rule as brain-chat), so Korean, Japanese, Greek, ...
// queries reach English videos too. Kill switch XL_ALL_SCRIPTS=off: the F3 rule, any Cyrillic character (U+0400-U+04FF).
const XL_ALL_SCRIPTS_DEFAULT = 'on';
const hasCyrillic = (s: string) => [...s].some(ch => { const cp = ch.codePointAt(0) ?? 0; return cp >= 0x400 && cp <= 0x4ff; });
const xlAllScripts = () => (process.env.XL_ALL_SCRIPTS ?? XL_ALL_SCRIPTS_DEFAULT) === 'on';
/** Script name when the query also runs in English, else null. */
export function crossLingualScript(query: string): string | null {
  if (xlAllScripts()) {
    const info = detectScript(query);
    return info.nonLatin ? info.script : null;
  }
  return hasCyrillic(query) ? 'cyrillic' : null;
}

/** Ids of the user's items whose best search-phrase matches the query embedding, best first. Any error/timeout -> []. */
async function phraseRecall(embedding: number[], userId: string): Promise<string[]> {
  try {
    const { data, error } = await dbAdmin
      .rpc('search_item_phrases', { query_embedding: embedding, filter_user_id: userId, match_count: 10 })
      .abortSignal(AbortSignal.timeout(1500));
    if (error) {
      console.error(`[phrase-recall] skipped: ${String(error.message).slice(0, 120)}`);
      return [];
    }
    const ids: string[] = [];
    for (const r of (data ?? []) as Array<{ id?: unknown }>) {
      if (typeof r?.id === 'string' && !ids.includes(r.id)) ids.push(r.id);
    }
    return ids;
  } catch (err) {
    console.error(`[phrase-recall] skipped: ${err instanceof Error ? err.name : 'error'}`);
    return [];
  }
}

/** Phrase hits the adaptive search did not return, hydrated like adaptive_search rows (same columns), owner-checked. */
async function hydratePhraseOnly(phraseIds: string[], adaptive: AdaptiveResult[], userId: string, strategy = 'phrase_recall', max = 10): Promise<AdaptiveResult[]> {
  const have = new Set(adaptive.map(r => r.id));
  const ids = phraseIds.filter(id => !have.has(id)).slice(0, max);
  if (ids.length === 0) return [];
  try {
    const { data, error } = await dbAdmin
      .from('items')
      .select('id, title, url, source_type, channel, summary, summary_oneliner, topic_primary, key_concepts, entities, tags, created_at').eq('is_adult', false)
      .in('id', ids)
      .eq('user_id', userId)
      .abortSignal(AbortSignal.timeout(1500));
    if (error) {
      console.error(`[phrase-recall] hydrate skipped: ${String(error.message).slice(0, 120)}`);
      return [];
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.id === 'string') byId.set(row.id, row);
    }
    const rows: AdaptiveResult[] = [];
    for (const id of ids) {                                   // keep the phrase RPC's order
      const r = byId.get(id);
      if (!r) continue;
      rows.push({
        id: r.id, title: r.title, url: r.url, source_type: r.source_type, channel: r.channel, summary: r.summary,
        summary_oneliner: r.summary_oneliner, topic_primary: r.topic_primary, key_concepts: r.key_concepts, entities: r.entities,
        tags: Array.isArray(r.tags) ? r.tags : [], created_at: r.created_at,
        full_text_rank: null, semantic_rank: null, rrf_score: 0, strategy,
      } as unknown as AdaptiveResult);
    }
    console.error(`[${strategy}] ${phraseIds.length} hits, ${ids.length} new, ${rows.length} hydrated`);
    return rows;
  } catch (err) {
    console.error(`[phrase-recall] hydrate skipped: ${err instanceof Error ? err.name : 'error'}`);
    return [];
  }
}

// -- Segment recall (retrieval gap vs Recall, 2026-11-19) ---------------------------------------------------------
// adaptive_search ranks items on their title, summary and tags, so a word that is only SPOKEN in a video ("Bevy")
// or written deep in an article never reached the result list. This asks the segment index (dense + lexical lists,
// reciprocal-rank fused, over the whole library) for the best passages and offers their items as extra candidates
// for the JEV re-ranker, each with its matching passage as the text to judge. Like phrase recall, such a row is only
// ever returned after the re-ranker scored it. Inert when JEV_RERANK=off; kill switch: SEGMENT_RECALL=off.
const SEGMENT_RECALL_ROWS = 12;
const SEGMENT_RECALL_ITEMS = 5;

/** Items of the best-matching segments in the user's library, best first, each with that segment's text. Any error -> []. */
async function segmentRecall(query: string, embedding: number[], userId: string): Promise<Array<{ id: string; text: string }>> {
  try {
    const { data, error } = await dbAdmin
      .rpc('search_segments_core', { p_user_id: userId, p_query: query, p_query_embedding: JSON.stringify(embedding), p_limit: SEGMENT_RECALL_ROWS, p_mode: 'rrf' })
      .abortSignal(AbortSignal.timeout(2500));
    if (error) {
      console.error(`[segment-recall] skipped: ${String(error.message).slice(0, 120)}`);
      return [];
    }
    const out: Array<{ id: string; text: string }> = [];
    for (const r of (data ?? []) as Array<{ item_id?: unknown; segment_text?: unknown }>) {
      if (typeof r?.item_id !== 'string' || typeof r.segment_text !== 'string' || !r.segment_text.trim()) continue;
      const id = r.item_id;
      if (!out.some(o => o.id === id)) out.push({ id, text: r.segment_text.replace(/\s+/g, ' ').trim().slice(0, 600) });
    }
    return out;
  } catch (err) {
    console.error(`[segment-recall] skipped: ${err instanceof Error ? err.name : 'error'}`);
    return [];
  }
}

// -- Date / source window (retrieval QA 2026-10-15b) ------------------------------------------------
// "what did I save in July about X", "the web page I saved in May about Y": the unfiltered search caps at 30 rows and
// ranks by topic only, so items from the asked month (or of the asked source type) often never reach the re-ranker.
// RPC search_items_window ranks ONLY the caller's items inside the filter (embedding of the query topic + full text);
// up to 8 rows the main search did not return join the re-rank pool. Fails open to [] (kill switch QUERY_FILTER=off).
async function windowCandidates(topic: string, topicEmbedding: number[], f: QueryFilter, userId: string, have: Set<string>): Promise<AdaptiveResult[]> {
  try {
    const { data, error } = await dbAdmin
      .rpc('search_items_window', {
        search_query: topic, query_embedding: topicEmbedding, filter_user_id: userId,
        date_from: f.from, date_to: f.to, source_types: f.sources.length ? f.sources : null, match_count: 8,
      })
      .abortSignal(AbortSignal.timeout(2000));
    if (error) {
      console.error(`[query-filter] window skipped: ${String(error.message).slice(0, 120)}`);
      return [];
    }
    const rows = ((data ?? []) as AdaptiveResult[]).filter(r => !have.has(r.id)).slice(0, 8);
    console.error(`[query-filter] window ${f.from?.slice(0, 10) ?? '-'}..${f.to?.slice(0, 10) ?? '-'} sources=${f.sources.join('|') || '-'}: ${rows.length} new candidates`);
    return rows;
  } catch (err) {
    console.error(`[query-filter] window skipped: ${err instanceof Error ? err.name : 'error'}`);
    return [];
  }
}

// -- Passages and moments (moments: PH demo 2026-10-22; passages: retrieval gap vs Recall, 2026-11-18) ----------------
// Every returned result gets `passages`: the text of its segments that best match the query (articles, PDFs, notes
// and posts too), each with its position `n` in the item and, for timed sources, `t` and a `url` at that second.
// Timed results (YouTube today) also keep `moments` ({ t, url, quote }), built from the same rows. Ranked by
// search_segments (service_role only), the hybrid segment ranking the in-app chat uses, scoped to one item per call so
// one long video cannot crowd out the others. The row itself is unchanged. Fails open per item (no field). Kill
// switches: SEARCH_PASSAGES=off (no passages), SEARCH_MOMENTS=off (no moments); with both off no RPC is made.
const PASSAGE_ITEMS = 10;
const SEGMENT_ROWS = 16;

// Segment ranking: one call returns the item's segments by reciprocal-rank fusion of the dense and the lexical list
// (search_segments_core, mode 'rrf') together with each row's fused score (cosine + a small lexical bonus, the order
// moments have always used). Passages take turns from both orders (byBothOrders), because each finds answers the other
// ranks low: measured 2026-11-19 on the Recall comparison battery, the answer segment sat at position 7 fused / 3 rrf
// for one question and 2 fused / 6 rrf for another. Non-Latin queries with KO_PGROONGA=on keep the search_segments_nl
// twin, and any error on the core RPC falls back to search_segments.
async function itemSegments(query: string, embedding: number[], userId: string, row: AdaptiveResult, limit = SEGMENT_ROWS): Promise<PassageSegmentRow[]> {
  const args = { p_user_id: userId, p_query: query, p_query_embedding: JSON.stringify(embedding), p_limit: limit, p_item_ids: [row.id] };
  const legacy = lexicalRpc('search_segments', query);
  try {
    let { data, error } = legacy === 'search_segments'
      ? await dbAdmin.rpc('search_segments_core', { ...args, p_mode: 'rrf' }).abortSignal(AbortSignal.timeout(2500))
      : await dbAdmin.rpc(legacy, args).abortSignal(AbortSignal.timeout(2500));
    if (error && legacy === 'search_segments') {
      ({ data, error } = await dbAdmin.rpc(legacy, args).abortSignal(AbortSignal.timeout(2500)));
    }
    if (error) {
      console.error(`[passages] skipped ${row.id}: ${String(error.message).slice(0, 120)}`);
      return [];
    }
    return ((data ?? []) as PassageSegmentRow[]).filter(s => s.item_id === row.id);
  } catch (err) {
    console.error(`[passages] skipped ${row.id}: ${err instanceof Error ? err.name : 'error'}`);
    return [];
  }
}

const fusedScore = (s: PassageSegmentRow) => { const n = Number(s.combined_score); return Number.isFinite(n) ? n : -Infinity; };
/** The rows by fused score, best first (stable: ties keep the order given). */
function byFusedScore(rows: PassageSegmentRow[]): PassageSegmentRow[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (fusedScore(b.r) - fusedScore(a.r)) || (a.i - b.i)).map(x => x.r);
}
/** Fused #1, rrf #1, fused #2, rrf #2, ... without repeats. `rrf` is the order the RPC returned. */
function byBothOrders(rrf: PassageSegmentRow[]): PassageSegmentRow[] {
  const fused = byFusedScore(rrf);
  const out: PassageSegmentRow[] = [];
  const seen = new Set<PassageSegmentRow>();
  for (let i = 0; i < rrf.length; i++) {
    for (const r of [fused[i], rrf[i]]) if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

/** Position of each segment inside its item (segment_index), for the passages' `n`. Any error -> empty map (no `n`). */
async function segmentIndexes(segmentIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (segmentIds.length === 0) return out;
  try {
    const { data, error } = await dbAdmin
      .from('transcript_segments')
      .select('id, segment_index')
      .in('id', segmentIds)
      .abortSignal(AbortSignal.timeout(1500));
    if (error) return out;
    for (const r of (data ?? []) as Array<{ id?: unknown; segment_index?: unknown }>) {
      if (typeof r.id === 'string' && typeof r.segment_index === 'number') out.set(r.id, r.segment_index);
    }
  } catch { /* no positions */ }
  return out;
}

/**
 * The segments next to each short pick (web pages are often stored as sentence fragments), per item and position, so
 * pickPassages can join them into a readable passage. One query for all items; any error -> no widening.
 */
const NEIGHBOUR_REACH = MAX_SPAN_SEGMENTS - 1;
async function segmentNeighbours(short: Array<{ itemId: string; n: number }>): Promise<Map<string, Neighbours>> {
  const out = new Map<string, Neighbours>();
  if (short.length === 0) return out;
  const itemIds = [...new Set(short.map(s => s.itemId))];
  const wanted = new Map<string, Set<number>>();
  const indexes = new Set<number>();
  for (const { itemId, n } of short) {
    const set = wanted.get(itemId) ?? new Set<number>();
    for (let i = Math.max(0, n - NEIGHBOUR_REACH); i <= n + NEIGHBOUR_REACH; i++) { set.add(i); indexes.add(i); }
    wanted.set(itemId, set);
  }
  try {
    const { data, error } = await dbAdmin
      .from('transcript_segments')
      .select('item_id, segment_index, text, start_time_sec')
      .in('item_id', itemIds)
      .in('segment_index', [...indexes])
      .limit(1000)
      .abortSignal(AbortSignal.timeout(1500));
    if (error) return out;
    for (const r of (data ?? []) as Array<{ item_id?: unknown; segment_index?: unknown; text?: unknown; start_time_sec?: unknown }>) {
      if (typeof r.item_id !== 'string' || typeof r.segment_index !== 'number' || typeof r.text !== 'string') continue;
      if (!wanted.get(r.item_id)?.has(r.segment_index)) continue;
      const m = out.get(r.item_id) ?? new Map();
      m.set(r.segment_index, { text: r.text, start_time_sec: r.start_time_sec });
      out.set(r.item_id, m);
    }
  } catch { /* no widening */ }
  return out;
}

/** The stored text of items that have no segments, for fallbackPassages. One query; any error -> none. */
async function itemTexts(ids: string[], userId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await dbAdmin
      .from('items')
      .select('id, description, full_transcript')
      .eq('user_id', userId)
      .in('id', ids)
      .abortSignal(AbortSignal.timeout(1500));
    if (error) return out;
    for (const r of (data ?? []) as Array<{ id?: unknown; description?: unknown; full_transcript?: unknown }>) {
      const text = [r.full_transcript, r.description].find(v => typeof v === 'string' && v.trim().length > 0);
      if (typeof r.id === 'string' && typeof text === 'string') out.set(r.id, text);
    }
  } catch { /* no fallback */ }
  return out;
}

/** `perItem`: passages for every row (search inside one item); default: the rank-based budget of a result list. */
export async function attachPassages<T extends AdaptiveResult>(query: string, embedding: number[], userId: string, rows: T[], perItem?: number): Promise<Array<T & { passages?: Passage[]; moments?: Moment[] }>> {
  const passagesOn = process.env.SEARCH_PASSAGES !== 'off';
  const momentsOn = process.env.SEARCH_MOMENTS !== 'off';
  const isTimed = (r: AdaptiveResult) => TIMED_SOURCES.has(String(r.source_type ?? ''));
  const wanted = rows.slice(0, PASSAGE_ITEMS).filter(r => passagesOn || (momentsOn && isTimed(r)));
  if (wanted.length === 0) return rows;
  const raw = await Promise.all(wanted.map(r => itemSegments(query, embedding, userId, r, perItem ? Math.max(SEGMENT_ROWS, perItem * 2 + 4) : SEGMENT_ROWS)));
  const found = raw.map(byBothOrders);                                  // passage order
  const segs = new Map(wanted.map((r, i) => [r.id, found[i]]));
  const fusedSegs = new Map(wanted.map((r, i) => [r.id, byFusedScore(raw[i])]));   // moment order, as before
  const budget = new Map(rows.map((r, i) => [r.id, perItem ?? passageBudget(i)]));
  const sid = (s: PassageSegmentRow) => (typeof s.segment_id === 'string' ? s.segment_id : null);
  const indexById = passagesOn ? await segmentIndexes(found.flat().map(sid).filter((id): id is string => id !== null)) : new Map<string, number>();
  // Short picks (within each item's budget) get their neighbours, so a fragment becomes a readable passage.
  const short: Array<{ itemId: string; n: number }> = [];
  if (passagesOn) {
    found.forEach((list, i) => {
      for (const s of list.slice(0, budget.get(wanted[i].id) ?? 0)) {
        const id = sid(s);
        const n = id ? indexById.get(id) : undefined;
        if (n !== undefined && typeof s.segment_text === 'string' && s.segment_text.trim().length < MIN_PASSAGE_CHARS) short.push({ itemId: wanted[i].id, n });
      }
    });
  }
  // Items with no segments at all (short notes, captions) still get a passage, cut from their own stored text.
  const bare = passagesOn ? wanted.filter((r, i) => found[i].length === 0).map(r => r.id) : [];
  const [neighbours, texts] = await Promise.all([segmentNeighbours(short), itemTexts(bare, userId)]);
  console.error(`[passages] ${found.filter(m => m.length > 0).length}/${wanted.length} results got segments, ${short.length} short picks widened, ${texts.size} from stored text`);
  return rows.map(r => {
    const list = segs.get(r.id);
    if (!list || list.length === 0) {
      const own = texts.get(r.id);
      const passages = own ? fallbackPassages(own, query, Math.min(budget.get(r.id) ?? 0, 2)) : [];
      return passages.length > 0 ? { ...r, passages } : r;
    }
    const meta = r as AdaptiveResult & { url?: string | null; video_id?: string | null };
    const passages = passagesOn ? pickPassages(list, meta.url, meta.video_id, budget.get(r.id), indexById, neighbours.get(r.id)) : [];
    const moments = momentsOn && isTimed(r) ? pickMoments(fusedSegs.get(r.id) ?? list, meta.url, meta.video_id) : [];
    return { ...r, ...(passages.length > 0 ? { passages } : {}), ...(moments.length > 0 ? { moments } : {}) };
  });
}

export const searchSchema = z.object({
  query: z.string().min(1).max(500).describe(
    'Natural language search query. Examples: "LLM security", "habit formation", "Andrew Huberman sleep", "AI agents"'
  ),
  limit: z.number().int().min(1).max(20).default(5).describe(
    'Number of results to return (default 5, max 20). With item_id: number of passages.'
  ),
  item_id: z.string().min(1).max(200).optional().describe(
    'Search inside this one item only (an id from a previous result) and return its best-matching passages. Omit to search the whole library.'
  )
});

// -- Search inside one item (retrieval gap vs Recall, 2026-11-19) ---------------------------------------------------
// With `item_id` the query is not ranked against the library: the one item comes back with its passages that best
// match the query (up to `limit`, 12 at most), the same passage ranking as a normal search. No confidence block: the
// item was named by the caller, not found by the search.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_ITEM_MAX_PASSAGES = 12;

async function searchInsideItem(query: string, itemId: string, limit: number, userId: string) {
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, title, url, source_type, channel, summary, summary_oneliner, tags, created_at, taint_level, provenance')
    .eq('user_id', userId)
    .eq(UUID_RE.test(itemId) ? 'id' : 'video_id', itemId)
    .not('is_adult', 'is', true)
    .limit(1);
  if (error) throw new Error(`Search inside item failed: ${String(error.message).slice(0, 160)}`);
  const item = ((data ?? []) as unknown as AdaptiveResult[])[0];
  if (!item) throw new Error(`No saved item with id "${itemId}". Use an id returned by search, search_knowledge or grep.`);
  const embedding = await generateEmbedding(query);
  const [row] = await attachPassages(query, embedding, userId, [{ ...item, tags: Array.isArray(item.tags) ? item.tags : [] }], Math.min(Math.max(limit, 1), IN_ITEM_MAX_PASSAGES));
  void logMcpRetrieval(userId, query, 'mcp_search_in_item', 1, [item.id]);
  const tainted = wrapWithTaint([{ ...row, match_type: 'in_item' }] as unknown as Array<{ taint_level?: number }>);
  const none = (row as { passages?: unknown[] }).passages?.length ? '' : '[No passage of this item matches the query. fetch returns its full text.]\n\n';
  return {
    content: [{ type: 'text' as const, text: none + formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>,
  };
}

// Low-confidence flag (retrieval QA 2026-10-04): when the best JEV relevance score is below the threshold, none of the
// results is likely to answer the query (the library may not contain it). Results are NEVER dropped - only flagged.
// Default 0.6 separated answerable from unanswerable benchmark queries (AUROC 0.97 on the summary-view score); it was
// chosen on the whole benchmark, so recalibrate on real traffic. Env: SEARCH_LOW_CONFIDENCE_THRESHOLD (number, or 'off').
// Recalibrated 2026-11-19 on the frozen 223-query set (21 unanswerable) with passages in play: the unanswerable queries
// top out at 0.51 (a "partial" verdict scores 0.5), so the threshold cannot go under 0.55 without letting them through.
// It stays 0.6; correct answers that scored low on their summary are fixed by recheckOnPassages instead (answerable
// queries with the expected item first and flagged: 6 of 168 -> 1 of 162; unanswerable flagged: 21 of 21 both ways).
export function lowConfidenceThreshold(): number | null {
  const raw = process.env.SEARCH_LOW_CONFIDENCE_THRESHOLD;
  if (raw === 'off') return null;
  const n = raw === undefined ? 0.6 : Number(raw);
  return Number.isFinite(n) ? n : 0.6;
}

/** Confidence summary for a re-ranked result list; null when the top row was not scored (fail-open / no rerank). */
export function confidenceOf(rows: Array<{ relevance_score?: number | null }>): { top_relevance: number; low_confidence: boolean; threshold: number } | null {
  const threshold = lowConfidenceThreshold();
  const top = rows[0]?.relevance_score;
  if (threshold === null || typeof top !== 'number' || !Number.isFinite(top)) return null;
  return { top_relevance: top, low_confidence: top < threshold, threshold };
}

// -- Slim result rows (payload, 2026-11-19) ------------------------------------------------------------------
// Rows no longer carry the retriever's internals (full_text_rank, semantic_rank, rrf_score, strategy, similarity,
// a null centrality_score): they told an agent nothing and were on every row. match_type (which path found the row)
// and relevance_score stay. SEARCH_RANK_FIELDS=on keeps them, for retrieval QA.
const RANK_FIELDS = ['full_text_rank', 'semantic_rank', 'rrf_score', 'strategy', 'similarity'] as const;

export function slimRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  if (process.env.SEARCH_RANK_FIELDS === 'on') return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of RANK_FIELDS) delete out[k];
  if (out.centrality_score == null) delete out.centrality_score;
  return out;
}

// Rows the re-ranker scored under this are not returned (they were: a query the library cannot answer came back with
// rows at 0.02 and 0.015, flagged but still paid for in tokens). The best row is always kept, so a low-confidence
// answer still shows what the closest item was. Only rows that carry a score are judged; without a re-rank nothing is
// dropped. Env: SEARCH_MIN_RELEVANCE (number, or 'off').
export function minRelevance(): number | null {
  const raw = process.env.SEARCH_MIN_RELEVANCE;
  if (raw === 'off') return null;
  const n = raw === undefined ? 0.05 : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;
}

export function dropWeakRows<T extends { relevance_score?: number | null }>(rows: T[]): { rows: T[]; omitted: number } {
  const min = minRelevance();
  if (min === null) return { rows, omitted: 0 };
  const kept = rows.filter((r, i) => i === 0 || typeof r.relevance_score !== 'number' || r.relevance_score >= min);
  return { rows: kept, omitted: rows.length - kept.length };
}

export const searchKnowledgeOutputSchema = taintedListSchema(looseItemSchema).extend({
  // Rows left out because the re-ranker scored them under SEARCH_MIN_RELEVANCE.
  omitted_low_relevance: z.number().optional(),
  confidence: z.object({
    top_relevance: z.number(),
    low_confidence: z.boolean(),
    threshold: z.number(),
  }).optional(),
});

export async function searchKnowledge(input: z.infer<typeof searchSchema>, userId: string) {
  const { query, limit } = input;
  if (input.item_id) return searchInsideItem(query, input.item_id, limit, userId);

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  // Two Hangul syllables or kanji ("영상") are a whole word, so they reach the hybrid path too (not with XL_ALL_SCRIPTS=off).
  const queryLongEnough = query.trim().length >= 3 || (xlAllScripts() && detectScript(query).nonLatin);
  console.error(`[search] query="${query.slice(0, 80)}", limit=${limit}, hasApiKey=${hasApiKey}`);

  // ── Hybrid path (vector + full-text RRF) ─────────────────────────────────────
  if (queryLongEnough && hasApiKey) {
    try {
      console.error('[search] generating 1536-dim 3-large query embedding for adaptive_search…');
      const embedding = await generateEmbedding(query);
      console.error(`[search] embedding generated, dims=${embedding.length}`);

      // cc-rrk2: always retrieve a 10-row window for the JEV re-ranker, then trim to the caller's limit below.
      // With JEV_RERANK=off nothing changes (fetchLimit === limit).
      const rerankOn = process.env.JEV_RERANK !== 'off';
      const fetchLimit = rerankOn ? Math.max(limit, 10) : limit;
      const xlScript = crossLingualScript(query);
      const crossLingual = xlScript !== null;
      // cc-rrk3: start phrase recall alongside adaptive_search (only when the JEV re-rank is on). Cross-lingual queries run it
      // on their English translation below (QA 2026-10-15b: the phrases are English).
      const phraseOn = rerankOn && process.env.PHRASE_RECALL !== 'off';
      let phrasePromise = phraseOn && !crossLingual ? phraseRecall(embedding, userId) : null;
      // Segment recall runs the same way: alongside adaptive_search, on the English text for cross-lingual queries.
      const segmentOn = rerankOn && process.env.SEGMENT_RECALL !== 'off';
      let segmentPromise = segmentOn && !crossLingual ? segmentRecall(query, embedding, userId) : null;
      let results = await adaptiveSearchRpc(query, embedding, userId, fetchLimit);
      console.error(`[search] adaptive returned ${results.length} results`);

      // ── Cross-lingual (F3, 2026-09-25; every non-Latin script since 2026-10-24): the query also runs in English ──
      // QA 2026-10-15b: keep the union of both lists (up to 20) for the re-rank pool, re-rank against the English text.
      let enQuery: string | null = null;
      let enEmbedding: number[] | null = null;
      if (crossLingual) {
        const translated = await translateQueryToEnglish(query);
        if (translated) {
          console.error(`[search] cross-lingual (${xlScript}): "${translated.slice(0, 80)}"`);
          enQuery = translated;
          enEmbedding = await generateEmbedding(translated);
          if (phraseOn) phrasePromise = phraseRecall(enEmbedding, userId);
          if (segmentOn) segmentPromise = segmentRecall(translated, enEmbedding, userId);
          const tResults = await adaptiveSearchRpc(translated, enEmbedding, userId, fetchLimit);
          results = mergeByBestScore(results, tResults, rerankOn ? Math.max(fetchLimit, 20) : fetchLimit);
        }
      }

      // ── Date / source filter (QA 2026-10-15b) ──
      const filter = rerankOn && process.env.QUERY_FILTER !== 'off' ? parseQueryFilter(query) : null;
      const baseQuery = enQuery ?? query;
      const topic = filter ? queryTopic(baseQuery) : null;
      let windowPromise: Promise<AdaptiveResult[]> | null = null;
      if (filter && topic) {
        const have = new Set(results.slice(0, 20).map(r => r.id));
        windowPromise = (async () => {
          const topicEmbedding = topic === query ? embedding : topic === enQuery && enEmbedding ? enEmbedding : await generateEmbedding(topic);
          return windowCandidates(topic, topicEmbedding, filter, userId, have);
        })().catch(() => [] as AdaptiveResult[]);
      }
      const rerankQuery = topic ?? baseQuery;

      if (results.length > 0) {
        // Telemetry keeps recording exactly what the retriever returned for the caller's limit (retriever order).
        const retrieved = results.slice(0, limit);
        void incrementRetrievalStats(retrieved.map(r => r.id));
        void logRetrieval(userId, query, retrieved);
        // JEV re-rank of the top-10 window (cc-rrk1/rrk2), then trim to the caller's limit (kill switch JEV_RERANK=off).
        // cc-rrk3 + QA 2026-10-15b: the pool is adaptive top-10 (in order) + date/source window rows + the rest of the
        // original/English union + phrase-only rows (max 20), and the WHOLE pool is scored; rows outside the pool stay after it.
        const windowRows = windowPromise ? await windowPromise : [];
        const more = crossLingual && rerankOn ? results.slice(10, 20) : [];
        const segmentHits = segmentPromise ? await segmentPromise : [];
        const segmentOnly = segmentHits.length
          ? await hydratePhraseOnly(segmentHits.map(h => h.id), [...results, ...windowRows], userId, 'segment_recall', SEGMENT_RECALL_ITEMS)
          : [];
        const phraseOnly = phrasePromise ? await hydratePhraseOnly(await phrasePromise, [...results, ...windowRows, ...segmentOnly], userId) : [];
        const extras = [...windowRows, ...more, ...segmentOnly, ...phraseOnly];
        if (extras.length > 0) {
          const pool = [...results.slice(0, 10), ...extras].slice(0, 20);
          // A pool row with a matching segment is judged on that passage plus its summary (the summary alone may not hold the word).
          const segmentText = new Map(segmentHits.map(h => [h.id, h.text]));
          const ranked = await jevRerank(rerankQuery, pool, 20, userId, segmentText);
          const inPool = new Set(pool.map(r => r.id));
          // ranked === pool means jevRerank did nothing: fail open to exactly what the retriever returned (extra rows dropped)
          results = (ranked === pool ? results : [...applyFilterPrior(ranked, filter), ...results.filter(r => !inPool.has(r.id))]).slice(0, limit);
        } else {
          const ranked = await jevRerank(rerankQuery, results, 10, userId);
          results = (ranked === results ? results : [...applyFilterPrior(ranked.slice(0, 10), filter), ...ranked.slice(10)]).slice(0, limit);
        }
        results = await attachPassages(baseQuery, enEmbedding ?? embedding, userId, results);
        results = await recheckOnPassages(rerankQuery, results, userId);
        const confidence = confidenceOf(results as Array<{ relevance_score?: number | null }>);
        const { rows: kept, omitted } = dropWeakRows(results as Array<AdaptiveResult & { relevance_score?: number | null }>);
        // match_type tells callers which retrieval path found the row; the other ranking internals are dropped (slimRow).
        const withMatchType = kept.map(r => slimRow({
          ...r,
          taint_level:      r.taint_level ?? 0,
          match_type:       r.strategy ?? 'adaptive',
        }));
        const tainted = wrapWithTaint(withMatchType as Array<{ taint_level?: number }>);
        const note = confidence?.low_confidence
          ? `[Low confidence] None of these results looks like a direct answer (top relevance ${confidence.top_relevance.toFixed(2)} < ${confidence.threshold}). Your library may not contain this.\n\n`
          : '';
        const left = omitted > 0 ? `\n[${omitted} weaker result${omitted === 1 ? '' : 's'} left out (relevance under ${minRelevance()}).]` : '';
        return {
          content: [{ type: 'text' as const, text: note + formatTaintedResponse(tainted, true) + left }],
          structuredContent: { ...tainted, ...(confidence ? { confidence } : {}), ...(omitted > 0 ? { omitted_low_relevance: omitted } : {}) } as unknown as Record<string, unknown>
        };
      }
      console.error('[search] adaptive returned 0 results, falling back to keyword');
    } catch (err) {
      console.error('[search] adaptive path threw, falling back to keyword:', err);
      // Non-fatal — fall through to ILIKE
    }
  } else {
    console.error(`[search] skipping adaptive (queryLongEnough=${queryLongEnough}, hasApiKey=${hasApiKey}), using keyword`);
  }

  // ── Keyword fallback (ILIKE — no API key or hybrid returned nothing) ──────────
  const ilikeResults = await semanticSearch(query, userId, limit);

  if (!ilikeResults.length) {
    return {
      content: [{
        type: 'text' as const,
        text: `No results found for "${query}". Try broader terms or call get_stats to check corpus coverage.`
      }],
      structuredContent: { data: [], taint_level: 0 } as unknown as Record<string, unknown>
    };
  }

  void incrementRetrievalStats(ilikeResults.map(r => r.id));
  void logMcpRetrieval(userId, query, 'keyword_fallback', ilikeResults.length, ilikeResults.map(r => r.id));

  const withMatchType = ilikeResults.map(r => ({ ...r, match_type: 'keyword' as const }));
  const tainted = wrapWithTaint(withMatchType as Array<{ taint_level?: number }>);
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

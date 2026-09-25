import { z } from 'zod';
import { dbAdmin, semanticSearch, adaptiveSearchRpc, incrementRetrievalStats, logMcpRetrieval } from '../db/supabase.js';
import { generateEmbedding, translateQueryToEnglish } from '../lib/openai.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';
import { taintedListSchema, looseItemSchema } from '../schemas/output.js';
import type { AdaptiveResult } from '../db/supabase.js';

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

async function jevRerank(query: string, rows: AdaptiveResult[], windowSize = 10): Promise<AdaptiveResult[]> {
  if (process.env.JEV_RERANK === 'off' || rows.length < 2) return rows;
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return rows;

  const top = rows.slice(0, windowSize) as RerankRow[];
  const passages = top.map(r => ({
    id: r.id,
    title: r.title ?? null,
    text: [r.summary_oneliner, r.summary].filter(Boolean).join('\n').slice(0, 1200),
  }));

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/functions/v1/jev-rerank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, passages }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      console.error(`[jev-rerank] skipped: HTTP ${res.status}`);
      return rows;
    }
    const data = (await res.json()) as { model?: unknown; ms?: unknown; scores?: unknown };
    if (!Array.isArray(data?.scores)) {
      console.error('[jev-rerank] skipped: no scores in response');
      return rows;
    }
    const scoreById = new Map<string, number>();
    for (const s of data.scores as Array<{ id?: unknown; score?: unknown }>) {
      if (typeof s?.id === 'string' && typeof s.score === 'number' && Number.isFinite(s.score)) scoreById.set(s.id, s.score);
    }
    if (top.some(r => !scoreById.has(r.id))) {
      console.error('[jev-rerank] skipped: scores do not cover every passage id');
      return rows;
    }
    const ordered = top
      .map((r, i) => ({ r, i, s: scoreById.get(r.id) as number }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map(x => x.r);
    const moved = ordered.filter((r, i) => r !== top[i]).length;
    console.error(`[jev-rerank] top ${top.length} re-ranked (model=${String(data.model ?? '?').slice(0, 40)}, ms=${Number(data.ms) || '?'}, moved=${moved})`);
    return [...ordered, ...rows.slice(windowSize)];
  } catch (err) {
    console.error(`[jev-rerank] skipped: ${err instanceof Error ? err.name : 'error'}`);
    return rows;
  }
}

// -- Phrase recall (cc-rrk3, 2026-09-25) --------------------------------------------------------
// Extra CANDIDATES for the JEV re-ranker: items whose best "how would I search for this" phrase matches the
// query (RPC search_item_phrases, service_role only; it already drops archived, adult and taint>=3 items).
// Phrase-only rows are hydrated with the columns adaptive_search returns and are ONLY ever returned after
// jev-rerank has scored them - if the re-rank does not happen they are dropped (fail open = the adaptive result).
// Inert when JEV_RERANK=off; kill switch: PHRASE_RECALL=off. Cyrillic queries are not touched.

// Same test as the cross-lingual branch in searchKnowledge (U+0400-U+04FF), written with code points.
const hasCyrillic = (s: string) => [...s].some(ch => { const cp = ch.codePointAt(0) ?? 0; return cp >= 0x400 && cp <= 0x4ff; });

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
async function hydratePhraseOnly(phraseIds: string[], adaptive: AdaptiveResult[], userId: string): Promise<AdaptiveResult[]> {
  const have = new Set(adaptive.map(r => r.id));
  const ids = phraseIds.filter(id => !have.has(id)).slice(0, 10);
  if (ids.length === 0) return [];
  try {
    const { data, error } = await dbAdmin
      .from('items')
      .select('id, title, url, source_type, channel, summary, summary_oneliner, topic_primary, key_concepts, entities, tags, created_at')
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
        full_text_rank: null, semantic_rank: null, rrf_score: 0, strategy: 'phrase_recall',
      } as unknown as AdaptiveResult);
    }
    console.error(`[phrase-recall] ${phraseIds.length} hits, ${ids.length} phrase-only, ${rows.length} hydrated`);
    return rows;
  } catch (err) {
    console.error(`[phrase-recall] hydrate skipped: ${err instanceof Error ? err.name : 'error'}`);
    return [];
  }
}

export const searchSchema = z.object({
  query: z.string().min(1).max(500).describe(
    'Natural language search query. Examples: "LLM security", "habit formation", "Andrew Huberman sleep", "AI agents"'
  ),
  limit: z.number().int().min(1).max(20).default(5).describe(
    'Number of results to return (default 5, max 20)'
  )
});

export const searchKnowledgeOutputSchema = taintedListSchema(looseItemSchema);

export async function searchKnowledge(input: z.infer<typeof searchSchema>, userId: string) {
  const { query, limit } = input;

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  const queryLongEnough = query.trim().length >= 3;
  console.error(`[search] query="${query.slice(0, 80)}", limit=${limit}, hasApiKey=${hasApiKey}`);

  // ── Hybrid path (vector + full-text RRF) ─────────────────────────────────────
  if (queryLongEnough && hasApiKey) {
    try {
      console.error('[search] generating 768-dim query embedding for adaptive_search…');
      const embedding = await generateEmbedding(query, 768);
      console.error(`[search] embedding generated, dims=${embedding.length}`);

      // cc-rrk2: always retrieve a 10-row window for the JEV re-ranker, then trim to the caller's limit below.
      // With JEV_RERANK=off nothing changes (fetchLimit === limit).
      const fetchLimit = process.env.JEV_RERANK === 'off' ? limit : Math.max(limit, 10);
      // cc-rrk3: start phrase recall alongside adaptive_search (only when the JEV re-rank is on; never for Cyrillic queries)
      const phraseOn = process.env.JEV_RERANK !== 'off' && process.env.PHRASE_RECALL !== 'off' && !hasCyrillic(query);
      const phrasePromise = phraseOn ? phraseRecall(embedding, userId) : null;
      let results = await adaptiveSearchRpc(query, embedding, userId, fetchLimit);
      console.error(`[search] adaptive returned ${results.length} results`);

      // ── Cross-lingual (F3, 2026-09-25): Cyrillic queries also run in English ──
      if (/[\u0400-\u04FF]/.test(query)) {
        const translated = await translateQueryToEnglish(query);
        if (translated) {
          console.error(`[search] cross-lingual: "${translated.slice(0, 80)}"`);
          const tEmbedding = await generateEmbedding(translated, 768);
          const tResults = await adaptiveSearchRpc(translated, tEmbedding, userId, fetchLimit);
          results = mergeByBestScore(results, tResults, fetchLimit);
        }
      }

      if (results.length > 0) {
        // Telemetry keeps recording exactly what the retriever returned for the caller's limit (retriever order).
        const retrieved = results.slice(0, limit);
        void incrementRetrievalStats(retrieved.map(r => r.id));
        void logRetrieval(userId, query, retrieved);
        // JEV re-rank of the top-10 window (cc-rrk1/rrk2), then trim to the caller's limit (kill switch JEV_RERANK=off).
        // cc-rrk3: with phrase recall on, the pool is adaptive top-10 (in order) + phrase-only rows (max 20) and the WHOLE
        // pool is scored; adaptive rows beyond the top 10 (limit > 10) stay after it.
        const phraseOnly = phrasePromise ? await hydratePhraseOnly(await phrasePromise, results, userId) : [];
        if (phraseOnly.length > 0) {
          const pool = [...results.slice(0, 10), ...phraseOnly].slice(0, 20);
          const ranked = await jevRerank(query, pool, 20);
          // ranked === pool means jevRerank did nothing: fail open to exactly what the retriever returned (phrase-only rows dropped)
          results = (ranked === pool ? results : [...ranked, ...results.slice(10)]).slice(0, limit);
        } else {
          results = (await jevRerank(query, results)).slice(0, limit);
        }
        // Use strategy as match_type so callers can see which retrieval path was used
        const withMatchType = results.map(r => ({
          ...r,
          taint_level:      r.taint_level ?? 0,
          match_type:       r.strategy ?? 'adaptive',
          centrality_score: r.centrality_score ?? null,
        }));
        const tainted = wrapWithTaint(withMatchType);
        return {
          content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
          structuredContent: tainted as unknown as Record<string, unknown>
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

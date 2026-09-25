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
type RerankRow = AdaptiveResult & { summary_oneliner?: string | null };

async function jevRerank(query: string, rows: AdaptiveResult[]): Promise<AdaptiveResult[]> {
  if (process.env.JEV_RERANK === 'off' || rows.length < 2) return rows;
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return rows;

  const top = rows.slice(0, 10) as RerankRow[];
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
    return [...ordered, ...rows.slice(10)];
  } catch (err) {
    console.error(`[jev-rerank] skipped: ${err instanceof Error ? err.name : 'error'}`);
    return rows;
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

      let results = await adaptiveSearchRpc(query, embedding, userId, limit);
      console.error(`[search] adaptive returned ${results.length} results`);

      // ── Cross-lingual (F3, 2026-09-25): Cyrillic queries also run in English ──
      if (/[\u0400-\u04FF]/.test(query)) {
        const translated = await translateQueryToEnglish(query);
        if (translated) {
          console.error(`[search] cross-lingual: "${translated.slice(0, 80)}"`);
          const tEmbedding = await generateEmbedding(translated, 768);
          const tResults = await adaptiveSearchRpc(translated, tEmbedding, userId, limit);
          results = mergeByBestScore(results, tResults, limit);
        }
      }

      if (results.length > 0) {
        void incrementRetrievalStats(results.map(r => r.id));
        void logRetrieval(userId, query, results);
        // JEV re-rank of the top 10 (cc-rrk1): same rows/fields/count, only the order can change (kill switch JEV_RERANK=off)
        results = await jevRerank(query, results);
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

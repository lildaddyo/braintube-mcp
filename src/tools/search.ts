import { z } from 'zod';
import { dbAdmin, semanticSearch, adaptiveSearchRpc, incrementRetrievalStats } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';
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

      const results = await adaptiveSearchRpc(query, embedding, userId, limit);
      console.error(`[search] adaptive returned ${results.length} results`);

      if (results.length > 0) {
        void incrementRetrievalStats(results.map(r => r.id));
        void logRetrieval(userId, query, results);
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

  const withMatchType = ilikeResults.map(r => ({ ...r, match_type: 'keyword' as const }));
  const tainted = wrapWithTaint(withMatchType as Array<{ taint_level?: number }>);
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

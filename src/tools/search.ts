import { z } from 'zod';
import { semanticSearch, hybridSearchRpc, incrementRetrievalStats } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';

export const searchSchema = z.object({
  query: z.string().min(1).max(500).describe(
    'Natural language search query. Examples: "LLM security", "habit formation", "Andrew Huberman sleep", "AI agents"'
  ),
  limit: z.number().int().min(1).max(20).default(5).describe(
    'Number of results to return (default 5, max 20)'
  )
});

export async function searchKnowledge(input: z.infer<typeof searchSchema>, userId: string) {
  const { query, limit } = input;

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  const queryLongEnough = query.trim().length >= 3;
  console.log(`[search] query="${query.slice(0, 80)}", limit=${limit}, hasApiKey=${hasApiKey}`);

  // ── Hybrid path (vector + full-text RRF) ─────────────────────────────────────
  if (queryLongEnough && hasApiKey) {
    try {
      console.log('[search] generating query embedding for hybrid_search…');
      const embedding = await generateEmbedding(query);
      console.log(`[search] embedding generated, dims=${embedding.length}`);

      const results = await hybridSearchRpc(query, embedding, userId, limit);
      console.log(`[search] hybrid returned ${results.length} results`);

      if (results.length > 0) {
        void incrementRetrievalStats(results.map(r => r.id));
        const withTaintDefault = results.map(r => ({ ...r, taint_level: r.taint_level ?? 0 }));
        const tainted = wrapWithTaint(withTaintDefault);
        return {
          content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
          structuredContent: tainted as unknown as Record<string, unknown>
        };
      }
      console.log('[search] hybrid returned 0 results, falling back to keyword');
    } catch (err) {
      console.error('[search] hybrid path threw, falling back to keyword:', err);
      // Non-fatal — fall through to ILIKE
    }
  } else {
    console.log(`[search] skipping hybrid (queryLongEnough=${queryLongEnough}, hasApiKey=${hasApiKey}), using keyword`);
  }

  // ── Keyword fallback (ILIKE — no API key or hybrid returned nothing) ──────────
  const ilikeResults = await semanticSearch(query, userId, limit);

  if (!ilikeResults.length) {
    return {
      content: [{
        type: 'text' as const,
        text: `No results found for "${query}". Try broader terms or call get_stats to check corpus coverage.`
      }]
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

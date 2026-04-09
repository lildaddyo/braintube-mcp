import { z } from 'zod';
import { semanticSearch, semanticSearchRpc, incrementRetrievalStats } from '../db/supabase.js';
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

  // ── Semantic path (query > 10 chars and OPENAI_API_KEY present) ──────────────
  const hasApiKey = !!process.env.OPENAI_API_KEY;
  const queryLongEnough = query.trim().length > 10;
  console.log(`[search] query="${query.slice(0, 80)}", limit=${limit}, hasApiKey=${hasApiKey}, queryLongEnough=${queryLongEnough}`);

  if (queryLongEnough && hasApiKey) {
    try {
      console.log('[search] generating query embedding…');
      const embedding = await generateEmbedding(query);
      console.log(`[search] embedding generated, dims=${embedding.length}`);

      const semanticResults = await semanticSearchRpc(embedding, userId, limit);
      console.log(`[search] semantic returned ${semanticResults.length} results`);

      if (semanticResults.length > 0) {
        // Fire-and-forget retrieval tracking (never delays or fails the search)
        void incrementRetrievalStats(semanticResults.map(r => r.id));
        // RPC doesn't return taint_level — default to 0 (conservative, safe for display)
        const withTaintDefault = semanticResults.map(r => ({ ...r, taint_level: 0 }));
        const tainted = wrapWithTaint(withTaintDefault);
        return {
          content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
          structuredContent: tainted as unknown as Record<string, unknown>
        };
      }
      console.log('[search] semantic returned 0 results (all below threshold), falling back to keyword');
    } catch (err) {
      console.error('[search] semantic path threw, falling back to keyword:', err);
      // Non-fatal — fall through to ILIKE
    }
  } else {
    console.log(`[search] skipping semantic: queryLongEnough=${queryLongEnough}, hasApiKey=${hasApiKey}`);
  }

  // ── Keyword fallback (ILIKE across title, description, summary, transcript) ──
  const ilikeResults = await semanticSearch(query, userId, limit);

  if (!ilikeResults.length) {
    return {
      content: [{
        type: 'text' as const,
        text: `No results found for "${query}". Try broader terms or call get_stats to check corpus coverage.`
      }]
    };
  }

  // Fire-and-forget retrieval tracking
  void incrementRetrievalStats(ilikeResults.map(r => r.id));

  const withMatchType = ilikeResults.map(r => ({ ...r, match_type: 'keyword' as const }));
  const tainted = wrapWithTaint(withMatchType as Array<{ taint_level?: number }>);
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

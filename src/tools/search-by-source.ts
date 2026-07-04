import { z } from 'zod';
import { dbAdmin, semanticSearchRpc, incrementRetrievalStats, logMcpRetrieval } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';
import { taintedListSchema, looseItemSchema } from '../schemas/output.js';

export const searchBySourceSchema = z.object({
  source_type: z.string().min(1).describe(
    'Source type to filter by. Examples: "youtube", "instagram", "web", "linkedin", "twitter", "github", "notion", "note", "reddit", "pdf"'
  ),
  query: z.string().min(1).max(500).describe('Natural language search query'),
  limit: z.number().int().min(1).max(20).default(10).describe('Number of results to return (default 10)')
});

export const searchBySourceOutputSchema = taintedListSchema(looseItemSchema);

export async function searchBySource(input: z.infer<typeof searchBySourceSchema>, userId: string) {
  const { source_type, query, limit } = input;

  // ── Semantic path ────────────────────────────────────────────────────────────
  if (query.trim().length > 10 && process.env.OPENAI_API_KEY) {
    try {
      const embedding = await generateEmbedding(query);
      const { data: semanticData, error } = await dbAdmin.rpc('search_knowledge_semantic', {
        query_embedding: embedding,
        match_user_id: userId,
        match_count: limit * 3, // over-fetch to account for source_type filter
        similarity_threshold: 0.3
      });

      if (!error && semanticData?.length) {
        const filtered = (semanticData as Array<{ id: string; source_type: string; taint_level?: number; [key: string]: unknown }>)
          .filter(r => r.source_type === source_type)
          .slice(0, limit);

        if (filtered.length > 0) {
          void incrementRetrievalStats(filtered.map(r => r.id));
          void logMcpRetrieval(userId, query, 'mcp_search_by_source', filtered.length, filtered.map(r => r.id));
          const tainted = wrapWithTaint(filtered.map(r => ({ ...r, match_type: 'semantic' })));
          return {
            content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
            structuredContent: tainted as unknown as Record<string, unknown>
          };
        }
      }
    } catch (err) {
      console.error('[search_by_source] semantic path failed, falling back to keyword:', err);
    }
  }

  // ── Keyword fallback ─────────────────────────────────────────────────────────
  const q = `%${query}%`;
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, source_type, title, channel, url, description, summary, taint_level, created_at')
    .eq('user_id', userId)
    .eq('source_type', source_type)
    .eq('is_archived', false)
    .or(`title.ilike.${q},description.ilike.${q},summary.ilike.${q},full_transcript.ilike.${q}`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`search_by_source failed: ${error.message}`);
  const results = data ?? [];

  if (!results.length) {
    return {
      content: [{
        type: 'text' as const,
        text: `No results found for "${query}" in source_type "${source_type}". Try get_stats to see which source types have content.`
      }],
      structuredContent: { data: [], taint_level: 0 } as unknown as Record<string, unknown>
    };
  }

  void incrementRetrievalStats(results.map(r => r.id));
  void logMcpRetrieval(userId, query, 'mcp_search_by_source', results.length, results.map(r => r.id));
  const tainted = wrapWithTaint(results.map(r => ({ ...r, match_type: 'keyword' as const })));
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

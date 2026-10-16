import { z } from 'zod';
import { dbAdmin, windowSearchRpc, incrementRetrievalStats, logMcpRetrieval } from '../db/supabase.js';
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

  // ── Hybrid path: semantic (content_embedding 768) + full text, inside the source type ─────────────
  if (process.env.OPENAI_API_KEY) {
    try {
      const embedding = await generateEmbedding(query, 768);
      const rows = await windowSearchRpc(query, embedding, userId, { sources: [source_type] }, limit);
      if (rows.length > 0) {
        void incrementRetrievalStats(rows.map(r => r.id));
        void logMcpRetrieval(userId, query, 'mcp_search_by_source', rows.length, rows.map(r => r.id));
        const tainted = wrapWithTaint(rows.map(r => ({ ...r, match_type: 'hybrid' })));
        return {
          content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
          structuredContent: tainted as unknown as Record<string, unknown>
        };
      }
    } catch (err) {
      console.error('[search_by_source] hybrid path failed, falling back to keyword:', err);
    }
  }

  // ── Keyword fallback ─────────────────────────────────────────────────────────
  const q = `%${query}%`;
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, source_type, title, channel, url, description, summary, taint_level, created_at').eq('is_adult', false)
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

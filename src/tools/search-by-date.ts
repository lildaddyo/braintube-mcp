import { z } from 'zod';
import { dbAdmin, incrementRetrievalStats, logMcpRetrieval } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';
import { taintedListSchema, looseItemSchema } from '../schemas/output.js';

export const searchByDateSchema = z.object({
  query: z.string().min(1).max(500).describe('Natural language search query'),
  after: z.string().describe('ISO 8601 date — only items created after this date. Examples: "2024-01-01", "2024-06-15T00:00:00Z"'),
  before: z.string().describe('ISO 8601 date — only items created before this date. Examples: "2024-12-31", "2025-03-01T00:00:00Z"'),
  limit: z.number().int().min(1).max(20).default(10).describe('Number of results to return (default 10)')
});

export const searchByDateOutputSchema = taintedListSchema(looseItemSchema);

export async function searchByDate(input: z.infer<typeof searchByDateSchema>, userId: string) {
  const { query, after, before, limit } = input;

  // Validate dates
  const afterDate = new Date(after);
  const beforeDate = new Date(before);
  if (isNaN(afterDate.getTime())) throw new Error(`Invalid "after" date: ${after}`);
  if (isNaN(beforeDate.getTime())) throw new Error(`Invalid "before" date: ${before}`);
  if (afterDate >= beforeDate) throw new Error('"after" must be earlier than "before"');

  // ── Semantic path ────────────────────────────────────────────────────────────
  if (query.trim().length > 10 && process.env.OPENAI_API_KEY) {
    try {
      const embedding = await generateEmbedding(query);
      // Over-fetch from semantic RPC then filter by date in JS
      const { data: semanticData, error } = await dbAdmin.rpc('search_knowledge_semantic', {
        query_embedding: embedding,
        match_user_id: userId,
        match_count: 100,
        similarity_threshold: 0.3
      });

      if (!error && semanticData?.length) {
        const filtered = (semanticData as Array<{ id: string; saved_at?: string; created_at?: string; taint_level?: number; [key: string]: unknown }>)
          .filter(r => {
            const ts = new Date((r.saved_at ?? r.created_at) as string);
            return ts >= afterDate && ts <= beforeDate;
          })
          .slice(0, limit);

        if (filtered.length > 0) {
          void incrementRetrievalStats(filtered.map(r => r.id));
          void logMcpRetrieval(userId, query, 'mcp_search_by_date_range', filtered.length, filtered.map(r => r.id));
          const tainted = wrapWithTaint(filtered.map(r => ({ ...r, match_type: 'semantic' })));
          return {
            content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
            structuredContent: tainted as unknown as Record<string, unknown>
          };
        }
      }
    } catch (err) {
      console.error('[search_by_date_range] semantic path failed, falling back to keyword:', err);
    }
  }

  // ── Keyword fallback with date range ─────────────────────────────────────────
  const q = `%${query}%`;
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, source_type, title, channel, url, description, summary, taint_level, created_at')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .gte('created_at', afterDate.toISOString())
    .lte('created_at', beforeDate.toISOString())
    .or(`title.ilike.${q},description.ilike.${q},summary.ilike.${q},full_transcript.ilike.${q}`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`search_by_date_range failed: ${error.message}`);
  const results = data ?? [];

  if (!results.length) {
    return {
      content: [{
        type: 'text' as const,
        text: `No results for "${query}" between ${after} and ${before}. Try wider date range or different terms.`
      }],
      structuredContent: { data: [], taint_level: 0 } as unknown as Record<string, unknown>
    };
  }

  void incrementRetrievalStats(results.map(r => r.id));
  void logMcpRetrieval(userId, query, 'mcp_search_by_date_range', results.length, results.map(r => r.id));
  const tainted = wrapWithTaint(results.map(r => ({ ...r, match_type: 'keyword' as const })));
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

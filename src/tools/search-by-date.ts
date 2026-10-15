import { z } from 'zod';
import { dbAdmin, windowSearchRpc, incrementRetrievalStats, logMcpRetrieval } from '../db/supabase.js';
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

  // ── Hybrid path: semantic (content_embedding 768) + full text, inside the date window ─────────────
  // The window is applied in SQL before ranking. Before 2026-10-16 this took a global top 100 from the legacy
  // 1536-d column and filtered dates in JS, so most of an older window never reached the results.
  if (process.env.OPENAI_API_KEY) {
    try {
      const embedding = await generateEmbedding(query);
      const rows = await windowSearchRpc(query, embedding, userId, { from: afterDate.toISOString(), to: beforeDate.toISOString() }, limit);
      if (rows.length > 0) {
        void incrementRetrievalStats(rows.map(r => r.id));
        void logMcpRetrieval(userId, query, 'mcp_search_by_date_range', rows.length, rows.map(r => r.id));
        const tainted = wrapWithTaint(rows.map(r => ({ ...r, match_type: 'hybrid' })));
        return {
          content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
          structuredContent: tainted as unknown as Record<string, unknown>
        };
      }
    } catch (err) {
      console.error('[search_by_date_range] hybrid path failed, falling back to keyword:', err);
    }
  }

  // ── Keyword fallback with date range ─────────────────────────────────────────
  const q = `%${query}%`;
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, source_type, title, channel, url, description, summary, taint_level, created_at').eq('is_adult', false)
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

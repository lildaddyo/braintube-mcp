import { z } from 'zod';
import { dbAdmin, incrementRetrievalStats } from '../db/supabase.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';

export const relatedSchema = z.object({
  item_id: z.string().uuid().describe('UUID of the item to find related items for'),
  limit: z.number().int().min(1).max(20).default(5).describe('Number of related items to return (default 5)')
});

export async function getRelated(input: z.infer<typeof relatedSchema>, userId: string) {
  const { item_id, limit } = input;

  const { data, error } = await dbAdmin.rpc('get_related_items', {
    p_item_id: item_id,
    p_user_id: userId,
    p_limit: limit
  });

  if (error) throw new Error(`get_related failed: ${error.message}`);
  const results = (data ?? []) as Array<{ id: string; taint_level?: number; [key: string]: unknown }>;

  if (results.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No related items found. The item may not have an embedding yet — run backfill_embeddings first.'
      }]
    };
  }

  void incrementRetrievalStats(results.map(r => r.id));
  const tainted = wrapWithTaint(results);
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

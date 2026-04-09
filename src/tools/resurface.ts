import { z } from 'zod';
import { dbAdmin, incrementRetrievalStats } from '../db/supabase.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';

export const resurfaceSchema = z.object({
  n: z.number().int().min(1).max(20).default(5).describe(
    'Number of items to resurface (default 5). Weighted toward items you\'ve retrieved least often.'
  )
});

export async function randomResuface(input: z.infer<typeof resurfaceSchema>, userId: string) {
  const { n } = input;

  const { data, error } = await dbAdmin.rpc('random_resurface_items', {
    p_user_id: userId,
    p_limit: n
  });

  if (error) throw new Error(`random_resurface failed: ${error.message}`);
  const results = (data ?? []) as Array<{ id: string; taint_level?: number; [key: string]: unknown }>;

  if (results.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No items in your corpus yet. Save some videos or content first.'
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

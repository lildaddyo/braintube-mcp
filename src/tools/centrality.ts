import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const computeCentralitySchema = z.object({});

export const computeCentralityOutputSchema = z.object({
  updated_count: z.number().nullable(),
});

export async function computeCentrality(
  _input: z.infer<typeof computeCentralitySchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { data, error } = await dbAdmin.rpc('compute_centrality_scores', { for_user_id: userId });

  if (error) throw new Error(`compute_centrality_scores RPC failed: ${error.message}`);

  const updatedCount = (data as { updated_count?: number } | null)?.updated_count
    ?? (typeof data === 'number' ? data : null);

  const text = updatedCount != null
    ? `Centrality scores recomputed. Updated: ${updatedCount} items.`
    : 'Centrality recompute completed.';

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { updated_count: updatedCount } as unknown as Record<string, unknown>,
  };
}

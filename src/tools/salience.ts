import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const recomputeSalienceSchema = z.object({});

export const recomputeSalienceOutputSchema = z.object({
  updated_count: z.number().nullable(),
});

export async function recomputeSalience(
  _input: z.infer<typeof recomputeSalienceSchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { data, error } = await dbAdmin.rpc('compute_salience_scores', { for_user_id: userId });

  if (error) throw new Error(`compute_salience_scores RPC failed: ${error.message}`);

  const updatedCount = (data as { updated_count?: number } | null)?.updated_count
    ?? (typeof data === 'number' ? data : null);

  const text = updatedCount != null
    ? `Salience scores recomputed. Updated: ${updatedCount} items.`
    : 'Salience recompute completed.';

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { updated_count: updatedCount } as unknown as Record<string, unknown>,
  };
}

import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const computeCentralitySchema = z.object({});

export const computeCentralityOutputSchema = z.object({
  updated_count: z.number().nullable(),
});

// compute_centrality_scores updates at most 150 changed rows per call and
// returns TABLE(updated_count int), i.e. [{ updated_count }]. Loop until a call
// comes back short so a whole library is recomputed, capped to bound latency.
const RPC_BATCH = 150;
const MAX_CALLS = 40;

export function readUpdatedCount(data: unknown): number | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row === 'number') return row;
  const n = (row as { updated_count?: unknown } | null | undefined)?.updated_count;
  return typeof n === 'number' ? n : null;
}

export async function computeCentrality(
  _input: z.infer<typeof computeCentralitySchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  let updatedCount = 0;
  let complete = false;

  for (let call = 0; call < MAX_CALLS; call++) {
    const { data, error } = await dbAdmin.rpc('compute_centrality_scores', { for_user_id: userId });
    if (error) throw new Error(`compute_centrality_scores RPC failed: ${error.message}`);

    const n = readUpdatedCount(data) ?? 0;
    updatedCount += n;
    if (n < RPC_BATCH) {
      complete = true;
      break;
    }
  }

  const text = complete
    ? `Centrality scores recomputed. Updated: ${updatedCount} items.`
    : `Centrality partly recomputed (${updatedCount} items updated); run again to finish.`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { updated_count: updatedCount } as unknown as Record<string, unknown>,
  };
}

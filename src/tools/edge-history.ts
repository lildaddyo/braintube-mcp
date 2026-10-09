import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const edgeHistorySchema = z.object({
  item_a: z.string().guid().describe('UUID of the first item'),
  item_b: z.string().guid().describe('UUID of the second item'),
});

export const getEdgeHistoryOutputSchema = z.object({
  history: z.array(z.object({
    edge_type: z.string().optional(),
    confidence: z.number().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }).passthrough()),
});

const NOT_FOUND = {
  content: [{ type: 'text' as const, text: 'No edge history found between these two items.' }],
  structuredContent: { history: [] },
};

export async function getEdgeHistory(
  input: z.infer<typeof edgeHistorySchema>,
  userId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  // The RPC runs with the service role and is not scoped to a user, so both items must belong
  // to the caller before it is called (BTMCP-08). Someone else's items look exactly like
  // items with no history, so the answer does not reveal whether a UUID exists.
  const ids = Array.from(new Set([input.item_a, input.item_b]));
  const { data: owned, error: ownErr } = await dbAdmin
    .from('items')
    .select('id')
    .eq('user_id', userId)
    .in('id', ids);
  if (ownErr) throw new Error(`get_edge_history ownership check failed: ${ownErr.message}`);
  if ((owned ?? []).length !== ids.length) return NOT_FOUND;

  const { data, error } = await dbAdmin.rpc('get_edge_history', {
    item_a: input.item_a,
    item_b: input.item_b,
  });

  if (error) throw new Error(`get_edge_history RPC failed: ${error.message}`);

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No edge history found between these two items.' }],
      structuredContent: { history: [] },
    };
  }

  const lines = [
    `Edge history between ${input.item_a.slice(0, 8)} and ${input.item_b.slice(0, 8)} — ${rows.length} record(s):`,
    '',
    ...rows.map((r, i) =>
      `${i + 1}. edge_type=${r.edge_type}  confidence=${r.confidence}  created=${String(r.created_at ?? '').slice(0, 10)}` +
      (r.updated_at && r.updated_at !== r.created_at ? `  updated=${String(r.updated_at).slice(0, 10)}` : '')
    ),
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { history: rows } as unknown as Record<string, unknown>,
  };
}

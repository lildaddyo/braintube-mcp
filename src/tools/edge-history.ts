import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const edgeHistorySchema = z.object({
  item_a: z.string().uuid().describe('UUID of the first item'),
  item_b: z.string().uuid().describe('UUID of the second item'),
});

export async function getEdgeHistory(
  input: z.infer<typeof edgeHistorySchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
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

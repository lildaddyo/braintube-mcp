import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const findPathSchema = z.object({
  item_a:    z.string().guid().describe('UUID of the start item'),
  item_b:    z.string().guid().describe('UUID of the end item'),
  max_depth: z.number().int().min(1).max(10).default(5).describe(
    'Maximum path length to search (default 5)'
  ),
});

export const findPathOutputSchema = z.object({
  found: z.boolean(),
  path_item_ids: z.array(z.string()),
  path_edge_types: z.array(z.string()),
  path_length: z.number().nullable(),
});

export async function findPath(
  input: z.infer<typeof findPathSchema>,
  userId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { item_a, item_b, max_depth } = input;

  // find_shortest_path(p_user_id, p_from_id, p_to_id, p_max_depth, p_edge_types)
  // returns one row per edge on the path (step, source_id, target_id,
  // edge_type), scoped to the caller's own knowledge_edges.
  const { data, error } = await dbAdmin.rpc('find_shortest_path', {
    p_user_id:    userId,
    p_from_id:    item_a,
    p_to_id:      item_b,
    p_max_depth:  max_depth,
    p_edge_types: null,
  });

  if (error) throw new Error(`Path search failed: ${error.message}`);

  const rows = ((data ?? []) as Array<{ step: number; source_id: string; target_id: string; edge_type: string }>)
    .slice()
    .sort((a, b) => a.step - b.step);

  // Walk the edges from item_a, following whichever endpoint is not the current node
  // (edges are traversed in both directions).
  const path_item_ids: string[] = [item_a];
  const path_edge_types: string[] = [];
  let current = item_a;
  for (const row of rows) {
    const next = row.source_id === current ? row.target_id : row.target_id === current ? row.source_id : null;
    if (next === null) break;
    path_item_ids.push(next);
    path_edge_types.push(String(row.edge_type));
    current = next;
    if (current === item_b) break;
  }

  if (current !== item_b || path_item_ids.length < 2) {
    return {
      content: [{ type: 'text' as const, text: `No path found between ${item_a.slice(0, 8)} and ${item_b.slice(0, 8)} within depth ${max_depth}.` }],
      structuredContent: { found: false, path_item_ids: [], path_edge_types: [], path_length: null },
    };
  }

  const steps = path_item_ids.map((id, i) =>
    i < path_edge_types.length ? `${id.slice(0, 8)} —[${path_edge_types[i]}]→ ` : id.slice(0, 8),
  ).join('');

  const path_length = path_item_ids.length - 1;
  const text = [
    `Path found: length ${path_length}`,
    '',
    steps,
    '',
    `Item IDs: ${path_item_ids.join(' → ')}`,
  ].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { found: true, path_item_ids, path_edge_types, path_length } as unknown as Record<string, unknown>,
  };
}

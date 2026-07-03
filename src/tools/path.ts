import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const findPathSchema = z.object({
  item_a:    z.string().uuid().describe('UUID of the start item'),
  item_b:    z.string().uuid().describe('UUID of the end item'),
  max_depth: z.number().int().min(1).max(10).default(5).describe(
    'Maximum path length to search (default 5)'
  ),
});

export async function findPath(
  input: z.infer<typeof findPathSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { item_a, item_b, max_depth } = input;

  const { data, error } = await dbAdmin.rpc('find_shortest_path', {
    start_id:  item_a,
    end_id:    item_b,
    max_depth,
  });

  if (error) throw new Error(`find_shortest_path RPC failed: ${error.message}`);

  const result = data as {
    path_item_ids?: string[];
    path_edge_types?: string[];
    path_length?: number;
  } | null;

  if (!result || !result.path_item_ids?.length) {
    return {
      content: [{ type: 'text' as const, text: `No path found between ${item_a.slice(0, 8)} and ${item_b.slice(0, 8)} within depth ${max_depth}.` }],
      structuredContent: { found: false, path_item_ids: [], path_edge_types: [], path_length: null },
    };
  }

  const { path_item_ids, path_edge_types = [], path_length } = result;

  const steps = path_item_ids.map((id, i) => {
    const edge = path_edge_types[i] ? ` —[${path_edge_types[i]}]→ ` : (i < path_item_ids.length - 1 ? ' → ' : '');
    return `${id.slice(0, 8)}${edge}`;
  }).join('');

  const text = [
    `Path found: length ${path_length ?? path_item_ids.length - 1}`,
    '',
    steps,
    '',
    `Item IDs: ${path_item_ids.join(' → ')}`,
  ].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      found: true,
      path_item_ids,
      path_edge_types,
      path_length: path_length ?? path_item_ids.length - 1,
    } as unknown as Record<string, unknown>,
  };
}

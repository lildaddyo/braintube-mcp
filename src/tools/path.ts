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

  // Breadth-first search over the caller's knowledge_edges, both directions.
  // (The find_shortest_path RPC is broken in the database: its recursive CTE
  // references itself in the non-recursive term, so Postgres rejects it.)
  type Edge = { source_id: string; target_id: string; edge_type: string };
  const prev = new Map<string, { from: string; edgeType: string }>();
  const seen = new Set<string>([item_a]);
  let frontier: string[] = [item_a];
  let found = item_a === item_b;
  const MAX_FRONTIER = 200;

  for (let depth = 0; depth < max_depth && !found && frontier.length > 0; depth++) {
    const ids = frontier.slice(0, MAX_FRONTIER);
    const list = ids.join(',');
    const { data, error } = await dbAdmin
      .from('knowledge_edges')
      .select('source_id, target_id, edge_type')
      .eq('user_id', userId)
      .or(`source_id.in.(${list}),target_id.in.(${list})`)
      .limit(5000);
    if (error) throw new Error(`Path search failed: ${error.message}`);

    const inFrontier = new Set(ids);
    const next: string[] = [];
    for (const e of (data ?? []) as Edge[]) {
      for (const [from, to] of [[e.source_id, e.target_id], [e.target_id, e.source_id]] as const) {
        if (!inFrontier.has(from) || seen.has(to)) continue;
        seen.add(to);
        prev.set(to, { from, edgeType: String(e.edge_type) });
        next.push(to);
        if (to === item_b) found = true;
      }
    }
    frontier = next;
  }

  const path_item_ids: string[] = [];
  const path_edge_types: string[] = [];
  let current = item_a;
  if (found && item_a !== item_b) {
    let node = item_b;
    path_item_ids.unshift(node);
    while (node !== item_a) {
      const step = prev.get(node);
      if (!step) break;
      path_edge_types.unshift(step.edgeType);
      node = step.from;
      path_item_ids.unshift(node);
    }
    current = item_b;
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

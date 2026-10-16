import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const knowledgeGraphSchema = z.object({
  item_id: z.string().guid().describe('UUID of the center item to build the graph around'),
  depth: z.number().int().min(1).max(3).default(1).describe(
    'Graph traversal depth (default 1). Depth 2-3 expands to neighbours of neighbours.'
  )
});

const graphNodeOutputSchema = z.object({
  id: z.string(),
  node_type: z.enum(['item', 'entity']).optional(),
  title: z.string().nullable().optional(),
  source_type: z.string().optional(),
  salience_score: z.number().nullable().optional(),
}).passthrough();

export const getKnowledgeGraphOutputSchema = z.object({
  center_item: graphNodeOutputSchema,
  nodes: z.array(graphNodeOutputSchema),
  edges: z.array(z.object({
    source_id: z.string(),
    target_id: z.string(),
    edge_type: z.string().optional(),
    confidence: z.number().nullable().optional(),
  }).passthrough()),
  stats: z.object({
    total_nodes: z.number(),
    total_edges: z.number(),
  }).passthrough(),
});

interface KnowledgeEdge {
  source_id: string;
  target_id: string;
  edge_type: string;
  confidence: number;
  source_title: string;
  target_title: string;
}

interface ItemNode {
  id: string;
  node_type?: 'item' | 'entity';
  title: string;
  source_type: string;
  salience_score: number | null;
}

async function fetchEdgesForIds(ids: string[], userId: string): Promise<KnowledgeEdge[]> {
  if (ids.length === 0) return [];

  // Fetch edges without FK-hint joins (knowledge_edges has no FK constraints declared)
  const { data: edgeRows, error } = await dbAdmin
    .from('knowledge_edges')
    .select('source_id, target_id, edge_type, confidence')
    .eq('user_id', userId)
    .or(ids.map(id => `source_id.eq.${id},target_id.eq.${id}`).join(','))
    .order('confidence', { ascending: false })
    .limit(50 * ids.length);

  if (error) throw new Error(`knowledge_graph query failed: ${error.message}`);
  if (!edgeRows || edgeRows.length === 0) return [];

  // Resolve titles for all referenced item IDs in a single batch query
  const referencedIds = [...new Set([
    ...edgeRows.map((e: { source_id: string }) => e.source_id),
    ...edgeRows.map((e: { target_id: string }) => e.target_id),
  ])];
  const { data: itemRows } = await dbAdmin
    .from('items')
    .select('id, title').eq('is_adult', false)
    .in('id', referencedIds);

  const titleMap = new Map<string, string>(
    (itemRows ?? []).map((r: { id: string; title: string }) => [r.id, r.title])
  );

  return edgeRows.map((e: { source_id: string; target_id: string; edge_type: string; confidence: number }) => ({
    source_id: e.source_id,
    target_id: e.target_id,
    edge_type: e.edge_type,
    confidence: e.confidence,
    source_title: titleMap.get(e.source_id) ?? '',
    target_title: titleMap.get(e.target_id) ?? '',
  }));
}

export async function getKnowledgeGraph(
  input: z.infer<typeof knowledgeGraphSchema>,
  userId: string
) {
  const { item_id, depth } = input;

  // Verify the center item belongs to this user
  const { data: centerData, error: centerError } = await dbAdmin
    .from('items')
    .select('id, title, source_type, salience_score').eq('is_adult', false)
    .eq('id', item_id)
    .eq('user_id', userId)
    .single();

  if (centerError || !centerData) {
    throw new Error(`Item not found or does not belong to this user: ${item_id}`);
  }

  const centerItem: ItemNode = {
    id: centerData.id,
    title: centerData.title,
    source_type: centerData.source_type,
    salience_score: centerData.salience_score ?? null,
  };

  // Depth 1: fetch edges for center item
  const allEdges: KnowledgeEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  const nodeIds = new Set<string>([item_id]);

  const addEdges = (edges: KnowledgeEdge[]) => {
    for (const e of edges) {
      const key = `${e.source_id}:${e.target_id}:${e.edge_type}`;
      if (!seenEdgeKeys.has(key)) {
        seenEdgeKeys.add(key);
        allEdges.push(e);
        nodeIds.add(e.source_id);
        nodeIds.add(e.target_id);
      }
    }
  };

  const depth1Edges = await fetchEdgesForIds([item_id], userId);
  addEdges(depth1Edges);

  // Depth 2+: collect neighbour IDs, fetch their edges
  if (depth >= 2) {
    const depth1Ids = [...nodeIds].filter(id => id !== item_id);
    if (depth1Ids.length > 0) {
      const depth2Edges = await fetchEdgesForIds(depth1Ids, userId);
      addEdges(depth2Edges);
    }
  }

  if (depth >= 3) {
    const depth2Ids = [...nodeIds].filter(id => id !== item_id);
    // Fetch edges only for newly added nodes beyond depth-1 set
    const newIds = depth2Ids.filter(id => !([item_id, ...depth1Edges.map(e => e.source_id), ...depth1Edges.map(e => e.target_id)]).includes(id));
    if (newIds.length > 0) {
      const depth3Edges = await fetchEdgesForIds(newIds, userId);
      addEdges(depth3Edges);
    }
  }

  // Fetch full node metadata for all discovered node IDs (excluding center)
  const neighbourIds = [...nodeIds].filter(id => id !== item_id);
  let nodes: ItemNode[] = [];

  if (neighbourIds.length > 0) {
    const { data: itemsData } = await dbAdmin
      .from('items')
      .select('id, title, source_type, salience_score').eq('is_adult', false)
      .in('id', neighbourIds)
      .eq('user_id', userId);

    nodes = (itemsData ?? []).map(row => ({
      id: row.id,
      node_type: 'item' as const,
      title: row.title,
      source_type: row.source_type,
      salience_score: row.salience_score ?? null,
    }));

    // Most edges (mentions, co_mentioned, related_to between concepts) point at
    // knowledge_entities, not items. Resolve those too so clients see their names.
    const itemIds = new Set(nodes.map(n => n.id));
    const entityIds = neighbourIds.filter(id => !itemIds.has(id));
    for (let i = 0; i < entityIds.length; i += 200) {
      const { data: entityRows, error: entityErr } = await dbAdmin
        .from('knowledge_entities')
        .select('id, name, entity_type')
        .in('id', entityIds.slice(i, i + 200))
        .eq('user_id', userId);
      if (entityErr) throw new Error(`knowledge_graph entity lookup failed: ${entityErr.message}`);
      for (const row of entityRows ?? []) {
        nodes.push({
          id: row.id,
          node_type: 'entity',
          title: row.name,
          source_type: row.entity_type ?? 'concept',
          salience_score: null,
        });
      }
    }
  }

  // Drop edges whose far end did not resolve (adult items, other users' rows, deleted rows).
  const resolvedIds = new Set<string>([item_id, ...nodes.map(n => n.id)]);
  const visibleEdges = allEdges.filter(e => resolvedIds.has(e.source_id) && resolvedIds.has(e.target_id));

  const edgesOut = visibleEdges.map(e => ({
    source_id: e.source_id,
    target_id: e.target_id,
    edge_type: e.edge_type,
    confidence: e.confidence,
  }));

  const result = {
    center_item: centerItem,
    nodes,
    edges: edgesOut,
    stats: {
      total_nodes: nodes.length + 1, // include center
      total_edges: edgesOut.length,
    },
  };

  const list = (ns: ItemNode[]) =>
    `${ns.slice(0, 10).map(n => `  • ${n.title} [${n.source_type}]`).join('\n')}${ns.length > 10 ? `\n  …and ${ns.length - 10} more` : ''}`;
  const itemNodes = nodes.filter(n => n.node_type === 'item');
  const entityNodes = nodes.filter(n => n.node_type === 'entity');
  const summary = [
    `Knowledge graph for "${centerItem.title}"`,
    `Depth: ${depth} | Nodes: ${result.stats.total_nodes} | Edges: ${result.stats.total_edges}`,
    itemNodes.length > 0 ? `\nConnected items:\n${list(itemNodes)}` : '',
    entityNodes.length > 0 ? `\nConcepts and entities:\n${list(entityNodes)}` : '',
    nodes.length === 0 ? '\nNo connected items found at this depth.' : '',
  ].filter(Boolean).join('\n');

  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

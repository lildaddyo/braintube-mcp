import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const knowledgeGraphSchema = z.object({
  item_id: z.string().uuid().describe('UUID of the center item to build the graph around'),
  depth: z.number().int().min(1).max(3).default(1).describe(
    'Graph traversal depth (default 1). Depth 2-3 expands to neighbours of neighbours.'
  )
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
  title: string;
  source_type: string;
  salience_score: number | null;
}

async function fetchEdgesForIds(ids: string[]): Promise<KnowledgeEdge[]> {
  if (ids.length === 0) return [];

  // Fetch edges without FK-hint joins (knowledge_edges has no FK constraints declared)
  const { data: edgeRows, error } = await dbAdmin
    .from('knowledge_edges')
    .select('source_id, target_id, edge_type, confidence')
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
    .select('id, title')
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
    .select('id, title, source_type, salience_score')
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

  const depth1Edges = await fetchEdgesForIds([item_id]);
  addEdges(depth1Edges);

  // Depth 2+: collect neighbour IDs, fetch their edges
  if (depth >= 2) {
    const depth1Ids = [...nodeIds].filter(id => id !== item_id);
    if (depth1Ids.length > 0) {
      const depth2Edges = await fetchEdgesForIds(depth1Ids);
      addEdges(depth2Edges);
    }
  }

  if (depth >= 3) {
    const depth2Ids = [...nodeIds].filter(id => id !== item_id);
    // Fetch edges only for newly added nodes beyond depth-1 set
    const newIds = depth2Ids.filter(id => !([item_id, ...depth1Edges.map(e => e.source_id), ...depth1Edges.map(e => e.target_id)]).includes(id));
    if (newIds.length > 0) {
      const depth3Edges = await fetchEdgesForIds(newIds);
      addEdges(depth3Edges);
    }
  }

  // Fetch full node metadata for all discovered node IDs (excluding center)
  const neighbourIds = [...nodeIds].filter(id => id !== item_id);
  let nodes: ItemNode[] = [];

  if (neighbourIds.length > 0) {
    const { data: itemsData } = await dbAdmin
      .from('items')
      .select('id, title, source_type, salience_score')
      .in('id', neighbourIds)
      .eq('user_id', userId);

    nodes = (itemsData ?? []).map(row => ({
      id: row.id,
      title: row.title,
      source_type: row.source_type,
      salience_score: row.salience_score ?? null,
    }));
  }

  const edgesOut = allEdges.map(e => ({
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

  const summary = [
    `Knowledge graph for "${centerItem.title}"`,
    `Depth: ${depth} | Nodes: ${result.stats.total_nodes} | Edges: ${result.stats.total_edges}`,
    nodes.length > 0
      ? `\nConnected items:\n${nodes.slice(0, 10).map(n => `  • ${n.title} [${n.source_type}]`).join('\n')}${nodes.length > 10 ? `\n  …and ${nodes.length - 10} more` : ''}`
      : '\nNo connected items found at this depth.',
  ].join('\n');

  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

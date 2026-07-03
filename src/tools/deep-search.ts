import { z } from 'zod';
import { dbAdmin, adaptiveSearchRpc } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';
import { taintedListSchema, looseItemSchema } from '../schemas/output.js';

export const deepSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('Search query'),
  max_hops: z.number().int().min(1).max(3).default(2).describe(
    'Graph traversal depth from each top result (default 2)'
  ),
});

export const deepSearchOutputSchema = z.object({
  direct_results: z.array(looseItemSchema),
  graph_connected: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    source_type: z.string().optional(),
    salience_score: z.number().nullable().optional(),
    via_item_id: z.string().optional(),
  }).passthrough()),
  total_nodes_explored: z.number(),
  tainted_direct: taintedListSchema(looseItemSchema),
});

export async function deepSearch(
  input: z.infer<typeof deepSearchSchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { query, max_hops } = input;

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  if (!hasApiKey) throw new Error('deep_search requires OPENAI_API_KEY — set it as a Railway env var.');

  // Step 1 — adaptive_search for direct results
  const embedding = await generateEmbedding(query, 768);
  const directResults = await adaptiveSearchRpc(query, embedding, userId, 10);

  // Step 2 — traverse knowledge graph from top-3 results
  const top3Ids = directResults.slice(0, 3).map(r => r.id);
  const directIds = new Set(directResults.map(r => r.id));

  const graphNodes: Array<{
    id: string; title: string; source_type: string;
    salience_score: number | null; via_item_id: string;
  }> = [];
  const seenGraphIds = new Set<string>(directIds);

  await Promise.all(top3Ids.map(async (seedId) => {
    try {
      const { data, error } = await dbAdmin.rpc('traverse_knowledge_graph', {
        item_id:  seedId,
        max_hops,
        user_id:  userId,
      });
      if (error) {
        console.error(`[deep_search] traverse_knowledge_graph error for ${seedId}:`, error.message);
        return;
      }
      for (const node of (data ?? []) as Array<{ id: string; title: string; source_type: string; salience_score: number | null }>) {
        if (!seenGraphIds.has(node.id)) {
          seenGraphIds.add(node.id);
          graphNodes.push({ ...node, via_item_id: seedId });
        }
      }
    } catch (err) {
      console.error(`[deep_search] graph traverse threw for ${seedId}:`, err);
    }
  }));

  const totalNodesExplored = directResults.length + graphNodes.length;

  const summaryLines = [
    `Deep search for "${query}" — ${max_hops}-hop graph traversal`,
    `Direct results: ${directResults.length} | Graph-connected: ${graphNodes.length} | Total explored: ${totalNodesExplored}`,
    '',
    '### Direct Results',
    ...directResults.slice(0, 5).map((r, i) =>
      `${i + 1}. **${r.title}** [${r.strategy ?? 'adaptive'}]`
    ),
  ];

  if (graphNodes.length > 0) {
    summaryLines.push('', '### Graph-Connected Items');
    for (const n of graphNodes.slice(0, 10)) {
      summaryLines.push(`- **${n.title}** [${n.source_type}] ← via ${n.via_item_id.slice(0, 8)}`);
    }
    if (graphNodes.length > 10) summaryLines.push(`  …and ${graphNodes.length - 10} more`);
  }

  const tainted = wrapWithTaint(directResults.map(r => ({ ...r, taint_level: r.taint_level ?? 0 })));

  return {
    content: [{ type: 'text' as const, text: summaryLines.join('\n') }],
    structuredContent: {
      direct_results:       directResults,
      graph_connected:      graphNodes,
      total_nodes_explored: totalNodesExplored,
      tainted_direct:       tainted,
    } as unknown as Record<string, unknown>,
  };
}

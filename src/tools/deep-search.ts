import { z } from 'zod';
import { dbAdmin, adaptiveSearchRpc, semanticSearch, logMcpRetrieval } from '../db/supabase.js';
import type { AdaptiveResult } from '../db/supabase.js';
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
    title: z.string().nullable().optional(),
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

  // Step 1 — adaptive_search for direct results.
  // Credits are already deducted by the caller, so an embedding/RPC failure (e.g. OpenAI 429)
  // must degrade to keyword search instead of returning an empty error (seen 2026-09-19).
  let directResults: AdaptiveResult[];
  try {
    const embedding = await generateEmbedding(query, 768);
    directResults = await adaptiveSearchRpc(query, embedding, userId, 10);
  } catch (err) {
    console.error('[deep_search] adaptive path threw, falling back to keyword:', err);
    const kw = await semanticSearch(query, userId, 10);
    directResults = (kw as unknown as AdaptiveResult[]).map(r => ({ ...r, strategy: 'keyword_fallback' }));
  }

  // Step 2 — traverse knowledge graph from top-3 results
  const top3Ids = directResults.slice(0, 3).map(r => r.id);
  const directIds = new Set(directResults.map(r => r.id));

  const graphNodes: Array<{
    id: string; title: string; source_type: string;
    salience_score: number | null; via_item_id: string;
  }> = [];
  const seenGraphIds = new Set<string>(directIds);

  // Step 2 — traverse. DB signature: traverse_knowledge_graph(start_item_id, max_depth, min_confidence)
  // (the previous call used item_id/max_hops/user_id, errored on every call and was swallowed).
  // The function has no user filter and we call it with the service role, so every node is
  // re-checked for ownership below before it can be returned.
  const candidates = new Map<string, { title: string; salience_score: number | null; via_item_id: string }>();
  await Promise.all(top3Ids.map(async (seedId) => {
    try {
      const { data, error } = await dbAdmin.rpc('traverse_knowledge_graph', {
        start_item_id: seedId,
        max_depth:     max_hops,
      });
      if (error) {
        console.error(`[deep_search] traverse_knowledge_graph error for ${seedId}:`, error.message);
        return;
      }
      for (const node of (data ?? []) as Array<{ item_id: string; title: string; salience_score: number | null }>) {
        if (!seenGraphIds.has(node.item_id) && !candidates.has(node.item_id)) {
          candidates.set(node.item_id, { title: node.title, salience_score: node.salience_score, via_item_id: seedId });
        }
      }
    } catch (err) {
      console.error(`[deep_search] graph traverse threw for ${seedId}:`, err);
    }
  }));

  if (candidates.size > 0) {
    const { data: owned, error: ownErr } = await dbAdmin
      .from('items')
      .select('id, source_type')
      .in('id', [...candidates.keys()])
      .eq('user_id', userId)
      .eq('is_archived', false);
    if (ownErr) {
      console.error('[deep_search] ownership check failed — returning no graph nodes:', ownErr.message);
    } else {
      for (const row of (owned ?? []) as Array<{ id: string; source_type: string }>) {
        const c = candidates.get(row.id)!;
        seenGraphIds.add(row.id);
        graphNodes.push({ id: row.id, title: c.title, source_type: row.source_type, salience_score: c.salience_score, via_item_id: c.via_item_id });
      }
      graphNodes.sort((a, b) => (Number(b.salience_score ?? 0) - Number(a.salience_score ?? 0)));
    }
  }

  const totalNodesExplored = directResults.length + graphNodes.length;

  void logMcpRetrieval(
    userId,
    query,
    'mcp_deep_search',
    totalNodesExplored,
    [...directResults.map(r => r.id), ...graphNodes.map(n => n.id)]
  );

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

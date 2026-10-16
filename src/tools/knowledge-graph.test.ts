import { test } from 'node:test';
import assert from 'node:assert/strict';

// Most knowledge_edges from an item point at knowledge_entities (mentions), not items.
// get_knowledge_graph used to resolve nodes from items only, so those came back as nodes: [].
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { getKnowledgeGraph } = await import('./knowledge-graph.js');

const USER = '00000000-0000-0000-0000-0000000000aa';
const ITEM = '00000000-0000-0000-0000-000000000001';
const OTHER_ITEM = '00000000-0000-0000-0000-000000000002';
const ENTITY = '00000000-0000-0000-0000-000000000003';
const GONE = '00000000-0000-0000-0000-000000000004';

test('entity targets resolve to named nodes; edges are user-scoped; unresolved ends are dropped', async () => {
  const urls: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname.endsWith('/knowledge_edges')) {
      return json([
        { source_id: ITEM, target_id: ENTITY, edge_type: 'mentions', confidence: 0.85 },
        { source_id: ITEM, target_id: OTHER_ITEM, edge_type: 'related_to', confidence: 0.7 },
        { source_id: ITEM, target_id: GONE, edge_type: 'mentions', confidence: 0.6 },
      ]);
    }
    if (url.pathname.endsWith('/knowledge_entities')) {
      return json([{ id: ENTITY, name: 'Spaced repetition', entity_type: 'concept' }]);
    }
    if (url.pathname.endsWith('/items')) {
      if (url.searchParams.get('id')?.startsWith('eq.')) {
        return json({ id: ITEM, title: 'Center', source_type: 'youtube', salience_score: 0.5 });
      }
      return json([{ id: OTHER_ITEM, title: 'Neighbour', source_type: 'web', salience_score: 0.2 }]);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  try {
    const out = await getKnowledgeGraph({ item_id: ITEM, depth: 1 }, USER);
    const r = out.structuredContent as any;
    const byId = new Map(r.nodes.map((n: any) => [n.id, n]));
    assert.equal((byId.get(ENTITY) as any)?.title, 'Spaced repetition');
    assert.equal((byId.get(ENTITY) as any)?.node_type, 'entity');
    assert.equal((byId.get(OTHER_ITEM) as any)?.node_type, 'item');
    assert.equal(r.edges.length, 2, 'edge to an unresolved node is dropped');
    assert.match(out.content[0].text, /Concepts and entities:\n {2}• Spaced repetition \[concept\]/);
    const edgeReq = urls.find(u => u.pathname.endsWith('/knowledge_edges'))!;
    assert.equal(edgeReq.searchParams.get('user_id'), `eq.${USER}`);
    const entReq = urls.find(u => u.pathname.endsWith('/knowledge_entities'))!;
    assert.equal(entReq.searchParams.get('user_id'), `eq.${USER}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

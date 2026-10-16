// search_by_source / search_by_date_range (embedding audit 2026-10-16, defect 5): both now rank inside the filter
// with RPC search_items_window on the content embedding (3-large 1536-d since 2026-10-16), instead of a global top-N from the legacy 1536-d
// column filtered in JS. Only the network is faked (Supabase PostgREST + OpenAI embeddings).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Fixture credentials, assembled at runtime (public repo: no token-shaped literals).
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = ['fixture', 'service', 'role'].join('-');
process.env.OPENAI_API_KEY = ['fixture', 'openai', 'key'].join('-');

const { searchBySource } = await import('./search-by-source.js');
const { searchByDate } = await import('./search-by-date.js');
const { clearCaches } = await import('../lib/ttl-cache.js');

const USER = '00000000-0000-4000-8000-000000000001';
type Call = { path: string; body: any; url: string };
let calls: Call[] = [];
let windowRows: any[] = [];
let windowStatus = 200;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  clearCaches();
  calls = [];
  windowRows = [];
  windowStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    let body: any = undefined;
    if (typeof raw === 'string' && raw.length) { try { body = JSON.parse(raw); } catch { body = raw; } }
    calls.push({ path: url.pathname, body, url: url.href });
    const p = url.pathname;
    if (p.endsWith('/embeddings')) {
      const dims = body.dimensions ?? 1536;
      return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: Array(dims).fill(0.01) }], model: body.model });
    }
    if (p === '/rest/v1/rpc/search_items_window') return windowStatus === 200 ? json(windowRows) : json({ message: 'boom' }, windowStatus);
    if (p === '/rest/v1/items') {
      // metadata hydrate (id, video_id, taint_level) or the keyword fallback
      if (url.searchParams.get('select')?.replace(/\s/g, '') === 'id,video_id,taint_level') return json(windowRows.map(r => ({ id: r.id, video_id: `v-${r.id}`, taint_level: 2 })));
      return json([{ id: 'kw1', title: 'keyword hit', source_type: 'youtube', taint_level: 0, created_at: '2026-07-01T00:00:00Z' }]);
    }
    if (p === '/rest/v1/rpc/increment_retrieval_stats') return new Response(null, { status: 204 });
    if (p === '/rest/v1/mcp_retrieval_log' || p === '/rest/v1/retrieval_log') return new Response(null, { status: 201 });
    return json({ message: `unrouted ${p}` }, 404);
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const callsTo = (path: string) => calls.filter(c => c.path === path);
const data = (res: any) => (res.structuredContent as any).data as any[];

test('search_by_source ranks inside the source type with a 1536-d (3-large) query on search_items_window', async () => {
  windowRows = [{ id: 'a', title: 'A', source_type: 'youtube', rrf_score: 0.03 }, { id: 'b', title: 'B', source_type: 'youtube', rrf_score: 0.02 }];
  const res = await searchBySource({ source_type: 'youtube', query: 'rag', limit: 5 }, USER);
  const emb = callsTo('/v1/embeddings')[0];
  assert.equal(emb.body.dimensions, 1536);
  const w = callsTo('/rest/v1/rpc/search_items_window');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].body.source_types, ['youtube']);
  assert.equal(w[0].body.filter_user_id, USER);
  assert.equal(w[0].body.match_count, 5);
  assert.equal(w[0].body.query_embedding.length, 1536);
  assert.deepEqual(data(res).map(r => r.id), ['a', 'b']);
  assert.equal(data(res)[0].video_id, 'v-a');                // hydrated
  assert.equal((res.structuredContent as any).taint_level, 2); // taint comes from the items lookup
  assert.equal(callsTo('/rest/v1/rpc/search_knowledge_semantic').length, 0);
});

test('search_by_date_range passes the window to SQL instead of filtering a global top-N', async () => {
  windowRows = [{ id: 'j', title: 'July item', source_type: 'web', rrf_score: 0.03, created_at: '2026-07-10T00:00:00Z' }];
  const res = await searchByDate({ query: 'jailbreaking models', after: '2026-07-01', before: '2026-08-01', limit: 10 }, USER);
  const w = callsTo('/rest/v1/rpc/search_items_window');
  assert.equal(w.length, 1);
  assert.equal(w[0].body.date_from, '2026-07-01T00:00:00.000Z');
  assert.equal(w[0].body.date_to, '2026-08-01T00:00:00.000Z');
  assert.equal(w[0].body.source_types, null);
  assert.deepEqual(data(res).map(r => r.id), ['j']);
});

test('an RPC failure falls back to the keyword search', async () => {
  windowStatus = 500;
  const res = await searchBySource({ source_type: 'youtube', query: 'anything at all', limit: 3 }, USER);
  assert.deepEqual(data(res).map(r => r.id), ['kw1']);
  assert.equal(data(res)[0].match_type, 'keyword');
});

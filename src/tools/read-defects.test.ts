// Smaller read-path defects from the 2026-11-18 connector comparison: the not-found error, slim search rows,
// weak hits left out, and one item count across get_stats and knowledge_health. Network faked; nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = ['fixture', 'service', 'role'].join('-');

const { getVideoById, ItemNotFoundError } = await import('../db/supabase.js');
const { chatgptFetch, chatgptFetchSchema } = await import('./chatgpt-compat.js');
const { knowledgeHealth, knowledgeHealthOutputSchema } = await import('./knowledge-health.js');
const { slimRow, dropWeakRows, minRelevance } = await import('./search.js');
const { formatTaintedResponse } = await import('../security/taint.js');

const USER = '00000000-0000-4000-8000-000000000001';
const UUID = '11111111-1111-4111-8111-111111111111';

type Call = { path: string; url: string; method: string; prefer: string | null };
let calls: Call[] = [];
let items: Array<Record<string, unknown>> = [];
let itemsError: { status: number; message: string } | null = null;
let health: Record<string, unknown> | null = null;
let adultCount = 0;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  calls = []; items = []; itemsError = null; health = null; adultCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ path: url.pathname, url: decodeURIComponent(url.href), method, prefer: headers.get('prefer') });
    if (url.pathname === '/rest/v1/rpc/knowledge_health') return json(health);
    if (url.pathname === '/rest/v1/items') {
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `0-0/${adultCount}` } });
      if (itemsError) return json({ message: itemsError.message }, itemsError.status);
      return json(items);
    }
    if (url.pathname === '/rest/v1/item_tags') return json([]);
    return json({ message: `unrouted ${url.pathname}` }, 404);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('an unknown id is refused with what to pass, never with database text', async () => {
  await assert.rejects(getVideoById('does-not-exist', USER), (e: Error) => {
    assert.ok(e instanceof ItemNotFoundError);
    assert.equal(e.message, 'No saved item with id "does-not-exist". Pass an id returned by search, search_knowledge, grep or list_recent (a UUID), or a YouTube video id.');
    assert.doesNotMatch(e.message, /coerce|JSON object|PGRST/i);
    return true;
  });
  // one query, on the column the id shape names, for this user only
  const q = calls.filter(c => c.path === '/rest/v1/items');
  assert.equal(q.length, 1);
  assert.ok(q[0].url.includes('video_id=eq.does-not-exist') && q[0].url.includes(`user_id=eq.${USER}`) && q[0].url.includes('limit=1'));
  calls = [];
  await assert.rejects(getVideoById(UUID, USER), /No saved item with id/);
  assert.ok(calls[0].url.includes(`id=eq.${UUID}`) && !calls[0].url.includes('video_id=eq.'));
});

test('fetch on an unknown id gives the same message; a database failure is not echoed', async () => {
  await assert.rejects(chatgptFetch(chatgptFetchSchema.parse({ id: 'nope' }), USER), /^ItemNotFoundError: No saved item with id "nope"\. Pass an id returned by search/);
  itemsError = { status: 500, message: 'connection to server at "10.0.0.5" failed: secret detail' };
  await assert.rejects(chatgptFetch(chatgptFetchSchema.parse({ id: 'nope' }), USER), (e: Error) => {
    assert.equal(e.message, 'The item could not be read right now. Try again in a moment.');
    return true;
  });
});

test('a video saved twice resolves to the newest copy instead of failing', async () => {
  items = [{ id: UUID, video_id: 'abcDEF12345', title: 'Newest', taint_level: 1 }];
  const item = await getVideoById('abcDEF12345', USER);
  assert.equal(item.title, 'Newest');
  assert.ok(calls[0].url.includes('order=created_at.desc') && calls[0].url.includes('limit=1'));
});

test('slimRow drops the retriever internals and keeps what an agent uses', () => {
  const row = { id: 'a', title: 'T', relevance_score: 0.9, match_type: 'balanced', full_text_rank: 3, semantic_rank: 1, rrf_score: 0.03, strategy: 'balanced', similarity: 0.5, centrality_score: null, passages: [{ text: 'p' }] };
  assert.deepEqual(slimRow(row), { id: 'a', title: 'T', relevance_score: 0.9, match_type: 'balanced', passages: [{ text: 'p' }] });
  assert.equal(slimRow({ id: 'b', centrality_score: 0.4 }).centrality_score, 0.4);      // a real value stays
  process.env.SEARCH_RANK_FIELDS = 'on';
  try { assert.equal(slimRow(row), row); } finally { delete process.env.SEARCH_RANK_FIELDS; }
});

test('dropWeakRows leaves out rows scored under 0.05, always keeps the best row, and never judges unscored rows', () => {
  const rows = [{ id: 'a', relevance_score: 0.3 }, { id: 'b', relevance_score: 0.05 }, { id: 'c', relevance_score: 0.049 }, { id: 'd' }, { id: 'e', relevance_score: 0 }];
  assert.deepEqual(dropWeakRows(rows), { rows: [rows[0], rows[1], rows[3]], omitted: 2 });
  const hopeless = [{ id: 'a', relevance_score: 0.01 }, { id: 'b', relevance_score: 0.005 }];
  assert.deepEqual(dropWeakRows(hopeless), { rows: [hopeless[0]], omitted: 1 });
  assert.deepEqual(dropWeakRows([]), { rows: [], omitted: 0 });
  assert.equal(minRelevance(), 0.05);
  process.env.SEARCH_MIN_RELEVANCE = 'off';
  try { assert.deepEqual(dropWeakRows(rows), { rows, omitted: 0 }); } finally { delete process.env.SEARCH_MIN_RELEVANCE; }
  process.env.SEARCH_MIN_RELEVANCE = '0.2';
  try { assert.equal(dropWeakRows(rows).rows.length, 2); } finally { delete process.env.SEARCH_MIN_RELEVANCE; }
  process.env.SEARCH_MIN_RELEVANCE = 'garbage';
  try { assert.equal(minRelevance(), 0.05); } finally { delete process.env.SEARCH_MIN_RELEVANCE; }
});

test('the compact text block is the same data without indentation, with the taint lines unchanged', () => {
  const response = { data: [{ id: 'a', title: 'T' }], taint_level: 1, taint_warning: 'careful' };
  const pretty = formatTaintedResponse(response);
  const compact = formatTaintedResponse(response, true);
  assert.ok(compact.length < pretty.length);
  assert.ok(compact.includes('[{"id":"a","title":"T"}]'));
  for (const line of ['TAINT WARNING [LOW]: careful', '[Taint level: low (1/3)]']) assert.ok(pretty.includes(line) && compact.includes(line));
});

test('knowledge_health reports the same item total as get_stats: adult-flagged items are left out and counted apart', async () => {
  health = { total_items: 1606, missing_embeddings: 14, health_score: 0.91 };
  adultCount = 3;
  const res = await knowledgeHealth({}, USER);
  const out = res.structuredContent as Record<string, unknown>;
  assert.equal(out.total_items, 1603);
  assert.equal(out.excluded_adult_items, 3);
  assert.match(res.content[0].text, /Total items:\s+1603/);
  assert.equal(knowledgeHealthOutputSchema.safeParse(out).success, true);
  const head = calls.find(c => c.path === '/rest/v1/items')!;
  assert.ok(head.url.includes(`user_id=eq.${USER}`) && head.url.includes('is_adult=eq.true') && head.url.includes('is_archived=not.is.true'));
  // nothing flagged: the total is the RPC's, and no extra field appears
  adultCount = 0;
  health = { total_items: 40 };
  const plain = (await knowledgeHealth({}, USER)).structuredContent as Record<string, unknown>;
  assert.deepEqual(plain, { total_items: 40 });
});

test('capLists keeps at most 8 entities and key concepts per row and leaves short lists alone', async () => {
  const { capLists, MAX_ROW_LIST } = await import('./search.js');
  const long = Array.from({ length: 20 }, (_, i) => `e${i}`);
  assert.equal(MAX_ROW_LIST, 8);
  assert.deepEqual(capLists({ entities: long, key_concepts: long }), { entities: long.slice(0, 8), key_concepts: long.slice(0, 8) });
  assert.deepEqual(capLists({ entities: ['a'], key_concepts: null }), {});
});

test('numeric fetch, grep and search arguments also arrive as whole-number strings (stale client schemas)', async () => {
  const { chatgptFetchSchema } = await import('./chatgpt-compat.js');
  const { grepSchema } = await import('./grep.js');
  const { searchSchema } = await import('./search.js');
  assert.deepEqual(chatgptFetchSchema.parse({ id: 'rcAyjg-oy84', from_passage: '196', max_chars: '2000' }), { id: 'rcAyjg-oy84', from_passage: 196, max_chars: 2000 });
  assert.equal(chatgptFetchSchema.safeParse({ id: 'x', from_passage: 'abc' }).success, false);
  assert.equal(chatgptFetchSchema.safeParse({ id: 'x', max_chars: '10' }).success, false);   // still range-checked
  assert.equal(grepSchema.parse({ pattern: 'Bevy', limit: '3' }).limit, 3);
  assert.equal(searchSchema.parse({ query: 'q', limit: '7' }).limit, 7);
  assert.equal(searchSchema.parse({ query: 'q' }).limit, 5);
});

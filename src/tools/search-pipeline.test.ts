// Integration test of searchKnowledge (code-health pass 2026-10-16). The whole retrieval pipeline runs for real
// (adaptive search, cross-lingual union, phrase recall, date/source window, JEV re-rank, filter prior, fail-open);
// only the network is faked: globalThis.fetch answers for Supabase (PostgREST + the jev-rerank edge function) and
// OpenAI (embeddings, query translation). Nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Fixture credentials, assembled at runtime (public repo: no token-shaped literals).
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = ['fixture', 'service', 'role'].join('-');
process.env.OPENAI_API_KEY = ['fixture', 'openai', 'key'].join('-');

const { searchKnowledge } = await import('./search.js');
const { clearCaches, cacheStats } = await import('../lib/ttl-cache.js');

const USER = '00000000-0000-4000-8000-000000000001';

type Row = { id: string; title: string; summary: string; source_type: string; created_at: string; rrf_score: number; strategy: string };
const row = (id: string, rrf: number, extra: Partial<Row> = {}): Row => ({
  id, title: `title ${id}`, summary: `summary ${id}`, source_type: 'web', created_at: '2026-01-10T10:00:00Z', rrf_score: rrf, strategy: 'balanced', ...extra,
});

type Call = { path: string; body: any; url: string };
type Fake = {
  calls: Call[];
  adaptive: (query: string) => Row[];
  phrases: string[];
  items: Row[];
  window: (body: any) => Row[];
  translation: string | null;
  rerank: ((query: string, ids: string[]) => Record<string, number>) | 'fail';
  segments: Record<string, Array<Record<string, unknown>>>;
};
let fake: Fake;
const realFetch = globalThis.fetch;
const ENV_KEYS = ['JEV_RERANK', 'PHRASE_RECALL', 'QUERY_FILTER', 'SEARCH_LOW_CONFIDENCE_THRESHOLD'] as const;
const savedEnv: Record<string, string | undefined> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Embedding = [text length, 1]: different texts get different vectors, so tests can tell which text was embedded.
const embed = (text: string) => [text.length, 1];

function route(url: URL, body: any): Response {
  const p = url.pathname;
  if (url.hostname === 'api.openai.com' || p.endsWith('/embeddings') || p.endsWith('/chat/completions')) {
    if (p.endsWith('/embeddings')) return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: embed(String(body.input)) }], model: body.model });
    if (p.endsWith('/chat/completions')) {
      if (fake.translation === null) return json({ error: { message: 'down' } }, 500);
      return json({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: fake.translation }, finish_reason: 'stop' }] });
    }
  }
  if (p === '/rest/v1/rpc/adaptive_search') return json(fake.adaptive(body.search_query));
  if (p === '/rest/v1/rpc/search_item_phrases') return json(fake.phrases.map(id => ({ id })));
  if (p === '/rest/v1/rpc/search_items_window') return json(fake.window(body));
  if (p === '/rest/v1/rpc/search_segments') return json((body.p_item_ids as string[]).flatMap(id => fake.segments[id] ?? []));
  if (p === '/rest/v1/rpc/increment_retrieval_stats') return new Response(null, { status: 204 });
  if (p === '/rest/v1/retrieval_log' || p === '/rest/v1/mcp_retrieval_log') return new Response(null, { status: 201 });
  if (p === '/rest/v1/items') return json(fake.items);
  if (p === '/functions/v1/jev-rerank') {
    if (fake.rerank === 'fail') return json({ error: 'boom' }, 500);
    const scores = fake.rerank(body.query, body.passages.map((x: any) => x.id));
    return json({ model: 'fake', ms: 1, scores: Object.entries(scores).map(([id, score]) => ({ id, score })) });
  }
  return json({ message: `unrouted ${p}` }, 404);
}

beforeEach(() => {
  clearCaches();
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  fake = { calls: [], adaptive: () => [], phrases: [], items: [], window: () => [], translation: null, rerank: 'fail', segments: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    let body: any = undefined;
    if (typeof raw === 'string' && raw.length) { try { body = JSON.parse(raw); } catch { body = raw; } }
    fake.calls.push({ path: url.pathname, body, url: url.href });
    return route(url, body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const ids = (res: Awaited<ReturnType<typeof searchKnowledge>>) => ((res.structuredContent as any).data as Array<{ id: string }>).map(r => r.id);
const callsTo = (path: string) => fake.calls.filter(c => c.path === path);
const tenRows = () => Array.from({ length: 10 }, (_, i) => row(`a${i}`, 1 - i / 100));
// Re-ranker that ranks by the given order (first id best); ids not listed get 0.1.
const rankBy = (order: string[]) => (_q: string, idsIn: string[]) =>
  Object.fromEntries(idsIn.map(id => [id, order.includes(id) ? 0.95 - order.indexOf(id) * 0.05 : 0.1]));

test('re-rank reorders the adaptive top 10, trims to the limit and reports confidence', async () => {
  fake.adaptive = () => tenRows();
  fake.rerank = rankBy(['a7', 'a3']);
  const res = await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  assert.deepEqual(ids(res).slice(0, 2), ['a7', 'a3']);
  assert.equal(ids(res).length, 3);
  assert.deepEqual((res.structuredContent as any).confidence, { top_relevance: 0.95, low_confidence: false, threshold: 0.6 });
  // adaptive_search always fetches a 10-row window for the re-ranker, for the caller's user only
  const a = callsTo('/rest/v1/rpc/adaptive_search');
  assert.equal(a.length, 1);
  assert.equal(a[0].body.match_count, 10);
  assert.equal(a[0].body.filter_user_id, USER);
  // no date/source words -> no window RPC
  assert.equal(callsTo('/rest/v1/rpc/search_items_window').length, 0);
});

test('low top relevance flags the answer but never drops rows', async () => {
  fake.adaptive = () => tenRows();
  fake.rerank = (_q, idsIn) => Object.fromEntries(idsIn.map((id, i) => [id, 0.3 - i / 100]));
  const res = await searchKnowledge({ query: 'something not in the library', limit: 5 }, USER);
  assert.equal(ids(res).length, 5);
  assert.equal((res.structuredContent as any).confidence.low_confidence, true);
  assert.match(res.content[0].text, /^\[Low confidence\]/);
});

test('re-rank failure fails open: exactly the adaptive order, phrase-only rows dropped', async () => {
  fake.adaptive = () => tenRows();
  fake.phrases = ['p1', 'a2'];
  fake.items = [row('p1', 0, { strategy: 'phrase_recall' })];
  fake.rerank = 'fail';
  const res = await searchKnowledge({ query: 'agent memory design', limit: 12 }, USER);
  assert.deepEqual(ids(res), tenRows().map(r => r.id));   // 10 rows, not 11: p1 was never scored, so it is not returned
  assert.equal((res.structuredContent as any).confidence, undefined);
});

test('scores that miss a passage id also fail open', async () => {
  fake.adaptive = () => tenRows();
  fake.rerank = (_q, idsIn) => Object.fromEntries(idsIn.slice(1).map(id => [id, 0.9]));
  const res = await searchKnowledge({ query: 'agent memory design', limit: 4 }, USER);
  assert.deepEqual(ids(res), ['a0', 'a1', 'a2', 'a3']);
});

test('phrase-only hits join the pool, are hydrated owner- and adult-filtered, and can win', async () => {
  fake.adaptive = () => tenRows();
  fake.phrases = ['p1', 'a4'];                       // a4 is already in the adaptive list
  fake.items = [row('p1', 0)];
  fake.rerank = rankBy(['p1', 'a0']);
  const res = await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  assert.deepEqual(ids(res).slice(0, 2), ['p1', 'a0']);
  const hydrate = callsTo('/rest/v1/items');
  assert.equal(hydrate.length, 1);
  const q = decodeURIComponent(hydrate[0].url);
  assert.match(q, /is_adult=eq\.false/);
  assert.match(q, new RegExp(`user_id=eq\\.${USER}`));
  assert.match(q, /id=in\.\(p1\)/);                  // only the phrase-only id is hydrated
  // the whole pool (10 adaptive + 1 phrase-only) was scored in one call
  assert.equal(callsTo('/functions/v1/jev-rerank')[0].body.passages.length, 11);
});

test('PHRASE_RECALL=off and JEV_RERANK=off switch their stages off', async () => {
  fake.adaptive = () => tenRows();
  fake.phrases = ['p1'];
  fake.rerank = rankBy(['a9']);
  process.env.PHRASE_RECALL = 'off';
  await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  assert.equal(callsTo('/rest/v1/rpc/search_item_phrases').length, 0);

  fake.calls = [];
  process.env.JEV_RERANK = 'off';
  const res = await searchKnowledge({ query: 'what did I save in July about agents', limit: 3 }, USER);
  assert.deepEqual(ids(res), ['a0', 'a1', 'a2']);
  assert.equal(callsTo('/functions/v1/jev-rerank').length, 0);
  assert.equal(callsTo('/rest/v1/rpc/search_items_window').length, 0);   // the filter needs the re-rank
  assert.equal(callsTo('/rest/v1/rpc/adaptive_search')[0].body.match_count, 3);  // no 10-row window
});

test('a date query adds in-window candidates, re-ranks on the topic and boosts relevant in-window rows', async () => {
  fake.adaptive = () => tenRows();
  fake.window = (body) => {
    const inWindow = body.date_from.slice(0, 8) + '15T09:00:00Z';         // mid-month of the asked month
    return [row('a1', 0.5, { created_at: inWindow }), row('w1', 0.4, { created_at: inWindow, strategy: 'window_filter' })];
  };
  // re-ranker: a0 best (out of window), w1 a bit lower but in the window -> +0.3 puts it first
  fake.rerank = (_q, idsIn) => Object.fromEntries(idsIn.map(id => [id, id === 'a0' ? 0.9 : id === 'w1' ? 0.7 : 0.2]));
  const res = await searchKnowledge({ query: 'what did I save in July about jailbreaking AI models?', limit: 3 }, USER);

  const w = callsTo('/rest/v1/rpc/search_items_window');
  assert.equal(w.length, 1);
  assert.equal(w[0].body.search_query, 'jailbreaking AI models');
  assert.match(w[0].body.date_from, /^\d{4}-07-01/);
  assert.match(w[0].body.date_to, /^\d{4}-08-01/);
  assert.equal(w[0].body.source_types, null);
  assert.equal(w[0].body.filter_user_id, USER);
  assert.equal(w[0].body.match_count, 8);
  // the window RPC got the topic's embedding, not the full query's
  assert.deepEqual(w[0].body.query_embedding, embed('jailbreaking AI models'));

  const rr = callsTo('/functions/v1/jev-rerank');
  assert.equal(rr.length, 1);
  assert.equal(rr[0].body.query, 'jailbreaking AI models');
  // a1 came back from the window too but is already in the pool: only w1 is new
  assert.equal(rr[0].body.passages.filter((p: any) => p.id === 'a1').length, 1);
  assert.equal(rr[0].body.passages.length, 11);
  assert.deepEqual(ids(res), ['w1', 'a0', 'a1']);
});

test('a source query passes the asked source types; QUERY_FILTER=off skips the window', async () => {
  fake.adaptive = () => tenRows();
  fake.rerank = rankBy(['a0']);
  await searchKnowledge({ query: 'the PDF I saved about pricing pages', limit: 3 }, USER);
  const w = callsTo('/rest/v1/rpc/search_items_window');
  assert.deepEqual(w[0].body.source_types, ['pdf', 'document']);
  assert.equal(w[0].body.date_from, null);

  fake.calls = [];
  process.env.QUERY_FILTER = 'off';
  await searchKnowledge({ query: 'the PDF I saved about pricing pages', limit: 3 }, USER);
  assert.equal(callsTo('/rest/v1/rpc/search_items_window').length, 0);
  assert.equal(callsTo('/functions/v1/jev-rerank')[0].body.query, 'the PDF I saved about pricing pages');
});

test('a failing window RPC is ignored (fail open to the unfiltered search)', async () => {
  fake.adaptive = () => tenRows();
  fake.window = () => { throw new Error('no window'); };
  fake.rerank = rankBy(['a5']);
  const res = await searchKnowledge({ query: 'what did I save last week about agents', limit: 2 }, USER);
  assert.deepEqual(ids(res), ['a5', 'a0']);
});

test('a Cyrillic query searches in both languages, pools the union and re-ranks against the English text', async () => {
  const bg = Array.from({ length: 10 }, (_, i) => row(`b${i}`, 0.9 - i / 100));
  const en = [row('b0', 0.99), ...Array.from({ length: 12 }, (_, i) => row(`e${i}`, 0.5 - i / 100))];
  fake.translation = 'memory for AI agents';
  fake.adaptive = (q) => (q === 'memory for AI agents' ? en : bg);
  fake.phrases = [];
  fake.rerank = rankBy(['e3', 'b2']);
  const res = await searchKnowledge({ query: 'памет за AI агенти', limit: 2 }, USER);

  const a = callsTo('/rest/v1/rpc/adaptive_search');
  assert.deepEqual(a.map(c => c.body.search_query), ['памет за AI агенти', 'memory for AI agents']);
  // phrase recall runs once, on the English embedding
  const ph = callsTo('/rest/v1/rpc/search_item_phrases');
  assert.equal(ph.length, 1);
  assert.deepEqual(ph[0].body.query_embedding, embed('memory for AI agents'));
  const rr = callsTo('/functions/v1/jev-rerank');
  assert.equal(rr.length, 1);
  assert.equal(rr[0].body.query, 'memory for AI agents');
  assert.equal(rr[0].body.passages.length, 20);           // the union is capped at 20 and all of it is scored
  assert.equal(new Set(rr[0].body.passages.map((p: any) => p.id)).size, 20);
  assert.deepEqual(ids(res), ['e3', 'b2']);
});

test('a Cyrillic query whose translation fails still searches the original text', async () => {
  fake.translation = null;
  fake.adaptive = () => tenRows();
  fake.rerank = rankBy(['a1']);
  const res = await searchKnowledge({ query: 'памет за агенти', limit: 2 }, USER);
  assert.equal(callsTo('/rest/v1/rpc/adaptive_search').length, 1);
  assert.equal(callsTo('/rest/v1/rpc/search_item_phrases').length, 0);   // Cyrillic phrases are only searched in English
  assert.deepEqual(ids(res), ['a1', 'a0']);
});

test('an adaptive RPC error falls back to the keyword search', async () => {
  fake.adaptive = () => { throw new Error('rpc down'); };
  fake.items = [row('k1', 0, { source_type: 'web' })];
  const res = await searchKnowledge({ query: 'pricing', limit: 3 }, USER);
  assert.deepEqual(ids(res), ['k1']);
  assert.equal((res.structuredContent as any).data[0].match_type, 'keyword');
  const kw = callsTo('/rest/v1/items');
  assert.match(decodeURIComponent(kw[0].url), new RegExp(`user_id=eq\\.${USER}`));
});

test('short queries skip the embedding and go straight to the keyword search', async () => {
  fake.items = [];
  const res = await searchKnowledge({ query: 'ai', limit: 3 }, USER);
  assert.match(res.content[0].text, /^No results found for "ai"/);
  assert.equal(fake.calls.filter(c => c.path.endsWith('/embeddings')).length, 0);
});

test('a repeated search is served from the caches: no second embedding or re-rank call, same result', async () => {
  fake.adaptive = () => tenRows();
  fake.rerank = rankBy(['a7', 'a3']);
  const first = await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  const embeds = fake.calls.filter(c => c.path.endsWith('/embeddings')).length;
  const reranks = callsTo('/functions/v1/jev-rerank').length;
  const second = await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  assert.deepEqual(ids(second), ids(first));
  assert.equal(fake.calls.filter(c => c.path.endsWith('/embeddings')).length, embeds);
  assert.equal(callsTo('/functions/v1/jev-rerank').length, reranks);
  assert.ok(cacheStats().embedding.hits >= 1 && cacheStats().rerank.hits >= 1);
});

test('a failed re-rank is not cached: the next search calls jev-rerank again', async () => {
  fake.adaptive = () => tenRows();
  await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  const reranks = callsTo('/functions/v1/jev-rerank').length;
  fake.rerank = rankBy(['a7']);
  const res = await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  assert.ok(callsTo('/functions/v1/jev-rerank').length > reranks);
  assert.equal(ids(res)[0], 'a7');
});

test('timed results carry moments from search_segments (scoped per item); other rows are unchanged', async () => {
  fake.adaptive = () => [
    row('v1', 0.9, { source_type: 'youtube', url: 'https://www.youtube.com/watch?v=abcDEF12345' } as any),
    row('w1', 0.8),
    row('v2', 0.7, { source_type: 'youtube', url: 'https://youtu.be/zzzYYY00011' } as any),
  ];
  fake.segments = {
    v1: [
      { item_id: 'v1', segment_text: '  memory is   the agent state ', start_time_sec: '754.6', combined_score: 0.62 },
      { item_id: 'v1', segment_text: 'right after the previous one', start_time_sec: '760', combined_score: 0.6 },  // same passage
      { item_id: 'v1', segment_text: 'later point', start_time_sec: '1200', combined_score: 0.5 },
      { item_id: 'v1', segment_text: 'weak match', start_time_sec: '1500', combined_score: 0.1 },                   // below floor
    ],
  };
  const res = await searchKnowledge({ query: 'agent memory design', limit: 3 }, USER);
  const data = (res.structuredContent as any).data as Array<any>;
  assert.deepEqual(data.map(r => r.id), ['v1', 'w1', 'v2']);
  assert.deepEqual(data[0].moments, [
    { t: 754, url: 'https://www.youtube.com/watch?v=abcDEF12345&t=754s', quote: 'memory is the agent state' },
    { t: 1200, url: 'https://www.youtube.com/watch?v=abcDEF12345&t=1200s', quote: 'later point' },
  ]);
  assert.equal('moments' in data[1], false);   // web row: not asked, no field
  assert.equal('moments' in data[2], false);   // video without matching segments: no field
  const seg = callsTo('/rest/v1/rpc/search_segments');
  assert.deepEqual(seg.map(c => c.body.p_item_ids).sort(), [['v1'], ['v2']]);
  assert.ok(seg.every(c => c.body.p_user_id === USER));
  assert.match(res.content[0].text, /watch\?v=abcDEF12345&t=754s/);
});

test('moments fail open: unusable segment rows add no field; SEARCH_MOMENTS=off skips the RPC', async () => {
  fake.adaptive = () => [row('v1', 0.9, { source_type: 'youtube', url: 'https://www.youtube.com/watch?v=abcDEF12345' } as any)];
  fake.segments = { v1: [{ item_id: 'v1', segment_text: 'x', start_time_sec: 'not-a-number', combined_score: 0.9 }] };
  let res = await searchKnowledge({ query: 'agent memory design', limit: 1 }, USER);
  assert.equal('moments' in (res.structuredContent as any).data[0], false);
  process.env.SEARCH_MOMENTS = 'off';
  try {
    fake.calls = [];
    res = await searchKnowledge({ query: 'agent memory design two', limit: 1 }, USER);
    assert.equal(callsTo('/rest/v1/rpc/search_segments').length, 0);
  } finally { delete process.env.SEARCH_MOMENTS; }
});

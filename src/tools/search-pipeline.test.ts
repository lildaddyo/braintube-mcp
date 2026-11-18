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
// These tests mock api.openai.com; the via-app path (D-211) is covered in lib/openai-via-app.test.ts.
process.env.OPENAI_VIA_APP = 'off';

const { searchKnowledge, crossLingualScript } = await import('./search.js');
const { SCRIPT_CASES } = await import('../lib/script-cases.js');
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
  segmentIndex: Array<{ id: string; segment_index: number }>;
  coreFails: boolean;
  recall: Array<Record<string, unknown>>;
  texts: Array<Record<string, unknown>>;
  oneItem: Array<Record<string, unknown>>;
  neighbours: Array<Record<string, unknown>>;
};
let fake: Fake;
const realFetch = globalThis.fetch;
const ENV_KEYS = ['JEV_RERANK', 'PHRASE_RECALL', 'SEGMENT_RECALL', 'QUERY_FILTER', 'SEARCH_LOW_CONFIDENCE_THRESHOLD', 'XL_ALL_SCRIPTS'] as const;
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
  if (p === '/rest/v1/rpc/search_segments_core') {
    if (fake.coreFails) return json({ message: 'function search_segments_core does not exist' }, 404);
    if (!body.p_item_ids) return json(fake.recall);   // library-wide: segment recall
    return json((body.p_item_ids as string[]).flatMap(id => fake.segments[id] ?? []));
  }
  if (p === '/rest/v1/rpc/search_segments') return json((body.p_item_ids as string[]).flatMap(id => fake.segments[id] ?? []));
  if (p === '/rest/v1/transcript_segments') return json(url.searchParams.has('item_id') ? fake.neighbours : fake.segmentIndex);
  if (p === '/rest/v1/rpc/increment_retrieval_stats') return new Response(null, { status: 204 });
  if (p === '/rest/v1/retrieval_log' || p === '/rest/v1/mcp_retrieval_log') return new Response(null, { status: 201 });
  if (p === '/rest/v1/items') {
    const sel = url.searchParams.get('select') ?? '';
    if (sel.includes('full_transcript')) return json(fake.texts);     // stored text of results without segments
    if (sel.includes('provenance')) return json(fake.oneItem);        // search inside one item
    return json(fake.items);
  }
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
  fake = { calls: [], adaptive: () => [], phrases: [], items: [], window: () => [], translation: null, rerank: 'fail', segments: {}, segmentIndex: [], coreFails: false, recall: [], neighbours: [], texts: [], oneItem: [] };
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
  const hydrate = callsTo('/rest/v1/items').filter(c => c.url.includes('summary_oneliner'));   // not the stored-text lookup for passages
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

test('crossLingualScript: XL_ALL_SCRIPTS=off = any Cyrillic letter, on (the default) = the shared detector', () => {
  process.env.XL_ALL_SCRIPTS = 'off';
  for (const c of SCRIPT_CASES) {
    assert.equal(crossLingualScript(c.text), /[Ѐ-ӿ]/.test(c.text) ? 'cyrillic' : null, c.text);
  }
  for (const flag of [undefined, 'on']) {
    if (flag) process.env.XL_ALL_SCRIPTS = flag; else delete process.env.XL_ALL_SCRIPTS;
    for (const c of SCRIPT_CASES) assert.equal(crossLingualScript(c.text), c.nonLatin ? c.script : null, c.text);
  }
});

test('XL_ALL_SCRIPTS=off: a Korean query is searched in Korean only (the rule before 2026-10-24)', async () => {
  process.env.XL_ALL_SCRIPTS = 'off';
  fake.translation = 'save video';
  fake.adaptive = () => tenRows();
  fake.rerank = rankBy(['a1']);
  await searchKnowledge({ query: '영상 저장', limit: 2 }, USER);
  assert.deepEqual(callsTo('/rest/v1/rpc/adaptive_search').map(c => c.body.search_query), ['영상 저장']);
});

test('XL_ALL_SCRIPTS on (default): a Korean query also runs in English, phrase recall and re-rank on the English text', async () => {
  const ko = Array.from({ length: 10 }, (_, i) => row(`k${i}`, 0.9 - i / 100));
  const en = Array.from({ length: 12 }, (_, i) => row(`e${i}`, 0.5 - i / 100));
  fake.translation = 'iPhone review';
  fake.adaptive = (q) => (q === 'iPhone review' ? en : ko);
  fake.phrases = [];
  fake.rerank = rankBy(['e2', 'k1']);
  const res = await searchKnowledge({ query: 'iPhone 리뷰', limit: 2 }, USER);
  assert.deepEqual(callsTo('/rest/v1/rpc/adaptive_search').map(c => c.body.search_query), ['iPhone 리뷰', 'iPhone review']);
  const ph = callsTo('/rest/v1/rpc/search_item_phrases');
  assert.equal(ph.length, 1);
  assert.deepEqual(ph[0].body.query_embedding, embed('iPhone review'));
  assert.equal(callsTo('/functions/v1/jev-rerank')[0].body.query, 'iPhone review');
  assert.deepEqual(ids(res), ['e2', 'k1']);
});

test('a 2-syllable Korean query reaches the hybrid path only with XL_ALL_SCRIPTS on', async () => {
  process.env.XL_ALL_SCRIPTS = 'off';
  fake.translation = 'video';
  fake.adaptive = () => tenRows();
  fake.items = [row('k1', 0)];
  fake.rerank = rankBy(['a1']);
  await searchKnowledge({ query: '영상', limit: 2 }, USER);
  assert.equal(callsTo('/rest/v1/rpc/adaptive_search').length, 0);       // off: keyword fallback, as before
  fake.calls = [];
  delete process.env.XL_ALL_SCRIPTS;
  await searchKnowledge({ query: '영상', limit: 2 }, USER);
  assert.deepEqual(callsTo('/rest/v1/rpc/adaptive_search').map(c => c.body.search_query), ['영상', 'video']);
});

test('an English query takes exactly the same path with XL_ALL_SCRIPTS off and on', async () => {
  for (const flag of ['off', undefined]) {
    if (flag) process.env.XL_ALL_SCRIPTS = flag; else delete process.env.XL_ALL_SCRIPTS;
    fake.calls = [];
    fake.translation = 'should not be used';
    fake.adaptive = () => tenRows();
    fake.rerank = rankBy(['a3']);
    const res = await searchKnowledge({ query: 'naïve résumé tips from the café video', limit: 2 }, USER);
    assert.equal(callsTo('/rest/v1/rpc/adaptive_search').length, 1);
    assert.equal(fake.calls.filter(c => c.url.includes('/chat/completions')).length, 0);
    assert.deepEqual(ids(res), ['a3', 'a0']);
  }
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

const SEG = '/rest/v1/rpc/search_segments_core';

test('timed results carry moments from the segment search (scoped per item); other rows have none', async () => {
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
  assert.equal('moments' in data[1], false);   // web row: no timed segments, no field
  assert.equal('moments' in data[2], false);   // video without matching segments: no field
  const seg = callsTo(SEG);
  assert.deepEqual(seg.filter(c => c.body.p_item_ids).map(c => c.body.p_item_ids).sort(), [['v1'], ['v2'], ['w1']]);   // every result is asked for passages
  assert.ok(seg.every(c => c.body.p_user_id === USER && c.body.p_mode === 'rrf'));
  assert.match(res.content[0].text, /watch\?v=abcDEF12345&t=754s/);
});

test('every result carries passages: articles too, with position, and timed ones with t and url', async () => {
  fake.adaptive = () => [
    row('w1', 0.9, { url: 'https://example.com/essay' } as any),
    row('v1', 0.8, { source_type: 'youtube', url: 'https://www.youtube.com/watch?v=abcDEF12345' } as any),
    row('n1', 0.7, { source_type: 'note' }),
  ];
  fake.segments = {
    w1: [
      { segment_id: 's-w1-b', item_id: 'w1', segment_text: 'Reach the   frontier of knowledge and notice the gaps.', start_time_sec: null, combined_score: 0.5 },
      { segment_id: 's-w1-a', item_id: 'w1', segment_text: 'Pick a field that matches your aptitude.', start_time_sec: null, combined_score: 0.2 },   // no score floor for passages
      { segment_id: 's-w1-a', item_id: 'w1', segment_text: 'Pick a field that matches your aptitude.', start_time_sec: null, combined_score: 0.2 },   // duplicate row
      { segment_id: 's-w1-e', item_id: 'w1', segment_text: '   ', start_time_sec: null, combined_score: 0.2 },                                        // empty
    ],
    v1: [{ segment_id: 's-v1-a', item_id: 'v1', segment_text: 'memory is the agent state', start_time_sec: '754.6', combined_score: 0.62 }],
  };
  fake.segmentIndex = [{ id: 's-w1-b', segment_index: 7 }, { id: 's-w1-a', segment_index: 2 }, { id: 's-v1-a', segment_index: 31 }];
  const res = await searchKnowledge({ query: 'frontier of knowledge', limit: 3 }, USER);
  const data = (res.structuredContent as any).data as Array<any>;
  assert.deepEqual(data[0].passages, [
    { text: 'Reach the frontier of knowledge and notice the gaps.', n: 7 },
    { text: 'Pick a field that matches your aptitude.', n: 2 },
  ]);
  assert.equal('moments' in data[0], false);
  assert.deepEqual(data[1].passages, [{ text: 'memory is the agent state', n: 31, t: 754, url: 'https://www.youtube.com/watch?v=abcDEF12345&t=754s' }]);
  assert.equal(data[1].moments.length, 1);
  assert.equal('passages' in data[2], false);   // an item with no segments: no field
  // one lookup for the positions, one for the neighbours of the short picks
  assert.equal(callsTo('/rest/v1/transcript_segments').length, 2);
});

test('passages: the top 3 results get up to 4, later ones 2; long text is cut at a word boundary', async () => {
  fake.adaptive = () => Array.from({ length: 5 }, (_, i) => row(`a${i}`, 1 - i / 100));
  const many = (id: string) => Array.from({ length: 6 }, (_, k) => ({ segment_id: `${id}-${k}`, item_id: id, segment_text: `passage ${k} ${'word '.repeat(k === 0 ? 400 : 3)}`, start_time_sec: null, combined_score: 0.5 }));
  fake.segments = Object.fromEntries(['a0', 'a1', 'a2', 'a3', 'a4'].map(id => [id, many(id)]));
  const res = await searchKnowledge({ query: 'agent memory design', limit: 5 }, USER);
  const data = (res.structuredContent as any).data as Array<any>;
  assert.deepEqual(data.map(r => r.passages.length), [4, 4, 4, 2, 2]);
  assert.ok(data[0].passages[0].text.length <= 701 && data[0].passages[0].text.endsWith('…'));
});

test('passages fall back to search_segments when the core RPC is missing; each kill switch works alone', async () => {
  fake.adaptive = () => [row('v1', 0.9, { source_type: 'youtube', url: 'https://www.youtube.com/watch?v=abcDEF12345' } as any), row('w1', 0.8)];
  fake.segments = {
    v1: [{ segment_id: 's1', item_id: 'v1', segment_text: 'memory is the agent state', start_time_sec: '754.6', combined_score: 0.62 }],
    w1: [{ segment_id: 's2', item_id: 'w1', segment_text: 'an article passage', start_time_sec: null, combined_score: 0.4 }],
  };
  fake.coreFails = true;
  let res = await searchKnowledge({ query: 'agent memory design', limit: 2 }, USER);
  let data = (res.structuredContent as any).data as Array<any>;
  assert.equal(data[0].passages[0].text, 'memory is the agent state');
  assert.equal(data[1].passages[0].text, 'an article passage');
  assert.equal(callsTo('/rest/v1/rpc/search_segments').length, 2);
  fake.coreFails = false;
  process.env.SEARCH_PASSAGES = 'off';
  try {
    fake.calls = [];
    res = await searchKnowledge({ query: 'agent memory design two', limit: 2 }, USER);
    data = (res.structuredContent as any).data as Array<any>;
    assert.equal('passages' in data[0], false);
    assert.equal(data[0].moments.length, 1);
    assert.deepEqual(callsTo(SEG).filter(c => c.body.p_item_ids).map(c => c.body.p_item_ids), [['v1']]);   // only the timed row is asked
    process.env.SEARCH_MOMENTS = 'off';
    fake.calls = [];
    await searchKnowledge({ query: 'agent memory design three', limit: 2 }, USER);
    assert.equal(callsTo(SEG).filter(c => c.body.p_item_ids).length, 0);
  } finally { delete process.env.SEARCH_PASSAGES; delete process.env.SEARCH_MOMENTS; }
});

test('moments fail open: unusable segment rows add no field; SEARCH_MOMENTS=off keeps passages only', async () => {
  fake.adaptive = () => [row('v1', 0.9, { source_type: 'youtube', url: 'https://www.youtube.com/watch?v=abcDEF12345' } as any)];
  fake.segments = { v1: [{ item_id: 'v1', segment_text: 'x', start_time_sec: 'not-a-number', combined_score: 0.9 }] };
  let res = await searchKnowledge({ query: 'agent memory design', limit: 1 }, USER);
  assert.equal('moments' in (res.structuredContent as any).data[0], false);
  assert.deepEqual((res.structuredContent as any).data[0].passages, [{ text: 'x' }]);   // the text is still a passage, without a time
  process.env.SEARCH_MOMENTS = 'off';
  try {
    res = await searchKnowledge({ query: 'agent memory design two', limit: 1 }, USER);
    assert.equal('moments' in (res.structuredContent as any).data[0], false);
  } finally { delete process.env.SEARCH_MOMENTS; }
});

test('segment recall: an item found only through its transcript joins the pool, is judged on that passage and can win', async () => {
  fake.adaptive = () => tenRows();
  fake.recall = [
    { item_id: 'g1', segment_text: 'they rewrite the old   games in Rust on the Bevy engine' },
    { item_id: 'g1', segment_text: 'a second segment of the same item' },
    { item_id: 'a3', segment_text: 'a3 also has a matching passage' },
  ];
  fake.items = [row('g1', 0, { strategy: 'segment_recall' })];
  fake.rerank = rankBy(['g1', 'a3']);
  const res = await searchKnowledge({ query: 'Bevy', limit: 3 }, USER);
  assert.deepEqual(ids(res).slice(0, 2), ['g1', 'a3']);
  assert.equal((res.structuredContent as any).data[0].match_type, 'segment_recall');
  const recall = callsTo(SEG).filter(c => !c.body.p_item_ids);
  assert.equal(recall.length, 1);
  assert.equal(recall[0].body.p_user_id, USER);
  assert.equal(recall[0].body.p_mode, 'rrf');
  // the re-ranker sees the matching passage in front of the summary, for the new row and for a3; other rows are unchanged
  const sent = callsTo('/functions/v1/jev-rerank')[0].body.passages as Array<{ id: string; text: string }>;
  assert.equal(sent.find(x => x.id === 'g1')!.text, 'they rewrite the old games in Rust on the Bevy engine\nsummary g1');
  assert.equal(sent.find(x => x.id === 'a3')!.text, 'a3 also has a matching passage\nsummary a3');
  assert.equal(sent.find(x => x.id === 'a0')!.text, 'summary a0');
  // hydration is owner-scoped
  assert.ok(callsTo('/rest/v1/items').every(c => c.url.includes(`user_id=eq.${USER}`)));
});

test('segment recall fails open and has its own kill switch', async () => {
  fake.adaptive = () => tenRows();
  fake.recall = [{ item_id: 'g1', segment_text: 'only in the transcript' }];
  fake.items = [row('g1', 0, { strategy: 'segment_recall' })];
  fake.rerank = 'fail';
  let res = await searchKnowledge({ query: 'Bevy engine rewrite', limit: 12 }, USER);
  assert.equal(ids(res).includes('g1'), false);            // never returned unscored
  process.env.SEGMENT_RECALL = 'off';
  fake.calls = [];
  fake.rerank = rankBy(['g1']);
  res = await searchKnowledge({ query: 'Bevy engine rewrite two', limit: 3 }, USER);
  assert.equal(callsTo(SEG).filter(c => !c.body.p_item_ids).length, 0);
  assert.equal(ids(res).includes('g1'), false);
  delete process.env.SEGMENT_RECALL;
  process.env.JEV_RERANK = 'off';
  fake.calls = [];
  await searchKnowledge({ query: 'Bevy engine rewrite three', limit: 3 }, USER);
  assert.equal(callsTo(SEG).filter(c => !c.body.p_item_ids).length, 0);   // inert without the re-ranker
});

test('passages take turns from the fused and the rrf order; moments keep the fused order', async () => {
  fake.adaptive = () => [row('v1', 0.9, { source_type: 'youtube', url: 'https://www.youtube.com/watch?v=abcDEF12345' } as any)];
  const long = (t: string) => `${t} ${'word '.repeat(60)}`.trim();
  // returned in rrf order; combined_score is the fused score
  fake.segments = { v1: [
    { segment_id: 'r1', item_id: 'v1', segment_text: long('rrf one'), start_time_sec: 100, combined_score: 0.40 },
    { segment_id: 'r2', item_id: 'v1', segment_text: long('rrf two'), start_time_sec: 200, combined_score: 0.70 },
    { segment_id: 'r3', item_id: 'v1', segment_text: long('rrf three'), start_time_sec: 300, combined_score: 0.35 },
    { segment_id: 'r4', item_id: 'v1', segment_text: long('rrf four'), start_time_sec: 400, combined_score: 0.60 },
    { segment_id: 'r5', item_id: 'v1', segment_text: long('rrf five'), start_time_sec: 500, combined_score: 0.31 },
  ] };
  const res = await searchKnowledge({ query: 'agent memory design', limit: 1 }, USER);
  const d = (res.structuredContent as any).data[0];
  // fused order: r2 r4 r1 r3 r5; rrf order: r1 r2 r3 r4 r5 -> r2, r1, r4, r3
  assert.deepEqual(d.passages.map((x: any) => x.t), [200, 100, 400, 300]);
  assert.deepEqual(d.moments.map((x: any) => x.t), [200, 400, 100]);
});

test('a short pick is joined with its neighbours into one passage; a pick inside it is not repeated', async () => {
  fake.adaptive = () => [row('w1', 0.9, { url: 'https://example.com/guide' } as any)];
  fake.segments = { w1: [
    { segment_id: 's29', item_id: 'w1', segment_text: 'AI Mode). Is', start_time_sec: null, combined_score: 0.5 },
    { segment_id: 's30', item_id: 'w1', segment_text: 'SEO still relevant for generative AI search? In short, yes!', start_time_sec: null, combined_score: 0.45 },
    { segment_id: 's02', item_id: 'w1', segment_text: `A long standalone passage. ${'word '.repeat(60)}`, start_time_sec: null, combined_score: 0.4 },
  ] };
  fake.segmentIndex = [{ id: 's29', segment_index: 29 }, { id: 's30', segment_index: 30 }, { id: 's02', segment_index: 2 }];
  fake.neighbours = [
    { item_id: 'w1', segment_index: 28, text: 'AI Overviews and', start_time_sec: null },
    { item_id: 'w1', segment_index: 29, text: 'AI Mode). Is', start_time_sec: null },
    { item_id: 'w1', segment_index: 30, text: 'SEO still relevant for generative AI search? In short, yes!', start_time_sec: null },
    { item_id: 'w1', segment_index: 31, text: `The same best practices apply. ${'more '.repeat(60)}`, start_time_sec: null },
    { item_id: 'other', segment_index: 30, text: 'a segment of another item at the same position', start_time_sec: null },
  ];
  const res = await searchKnowledge({ query: 'is seo still relevant', limit: 1 }, USER);
  const passages = (res.structuredContent as any).data[0].passages as Array<{ text: string; n: number }>;
  assert.equal(passages.length, 2);
  assert.equal(passages[0].n, 28);
  assert.match(passages[0].text, /^AI Overviews and AI Mode\)\. Is SEO still relevant for generative AI search\? In short, yes! The same best practices apply\./);
  assert.equal(passages[0].text.includes('another item'), false);
  assert.equal(passages[1].n, 2);                           // s30 is inside the first passage and is not returned again
  const nb = callsTo('/rest/v1/transcript_segments').find(c => c.url.includes('item_id='))!;
  assert.ok(nb.url.includes('item_id=in.%28w1%29') || nb.url.includes('item_id=in.(w1)'));
});

test('a result with no segments gets a passage cut from its own stored text', async () => {
  fake.adaptive = () => [row('n1', 0.9, { source_type: 'note' }), row('n2', 0.8, { source_type: 'instagram' }), row('n3', 0.7)];
  const long = `${'filler words here. '.repeat(40)}The launch is planned for the ninth of March in Sofia. ${'more filler text. '.repeat(40)}`;
  fake.texts = [{ id: 'n1', full_transcript: 'A short note about agent memory.', description: null }, { id: 'n2', full_transcript: null, description: long }];
  const res = await searchKnowledge({ query: 'when is the launch planned in Sofia', limit: 3 }, USER);
  const data = (res.structuredContent as any).data as Array<any>;
  assert.deepEqual(data[0].passages, [{ text: 'A short note about agent memory.' }]);
  assert.equal(data[1].passages.length, 1);
  assert.match(data[1].passages[0].text, /ninth of March in Sofia/);
  assert.equal('passages' in data[2], false);        // nothing stored: no field
  const lookup = callsTo('/rest/v1/items').filter(c => c.url.includes('full_transcript'));
  assert.equal(lookup.length, 1);
  assert.ok(lookup[0].url.includes(`user_id=eq.${USER}`));
});

test('item_id searches inside one item: its passages for the query, owner-scoped, no library search', async () => {
  fake.oneItem = [{ id: 'v1', video_id: 'abcDEF12345', title: 'Long talk', url: 'https://www.youtube.com/watch?v=abcDEF12345', source_type: 'youtube', summary: 'S', tags: null, taint_level: 1, provenance: 'third_party' }];
  const long = (t: string) => `${t} ${'word '.repeat(60)}`.trim();
  fake.segments = { v1: Array.from({ length: 9 }, (_, k) => ({ segment_id: `s${k}`, item_id: 'v1', segment_text: long(`passage ${k}`), start_time_sec: k * 100, combined_score: 0.9 - k / 20 })) };
  fake.segmentIndex = Array.from({ length: 9 }, (_, k) => ({ id: `s${k}`, segment_index: k * 3 }));
  const res = await searchKnowledge({ query: 'where does he talk about memory', limit: 6, item_id: 'abcDEF12345' }, USER);
  const data = (res.structuredContent as any).data as Array<any>;
  assert.equal(data.length, 1);
  assert.equal(data[0].id, 'v1');
  assert.equal(data[0].match_type, 'in_item');
  assert.equal(data[0].provenance, 'third_party');
  assert.equal(data[0].passages.length, 6);                              // `limit` passages
  assert.deepEqual(data[0].passages[0].n, 0);
  assert.equal((res.structuredContent as any).confidence, undefined);
  assert.equal(callsTo('/rest/v1/rpc/adaptive_search').length, 0);
  assert.equal(callsTo('/functions/v1/jev-rerank').length, 0);
  const lookup = callsTo('/rest/v1/items')[0].url;
  assert.ok(lookup.includes(`user_id=eq.${USER}`) && lookup.includes('video_id=eq.abcDEF12345'));
  assert.deepEqual(callsTo(SEG).map(c => c.body.p_item_ids), [['v1']]);
});

test('item_id that is not the caller\'s item is refused with what to pass', async () => {
  fake.oneItem = [];
  await assert.rejects(
    searchKnowledge({ query: 'anything at all', limit: 5, item_id: '00000000-0000-4000-8000-00000000dead' }, USER),
    /No saved item with id "00000000-0000-4000-8000-00000000dead"\. Use an id returned by search/,
  );
});

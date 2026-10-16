import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = ['fixture', 'openai', 'key'].join('-');

const { TtlCache, normaliseQuery, hashKey, cacheStats, clearCaches } = await import('./ttl-cache.js');
const { generateEmbedding, translateQueryToEnglish } = await import('./openai.js');

test('hit after set, miss for unknown keys; counters and hit rate follow', () => {
  const c = new TtlCache<number>(10, 1000);
  assert.equal(c.get('a'), undefined);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('a'), 1);
  assert.deepEqual(c.stats(), { size: 1, max: 10, ttl_s: 1, hits: 2, misses: 1, hit_rate: 0.667 });
});

test('entries expire after the TTL', () => {
  let now = 0;
  const c = new TtlCache<string>(10, 1000, () => now);
  c.set('k', 'v');
  now = 999;
  assert.equal(c.get('k'), 'v');
  now = 1000;
  assert.equal(c.get('k'), undefined);
  assert.equal(c.size, 0);
});

test('size is bounded and the least recently used entry goes first', () => {
  const c = new TtlCache<number>(2, 60_000);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');           // a is now the most recently used
  c.set('c', 3);        // evicts b
  assert.equal(c.size, 2);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
});

test('getOrCompute computes once, never stores errors or null', async () => {
  const c = new TtlCache<string | null>(10, 60_000);
  let calls = 0;
  const ok = async () => { calls++; return 'x'; };
  assert.equal(await c.getOrCompute('k', ok), 'x');
  assert.equal(await c.getOrCompute('k', ok), 'x');
  assert.equal(calls, 1);

  await assert.rejects(c.getOrCompute('e', async () => { throw new Error('boom'); }));
  assert.equal(await c.getOrCompute('e', ok), 'x');   // the error was not cached
  assert.equal(calls, 2);

  let nulls = 0;
  const fail = async () => { nulls++; return null; };
  assert.equal(await c.getOrCompute('n', fail), null);
  assert.equal(await c.getOrCompute('n', fail), null);
  assert.equal(nulls, 2);
});

test('QUERY_CACHE=off bypasses the cache', async () => {
  const c = new TtlCache<number>(10, 60_000);
  let calls = 0;
  process.env.QUERY_CACHE = 'off';
  try {
    await c.getOrCompute('k', async () => ++calls);
    await c.getOrCompute('k', async () => ++calls);
  } finally { delete process.env.QUERY_CACHE; }
  assert.equal(calls, 2);
  assert.equal(c.size, 0);
});

test('normaliseQuery collapses whitespace and keeps case; hashKey separates parts', () => {
  assert.equal(normaliseQuery('  agent\n memory\tdesign '), 'agent memory design');
  assert.equal(normaliseQuery('Agent'), 'Agent');
  assert.notEqual(hashKey('ab', 'c'), hashKey('a', 'bc'));
});

// ── OpenAI wrappers: only the network is faked ────────────────────────────────
const realFetch = globalThis.fetch;
let embedCalls = 0;
let chatCalls = 0;
let translationUp = true;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  clearCaches();
  embedCalls = 0; chatCalls = 0; translationUp = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname.endsWith('/embeddings')) {
      embedCalls++;
      return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [String(body.input).length, body.dimensions ?? 0] }], model: body.model });
    }
    chatCalls++;
    if (!translationUp) return json({ error: { message: 'down' } }, 500);
    return json({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'memory' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('generateEmbedding: a repeated query is served from the cache; always 3-large @1536', async () => {
  const a = await generateEmbedding('agent memory');
  const b = await generateEmbedding('  agent   memory ');
  assert.deepEqual(a, b);
  assert.equal(embedCalls, 1);
  assert.equal(a[1], 1536);                            // the fake echoes the requested dimensions
  assert.equal(cacheStats().embedding.hits, 1);
});

test('generateEmbedding: long texts (item bodies) are not cached', async () => {
  const long = 'x'.repeat(5000);
  await generateEmbedding(long);
  await generateEmbedding(long);
  assert.equal(embedCalls, 2);
  assert.equal(cacheStats().embedding.size, 0);
});

test('translateQueryToEnglish: cached on success, failure is retried', async () => {
  translationUp = false;
  assert.equal(await translateQueryToEnglish('памет'), null);
  translationUp = true;
  assert.equal(await translateQueryToEnglish('памет'), 'memory');
  assert.equal(await translateQueryToEnglish('памет'), 'memory');
  assert.equal(chatCalls, 2);
  assert.equal(cacheStats().translation.hits, 1);
});

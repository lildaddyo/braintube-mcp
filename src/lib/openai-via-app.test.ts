import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// D-211: embeddings and translation go through the app's mcp-ai edge function, not OpenAI.
process.env.SUPABASE_URL = 'https://fixture.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = ['fixture', 'service', 'key'].join('-');
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_VIA_APP;

const { generateEmbedding, generateEmbeddings, translateQueryToEnglish, viaApp, EMBED_DIMS } = await import('./openai.js');
const { withUsageContext } = await import('./usage-log.js');
const { clearCaches } = await import('./ttl-cache.js');

const realFetch = globalThis.fetch;
let calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
let upstreamFails = false;

beforeEach(() => {
  calls = [];
  upstreamFails = false;
  clearCaches();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    if (url.includes('api.openai.com')) throw new Error('must not call OpenAI directly');
    if (upstreamFails) return new Response(JSON.stringify({ error: 'embeddings 429' }), { status: 502 });
    if (body.mode === 'embed') {
      const texts = body.texts as string[];
      return Response.json({ model: 'text-embedding-3-large', dimensions: EMBED_DIMS, embeddings: texts.map((_, i) => new Array(EMBED_DIMS).fill(i)) });
    }
    return Response.json({ text: 'memory' });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

test('on by default when the Supabase service env is present', () => {
  assert.equal(viaApp(), true);
});

test('query embedding asks mcp-ai, pinned to eu-west-1, with the caller attribution', async () => {
  const v = await withUsageContext({ tool: 'search_knowledge', userId: '160e3096-07f2-45ea-9371-2f438e2af686' }, () => generateEmbedding('model context protocol'));
  assert.equal(v.length, EMBED_DIMS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://fixture.supabase.co/functions/v1/mcp-ai?forceFunctionRegion=eu-west-1');
  assert.equal(calls[0].auth, `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.deepEqual(calls[0].body, { mode: 'embed', texts: ['model context protocol'], tool: 'search_knowledge', user_id: '160e3096-07f2-45ea-9371-2f438e2af686' });
});

test('batches over 100 texts are split and kept in order', async () => {
  const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
  const out = await generateEmbeddings(texts);
  assert.equal(out.length, 150);
  assert.equal(calls.length, 2);
  assert.equal((calls[0].body.texts as string[]).length, 100);
  assert.equal((calls[1].body.texts as string[]).length, 50);
  assert.equal(out[100][0], 0); // first vector of the second batch
});

test('an upstream failure throws, so search falls back to keyword like before', async () => {
  upstreamFails = true;
  await assert.rejects(generateEmbedding('anything else'), /mcp-ai 502/);
});

test('translation goes through mcp-ai; a failure returns null', async () => {
  assert.equal(await translateQueryToEnglish('기억'), 'memory');
  assert.equal(calls[0].body.mode, 'translate');
  upstreamFails = true;
  assert.equal(await translateQueryToEnglish('다른 질문'), null);
});

test('OPENAI_VIA_APP=off restores the direct path', () => {
  process.env.OPENAI_VIA_APP = 'off';
  try { assert.equal(viaApp(), false); } finally { delete process.env.OPENAI_VIA_APP; }
});

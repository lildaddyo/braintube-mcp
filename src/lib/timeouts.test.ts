import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Fixture values only; assembled so they never look like real credentials.
process.env.OPENAI_API_KEY = ['fixture', 'openai', 'key'].join('-');
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY ??= ['fixture', 'anon'].join('-');
process.env.SUPABASE_SERVICE_ROLE_KEY ??= ['fixture', 'service'].join('-');
process.env.ANTHROPIC_API_KEY ??= ['fixture', 'anthropic'].join('-');

const { TIMEOUTS } = await import('./timeouts.js');
const { embeddingClient } = await import('./openai.js');
const { getAuthContext } = await import('../auth/jwt.js');
const { summariseConversation } = await import('../tools/summarise.js');
const { connectReadwise, syncReadwise } = await import('../tools/readwise.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replaces fetch with one that records each call's init and answers `respond()`. */
function captureFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return calls;
}

function assertLiveSignal(init: RequestInit | undefined, label: string) {
  assert.ok(init?.signal instanceof AbortSignal, `${label}: fetch got an AbortSignal`);
  assert.equal(init.signal.aborted, false, `${label}: signal not aborted up front`);
}

test('budgets are bounded and sit above normal latency', () => {
  assert.equal(TIMEOUTS.openAiMaxRetries, 1);
  assert.ok(TIMEOUTS.openAiEmbedMs >= 10_000 && TIMEOUTS.openAiEmbedMs <= 30_000);
  assert.ok(TIMEOUTS.brainChatMs >= 45_000, 'brain-chat p95 is ~17 s; leave plenty of headroom');
  for (const [k, v] of Object.entries(TIMEOUTS)) {
    if (k.endsWith('Ms')) assert.ok(v > 0 && v <= 150_000, `${k} bounded`);
  }
});

test('embedding client: 15 s and 1 retry instead of the SDK default 600 s x 2', () => {
  const c = embeddingClient();
  assert.equal(c.timeout, TIMEOUTS.openAiEmbedMs);
  assert.equal(c.maxRetries, 1);
  assert.equal(embeddingClient(TIMEOUTS.openAiEmbedBatchMs).timeout, 30_000);
});

test('JWT validation passes a timeout signal to GoTrue, and a timeout fails closed (401 path, no throw)', async () => {
  const calls = captureFetch(() => new Response(JSON.stringify({ id: 'user-1234567890' }), { status: 200 }));
  const req = { headers: { authorization: 'Bearer header.payload.sig' } } as never;
  const ok = await getAuthContext(req);
  assert.equal(ok?.userId, 'user-1234567890');
  assert.match(calls[0].url, /\/auth\/v1\/user$/);
  assertLiveSignal(calls[0].init, 'auth/v1/user');

  globalThis.fetch = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
  assert.equal(await getAuthContext(req), null);
});

test('Anthropic summary call carries a timeout signal', async () => {
  const calls = captureFetch(() => new Response(JSON.stringify({ content: [{ text: '**Title**: T\nbody' }] }), { status: 200 }));
  const out = await summariseConversation('x'.repeat(100), 'claude');
  assert.equal(out.title, 'T');
  assertLiveSignal(calls[0].init, 'anthropic');
});

test('readwise connect and sync carry timeout signals', async () => {
  const calls = captureFetch(() => new Response('{}', { status: 200 }));
  await connectReadwise({ access_token: 'r'.repeat(24) }, 'user-1');
  await syncReadwise({ mode: 'incremental' }, 'user-1');
  assert.equal(calls.length, 2);
  assertLiveSignal(calls[0].init, 'readwise connect');
  assertLiveSignal(calls[1].init, 'readwise sync');
});

test('a timed-out readwise call surfaces as a tool error, not a hang', async () => {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    // Behaves like a hung upstream: settles only when the caller's signal fires.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const ac = new AbortController();
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => ac.signal; // fire the "timeout" on demand
  try {
    const p = connectReadwise({ access_token: 'r'.repeat(24) }, 'user-1');
    ac.abort(new DOMException('timed out', 'TimeoutError'));
    await assert.rejects(p, /timed out/);
  } finally {
    AbortSignal.timeout = origTimeout;
  }
});

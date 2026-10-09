import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { brainAccessError, brainChatHeaders, chatWithBrain } = await import('./brain-chat.js');

const USER = '11111111-2222-3333-4444-555555555555';

test('brain-chat headers carry the service key, the acting user and the counted marker', () => {
  const h = brainChatHeaders(USER);
  assert.equal(h.Authorization, `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.equal(h['x-bt-acting-user'], USER);
  assert.equal(h['x-bt-fair-use'], 'counted');
  assert.equal(h['Content-Type'], 'application/json');
});

test('without a service key the call stays anonymous (no acting-user header to forge)', () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.deepEqual(brainChatHeaders(USER), { 'Content-Type': 'application/json' });
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test('brainAccessError refuses, before any charge, exactly what brain-chat would refuse', () => {
  const OTHER = '99999999-8888-7777-6666-555555555555';
  assert.match(brainAccessError(null, 'nope', USER)!, /not found/);
  assert.match(brainAccessError({ user_id: OTHER, is_public: false }, 'theirs', USER)!, /private/);
  assert.equal(brainAccessError({ user_id: USER, is_public: false }, 'mine', USER), null);
  assert.equal(brainAccessError({ user_id: OTHER, is_public: true }, 'public', USER), null);
});

test('chatWithBrain sends the acting-user headers to brain-chat', async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/functions/v1/brain-chat')) {
      calls.push({ url: u, init });
      return new Response(JSON.stringify({ answer: 'hi', sources: [{ title: 'A' }], session_id: 's1' }), { status: 200 });
    }
    return new Response('[]', { status: 200 }); // retrieval_log insert
  }) as typeof fetch;
  try {
    const out = await chatWithBrain({ brain_slug: 'me', question: 'q', chat_history: [] }, USER);
    assert.equal(calls.length, 1);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers['x-bt-acting-user'], USER);
    assert.equal(headers['x-bt-fair-use'], 'counted');
    assert.match(out.content[0].text, /^hi\n\nSources:\n1\. A/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

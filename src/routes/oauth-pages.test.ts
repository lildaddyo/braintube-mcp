import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';

const { loginForm, errorPage } = await import('./oauth.js');

// The OAuth pages follow the brand canon (bt-brand-canon §1–§2). These pin the
// values that drifted before: an orange "Tube", flat grey surfaces and a flat
// violet button that matched nothing on brain-tube.com.

test('login page uses the canon palette and type roles', () => {
  const html = loginForm('s1');
  for (const token of ['#f5f0ff', '#a78bfa', '#8b5cf6 0%, #6d28d9 100%', '#6D4DE6 0%, #9F4DBF 60%, #BD6FA3 100%', 'Fraunces', 'Space Grotesk']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
  for (const stale of ['#FF6B1A', '#866CEF', '#0a0a0a', '#141414']) {
    assert.ok(!html.includes(stale), `stale value ${stale} still present`);
  }
});

test('OAuth pages load images only inline (helmet CSP img-src is self + data:)', () => {
  for (const html of [loginForm('s1'), errorPage('x')]) {
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0, 'logo missing');
    for (const src of srcs) assert.ok(src.startsWith('data:image/'), `external image ${src.slice(0, 40)}`);
  }
});

test('OAuth pages still escape state and messages', () => {
  assert.ok(!loginForm('"><script>x</script>').includes('<script>x'));
  assert.ok(!errorPage('<b>bad</b>').includes('<b>bad'));
  assert.ok(loginForm('s1', '<i>e</i>').includes('&lt;i&gt;e&lt;/i&gt;'));
});

// --- BTMCP-04: the login form names who is asking and where the code goes ---

test('loginForm shows the requesting client and redirect host, escaped, when given', () => {
  const html = loginForm('s1', undefined, { clientName: 'Evil <b>Co</b>', redirectHost: 'chatgpt.com' });
  assert.ok(html.includes('Evil &lt;b&gt;Co&lt;/b&gt;'));
  assert.ok(html.includes('<strong>chatgpt.com</strong>'));
  assert.ok(html.includes('Only continue if you started this connection yourself'));
  assert.ok(!loginForm('s1').includes('class="requester"'));
});

// --- ChatGPT compatibility (2026-10-16) ---

const { formActionCsp, appNameFor } = await import('./oauth.js');
const HELMET_CSP = "default-src 'self';base-uri 'self';form-action 'self';frame-ancestors 'self';upgrade-insecure-requests";

test('formActionCsp lets the login form redirect to the flow callback origin only', () => {
  assert.equal(
    formActionCsp(HELMET_CSP, 'https://chatgpt.com/connector/oauth/abc'),
    "default-src 'self';base-uri 'self';form-action 'self' https://chatgpt.com;frame-ancestors 'self';upgrade-insecure-requests",
  );
  assert.ok(formActionCsp(HELMET_CSP, 'https://claude.ai/api/mcp/auth_callback').includes("form-action 'self' https://claude.ai;"));
  assert.ok(formActionCsp(HELMET_CSP, 'http://127.0.0.1:4555/cb').includes("form-action 'self' http://127.0.0.1:4555;"));
  assert.equal(formActionCsp(HELMET_CSP, 'not a url'), HELMET_CSP);
});

test('login form names the app the code goes to', () => {
  assert.equal(appNameFor('chatgpt.com'), 'ChatGPT');
  assert.equal(appNameFor('claude.ai'), 'Claude');
  assert.equal(appNameFor('127.0.0.1:4555'), 'your AI app');
  assert.equal(appNameFor('evilchatgpt.com'), 'your AI app');
  const html = loginForm('s1', undefined, { clientName: 'ChatGPT', redirectHost: 'chatgpt.com' });
  assert.ok(html.includes('Connect to ChatGPT'));
  assert.ok(!html.includes('Connect to Claude'));
});

test('DCR honours token_endpoint_auth_method "none" (ChatGPT) and keeps client_secret_post otherwise', async () => {
  const express = (await import('express')).default;
  const { oauthRouter } = await import('./oauth.js');
  const app = express();
  app.use(express.json());
  app.use(oauthRouter);
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const reg = (body: unknown) => fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json() as Record<string, unknown> }));

    const pub = await reg({ redirect_uris: ['https://chatgpt.com/connector/oauth/cb1'], client_name: 'ChatGPT', token_endpoint_auth_method: 'none' });
    assert.equal(pub.status, 201);
    assert.equal(pub.json.token_endpoint_auth_method, 'none');
    assert.equal(pub.json.client_secret, undefined);

    const conf = await reg({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
    assert.equal(conf.status, 201);
    assert.equal(conf.json.token_endpoint_auth_method, 'client_secret_post');
    assert.equal(typeof conf.json.client_secret, 'string');

    const prm = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json()) as { resource: string };
    assert.ok(prm.resource.endsWith('/mcp'));
  } finally {
    server.close();
  }
});

// --- Apple sign-in (2026-10-30): accounts made with Sign in with Apple have no password ---

test('login page offers Apple next to Google, through the same start route', () => {
  const html = loginForm('s1');
  assert.ok(html.includes('href="/oauth/google/start?state=s1"'));
  assert.ok(html.includes('href="/oauth/google/start?state=s1&amp;provider=apple"'));
  assert.ok(html.includes('Continue with Apple'));
});

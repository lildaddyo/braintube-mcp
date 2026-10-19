import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';

const { isRedirectUriAllowed, isGoogleRelayRedirect } = await import('../auth/oauth-store.js');
const { clientIdFromBasic, relayRedirectPage, oauthRouter } = await import('./oauth.js');
const { isAllowedOrigin } = await import('../security/origin.js');

// Gemini app DCR registers all six relay callbacks at once and fails if one is refused.
const GEMINI_APP_CALLBACKS = ['oauth-redirect', 'oauth-redirect-sandbox', 'oauth-redirect-test'].flatMap((h) =>
  ['r', 'a'].map((k) => `https://${h}.googleusercontent.com/${k}/user_bound_custom-mcp-abc123-braintube`),
);

test('Gemini callbacks are allowlisted, look-alikes are not', () => {
  for (const uri of GEMINI_APP_CALLBACKS) assert.equal(isRedirectUriAllowed(uri), true, uri);
  assert.equal(isRedirectUriAllowed('https://vertexaisearch.cloud.google.com/oauth-redirect'), true);
  assert.equal(isRedirectUriAllowed('https://antigravity.google/oauth-callback'), true);
  assert.equal(isRedirectUriAllowed('http://localhost:53712/oauth/callback'), true); // Gemini CLI

  assert.equal(isRedirectUriAllowed('https://oauth-redirect.googleusercontent.com/r/other-thing'), false);
  assert.equal(isRedirectUriAllowed('https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-x/extra'), false);
  assert.equal(isRedirectUriAllowed('https://evil.googleusercontent.com/r/user_bound_custom-mcp-x'), false);
  assert.equal(isRedirectUriAllowed('https://vertexaisearch.cloud.google.com/oauth-redirect/x'), false);
  assert.equal(isRedirectUriAllowed('https://oauth-redirect.googleusercontent.com.evil.com/r/user_bound_custom-mcp-x'), false);
});

test('only the Google relay hosts finish sign-in with a meta refresh', () => {
  assert.equal(isGoogleRelayRedirect(GEMINI_APP_CALLBACKS[0]), true);
  assert.equal(isGoogleRelayRedirect(GEMINI_APP_CALLBACKS[3]), true);
  assert.equal(isGoogleRelayRedirect('https://claude.ai/api/mcp/auth_callback'), false);
  assert.equal(isGoogleRelayRedirect('https://vertexaisearch.cloud.google.com/oauth-redirect'), false);
  assert.equal(isGoogleRelayRedirect('not a url'), false);
});

test('relay page escapes the URL', () => {
  const html = relayRedirectPage('https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-x?code=a&state="><script>');
  assert.ok(html.includes('http-equiv="refresh"'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('code=a&amp;state=&quot;&gt;&lt;script&gt;'));
});

test('client id is read from a client_secret_basic header', () => {
  const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
  assert.equal(clientIdFromBasic(basic('bt_client_v2.abc:secret')), 'bt_client_v2.abc');
  assert.equal(clientIdFromBasic(basic('id%3Awith%3Acolon:secret')), 'id:with:colon');
  assert.equal(clientIdFromBasic('Bearer xyz'), undefined);
  assert.equal(clientIdFromBasic(undefined), undefined);
});

test('Gemini origins pass, other Google subdomains do not', () => {
  assert.equal(isAllowedOrigin('https://gemini.google.com'), true);
  assert.equal(isAllowedOrigin('https://vertexaisearch.cloud.google.com'), true);
  assert.equal(isAllowedOrigin('https://sites.google.com'), false);
  assert.equal(isAllowedOrigin('https://x.googleusercontent.com'), false);
});

test('DCR accepts the six Gemini callbacks and echoes client_secret_basic', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use(oauthRouter);
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: GEMINI_APP_CALLBACKS, client_name: 'Gemini', token_endpoint_auth_method: 'client_secret_basic' }),
    });
    const json = await r.json() as Record<string, unknown>;
    assert.equal(r.status, 201);
    assert.equal(json.token_endpoint_auth_method, 'client_secret_basic');
    assert.equal(typeof json.client_secret, 'string');
    assert.equal((json.redirect_uris as string[]).length, 6);

    const meta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`).then((x) => x.json()) as { token_endpoint_auth_methods_supported: string[] };
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['client_secret_post', 'client_secret_basic', 'none']);
  } finally {
    server.close();
  }
});

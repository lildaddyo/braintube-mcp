import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRedirectUriAllowed, verifyPkce } from './oauth-store.js';
import { createHash } from 'crypto';

test('rejects evil.com', () => {
  assert.equal(isRedirectUriAllowed('https://evil.com/cb'), false);
});

test('rejects arbitrary path on claude.ai (only the real callback path is allowed)', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai/cb'), false);
  assert.equal(isRedirectUriAllowed('https://claude.ai/evil'), false);
});

test('accepts claude.ai real callback path', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback'), true);
});

test('accepts claude.com real callback path (mirrors claude.ai)', () => {
  assert.equal(isRedirectUriAllowed('https://claude.com/api/mcp/auth_callback'), true);
});

test('rejects arbitrary path on claude.com', () => {
  assert.equal(isRedirectUriAllowed('https://claude.com/evil'), false);
});

test('rejects redirect_uri with userinfo or query/fragment smuggling', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai@evil.com/api/mcp/auth_callback'), false);
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback?x=1'), false);
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback#x'), false);
});

test('accepts subdomain *.claude.ai', () => {
  assert.equal(isRedirectUriAllowed('https://chat.claude.ai/cb'), true);
});

test('rejects host smuggling via path', () => {
  // The * → [^/]* substitution must prevent the host wildcard from
  // crossing a / and matching a different domain in the path.
  assert.equal(isRedirectUriAllowed('https://evil.com/?x=.claude.ai/cb'), false);
});

test('rejects sibling domain that just contains claude.ai', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai.evil.com/cb'), false);
});

test('accepts localhost with port and path', () => {
  assert.equal(isRedirectUriAllowed('http://localhost:3000/cb'), true);
});

test('rejects http on non-loopback host', () => {
  assert.equal(isRedirectUriAllowed('http://claude.ai/cb'), false);
});

test('verifyPkce rejects plain method even with matching verifier/challenge', () => {
  assert.equal(verifyPkce('secret', 'secret', 'plain'), false);
});

test('verifyPkce accepts a correct S256 verifier', () => {
  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(verifyPkce(verifier, challenge, 'S256'), true);
});

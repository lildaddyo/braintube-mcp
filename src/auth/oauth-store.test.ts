import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRedirectUriAllowed } from './oauth-store.js';

test('rejects evil.com', () => {
  assert.equal(isRedirectUriAllowed('https://evil.com/cb'), false);
});

test('accepts claude.ai/cb', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai/cb'), true);
});

test('accepts claude.ai nested callback path', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback'), true);
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

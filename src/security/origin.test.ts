import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, validateMcpOrigin } from './origin.js';

test('requests without an Origin header are allowed (server-to-server clients)', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), true);
});

test('Claude and BrainTube web origins are allowed', () => {
  for (const o of [
    'https://claude.ai', 'https://claude.com', 'https://www.claude.com', 'https://chat.claude.ai',
    'https://brain-tube.com', 'https://app.brain-tube.com',
  ]) {
    assert.equal(isAllowedOrigin(o), true, o);
  }
});

test('extensions, desktop apps and loopback tools (MCP Inspector) are allowed', () => {
  for (const o of [
    'chrome-extension://abcdefghijklmnop', 'moz-extension://x', 'vscode-file://vscode-app',
    'http://localhost:6274', 'http://127.0.0.1:3000', 'http://[::1]:8080',
  ]) {
    assert.equal(isAllowedOrigin(o), true, o);
  }
});

test('unknown and look-alike origins are rejected', () => {
  for (const o of [
    'https://evil.com', 'https://claude.ai.evil.com', 'https://evilclaude.ai', 'https://notbrain-tube.com',
    'http://claude.ai', 'https://claude.ai:8443', 'null', 'https://192.168.1.10', 'http://attacker.localhost.evil',
  ]) {
    assert.equal(isAllowedOrigin(o), false, o);
  }
});

test('middleware calls next for allowed origins and 403s the rest', () => {
  let nextCalled = 0;
  let status = 0;
  const res = { status(code: number) { status = code; return { json: () => undefined }; } };

  validateMcpOrigin({ headers: { origin: 'https://claude.ai' } }, res, () => { nextCalled++; });
  validateMcpOrigin({ headers: {} }, res, () => { nextCalled++; });
  assert.equal(nextCalled, 2);
  assert.equal(status, 0);

  validateMcpOrigin({ headers: { origin: 'https://evil.com' } }, res, () => { nextCalled++; });
  assert.equal(nextCalled, 2);
  assert.equal(status, 403);
});

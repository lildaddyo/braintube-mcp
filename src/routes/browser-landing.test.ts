import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { isBrowserNavigation, LANDING_HTML } from './browser-landing.js';

const req = (headers: Record<string, string>, over: Partial<Request> = {}) =>
  ({ method: 'GET', headers, query: {}, ...over }) as unknown as Request;

test('browser navigation gets the landing page', () => {
  assert.equal(isBrowserNavigation(req({ accept: 'text/html,application/xhtml+xml,*/*;q=0.8' })), true);
});

test('MCP clients are not intercepted', () => {
  assert.equal(isBrowserNavigation(req({ accept: 'text/event-stream' })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'application/json, text/event-stream' })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'text/html, text/event-stream' })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'text/html', authorization: 'Bearer x' })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'text/html', 'x-braintube-token': 'x' })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'text/html', 'mcp-session-id': 'x' })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'text/html' }, { query: { token: 'x' } as never })), false);
  assert.equal(isBrowserNavigation(req({ accept: 'text/html' }, { method: 'POST' })), false);
  assert.equal(isBrowserNavigation(req({})), false);
});

test('page names the endpoint and contains no forbidden copy', () => {
  assert.ok(LANDING_HTML.includes('https://mcp.brain-tube.com/mcp'));
  assert.ok(!/second brain|claude-powered/i.test(LANDING_HTML));
});

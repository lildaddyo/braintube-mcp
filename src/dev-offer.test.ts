import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Same isolation as tool-profiles.test.ts: audit writes go to a closed port.
process.env.SUPABASE_URL = 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { buildMcpServer } = await import('./server.js');
const { TOOL_ANNOTATIONS } = await import('./tool-annotations.js');
const { keyRowToAuth } = await import('./auth/jwt.js');
const { classifyClient, initializeClientName, restRouteLabel } = await import('./lib/client-id.js');
const { parseLimits, DEFAULT_LIMITS, limitsFor } = await import('./lib/plan-limits.js');
import type { AuthContext } from './types.js';
import type { ToolProfile } from './tool-profiles.js';

const USER = '00000000-0000-0000-0000-000000000000';

async function connect(auth: AuthContext, profile: ToolProfile) {
  const server = buildMcpServer(auth, 'authenticated', profile);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dev-offer-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function names(auth: AuthContext, profile: ToolProfile): Promise<string[]> {
  const s = await connect(auth, profile);
  try { return (await s.client.listTools()).tools.map((t) => t.name); } finally { await s.close(); }
}

test('read-scoped key lists only read-only tools; full key lists the write tools too', async () => {
  const full = await names({ userId: USER, authMethod: 'apikey', keyScope: 'full' }, 'full');
  const read = await names({ userId: USER, authMethod: 'apikey', keyScope: 'read' }, 'full');
  const writes = full.filter((n) => TOOL_ANNOTATIONS[n]?.readOnlyHint !== true);
  assert.ok(writes.length >= 10, `expected the write tools in the full list, got ${writes.length}`);
  assert.ok(read.length > 0);
  for (const n of read) assert.equal(TOOL_ANNOTATIONS[n]?.readOnlyHint, true, `${n} is not read-only`);
  assert.equal(read.length, full.length - writes.length);
  assert.ok(read.includes('search') && read.includes('fetch'));
});

test('no scope (OAuth / JWT) behaves like a full key', async () => {
  const oauth = await names({ userId: USER, authMethod: 'jwt' }, 'full');
  const full = await names({ userId: USER, authMethod: 'apikey', keyScope: 'full' }, 'full');
  assert.deepEqual(oauth, full);
});

test('read-scoped key cannot reach a write tool through the router', async () => {
  const s = await connect({ userId: USER, authMethod: 'apikey', keyScope: 'read' }, 'core');
  try {
    const listed = (await s.client.listTools()).tools.map((t) => t.name);
    if (!listed.includes('braintube_run_tool')) return; // router hidden: nothing to reach
    const res = await s.client.callTool({ name: 'braintube_run_tool', arguments: { name: 'add_note', args: { item_id: USER, note: 'x' } } });
    const text = JSON.stringify(res);
    assert.equal(res.isError, true);
    assert.match(text, /read-only/, text.slice(0, 300));
  } finally { await s.close(); }
});

test('keyRowToAuth: scope, expiry, missing rows', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  assert.equal(keyRowToAuth(null, now), null);
  assert.equal(keyRowToAuth({ id: 'k', user_id: USER, scope: 'full', expires_at: '2026-11-14T11:59:59Z' }, now), null);
  const ok = keyRowToAuth({ id: 'k', user_id: USER, scope: 'read', expires_at: '2026-12-01T00:00:00Z' }, now);
  assert.deepEqual(ok, { userId: USER, authMethod: 'apikey', apiKeyId: 'k', keyScope: 'read' });
  assert.equal(keyRowToAuth({ id: 'k', user_id: USER, scope: 'weird' }, now)?.keyScope, 'full');
  assert.equal(keyRowToAuth({ id: 'k', user_id: USER }, now)?.keyScope, 'full');
});

test('classifyClient maps clientInfo names and user agents', () => {
  assert.equal(classifyClient('claude-ai'), 'claude');
  assert.equal(classifyClient('claude-code'), 'claude-code');
  assert.equal(classifyClient('openai-mcp'), 'chatgpt');
  assert.equal(classifyClient('cursor-vscode'), 'cursor');
  assert.equal(classifyClient('Visual Studio Code'), 'vscode');
  assert.equal(classifyClient(undefined, 'curl/8.4.0'), 'script');
  assert.equal(classifyClient('my-own-agent'), 'other');
  assert.equal(classifyClient(undefined, undefined), 'unknown');
  assert.equal(initializeClientName({ jsonrpc: '2.0', method: 'initialize', params: { clientInfo: { name: 'Cursor' } } }), 'Cursor');
  assert.equal(initializeClientName([{ method: 'tools/list' }]), undefined);
});

test('restRouteLabel hides ids', () => {
  assert.equal(restRouteLabel('/related/3f2a1c4e-0000-4000-8000-123456789abc'), '/related/:id');
  assert.equal(restRouteLabel('/search'), '/search');
  assert.equal(restRouteLabel('/brain-chat/my-brain'), '/brain-chat/my-brain');
});

test('plan limits: defaults keep 60 / 15 min and no daily cap', async () => {
  assert.deepEqual(parseLimits(null), DEFAULT_LIMITS);
  assert.deepEqual(parseLimits({ tier: 'pro', per_15m: 60, per_day: null }), { tier: 'pro', per15m: 60, perDay: null });
  assert.deepEqual(parseLimits({ tier: 'developer', per_15m: 600, per_day: 10000 }), { tier: 'developer', per15m: 600, perDay: 10000 });
  assert.deepEqual(parseLimits({ tier: 'x', per_15m: -1, per_day: 0 }), { tier: 'x', per15m: 60, perDay: null });
  assert.deepEqual(await limitsFor(USER), DEFAULT_LIMITS, 'tests never query the DB');
});

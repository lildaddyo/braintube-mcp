/**
 * Regression guard for D-068: admin-tier tools must never reach a non-admin
 * surface — neither the public server card (what directory scanners copy)
 * nor the tools/list a non-admin MCP session receives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// src/db/supabase.ts needs these to build its client. The URL points at a
// closed local port, so the role lookup in createMcpServer() fails and
// resolveUserRole() falls back to 'authenticated' — a non-admin session.
process.env.SUPABASE_URL ??= 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { TOOLS, PUBLIC_TOOLS } = await import('../routes/server-card.js');
const { TOOL_ACCESS_MAP, getRequiredTier, tierGrantsAccess } = await import('./tool-access.js');
const { createMcpServer } = await import('../server.js');

const adminTools = Object.entries(TOOL_ACCESS_MAP)
  .filter(([, tier]) => tier === 'admin')
  .map(([name]) => name);

test('the access map still marks some tools admin-tier', () => {
  assert.ok(adminTools.length > 0, 'no admin-tier tools found — this guard would pass vacuously');
});

test('public server card lists no admin-tier tool', () => {
  const published = new Set(PUBLIC_TOOLS.map((t) => t.name));
  for (const name of adminTools) {
    assert.ok(!published.has(name), `admin-tier tool "${name}" is on the public server card`);
  }
  for (const tool of PUBLIC_TOOLS) {
    assert.notEqual(getRequiredTier(tool.name), 'admin', `"${tool.name}" is admin-tier`);
  }
});

test('public server card keeps every non-admin tool', () => {
  const nonAdmin = TOOLS.filter((t) => getRequiredTier(t.name) !== 'admin').map((t) => t.name).sort();
  assert.deepEqual(PUBLIC_TOOLS.map((t) => t.name).sort(), nonAdmin);
});

test('the authenticated role is denied every admin-tier tool', () => {
  for (const name of adminTools) {
    assert.equal(tierGrantsAccess('authenticated', getRequiredTier(name)), false, name);
    assert.equal(tierGrantsAccess('admin', getRequiredTier(name)), true, name);
  }
});

test('a non-admin session gets no admin-tier tool from tools/list', async () => {
  const server = await createMcpServer({ userId: '00000000-0000-0000-0000-000000000000', authMethod: 'apikey' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'public-surface-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const listed = new Set(tools.map((t) => t.name));
    assert.ok(listed.size > 0, 'tools/list returned nothing');
    for (const name of adminTools) {
      assert.ok(!listed.has(name), `non-admin tools/list includes admin-tier tool "${name}"`);
    }
    assert.ok(listed.has('bulk_ingest'), 'bulk_ingest should be available to every account (D-069)');
  } finally {
    await client.close();
    await server.close();
  }
});

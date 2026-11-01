import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// No handler here reaches the DB: the router refusals and the schema check
// return before any tool runs. Forced (not ??=) so the fire-and-forget audit
// writes go to a closed port even on a machine with real Supabase vars set.
process.env.SUPABASE_URL = 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { buildMcpServer } = await import('./server.js');
const { CORE_TOOLS, ROUTER_TOOLS, requestedProfile, resolveProfile } = await import('./tool-profiles.js');
const { TOOL_ACCESS_MAP } = await import('./security/tool-access.js');
const { PUBLIC_TOOLS } = await import('./routes/server-card.js');
const { rankTools } = await import('./tools/router.js');
import type { UserRole } from './security/tool-access.js';
import type { ToolProfile } from './tool-profiles.js';

const AUTH = { userId: '00000000-0000-0000-0000-000000000000', authMethod: 'apikey' as const };

async function connect(role: UserRole, profile: ToolProfile) {
  const server = buildMcpServer(AUTH, role, profile);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-profiles-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => { await client.close(); await server.close(); },
  };
}

async function listNames(role: UserRole, profile: ToolProfile): Promise<string[]> {
  const s = await connect(role, profile);
  try {
    return (await s.client.listTools()).tools.map((t) => t.name);
  } finally {
    await s.close();
  }
}

const adminTools = Object.entries(TOOL_ACCESS_MAP).filter(([, t]) => t === 'admin').map(([n]) => n);
const nonAdminTools = Object.entries(TOOL_ACCESS_MAP)
  .filter(([n, t]) => t !== 'admin' && !ROUTER_TOOLS.has(n))
  .map(([n]) => n);

test('core profile registers 12 tools: the 10 core tools plus the 2 routers', async () => {
  const names = await listNames('authenticated', 'core');
  assert.equal(names.length, 12);
  assert.deepEqual(new Set(names), new Set([...CORE_TOOLS, ...ROUTER_TOOLS]));
  assert.ok(names.includes('search') && names.includes('fetch'), 'ChatGPT search/fetch pair stays');
});

test('full profile is unchanged: every tool the role allows, no router tools', async () => {
  const user = await listNames('authenticated', 'full');
  assert.equal(user.length, 40);
  assert.deepEqual(new Set(user), new Set(nonAdminTools));
  const admin = await listNames('admin', 'full');
  assert.equal(admin.length, 54);
  for (const n of ROUTER_TOOLS) assert.ok(!admin.includes(n), n);
});

test('admins default to full, everyone else to core; an explicit request wins', () => {
  assert.equal(resolveProfile('admin'), 'full');
  assert.equal(resolveProfile('authenticated'), 'core');
  assert.equal(resolveProfile('premium'), 'core');
  assert.equal(resolveProfile('authenticated', 'full'), 'full');
  assert.equal(resolveProfile('admin', 'core'), 'core');
});

test('?tools= and X-BrainTube-Tools select the profile; query wins; junk is ignored', () => {
  assert.equal(requestedProfile({ tools: 'full' }, {}), 'full');
  assert.equal(requestedProfile({ tools: 'FULL' }, {}), 'full');
  assert.equal(requestedProfile({}, { 'x-braintube-tools': 'full' }), 'full');
  assert.equal(requestedProfile({ tools: 'core' }, { 'x-braintube-tools': 'full' }), 'core');
  assert.equal(requestedProfile({ tools: 'everything' }, {}), undefined);
  assert.equal(requestedProfile(undefined, undefined), undefined);
});

test('the server card shows the core profile', () => {
  assert.deepEqual(new Set(PUBLIC_TOOLS.map((t) => t.name)), new Set([...CORE_TOOLS, ...ROUTER_TOOLS]));
});

test('router tools carry read-only annotations', async () => {
  const s = await connect('authenticated', 'core');
  try {
    const { tools } = await s.client.listTools();
    for (const name of ROUTER_TOOLS) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, name);
      assert.equal(t.annotations?.readOnlyHint, true, name);
    }
  } finally {
    await s.close();
  }
});

test('find_tools lists read-only extras only, never writes or admin tools', async () => {
  const s = await connect('authenticated', 'core');
  try {
    const res = await s.client.callTool({ name: 'braintube_find_tools', arguments: {} });
    const out = res.structuredContent as { tools: Array<{ name: string; input_schema: unknown }>; full_profile_only: string[] };
    const names = out.tools.map((t) => t.name);
    assert.equal(names.length, 23);
    for (const n of ['bulk_ingest', 'toggle_bookmark', 'ingest_notion_page', 'set_notion_api_key', 'connect_readwise', 'sync_readwise', 'compile_knowledge']) {
      assert.ok(!names.includes(n), `${n} must not be routable`);
      assert.ok(out.full_profile_only.includes(n), `${n} should be listed as full-only`);
    }
    for (const n of adminTools) assert.ok(!names.includes(n) && !out.full_profile_only.includes(n), n);
    for (const n of CORE_TOOLS) assert.ok(!names.includes(n), `${n} is core, not routed`);
    assert.ok(out.tools.every((t) => t.input_schema && typeof t.input_schema === 'object'));
  } finally {
    await s.close();
  }
});

test('run_tool refuses write tools and points to ?tools=full', async () => {
  const s = await connect('authenticated', 'core');
  try {
    for (const name of ['bulk_ingest', 'toggle_bookmark', 'sync_readwise']) {
      const res = await s.client.callTool({ name: 'braintube_run_tool', arguments: { name, args: {} } });
      assert.equal(res.isError, true, name);
      assert.match(JSON.stringify(res.content), /tools=full/, name);
    }
  } finally {
    await s.close();
  }
});

test('run_tool refuses admin tools for non-admins', async () => {
  const s = await connect('authenticated', 'core');
  try {
    for (const name of ['firewall_status', 'security_dashboard', 'search_obsidian']) {
      const res = await s.client.callTool({ name: 'braintube_run_tool', arguments: { name, args: {} } });
      assert.equal(res.isError, true, name);
      assert.match(JSON.stringify(res.content), /No tool/, name);
    }
  } finally {
    await s.close();
  }
});

test('run_tool returns the schema on an argument mismatch', async () => {
  const s = await connect('authenticated', 'core');
  try {
    const res = await s.client.callTool({ name: 'braintube_run_tool', arguments: { name: 'get_related', args: { item_id: 'not-a-uuid', limit: 99 } } });
    assert.equal(res.isError, true);
    const text = JSON.stringify(res.content);
    assert.match(text, /do not match the input schema of `get_related`/);
    assert.match(text, /item_id/);
    assert.match(text, /Expected schema/);
  } finally {
    await s.close();
  }
});

test('run_tool sends core tools back to a direct call', async () => {
  const s = await connect('authenticated', 'core');
  try {
    const res = await s.client.callTool({ name: 'braintube_run_tool', arguments: { name: 'search', args: {} } });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /call it directly/);
  } finally {
    await s.close();
  }
});

test('rankTools puts the best match first and falls back to everything', () => {
  const tools = [
    { name: 'list_bookmarks', title: 'List Bookmarks', description: 'saved bookmarks', inputSchema: {} as never },
    { name: 'get_knowledge_graph', title: 'Get Knowledge Graph', description: 'graph around an item', inputSchema: {} as never },
  ];
  assert.equal(rankTools(tools, 'knowledge graph').tools[0].name, 'get_knowledge_graph');
  assert.deepEqual(rankTools(tools, 'zzzz'), { tools, matched: false });
  assert.equal(rankTools(tools).tools.length, 2);
});

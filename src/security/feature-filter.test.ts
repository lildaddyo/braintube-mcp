import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Forced (not ??=) so the feature RPC and the fire-and-forget audit / security
// writes go to a closed port even on a machine with real Supabase vars set.
process.env.SUPABASE_URL = 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { buildMcpServer } = await import('../server.js');
const { TOOL_ACCESS_MAP, TOOL_FEATURES, getRequiredTier } = await import('./tool-access.js');
const {
  FEATURE_GATE_OFF, featureAllows, featureFilterMode, resolveFeatureGate, resolveUserFeatures, taggedFeatureKeys,
} = await import('./feature-filter.js');
import type { FeatureGate } from './feature-filter.js';
import type { UserRole } from './tool-access.js';
import type { ToolProfile } from '../tool-profiles.js';

const AUTH = { userId: '00000000-0000-0000-0000-000000000000', authMethod: 'apikey' as const };

async function connect(role: UserRole, profile: ToolProfile, gate: FeatureGate = FEATURE_GATE_OFF) {
  const server = buildMcpServer(AUTH, role, profile, gate);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'feature-filter-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => { await client.close(); await server.close(); },
  };
}

async function listNames(role: UserRole, profile: ToolProfile, gate?: FeatureGate): Promise<string[]> {
  const s = await connect(role, profile, gate);
  try {
    return (await s.client.listTools()).tools.map((t) => t.name);
  } finally {
    await s.close();
  }
}

const tagged = Object.keys(TOOL_FEATURES);
const enforce = (keys: string[]): FeatureGate => ({ mode: 'enforce', enabled: new Set(keys) });
const shadow = (keys: string[]): FeatureGate => ({ mode: 'shadow', enabled: new Set(keys) });

// ─── Fail closed: TOOL_ACCESS_MAP covers every registered tool ────────────────

test('every registered tool is listed in TOOL_ACCESS_MAP, and every entry is registered', async () => {
  // Admin sees everything: full has every tool, core adds the two routers.
  const registered = new Set([...await listNames('admin', 'full'), ...await listNames('admin', 'core')]);
  const missing = [...registered].filter((n) => !(n in TOOL_ACCESS_MAP));
  assert.deepEqual(missing, [], `add these tools to TOOL_ACCESS_MAP in src/security/tool-access.ts: ${missing.join(', ')}`);
  const stale = Object.keys(TOOL_ACCESS_MAP).filter((n) => !registered.has(n));
  assert.deepEqual(stale, [], `TOOL_ACCESS_MAP lists tools that are not registered: ${stale.join(', ')}`);
});

test('a tool missing from TOOL_ACCESS_MAP requires admin', () => {
  assert.equal(getRequiredTier('some_new_tool_nobody_listed'), 'admin');
});

test('every feature-tagged tool is in TOOL_ACCESS_MAP and the tags are the features.json keys', () => {
  for (const name of tagged) assert.ok(name in TOOL_ACCESS_MAP, name);
  assert.deepEqual(TOOL_FEATURES, {
    chat_with_brain: 'brains',
    list_brains: 'brains',
    compile_knowledge: 'wiki',
    get_concept_articles: 'wiki',
  });
  assert.deepEqual(taggedFeatureKeys(), ['brains', 'wiki']);
});

// ─── Switch ───────────────────────────────────────────────────────────────────

test('MCP_FEATURE_FILTER parses off / shadow / enforce; anything else is off', () => {
  assert.equal(featureFilterMode(undefined), 'off');
  assert.equal(featureFilterMode(''), 'off');
  assert.equal(featureFilterMode('off'), 'off');
  assert.equal(featureFilterMode('Shadow'), 'shadow');
  assert.equal(featureFilterMode(' enforce '), 'enforce');
  assert.equal(featureFilterMode('on'), 'off');
});

test('off makes no lookup; a missing or failing feature RPC yields a gate that filters nothing', async () => {
  assert.equal(await resolveFeatureGate(AUTH.userId, 'off'), FEATURE_GATE_OFF);
  // SUPABASE_URL points at a closed port: the lookup fails and the filter is skipped.
  assert.equal(await resolveUserFeatures(AUTH.userId), null);
  assert.deepEqual(await resolveFeatureGate(AUTH.userId, 'enforce'), { mode: 'enforce', enabled: null });
});

// ─── featureAllows: the decision and what gets logged ─────────────────────────

test('featureAllows: off and unknown pass silently; shadow logs and allows; enforce refuses', () => {
  const calls: unknown[][] = [];
  const log = (...args: unknown[]) => { calls.push(args); };
  const allows = (gate: FeatureGate, tool: string, phase: 'register' | 'call') =>
    featureAllows(gate, AUTH.userId, tool, phase, log);

  assert.equal(allows(FEATURE_GATE_OFF, 'chat_with_brain', 'call'), true);
  assert.equal(allows({ mode: 'enforce', enabled: null }, 'chat_with_brain', 'call'), true);
  assert.equal(allows(enforce([]), 'search_knowledge', 'call'), true, 'untagged tools are core');
  assert.equal(allows(enforce(['brains']), 'chat_with_brain', 'call'), true);
  assert.equal(calls.length, 0);

  assert.equal(allows(shadow([]), 'chat_with_brain', 'register'), true);
  assert.deepEqual(calls.pop(), [AUTH.userId, 'chat_with_brain', 'brains', 'shadow', 'register']);

  assert.equal(allows(enforce([]), 'compile_knowledge', 'register'), false);
  assert.equal(calls.length, 0, 'routine hides at registration are not logged in enforce');
  assert.equal(allows(enforce([]), 'compile_knowledge', 'call'), false);
  assert.deepEqual(calls.pop(), [AUTH.userId, 'compile_knowledge', 'wiki', 'enforce', 'call']);
});

// ─── tools/list under each mode ───────────────────────────────────────────────

test('off, shadow and a missing RPC list exactly what the role and profile allow today', async () => {
  const today = await listNames('authenticated', 'full');
  for (const name of tagged) assert.ok(today.includes(name), name);
  assert.deepEqual(await listNames('authenticated', 'full', shadow([])), today);
  assert.deepEqual(await listNames('authenticated', 'full', { mode: 'enforce', enabled: null }), today);
});

test('enforce hides the tools of disabled features and keeps the rest', async () => {
  const today = await listNames('authenticated', 'full');
  const wikiOnly = await listNames('authenticated', 'full', enforce(['wiki']));
  assert.deepEqual(wikiOnly, today.filter((n) => n !== 'chat_with_brain' && n !== 'list_brains'));
  const none = await listNames('authenticated', 'full', enforce([]));
  assert.deepEqual(none, today.filter((n) => !tagged.includes(n)));
  // Admins are filtered too (feature_enabled grants them cohort features itself).
  const admin = await listNames('admin', 'full', enforce([]));
  for (const name of tagged) assert.ok(!admin.includes(name), name);
});

// ─── Router: braintube_find_tools / braintube_run_tool ────────────────────────

async function findTools(gate: FeatureGate) {
  const s = await connect('authenticated', 'core', gate);
  try {
    const r = await s.client.callTool({ name: 'braintube_find_tools', arguments: {} });
    const out = r.structuredContent as { tools: Array<{ name: string }>; full_profile_only: string[] };
    return { routable: out.tools.map((t) => t.name), fullOnly: out.full_profile_only };
  } finally {
    await s.close();
  }
}

test('router: shadow lists feature tools like today; enforce cannot find them', async () => {
  const today = await findTools(FEATURE_GATE_OFF);
  for (const n of ['chat_with_brain', 'list_brains', 'get_concept_articles']) assert.ok(today.routable.includes(n), n);
  assert.ok(today.fullOnly.includes('compile_knowledge'));
  assert.deepEqual(await findTools(shadow([])), today);

  const hidden = await findTools(enforce([]));
  for (const n of tagged) {
    assert.ok(!hidden.routable.includes(n), `${n} routable`);
    assert.ok(!hidden.fullOnly.includes(n), `${n} listed as full-only`);
  }
  assert.deepEqual(hidden.routable, today.routable.filter((n) => !tagged.includes(n)));
});

test('router: braintube_run_tool cannot reach a tool hidden by enforce', async () => {
  const s = await connect('authenticated', 'core', enforce([]));
  try {
    for (const name of ['list_brains', 'chat_with_brain', 'get_concept_articles', 'compile_knowledge']) {
      const r = await s.client.callTool({ name: 'braintube_run_tool', arguments: { name, args: {} } });
      assert.equal(r.isError, true, name);
      const text = (r.content as Array<{ text: string }>)[0].text;
      assert.match(text, /No tool `.+` is available to your account here/, name);
    }
  } finally {
    await s.close();
  }
});

test('enforce: a direct call to a hidden tool is refused (not registered)', async () => {
  const s = await connect('authenticated', 'full', enforce([]));
  try {
    const r = await s.client.callTool({ name: 'list_brains', arguments: {} }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal(r.isError, true);
  } finally {
    await s.close();
  }
});

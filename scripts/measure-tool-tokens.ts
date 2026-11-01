/**
 * Size of the tools/list payload per profile, as an estimate of the tokens a
 * client spends on tool definitions every chat (JSON length / 4).
 *
 *   npx tsx scripts/measure-tool-tokens.ts
 */

process.env.SUPABASE_URL = 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { buildMcpServer } = await import('../src/server.js');

const rows: Array<{ session: string; tools: number; chars: number; tokens: number }> = [];
for (const [session, role, profile] of [
  ['user, core (default)', 'authenticated', 'core'],
  ['user, ?tools=full', 'authenticated', 'full'],
  ['admin, full (default)', 'admin', 'full'],
] as const) {
  const server = buildMcpServer({ userId: '00000000-0000-0000-0000-000000000000', authMethod: 'apikey' }, role, profile);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'measure', version: '1.0.0' });
  await server.connect(s);
  await client.connect(c);
  const { tools } = await client.listTools();
  const chars = JSON.stringify(tools).length;
  rows.push({ session, tools: tools.length, chars, tokens: Math.round(chars / 4) });
  await client.close();
  await server.close();
}
console.table(rows);

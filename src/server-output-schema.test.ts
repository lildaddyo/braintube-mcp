/**
 * Regression tests for the commit-0cbcf01 production incident.
 *
 * Root cause: outputSchema was declared as a top-level `z.union([toolSchema,
 * envelopeSchema])` (via a since-removed withEnvelope() helper) so that
 * secureWrap's short-circuit results (role denial, injection reject,
 * confirm-required preview) would "conform" to whatever schema was declared.
 *
 * That looked fine everywhere we checked pre-deploy: tsc, build, tests,
 * verify:card, even the live server-card.json (which is built via
 * zod-to-json-schema, a completely separate code path that DOES support
 * unions — it renders `anyOf`). But the MCP SDK's *runtime* output validator
 * — normalizeObjectSchema() in its zod-compat layer — only recognizes
 * ZodObject/raw-shape schemas at the top level via `.shape`. A top-level
 * z.union(...) has no `.shape`, so normalizeObjectSchema() silently returns
 * undefined, and the very next line, safeParseAsync(undefined, ...), throws
 * "Cannot read properties of undefined (reading '_zod')".
 *
 * The SDK catches that internally and returns a normal (non-throwing)
 * CallToolResult with isError:true and the raw crash message as content —
 * so from a client's perspective, every single tool call just silently
 * "fails" with a useless error message. Server boot and the static
 * server-card route are completely unaffected, which is exactly why this
 * shipped past every existing check: none of them ever called a tool
 * through the actual SDK server.
 *
 * Fix: outputSchema must never be a top-level union. secureWrap's
 * short-circuits now mark themselves isError:true instead (see
 * shortCircuitResult() in server.ts and src/security/tool-envelope.ts),
 * which the SDK's validator explicitly skips validation for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

// src/db/supabase.ts throws at import time if these are unset. Nothing in
// this file calls a real handler or touches the DB — only schema exports
// and trivial stub handlers — so dummy values are enough to satisfy the
// Supabase client constructor without ever making a network call.
process.env.SUPABASE_URL ??= 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { tagItemOutputSchema } = await import('./tools/tag-item.js');
const { getStatsOutputSchema } = await import('./tools/stats.js');
const { toggleBookmarkOutputSchema } = await import('./tools/bookmarks.js');
const { searchKnowledgeOutputSchema } = await import('./tools/search.js');
const { getSessionBriefOutputSchema } = await import('./tools/session-brief.js');

/**
 * Every currently-declared output schema, keyed by tool name. Extend this
 * list when adding a new tool's outputSchema — cheap insurance against this
 * exact bug class recurring for a schema built differently than the ones
 * already covered here.
 */
const REAL_OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  tag_item: tagItemOutputSchema,
  get_stats: getStatsOutputSchema,
  toggle_bookmark: toggleBookmarkOutputSchema,
  search_knowledge: searchKnowledgeOutputSchema,
  get_session_brief: getSessionBriefOutputSchema,
};

test('every declared output schema is recognized by the SDK\'s normalizeObjectSchema()', () => {
  for (const [name, schema] of Object.entries(REAL_OUTPUT_SCHEMAS)) {
    const normalized = normalizeObjectSchema(schema);
    assert.ok(
      normalized,
      `${name}: normalizeObjectSchema() returned undefined — this schema is not a top-level ` +
      `ZodObject/raw-shape and WILL crash every call to this tool with "Cannot read properties ` +
      `of undefined (reading '_zod')" once outputSchema is declared (the exact 0cbcf01 incident)`
    );
  }
});

test('a top-level z.union(...) outputSchema is NOT recognized by normalizeObjectSchema() (documents the SDK limitation this incident hit)', () => {
  const unionSchema = z.union([
    z.object({ item_id: z.string() }),
    z.object({ status: z.string(), message: z.string() }),
  ]);
  assert.equal(
    normalizeObjectSchema(unionSchema),
    undefined,
    'expected normalizeObjectSchema to return undefined for a top-level union — if this ' +
    'assertion now fails, the SDK has started supporting unions and REAL_OUTPUT_SCHEMAS-style ' +
    'checks above may no longer be sufficient to catch other shapes'
  );
});

test('boots a real McpServer, calls a real tool through a real Client over InMemoryTransport — structuredContent present, text unchanged', async () => {
  const server = new McpServer({ name: 'smoke-test', version: '0.0.0' });

  const EXPECTED_TEXT = 'Tags updated for item test-item.';
  const EXPECTED_STRUCTURED = { item_id: 'test-item', tags: ['a'], added: ['a'], removed: [] };

  server.registerTool(
    'tag_item',
    {
      description: 'smoke test stub',
      inputSchema: z.object({ item_id: z.string() }),
      outputSchema: tagItemOutputSchema,
    },
    async () => ({
      content: [{ type: 'text' as const, text: EXPECTED_TEXT }],
      structuredContent: EXPECTED_STRUCTURED,
    })
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'smoke-test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: 'tag_item', arguments: { item_id: 'test-item' } });

  assert.ok(!result.isError, `tool call should not error: ${JSON.stringify(result)}`);
  assert.ok(result.structuredContent, 'structuredContent must be present once outputSchema is declared');
  assert.deepEqual(result.structuredContent, EXPECTED_STRUCTURED);
  assert.equal(
    (result.content as Array<{ type: string; text?: string }>)[0].text,
    EXPECTED_TEXT,
    'text content must be byte-identical to what the handler returned'
  );

  await client.close();
  await server.close();
});

test('a tool registered with a top-level union outputSchema (the historical bug pattern) returns isError:true on every call', async () => {
  const server = new McpServer({ name: 'smoke-test-buggy', version: '0.0.0' });

  const buggyOutputSchema = z.union([
    z.object({ item_id: z.string() }),
    z.object({ status: z.string(), message: z.string() }),
  ]);

  server.registerTool(
    'buggy_tool',
    {
      description: 'reproduces the 0cbcf01 incident pattern',
      inputSchema: z.object({}),
      outputSchema: buggyOutputSchema,
    },
    async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { item_id: 'x' },
    })
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'smoke-test-buggy-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: 'buggy_tool', arguments: {} });

  // The SDK catches the internal TypeError server-side and returns a normal
  // (non-throwing) result with isError:true — it does NOT reject the call.
  // This is exactly what made the incident invisible to a naive try/catch
  // smoke test, and exactly what a Claude.ai connector user actually saw.
  assert.equal(result.isError, true, `expected isError:true, got: ${JSON.stringify(result)}`);

  await client.close();
  await server.close();
});

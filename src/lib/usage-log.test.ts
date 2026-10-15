import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costCents, buildUsageRow, withUsageContext, logOpenAiUsage, PRICES_AS_OF } from './usage-log.js';

test('prices match dark-n-cozy api-prices.ts (cents, 4 decimals)', () => {
  // text-embedding-3-small $0.02/M: 1,000 tokens = 0.002 cents
  assert.equal(costCents('openai/text-embedding-3-small', 1000), 0.002);
  assert.equal(costCents('text-embedding-3-small', 1000), 0.002);
  // gpt-4o-mini $0.15/M in, $0.60/M out
  assert.equal(costCents('gpt-4o-mini', 100, 20), 0.0027);
  assert.equal(costCents('unknown-model', 1000), 0);
});

test('a row carries user, mcp/<tool> endpoint, tokens and cost', () => {
  const row = buildUsageRow(
    { model: 'openai/text-embedding-3-small', inputTokens: 12, latencyMs: 80, status: 200, metadata: { kind: 'embedding' } },
    { userId: 'u-1', tool: 'search_knowledge' },
  );
  assert.equal(row.api_name, 'openai/text-embedding-3-small');
  assert.equal(row.endpoint, 'mcp/search_knowledge');
  assert.equal(row.user_id, 'u-1');
  assert.equal(row.tokens_used, 12);
  assert.equal(row.cost_cents, 0.0000);
  assert.equal(row.provider, 'openai');
  assert.equal(row.metadata.source, 'mcp');
  assert.equal((row.metadata as Record<string, unknown>).kind, 'embedding');
  assert.equal(row.metadata.prices_as_of, PRICES_AS_OF);
});

test('failed calls cost nothing; no context means mcp/unknown and no user', () => {
  const row = buildUsageRow({ model: 'gpt-4o-mini', inputTokens: 0, latencyMs: 5, status: 429 }, undefined);
  assert.equal(row.cost_cents, 0);
  assert.equal(row.endpoint, 'mcp/unknown');
  assert.equal(row.user_id, null);
  assert.equal(row.tokens_used, null);
});

test('logging never throws into the caller, even without a database', async () => {
  const out = await withUsageContext({ userId: 'u-2', tool: 't' }, async () => {
    await new Promise(r => setTimeout(r, 1));
    logOpenAiUsage({ model: 'gpt-4o-mini', inputTokens: 1, latencyMs: 1, status: 200 });
    return 'ok';
  });
  assert.equal(out, 'ok');
});

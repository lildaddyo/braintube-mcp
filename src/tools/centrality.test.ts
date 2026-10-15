import { test } from 'node:test';
import assert from 'node:assert/strict';

// compute_centrality_scores returns TABLE(updated_count int) = [{ updated_count }] and
// updates at most 150 rows per call. The tool used to read data.updated_count off the
// array (always null) and call once (150 rows max).
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { computeCentrality, readUpdatedCount } = await import('./centrality.js');

test('readUpdatedCount reads the RPC table shape', () => {
  assert.equal(readUpdatedCount([{ updated_count: 150 }]), 150);
  assert.equal(readUpdatedCount({ updated_count: 7 }), 7);
  assert.equal(readUpdatedCount(3), 3);
  assert.equal(readUpdatedCount([]), null);
  assert.equal(readUpdatedCount(null), null);
});

test('computeCentrality loops until a short batch and sums the counts', async () => {
  const replies = [150, 150, 42];
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/rest\/v1\/rpc\/compute_centrality_scores/);
    const n = replies[calls++];
    return new Response(JSON.stringify([{ updated_count: n }]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const out = await computeCentrality({}, '00000000-0000-0000-0000-000000000001');
    assert.equal(calls, 3);
    assert.equal(out.structuredContent.updated_count, 342);
    assert.match(out.content[0].text, /Updated: 342 items/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

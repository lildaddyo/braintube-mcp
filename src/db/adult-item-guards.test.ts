import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP server reads public.items with the service key, which skips the row rule that hides
// adult items outside the app's XXX tab. Each read that returns item content to an MCP client has
// to filter them itself. This records the PostgREST requests a real supabase-js client sends and
// checks the filter is on the wire. Audit: 2DO e4289926, 2026-10-13.
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.OPENAI_API_KEY ??= 'test-openai-key';

const requests: URL[] = [];
// Set before the first query: supabase-js picks up the global fetch when the client is created.
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requests.push(url);
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
}) as typeof fetch;

const db = await import('./supabase.js');
const { listBookmarks } = await import('../tools/bookmarks.js');
const { getRecentConversations } = await import('../tools/recent-conversations.js');
const { backfillEmbeddings } = await import('../tools/embedding.js');

const USER = '11111111-2222-3333-4444-555555555555';

/** The items reads a call sent; a call may throw on the empty stub reply, the request is what counts. */
async function itemsReads(call: () => Promise<unknown>): Promise<URL[]> {
  requests.length = 0;
  try { await call(); } catch { /* empty stub reply */ }
  return requests.filter((u) => u.pathname.endsWith('/rest/v1/items'));
}

const guarded = (u: URL, column: 'is_adult' | 'ai_excluded') => u.searchParams.get(column) === 'eq.false';

const READS: Array<[string, () => Promise<unknown>, 'is_adult' | 'ai_excluded']> = [
  ['keyword search (search_knowledge fallback, deep_search)', () => db.semanticSearch('anything', USER, 5), 'is_adult'],
  ['get_video by internal id', () => db.getVideoById('22222222-3333-4444-5555-666666666666', USER), 'is_adult'],
  ['get_video by YouTube id', () => db.getVideoById('dQw4w9WgXcQ', USER), 'is_adult'],
  ['list_recent', () => db.getRecentVideos(USER, 10), 'is_adult'],
  ['get_stats', () => db.getCorpusStats(USER), 'is_adult'],
  ['list_bookmarks', () => listBookmarks({ limit: 10 } as never, USER), 'is_adult'],
  ['get_recent_conversations', () => getRecentConversations({ n: 5 } as never, USER), 'is_adult'],
  ['backfill_embeddings (text sent to the embeddings provider)', () => backfillEmbeddings(USER), 'ai_excluded'],
];

for (const [name, call, column] of READS) {
  test(`${name}: every items read filters ${column} = false`, async () => {
    const reads = await itemsReads(call);
    assert.ok(reads.length > 0, 'the call read items');
    for (const u of reads) assert.ok(guarded(u, column), `unfiltered items read: ${u.search}`);
  });
}

// Negative control: the recorder has to see a read that carries no filter.
test('negative control: a read without the filter is seen as unfiltered', async () => {
  const reads = await itemsReads(() => db.findItemBySourceUrl('https://example.com/a', USER));
  assert.equal(reads.length, 1);
  assert.equal(guarded(reads[0], 'is_adult'), false);
  assert.equal(guarded(reads[0], 'ai_excluded'), false);
});

test('negative control: the filter is matched on its value, not on the column name', () => {
  assert.equal(guarded(new URL('https://x.test/rest/v1/items?is_adult=eq.true'), 'is_adult'), false);
  assert.equal(guarded(new URL('https://x.test/rest/v1/items?select=is_adult'), 'is_adult'), false);
  assert.equal(guarded(new URL('https://x.test/rest/v1/items?is_adult=eq.false'), 'is_adult'), true);
});

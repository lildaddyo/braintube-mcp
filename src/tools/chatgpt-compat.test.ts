import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

process.env.SUPABASE_URL ??= 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { toSearchResults, toFetchDocument, itemUrl, chatgptSearchOutputSchema, chatgptFetchOutputSchema, parseFetchCursor, passagePage, FETCH_PAGE_CHARS } = await import('./chatgpt-compat.js');

test('search results have the {results:[{id,title,url}]} shape ChatGPT expects, deduplicated', () => {
  const out = toSearchResults([
    { id: 'a', title: 'One', url: 'https://example.com/1' },
    { id: 'a', title: 'One again' },
    { id: 'b', title: null, video_id: 'dQw4w9WgXcQ' },
    { title: 'no id' },
  ]);
  assert.deepEqual(out, { results: [
    { id: 'a', title: 'One', url: 'https://example.com/1' },
    { id: 'b', title: 'Untitled', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  ] });
  assert.equal(chatgptSearchOutputSchema.safeParse(out).success, true);
});

test('fetch returns id/title/text/url/metadata built from the item', () => {
  const doc = toFetchDocument({
    id: 'x', title: 'T', url: 'https://e.com', summary: 'S', key_takeaways: ['k1', 'k2'],
    full_transcript: 'body', source_type: 'youtube', channel: 'Chan', tags: ['ai'],
  }, 'careful');
  assert.equal(doc.id, 'x');
  assert.equal(doc.url, 'https://e.com');
  assert.ok(doc.text.includes('Summary\nS') && doc.text.includes('- k2') && doc.text.includes('Transcript\nbody'));
  assert.deepEqual(doc.metadata, { source_type: 'youtube', author: 'Chan', tags: 'ai', taint_warning: 'careful' });
  assert.equal(chatgptFetchOutputSchema.safeParse(doc).success, true);
});

test('fetch pages a long text instead of cutting it off, and never invents a non-http url', () => {
  const body = Array.from({ length: 30_000 }, (_, i) => `w${i}`).join(' ');     // ~199k characters
  const row = { id: 'y', full_transcript: body, url: 'javascript:alert(1)' };
  const first = toFetchDocument(row);
  assert.equal(first.url, '');
  assert.ok(first.text.length <= FETCH_PAGE_CHARS + 200);
  assert.match(first.metadata!.chars, /^0-\d+$/);
  assert.match(first.text, /To read on, call fetch with the same id and cursor "c:\d+"\.\]$/);
  // following next_cursor to the end returns every character exactly once, split at spaces
  let rebuilt = '';
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const c = parseFetchCursor(cursor);
    const doc = toFetchDocument(row, undefined, { offset: c && c.kind === 'chars' ? c.offset : 0 });
    rebuilt += doc.text.replace(/\n\n\[Characters \d+ to \d+ of \d+\. To read on.*\]$/, '');
    pages++;
    cursor = doc.metadata?.next_cursor;
    if (!cursor) { assert.ok(doc.metadata!.chars.endsWith(`-${doc.metadata!.total_chars}`)); break; }
    assert.ok(pages < 20);
  }
  assert.equal(rebuilt, `Transcript\n${body}`);
  assert.equal(first.metadata!.total_chars, String(`Transcript\n${body}`.length));
  // a short item has no paging fields at all
  assert.deepEqual(Object.keys(toFetchDocument({ id: 's', summary: 'short' }).metadata ?? {}), []);
  assert.equal(itemUrl({ video_id: 'bad id!' }), '');
  assert.equal(itemUrl({ id: '62c15413-81a1-4431-863f-308f0facb038', url: '' }), 'https://app.brain-tube.com/item/62c15413-81a1-4431-863f-308f0facb038');
});

test('output schemas are plain objects the SDK can validate against', () => {
  assert.ok(normalizeObjectSchema(chatgptSearchOutputSchema));
  assert.ok(normalizeObjectSchema(chatgptFetchOutputSchema));
});

test('search results pass video moments through and stay schema-valid', () => {
  const moments = [{ t: 754, url: 'https://www.youtube.com/watch?v=abcDEF12345&t=754s', quote: 'memory is the agent state' }];
  const out = toSearchResults([{ id: 'a', title: 'T', url: 'https://www.youtube.com/watch?v=abcDEF12345', moments }, { id: 'b', title: 'W', url: 'https://x.test/', moments: [] }]);
  assert.deepEqual(out.results[0].moments, moments);
  assert.equal('moments' in out.results[1], false);
  assert.equal(chatgptSearchOutputSchema.safeParse(out).success, true);
});

test('search results pass passages through, with the item\'s provenance and taint for the envelope', () => {
  const passages = [{ text: 'the matching text', n: 4 }];
  const out = toSearchResults([
    { id: 'a', title: 'T', url: 'https://x.test/a', passages, provenance: 'third_party', taint_level: 1 },
    { id: 'b', title: 'W', url: 'https://x.test/b', passages: [], taint_level: 1 },
  ]);
  assert.deepEqual(out.results[0], { id: 'a', title: 'T', url: 'https://x.test/a', passages, provenance: 'third_party', taint_level: 1 });
  assert.deepEqual(out.results[1], { id: 'b', title: 'W', url: 'https://x.test/b' });
  assert.equal(chatgptSearchOutputSchema.safeParse(out).success, true);
});

test('fetch cursors: c:<offset> and p:<passage> only; anything else says what to pass', () => {
  assert.equal(parseFetchCursor(undefined), null);
  assert.deepEqual(parseFetchCursor('c:40000'), { kind: 'chars', offset: 40000 });
  assert.deepEqual(parseFetchCursor(' p:12 '), { kind: 'passage', n: 12 });
  for (const bad of ['40000', 'x:1', 'c:-1', 'c:1; drop', 'p:']) assert.throws(() => parseFetchCursor(bad), /Invalid cursor\. Pass the next_cursor value/);
});

test('passagePage reads whole passages up to the page size, with times, and names the next passage', () => {
  const rows = [
    { segment_index: 7, text: '  first   passage ', start_time_sec: 65 },
    { segment_index: 8, text: 'x'.repeat(50), start_time_sec: '3725.4' },
    { segment_index: 9, text: 'third', start_time_sec: null },
    { segment_index: 10, text: 'fourth', start_time_sec: null },
  ];
  const all = passagePage(rows, 10_000)!;
  assert.equal(all.text, `[1:05] first passage\n\n[1:02:05] ${'x'.repeat(50)}\n\nthird\n\nfourth`);
  assert.deepEqual([all.first, all.last, all.next], [7, 10, undefined]);
  const small = passagePage(rows, 86)!;
  assert.deepEqual([small.first, small.last, small.next], [7, 8, 9]);
  const tiny = passagePage(rows, 5)!;                 // always at least one passage, cut if it is longer than the page
  assert.deepEqual([tiny.first, tiny.last, tiny.next], [7, 7, 8]);
  assert.equal(passagePage([], 100), null);
  assert.equal(passagePage([{ segment_index: 0, text: '   ' }], 100), null);
});

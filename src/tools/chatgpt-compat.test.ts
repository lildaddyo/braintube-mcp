import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

process.env.SUPABASE_URL ??= 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { toSearchResults, toFetchDocument, itemUrl, chatgptSearchOutputSchema, chatgptFetchOutputSchema } = await import('./chatgpt-compat.js');

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

test('fetch truncates very long text and never invents a non-http url', () => {
  const doc = toFetchDocument({ id: 'y', full_transcript: 'z'.repeat(200_000), url: 'javascript:alert(1)' });
  assert.ok(doc.text.length < 100_100 && doc.text.endsWith('[truncated]'));
  assert.equal(doc.url, '');
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

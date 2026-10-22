import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timestampUrl, shortQuote, pickMoments, MAX_MOMENTS } from './moments.js';

test('timestampUrl opens YouTube links at the second, in every URL form', () => {
  assert.equal(timestampUrl('https://www.youtube.com/watch?v=abcDEF12345', 83.9), 'https://www.youtube.com/watch?v=abcDEF12345&t=83s');
  assert.equal(timestampUrl('https://www.youtube.com/watch?v=abcDEF12345&t=10s&list=PL1', 5), 'https://www.youtube.com/watch?v=abcDEF12345&t=5s');
  assert.equal(timestampUrl('https://youtu.be/abcDEF12345?si=x', 42), 'https://www.youtube.com/watch?v=abcDEF12345&t=42s');
  assert.equal(timestampUrl('https://m.youtube.com/shorts/abcDEF12345', 3), 'https://www.youtube.com/watch?v=abcDEF12345&t=3s');
  assert.equal(timestampUrl(null, 7, 'abcDEF12345'), 'https://www.youtube.com/watch?v=abcDEF12345&t=7s');
  assert.equal(timestampUrl('https://youtube.com/watch?v=abcDEF12345', -4), 'https://www.youtube.com/watch?v=abcDEF12345&t=0s');
});

test('timestampUrl leaves non-YouTube URLs as they are and returns "" without any URL', () => {
  assert.equal(timestampUrl('https://podcasts.apple.com/us/podcast/x/id1?i=2', 60), 'https://podcasts.apple.com/us/podcast/x/id1?i=2');
  assert.equal(timestampUrl('not a url', 60), '');
  assert.equal(timestampUrl(undefined, 60), '');
});

test('shortQuote collapses whitespace and cuts at a word boundary', () => {
  assert.equal(shortQuote('  a   b\nc '), 'a b c');
  assert.equal(shortQuote('we don&#39;t know &amp; &quot;x&quot; &#x27;y&#x27; &bogus;'), `we don't know & "x" 'y' &bogus;`);
  const q = shortQuote('word '.repeat(100), 50);
  assert.ok(q.length <= 51 && q.endsWith('…') && !q.includes('  '));
});

test('pickMoments: best first, at most 3, score floor, neighbours merged, untimed rows skipped', () => {
  const url = 'https://www.youtube.com/watch?v=abcDEF12345';
  const rows = [
    { segment_text: 'one', start_time_sec: '100', combined_score: 0.7 },
    { segment_text: 'neighbour', start_time_sec: '110', combined_score: 0.69 },
    { segment_text: 'untimed', start_time_sec: null, combined_score: 0.68 },
    { segment_text: 'two', start_time_sec: 400, combined_score: 0.6 },
    { segment_text: '', start_time_sec: 500, combined_score: 0.6 },
    { segment_text: 'three', start_time_sec: 900, combined_score: 0.5 },
    { segment_text: 'four', start_time_sec: 1300, combined_score: 0.45 },
    { segment_text: 'weak', start_time_sec: 2000, combined_score: 0.2 },
  ];
  const m = pickMoments(rows, url);
  assert.equal(m.length, MAX_MOMENTS);
  assert.deepEqual(m.map(x => [x.t, x.quote]), [[100, 'one'], [400, 'two'], [900, 'three']]);
  assert.equal(m[1].url, 'https://www.youtube.com/watch?v=abcDEF12345&t=400s');
  assert.deepEqual(pickMoments([{ segment_text: 'weak', start_time_sec: 1, combined_score: 0.2 }], url), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPassages, passageBudget, passageSchema, MAX_PASSAGES, MAX_PASSAGES_TAIL, PASSAGE_CHARS } from './passages.js';

test('pickPassages keeps the given order, drops empty and repeated segments and stops at max', () => {
  const rows = [
    { segment_id: 'a', segment_text: 'first  passage', start_time_sec: null },
    { segment_id: 'a', segment_text: 'first  passage', start_time_sec: null },
    { segment_id: 'b', segment_text: '', start_time_sec: null },
    { segment_id: 'c', segment_text: 'second', start_time_sec: null },
    { segment_id: 'd', segment_text: 'third', start_time_sec: null },
  ];
  assert.deepEqual(pickPassages(rows, 'https://example.com/a', null, 2), [{ text: 'first passage' }, { text: 'second' }]);
  assert.equal(pickPassages(rows, null, null).length, 3);
  assert.deepEqual(pickPassages([], 'https://example.com/a', null), []);
});

test('pickPassages adds the position when known and a timestamp link only for timed rows', () => {
  const idx = new Map([['a', 12]]);
  const out = pickPassages([
    { segment_id: 'a', segment_text: 'we don&#39;t know', start_time_sec: '83.9' },
    { segment_id: 'b', segment_text: 'no time, no position', start_time_sec: null },
    { segment_id: 'c', segment_text: 'timed but not a video link', start_time_sec: 5 },
  ], 'https://youtu.be/abcDEF12345', null, 4, idx);
  assert.deepEqual(out[0], { text: "we don't know", n: 12, t: 83, url: 'https://www.youtube.com/watch?v=abcDEF12345&t=83s' });
  assert.deepEqual(out[1], { text: 'no time, no position' });
  assert.equal(out[2].t, 5);
  for (const p of out) assert.equal(passageSchema.safeParse(p).success, true);
  // an item with no URL at all cannot link to a second: the passage keeps its text only
  assert.deepEqual(pickPassages([{ segment_id: 'z', segment_text: 'x', start_time_sec: 9 }], null, null), [{ text: 'x' }]);
});

test('long passages are cut at a word boundary; the budget shrinks after the top results', () => {
  const [p] = pickPassages([{ segment_id: 'a', segment_text: 'word '.repeat(500), start_time_sec: null }], null, null);
  assert.ok(p.text.length <= PASSAGE_CHARS + 1 && p.text.endsWith('…'));
  assert.deepEqual([0, 2, 3, 9].map(passageBudget), [MAX_PASSAGES, MAX_PASSAGES, MAX_PASSAGES_TAIL, MAX_PASSAGES_TAIL]);
});

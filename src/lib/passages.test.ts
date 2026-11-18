import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPassages, passageBudget, passageSchema, fallbackPassages, queryTerms, MAX_PASSAGES, MAX_PASSAGES_TAIL, PASSAGE_CHARS, MAX_SPAN_SEGMENTS, type Neighbours } from './passages.js';

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

test('widening: forward first, then back; starts at the earliest joined segment and takes its time', () => {
  const nb: Neighbours = new Map([
    [4, { text: 'before.', start_time_sec: 40 }],
    [5, { text: 'short pick', start_time_sec: 50 }],
    [6, { text: `after ${'x'.repeat(400)}`, start_time_sec: 60 }],
    [7, { text: 'never reached', start_time_sec: 70 }],
  ]);
  const idx = new Map([['p', 5]]);
  const [a] = pickPassages([{ segment_id: 'p', segment_text: 'short pick', start_time_sec: 50 }], 'https://youtu.be/abcDEF12345', null, 4, idx, nb);
  assert.ok(a.text.startsWith('short pick after x'));        // long enough after one step forward: no step back
  assert.equal(a.n, 5);
  assert.equal(a.t, 50);
  const nb2: Neighbours = new Map([[4, { text: 'before.', start_time_sec: 40 }], [5, { text: 'short pick', start_time_sec: 50 }]]);
  const [b] = pickPassages([{ segment_id: 'p', segment_text: 'short pick', start_time_sec: 50 }], 'https://youtu.be/abcDEF12345', null, 4, idx, nb2);
  assert.deepEqual(b, { text: 'before. short pick', n: 4, t: 40, url: 'https://www.youtube.com/watch?v=abcDEF12345&t=40s' });
});

test('widening stops at the span limit, never crosses into an earlier passage, and needs a known position', () => {
  const nb: Neighbours = new Map(Array.from({ length: 30 }, (_, i) => [i, { text: `s${i}` }]));
  const idx = new Map([['a', 10], ['b', 14]]);
  const out = pickPassages([{ segment_id: 'a', segment_text: 's10' }, { segment_id: 'b', segment_text: 's14' }, { segment_id: 'c', segment_text: 'no position' }], null, null, 4, idx, nb);
  assert.equal(out[0].text.split(' ').length, MAX_SPAN_SEGMENTS);
  assert.equal(out[0].text, 's7 s8 s9 s10 s11 s12 s13');
  assert.equal(out[1].text.includes('s13'), false);         // s13 belongs to the first passage
  assert.ok(out[1].text.startsWith('s14'));
  assert.deepEqual(out[2], { text: 'no position' });
});

test('fallbackPassages: a short text whole; a long one by the windows holding the most query words', () => {
  assert.deepEqual(fallbackPassages('  A short   note. ', 'anything'), [{ text: 'A short note.' }]);
  assert.deepEqual(fallbackPassages('   ', 'anything'), []);
  const long = `${'alpha beta gamma. '.repeat(60)}The launch date is the ninth of March. ${'delta epsilon. '.repeat(60)}The launch venue is Sofia.`;
  const out = fallbackPassages(long, 'what is the launch date and venue', 2);
  assert.equal(out.length, 2);
  assert.ok(out.some(p => p.text.includes('ninth of March')) && out.some(p => p.text.includes('Sofia')));
  assert.ok(out.every(p => p.text.length <= PASSAGE_CHARS + 1 && !('n' in p)));
  // no query word anywhere: the opening of the text, once
  const none = fallbackPassages(long, 'zzz qqq', 2);
  assert.equal(none.length, 1);
  assert.ok(none[0].text.startsWith('alpha beta gamma.'));
  assert.deepEqual(queryTerms('What is the launch date, and the venue?'), ['launch', 'date', 'venue']);
});

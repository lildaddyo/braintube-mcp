import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseRuns } from './search.js';
import type { AdaptiveResult } from '../db/supabase.js';

const r = (id: string): AdaptiveResult => ({ id, title: id, summary: null, source_type: 'x', source_url: null, channel_name: null, tags: null, saved_at: '', similarity: 0, strategy: 's' });

test('item found by both runs beats item found by one run at rank 1', () => {
  const out = fuseRuns([r('junk'), r('a'), r('b'), r('c'), r('d'), r('e'), r('f'), r('target')], [r('target'), r('x')], 5);
  assert.equal(out[0].id, 'target');
});

test('tie breaks toward the English run', () => {
  const out = fuseRuns([r('bgOnly')], [r('enOnly')], 2);
  assert.deepEqual(out.map(o => o.id), ['enOnly', 'bgOnly']);
});

test('respects limit and dedupes', () => {
  const out = fuseRuns([r('a'), r('b'), r('c')], [r('a'), r('b'), r('d')], 3);
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map(o => o.id)).size, 3);
  assert.deepEqual(out.slice(0, 2).map(o => o.id), ['a', 'b']);
});

test('empty english run returns original order truncated', () => {
  const out = fuseRuns([r('a'), r('b'), r('c')], [], 2);
  assert.deepEqual(out.map(o => o.id), ['a', 'b']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexicalRpc, koPgroongaOn } from './lexical-nl.js';
import { SCRIPT_CASES } from './script-cases.js';

test('lexicalRpc: flag off = the plain RPC for every query', () => {
  for (const c of SCRIPT_CASES) {
    assert.equal(lexicalRpc('adaptive_search', c.text, false), 'adaptive_search', c.text);
    assert.equal(lexicalRpc('search_segments', c.text, false), 'search_segments', c.text);
  }
});

test('lexicalRpc: flag on = the _nl twin only for non-Latin queries (shared case table)', () => {
  for (const c of SCRIPT_CASES) {
    assert.equal(lexicalRpc('hybrid_search', c.text, true), c.nonLatin ? 'hybrid_search_nl' : 'hybrid_search', c.text);
  }
  assert.equal(lexicalRpc('adaptive_search', '김치찌개 끓이는 법', true), 'adaptive_search_nl');
  assert.equal(lexicalRpc('adaptive_search', 'how to make kimchi stew', true), 'adaptive_search');
  assert.equal(lexicalRpc('adaptive_search', null, true), 'adaptive_search');
});

test('koPgroongaOn: only the exact value "on" enables it (default off)', () => {
  const prev = process.env.KO_PGROONGA;
  try {
    delete process.env.KO_PGROONGA;
    assert.equal(koPgroongaOn(), false);
    process.env.KO_PGROONGA = 'true';
    assert.equal(koPgroongaOn(), false);
    process.env.KO_PGROONGA = 'on';
    assert.equal(koPgroongaOn(), true);
  } finally {
    if (prev === undefined) delete process.env.KO_PGROONGA; else process.env.KO_PGROONGA = prev;
  }
});

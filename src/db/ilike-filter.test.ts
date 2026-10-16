import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ilikeAnyFilter, isStatementTimeout } from './supabase.js';

test('ilike filter double-quotes the value so commas and dots stay inside it', () => {
  assert.equal(
    ilikeAnyFilter(['title', 'summary'], 'Swift package, glass blobs. v1.2: (beta)'),
    'title.ilike."%Swift package, glass blobs. v1.2: (beta)%",summary.ilike."%Swift package, glass blobs. v1.2: (beta)%"',
  );
});

test('ilike filter escapes double quotes and backslashes', () => {
  assert.equal(ilikeAnyFilter(['title'], 'say "hi" \\ bye'), 'title.ilike."%say \\"hi\\" \\\\ bye%"');
});

test('statement timeout detection', () => {
  assert.equal(isStatementTimeout('canceling statement due to statement timeout'), true);
  assert.equal(isStatementTimeout('permission denied'), false);
  assert.equal(isStatementTimeout(undefined), false);
});

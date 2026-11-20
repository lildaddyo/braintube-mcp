import test from 'node:test';
import assert from 'node:assert/strict';
import { titleMatcher } from './youtube-channel.js';

test('titleMatcher: alternatives with "|", all words of one alternative, case-insensitive', () => {
  const m = titleMatcher('Theo Von|Theo');
  assert.ok(m('Joe Rogan Experience #2054 - Theo Von'));
  assert.ok(m('JRE MMA Show with THEO'));
  assert.ok(!m('Joe Rogan Experience #2100 - Shane Gillis'));
  assert.ok(titleMatcher(undefined)('anything'));
  assert.ok(!titleMatcher('theo von')('Theo Walcott'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectScript } from './script.js';
import { SCRIPT_CASES } from './script-cases.js';

// Same table as dark-n-cozy supabase/functions/_shared/script_test.ts.
test('script detector: shared case table', () => {
  for (const c of SCRIPT_CASES) {
    const r = detectScript(c.text);
    assert.deepEqual(
      { script: r.script, share: Math.round(r.nonLatinShare * 100) / 100, nonLatin: r.nonLatin },
      { script: c.script, share: c.share, nonLatin: c.nonLatin },
      `${JSON.stringify(c.text)} (${c.note})`,
    );
  }
});

test('script detector: null and undefined are "none"', () => {
  assert.equal(detectScript(null).script, 'none');
  assert.equal(detectScript(undefined).nonLatin, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TRANSLATE_MODEL, translationParams } from './lib/openai.js';

// OpenAI shuts these down 2027-01-14 (developers.openai.com/api/docs/deprecations). A call to one
// fails, and translation failures are silent (null -> original query), so catch them here instead.
const RETIRED = /['"`](gpt-4o(-mini)?|gpt-4\.1(-mini|-nano)?|gpt-4-turbo|gpt-3\.5-turbo|chatgpt-4o-latest)['"`]/;

// The price table keeps gpt-4o-mini so a QUERY_TRANSLATE_MODEL rollback still logs cost.
const ALLOWED = new Set(['lib/usage-log.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

test('no retired OpenAI chat model is named in server code', () => {
  const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const hits = sourceFiles(root)
    .map((f) => relative(root, f).replace(/\\/g, '/'))
    .filter((rel) => !ALLOWED.has(rel))
    .flatMap((rel) => readFileSync(join(root, rel), 'utf8').split('\n')
      .map((line, i) => (RETIRED.test(line) ? `${rel}:${i + 1}: ${line.trim()}` : null))
      .filter((x): x is string => x !== null));
  assert.deepEqual(hits, []);
});

test('the default translation request uses parameters the model accepts', () => {
  assert.equal(TRANSLATE_MODEL, 'gpt-6-luna');
  const p = translationParams(TRANSLATE_MODEL) as Record<string, unknown>;
  assert.equal(p.temperature, undefined);
  assert.equal(p.max_tokens, undefined);
  assert.equal(p.max_completion_tokens, 120);
  assert.equal(p.reasoning_effort, 'none');
  // Rollback through QUERY_TRANSLATE_MODEL keeps the old shape.
  assert.deepEqual(translationParams('gpt-4o-mini'), { temperature: 0, max_tokens: 120 });
});

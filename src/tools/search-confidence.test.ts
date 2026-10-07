import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceOf, lowConfidenceThreshold, searchKnowledgeOutputSchema } from './search.js';

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.SEARCH_LOW_CONFIDENCE_THRESHOLD;
  if (value === undefined) delete process.env.SEARCH_LOW_CONFIDENCE_THRESHOLD;
  else process.env.SEARCH_LOW_CONFIDENCE_THRESHOLD = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.SEARCH_LOW_CONFIDENCE_THRESHOLD;
    else process.env.SEARCH_LOW_CONFIDENCE_THRESHOLD = prev;
  }
}

test('default threshold is 0.6; env can override it or turn it off', () => {
  withEnv(undefined, () => assert.equal(lowConfidenceThreshold(), 0.6));
  withEnv('0.8', () => assert.equal(lowConfidenceThreshold(), 0.8));
  withEnv('off', () => assert.equal(lowConfidenceThreshold(), null));
  withEnv('garbage', () => assert.equal(lowConfidenceThreshold(), 0.6));
});

test('low_confidence is true only when the top re-ranked score is below the threshold', () => {
  withEnv(undefined, () => {
    assert.deepEqual(confidenceOf([{ relevance_score: 0.42 }, { relevance_score: 0.1 }]), { top_relevance: 0.42, low_confidence: true, threshold: 0.6 });
    assert.deepEqual(confidenceOf([{ relevance_score: 0.95 }]), { top_relevance: 0.95, low_confidence: false, threshold: 0.6 });
  });
});

test('no flag when the re-rank did not run (unscored rows, empty list) or the flag is off', () => {
  withEnv(undefined, () => {
    assert.equal(confidenceOf([{}]), null);
    assert.equal(confidenceOf([{ relevance_score: null }]), null);
    assert.equal(confidenceOf([]), null);
  });
  withEnv('off', () => assert.equal(confidenceOf([{ relevance_score: 0.1 }]), null));
});

test('output schema accepts the confidence block and still accepts responses without it', () => {
  const base = { data: [{ id: 'a', relevance_score: 0.3 }], taint_level: 0 };
  assert.ok(searchKnowledgeOutputSchema.safeParse(base).success);
  assert.ok(searchKnowledgeOutputSchema.safeParse({ ...base, confidence: { top_relevance: 0.3, low_confidence: true, threshold: 0.6 } }).success);
});

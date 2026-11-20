import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBody, chatAnswerCredits } from './credits.js';
import { ingestItemCredits } from './ingest-credits.js';

test('chat answer tiers by length', () => {
  assert.equal(chatAnswerCredits('a'.repeat(1600)), 1);
  assert.equal(chatAnswerCredits('a'.repeat(1604)), 2);
  assert.equal(chatAnswerCredits('a'.repeat(6004)), 3);
  assert.equal(chatAnswerCredits('a'.repeat(9000), 2), 6);
});

test('ingest item credits: 1 per item, +1 per extra 25k chars, cap 4', () => {
  assert.equal(ingestItemCredits(10), 1);
  assert.equal(ingestItemCredits(25_000), 1);
  assert.equal(ingestItemCredits(25_001), 2);
  assert.equal(ingestItemCredits(75_001), 4);
  assert.equal(ingestItemCredits(1_000_000), 4);
});

test('settle measures the answer inside the untrusted_content envelope', () => {
  const inner = 'a'.repeat(1500);
  const wrapped = `[BrainTube] notice ${'x'.repeat(400)}
<untrusted_content nonce="N1">
${inner}
</untrusted_content nonce="N1">`;
  assert.equal(answerBody(wrapped), inner);
  assert.equal(chatAnswerCredits(answerBody(wrapped)), 1);
  assert.equal(answerBody('plain answer'), 'plain answer');
});

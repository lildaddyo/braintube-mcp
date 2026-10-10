import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEALED_PREFIX, isSealed, open, openFromStorage, seal, sealForStorage, secretBoxKey } from './secret-box.js';

const KEY_ENV = { SECRET_BOX_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv;
const OTHER_ENV = { SECRET_BOX_KEY: 'z'.repeat(40) } as NodeJS.ProcessEnv;
const NO_KEY = {} as NodeJS.ProcessEnv;

test('key: unset, blank or short keys count as not configured', () => {
  assert.equal(secretBoxKey(NO_KEY), null);
  assert.equal(secretBoxKey({ SECRET_BOX_KEY: '   ' } as NodeJS.ProcessEnv), null);
  assert.equal(secretBoxKey({ SECRET_BOX_KEY: 'short' } as NodeJS.ProcessEnv), null);
  assert.equal(secretBoxKey(KEY_ENV)?.length, 32);
});

test('seal/open round-trips and never stores the plain text', () => {
  const key = secretBoxKey(KEY_ENV)!;
  const sealed = seal('ntn_example_token_value', key);
  assert.ok(sealed.startsWith(SEALED_PREFIX));
  assert.ok(!sealed.includes('ntn_example_token_value'));
  assert.equal(open(sealed, key), 'ntn_example_token_value');
  assert.notEqual(seal('same', key), seal('same', key)); // random IV
});

test('open rejects a wrong key and a tampered value', () => {
  const sealed = seal('secret', secretBoxKey(KEY_ENV)!);
  assert.throws(() => open(sealed, secretBoxKey(OTHER_ENV)!));
  const parts = sealed.split(':');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => open(parts.join(':'), secretBoxKey(KEY_ENV)!));
  assert.throws(() => open(SEALED_PREFIX + 'a:b', secretBoxKey(KEY_ENV)!));
});

test('storage: sealed with a key, plain (legacy behaviour) without one', () => {
  assert.ok(isSealed(sealForStorage('tok', KEY_ENV)));
  assert.equal(sealForStorage('tok', NO_KEY), 'tok');
});

test('storage read: legacy plain values pass through, sealed values open, sealed without key throws', () => {
  assert.equal(openFromStorage('secret_legacy', NO_KEY), 'secret_legacy');
  assert.equal(openFromStorage('secret_legacy', KEY_ENV), 'secret_legacy');
  const stored = sealForStorage('tok', KEY_ENV);
  assert.equal(openFromStorage(stored, KEY_ENV), 'tok');
  assert.throws(() => openFromStorage(stored, NO_KEY), /SECRET_BOX_KEY/);
});

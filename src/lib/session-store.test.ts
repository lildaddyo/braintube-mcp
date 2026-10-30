import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, envInt, type EvictReason } from './session-store.js';

const MIN = 60_000;

function makeStore(opts: { idleMs?: number; maxSessions?: number } = {}) {
  let now = 0;
  const evicted: Array<[string, string, EvictReason]> = [];
  const store = new SessionStore<string>({
    idleMs: opts.idleMs ?? 30 * MIN,
    maxSessions: opts.maxSessions ?? 100,
    now: () => now,
    onEvict: (id, value, reason) => evicted.push([id, value, reason]),
  });
  return { store, evicted, advance: (ms: number) => { now += ms; } };
}

test('get returns the value only for the user who created the session', () => {
  const { store } = makeStore();
  store.set('s1', 't1', 'alice');
  assert.equal(store.get('s1', 'alice'), 't1');
  assert.equal(store.get('s1', 'bob'), undefined);
  assert.equal(store.get('nope', 'alice'), undefined);
});

test('sweep evicts only sessions idle longer than the TTL', () => {
  const { store, evicted, advance } = makeStore();
  store.set('old', 'a', 'u');
  advance(20 * MIN);
  store.set('new', 'b', 'u');
  advance(11 * MIN); // old idle 31 min, new idle 11 min
  assert.equal(store.sweep(), 1);
  assert.deepEqual(evicted, [['old', 'a', 'idle']]);
  assert.equal(store.get('new', 'u'), 'b');
  assert.equal(store.size, 1);
});

test('an active session survives past the old hourly wipe', () => {
  const { store, evicted, advance } = makeStore();
  store.set('s', 'a', 'u');
  for (let i = 0; i < 12; i++) { // 2 hours, used every 10 minutes
    advance(10 * MIN);
    assert.equal(store.get('s', 'u'), 'a');
    store.sweep();
  }
  assert.deepEqual(evicted, []);
});

test('a session with a request in flight (open SSE stream) is never idle-evicted; ending it restarts the clock', () => {
  const { store, evicted, advance } = makeStore();
  store.set('s', 'a', 'u');
  const end = store.begin('s');
  advance(2 * 60 * MIN);
  assert.equal(store.sweep(), 0);
  end();
  end(); // idempotent
  advance(29 * MIN);
  assert.equal(store.sweep(), 0);
  advance(2 * MIN);
  assert.equal(store.sweep(), 1);
  assert.deepEqual(evicted, [['s', 'a', 'idle']]);
});

test('the cap evicts the least recently used session, preferring idle ones', () => {
  const { store, evicted, advance } = makeStore({ maxSessions: 3 });
  store.set('a', 'A', 'u'); advance(1);
  store.set('b', 'B', 'u'); advance(1);
  store.set('c', 'C', 'u'); advance(1);
  store.get('a', 'u'); // a is now most recent; b is LRU
  store.set('d', 'D', 'u');
  assert.deepEqual(evicted, [['b', 'B', 'cap']]);
  assert.equal(store.size, 3);

  store.begin('c'); // c busy: next eviction skips it even though it is LRU
  store.set('e', 'E', 'u');
  assert.deepEqual(evicted.at(-1), ['a', 'A', 'cap']);
  assert.equal(store.size, 3);
});

test('the cap is hard: with every session busy the oldest still goes', () => {
  const { store, evicted } = makeStore({ maxSessions: 2 });
  store.set('a', 'A', 'u'); store.begin('a');
  store.set('b', 'B', 'u'); store.begin('b');
  store.set('c', 'C', 'u');
  assert.equal(store.size, 2);
  assert.deepEqual(evicted, [['a', 'A', 'cap']]);
});

test('delete removes without the evict callback; closeAll evicts everything with reason shutdown', () => {
  const { store, evicted } = makeStore();
  store.set('a', 'A', 'u');
  store.set('b', 'B', 'u');
  assert.equal(store.delete('a'), true);
  assert.deepEqual(evicted, []);
  assert.equal(store.closeAll(), 1);
  assert.deepEqual(evicted, [['b', 'B', 'shutdown']]);
  assert.equal(store.size, 0);
});

test('an evict callback that re-enters delete (transport.onclose) or throws does not break the sweep', () => {
  let now = 0;
  const store: SessionStore<string> = new SessionStore<string>({
    idleMs: 10,
    maxSessions: 10,
    now: () => now,
    onEvict: (id) => {
      store.delete(id);
      if (id === 'a') throw new Error('boom');
    },
  });
  store.set('a', 'A', 'u');
  store.set('b', 'B', 'u');
  now = 100;
  assert.equal(store.sweep(), 2);
  assert.equal(store.size, 0);
});

test('envInt reads positive integers and falls back otherwise', () => {
  const key = 'BT_TEST_ENV_INT';
  delete process.env[key];
  assert.equal(envInt(key, 7), 7);
  process.env[key] = '42';
  assert.equal(envInt(key, 7), 42);
  for (const bad of ['', 'abc', '-3', '0']) {
    process.env[key] = bad;
    assert.equal(envInt(key, 7), 7);
  }
  delete process.env[key];
});

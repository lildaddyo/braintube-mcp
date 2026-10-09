import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actingUserHeaders, edgeAuthHeaders } from './edge-auth.js';

const USER = '11111111-2222-3333-4444-555555555555';

function withServiceKey(value: string | undefined, fn: () => void) {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (value === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
}

test('a JWT caller is forwarded as before (no service key, no acting user)', () => {
  withServiceKey('svc', () => {
    assert.deepEqual(edgeAuthHeaders(USER, 'user-jwt'), {
      'Content-Type': 'application/json', Authorization: 'Bearer user-jwt', apikey: 'user-jwt',
    });
  });
});

test('an API-key caller (no JWT) gets the service key + acting user instead of nothing', () => {
  withServiceKey('svc', () => {
    assert.deepEqual(edgeAuthHeaders(USER, undefined), {
      'Content-Type': 'application/json', Authorization: 'Bearer svc', 'x-bt-acting-user': USER,
    });
    assert.deepEqual(edgeAuthHeaders(USER, ''), edgeAuthHeaders(USER));
  });
});

test('the counted marker is only sent when asked for', () => {
  withServiceKey('svc', () => {
    assert.equal(actingUserHeaders(USER)['x-bt-fair-use'], undefined);
    assert.equal(actingUserHeaders(USER, { fairUseCounted: true })['x-bt-fair-use'], 'counted');
  });
});

test('without a service key nothing identity-bearing is sent', () => {
  withServiceKey(undefined, () => {
    assert.deepEqual(edgeAuthHeaders(USER), { 'Content-Type': 'application/json' });
  });
});

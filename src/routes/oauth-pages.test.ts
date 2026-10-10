import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';

const { loginForm, errorPage } = await import('./oauth.js');

// The OAuth pages follow the brand canon (bt-brand-canon §1–§2). These pin the
// values that drifted before: an orange "Tube", flat grey surfaces and a flat
// violet button that matched nothing on brain-tube.com.

test('login page uses the canon palette and type roles', () => {
  const html = loginForm('s1');
  for (const token of ['#f5f0ff', '#a78bfa', '#8b5cf6 0%, #6d28d9 100%', '#6D4DE6 0%, #9F4DBF 60%, #BD6FA3 100%', 'Fraunces', 'Space Grotesk']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
  for (const stale of ['#FF6B1A', '#866CEF', '#0a0a0a', '#141414']) {
    assert.ok(!html.includes(stale), `stale value ${stale} still present`);
  }
});

test('OAuth pages load images only inline (helmet CSP img-src is self + data:)', () => {
  for (const html of [loginForm('s1'), errorPage('x')]) {
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0, 'logo missing');
    for (const src of srcs) assert.ok(src.startsWith('data:image/'), `external image ${src.slice(0, 40)}`);
  }
});

test('OAuth pages still escape state and messages', () => {
  assert.ok(!loginForm('"><script>x</script>').includes('<script>x'));
  assert.ok(!errorPage('<b>bad</b>').includes('<b>bad'));
  assert.ok(loginForm('s1', '<i>e</i>').includes('&lt;i&gt;e&lt;/i&gt;'));
});

// --- BTMCP-04: the login form names who is asking and where the code goes ---

test('loginForm shows the requesting client and redirect host, escaped, when given', () => {
  const html = loginForm('s1', undefined, { clientName: 'Evil <b>Co</b>', redirectHost: 'chatgpt.com' });
  assert.ok(html.includes('Evil &lt;b&gt;Co&lt;/b&gt;'));
  assert.ok(html.includes('<strong>chatgpt.com</strong>'));
  assert.ok(html.includes('Only continue if you started this connection yourself'));
  assert.ok(!loginForm('s1').includes('class="requester"'));
});

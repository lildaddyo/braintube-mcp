import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRedirectUriAllowed, normalizeRedirectUri, verifyPkce } from './oauth-store.js';
import { createHash } from 'crypto';

// Test inputs are assembled from char codes so this file stays plain ASCII.
const BS = String.fromCharCode(92);
const AT = String.fromCharCode(64);
const chr = (code: number) => String.fromCharCode(code);
const show = (s: string) => JSON.stringify(s);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Allowed shapes; each is already in canonical form.
const ACCEPTED_CALLBACKS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://smithery.run/oauth/callback',
  'https://chat.claude.ai/x/y',
  'https://a.b.claude.ai/cb',
  'https://console.anthropic.com/cb',
  'https://cursor.sh/a',
  'https://x.cursor.sh/a',
  'https://codeium.com/a',
  'https://x.windsurf.dev/a',
  'http://localhost:3000/cb',
  'http://localhost/cb',
  'http://127.0.0.1:8080/a/b',
  'http://[::1]:8080/cb',
];

// Base URIs used to place one odd character at the start, the end and inside the path.
const BASES = [
  'https://chat.claude.ai/cb',
  'https://claude.ai/api/mcp/auth_callback',
  'https://smithery.run/oauth/callback',
  'http://localhost:3000/cb',
  'http://[::1]:8080/cb',
];

const withChar = (base: string, c: string) => [c + base, base + c, base.slice(0, -1) + c + base.slice(-1)];

function assertRejectedWithChar(code: number) {
  const c = chr(code);
  for (const base of BASES) {
    for (const uri of withChar(base, c)) {
      const label = 'U+' + code.toString(16) + ' in ' + show(uri);
      assert.equal(isRedirectUriAllowed(uri), false, label);
      assert.equal(normalizeRedirectUri(uri), null, label);
    }
  }
}

test('rejects evil.com', () => {
  assert.equal(isRedirectUriAllowed('https://evil.com/cb'), false);
});

test('rejects arbitrary path on claude.ai (only the real callback path is allowed)', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai/cb'), false);
  assert.equal(isRedirectUriAllowed('https://claude.ai/evil'), false);
});

test('accepts claude.ai real callback path', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback'), true);
});

test('accepts claude.com real callback path (mirrors claude.ai)', () => {
  assert.equal(isRedirectUriAllowed('https://claude.com/api/mcp/auth_callback'), true);
});

test('rejects arbitrary path on claude.com', () => {
  assert.equal(isRedirectUriAllowed('https://claude.com/evil'), false);
});

test('rejects redirect_uri with userinfo or query/fragment smuggling', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai@evil.com/api/mcp/auth_callback'), false);
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback?x=1'), false);
  assert.equal(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback#x'), false);
});

test('accepts subdomain *.claude.ai', () => {
  assert.equal(isRedirectUriAllowed('https://chat.claude.ai/cb'), true);
});

test('rejects host smuggling via path', () => {
  // The * → [^/]* substitution must prevent the host wildcard from
  // crossing a / and matching a different domain in the path.
  assert.equal(isRedirectUriAllowed('https://evil.com/?x=.claude.ai/cb'), false);
});

test('rejects sibling domain that just contains claude.ai', () => {
  assert.equal(isRedirectUriAllowed('https://claude.ai.evil.com/cb'), false);
});

test('accepts localhost with port and path', () => {
  assert.equal(isRedirectUriAllowed('http://localhost:3000/cb'), true);
});

test('rejects http on non-loopback host', () => {
  assert.equal(isRedirectUriAllowed('http://claude.ai/cb'), false);
});

test('rejects non-canonical redirect URIs on allowlisted domains', () => {
  for (const domain of ['claude.ai', 'anthropic.com', 'cursor.sh', 'windsurf.dev']) {
    const uri = 'https://evil.com' + BS + '.' + domain + '/x';
    assert.equal(isRedirectUriAllowed(uri), false, show(uri));
    assert.equal(normalizeRedirectUri(uri), null, show(uri));
  }
});

test('rejects non-canonical redirect URI spellings', () => {
  const variants = [
    'https://evil.com' + BS + BS + '.claude.ai/x',
    'https://evil.com' + BS + 'x.claude.ai/x',
    'https://evil.com' + BS + '@x.claude.ai/',
    'https://x.claude.ai' + BS + '@evil.com/',
    'https://chat.claude.ai' + BS + 'cb',
    'https://chat.claude.ai/cb' + BS,
    'https:' + BS + BS + 'evil.com' + BS + '.claude.ai' + BS + 'x',
    'https:' + BS + BS + 'chat.claude.ai' + BS + 'cb',
    'https://claude.ai' + BS + 'api' + BS + 'mcp' + BS + 'auth_callback',
    'https://claude.ai/api' + BS + 'mcp/auth_callback',
    'https://smithery.run' + BS + 'oauth' + BS + 'callback',
    'https://evil.com:80' + BS + '.claude.ai/x',
    'http://localhost' + BS + '.evil.com/',
    'http://127.0.0.1:8080' + BS + '@evil.com/',
    'https://evil.com%5C.claude.ai/x',
    'https://evil.com%2F.claude.ai/x',
  ];
  for (const uri of variants) {
    assert.equal(isRedirectUriAllowed(uri), false, show(uri));
    assert.equal(normalizeRedirectUri(uri), null, show(uri));
  }
  assertRejectedWithChar(92);
});

test('rejects redirect URIs containing control characters', () => {
  for (const code of [...range(0x00, 0x1f), ...range(0x7f, 0x9f)]) assertRejectedWithChar(code);
});

test('rejects redirect URIs containing whitespace', () => {
  const spaces = [0x20, 0xa0, 0x1680, ...range(0x2000, 0x200a), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
  for (const code of spaces) assertRejectedWithChar(code);
});

test('accepts bracketed IPv6 loopback', () => {
  assert.equal(isRedirectUriAllowed('http://[::1]:8080/cb'), true);
  assert.equal(isRedirectUriAllowed('http://[::1]/cb'), true);
  assert.equal(normalizeRedirectUri('http://[0:0:0:0:0:0:0:1]:8080/cb'), 'http://[::1]:8080/cb');
});

test('rejects https and look-alike hosts on loopback', () => {
  for (const uri of [
    'https://localhost:3000/cb',
    'https://127.0.0.1:8080/cb',
    'https://[::1]:8080/cb',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://[::1].evil.com',
    'http://127.0.0.2/cb',
    'http://[::2]/cb',
    'http://localhost./cb',
  ]) {
    assert.equal(isRedirectUriAllowed(uri), false, show(uri));
  }
});

test('keeps accepting every allowlisted callback shape unchanged', () => {
  for (const uri of ACCEPTED_CALLBACKS) {
    assert.equal(isRedirectUriAllowed(uri), true, show(uri));
    assert.equal(normalizeRedirectUri(uri), uri, show(uri));
  }
});

test('normalizeRedirectUri returns the canonical form of an allowed URI', () => {
  const cases: Array<[string, string]> = [
    ['HTTPS://Claude.AI:443/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback'],
    ['https://claude.ai/api/mcp/x/../auth_callback', 'https://claude.ai/api/mcp/auth_callback'],
    ['https://CHAT.claude.ai/cb', 'https://chat.claude.ai/cb'],
    ['https://chat.claude.ai:443/cb', 'https://chat.claude.ai/cb'],
    ['https://chat.claude.ai', 'https://chat.claude.ai/'],
    ['HTTP://LOCALHOST:3000/cb', 'http://localhost:3000/cb'],
    ['http://[0:0:0:0:0:0:0:1]:8080/cb', 'http://[::1]:8080/cb'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeRedirectUri(input), expected, show(input));
    assert.equal(normalizeRedirectUri(expected), expected, show(expected));
  }
});

test('normalizeRedirectUri returns null for anything not allowed', () => {
  for (const input of ['', 'not a url', 'https://evil.com/cb', 'https://claude.ai/cb', 'http://claude.ai/cb', 'javascript:alert(1)']) {
    assert.equal(normalizeRedirectUri(input), null, show(input));
  }
  for (const input of [undefined, null, 123, {}, ['https://claude.ai/api/mcp/auth_callback']]) {
    assert.equal(normalizeRedirectUri(input as unknown as string), null);
    assert.equal(isRedirectUriAllowed(input as unknown as string), false);
  }
});

test('rejects ports, trailing slashes and other paths on exact callbacks', () => {
  for (const uri of [
    'https://claude.ai:8443/api/mcp/auth_callback',
    'https://claude.com:8443/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback/',
    'https://claude.ai/api/mcp/auth_callback/..',
    'https://claude.ai/api/mcp/%2e%2e/evil',
    'https://claude.ai/api/mcp/auth%5Fcallback',
    'https://claude.ai/api/mcp/auth_callback;x=1',
    'https://smithery.run:8443/oauth/callback',
    'https://smithery.run/oauth/callback/',
    'https://chat.claude.ai:8443/cb',
  ]) {
    assert.equal(isRedirectUriAllowed(uri), false, show(uri));
  }
});

test('rejects non-https schemes outside loopback', () => {
  for (const uri of [
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://claude.ai/api/mcp/auth_callback',
    '//chat.claude.ai/cb',
    'HTTP://CLAUDE.AI/api/mcp/auth_callback',
    'file:///etc/passwd',
    'ws://localhost:3000/cb',
    'ftp://localhost/cb',
  ]) {
    assert.equal(isRedirectUriAllowed(uri), false, show(uri));
  }
});

test('glob entries never match a normalised URL whose host is elsewhere', () => {
  // What is compared is the normalised form, whose host must itself be allowlisted.
  const input = 'https://evil.com' + BS + '.claude.ai/x';
  const u = new URL(input);
  const normalized = `${u.protocol}//${u.host}${u.pathname}`;
  assert.equal(u.hostname, 'evil.com');
  assert.equal(isRedirectUriAllowed(normalized), false, show(normalized));

  for (const domain of ['claude.ai', 'anthropic.com', 'cursor.sh', 'windsurf.dev', 'codeium.com']) {
    for (const uri of [
      `https://evil.com/.${domain}/x`,
      `https://evil.com/x.${domain}/y`,
      `https://${domain}.evil.com/x`,
      `https://evil${domain}/x`,
    ]) {
      assert.equal(isRedirectUriAllowed(uri), false, show(uri));
    }
  }
});

test('rejects userinfo, query and fragment on loopback and glob hosts', () => {
  for (const uri of [
    'http://x' + AT + 'localhost:3000/cb',
    'http://localhost:3000/cb?x=1',
    'http://localhost:3000/cb#x',
    'https://x' + AT + 'chat.claude.ai/cb',
    'https://chat.claude.ai/cb?x=1',
    'https://chat.claude.ai/cb#x',
  ]) {
    assert.equal(isRedirectUriAllowed(uri), false, show(uri));
  }
});

test('verifyPkce rejects plain method even with matching verifier/challenge', () => {
  assert.equal(verifyPkce('secret', 'secret', 'plain'), false);
});

test('verifyPkce accepts a correct S256 verifier', () => {
  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(verifyPkce(verifier, challenge, 'S256'), true);
});

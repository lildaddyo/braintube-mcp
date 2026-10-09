import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

// ─── redirect_uri allowlist ───────────────────────────────────────────────────
// Every entry is evaluated against the parsed, normalised URL
// (`protocol//host/path`), never the raw string. Exact callbacks (confirmed real
// paths) match on origin + pathname only — no path is left open to registration.
// Providers whose exact callback path hasn't been confirmed keep a glob entry;
// `*` matches a single path/host segment (no slashes), `**` matches across
// slashes. Adjust deliberately — these gate every redirect we emit, so a
// permissive entry is an open-redirect oracle for that path (though never for a
// domain the attacker doesn't control).
const EXACT_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback', // Anthropic's newer domain — keep in sync with claude.ai
  'https://smithery.run/oauth/callback',
  // ChatGPT's stable callback, used when the server advertises issuer
  // identification (and by legacy connectors). developers.openai.com/plugins/build/auth
  'https://chatgpt.com/connector_platform_oauth_redirect',
]);

// TODO: confirm exact callback paths for these and move them into
// EXACT_REDIRECT_URIS — left as path-wildcards for now because guessing wrong
// would break live integrations. cursor.sh is also worth re-checking: Cursor's
// current product domain is cursor.com, not cursor.sh.
const REDIRECT_URI_GLOB_ALLOWLIST = [
  'https://*.claude.ai/**',
  'https://*.anthropic.com/**',
  'https://cursor.sh/**',
  'https://*.cursor.sh/**',
  'https://codeium.com/**',
  'https://*.windsurf.dev/**',
  // ChatGPT without issuer identification: one callback per connection,
  // https://chatgpt.com/connector/oauth/{callback_id}. Single segment only.
  'https://chatgpt.com/connector/oauth/*',
];

// URL.hostname keeps the brackets on IPv6 literals.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Canonical spellings only: raw input containing any of these is rejected.
const NON_CANONICAL_CHARS = /[\\\x00-\x20\x7f-\x9f\s]/;

function globToRegex(p: string): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*') + '$');
}

const allowlistRegexes = REDIRECT_URI_GLOB_ALLOWLIST.map(globToRegex);

// The single place a redirect_uri is judged. Returns the normalised
// `protocol//host/path` of an allowed URI, or null. Callers register, compare
// and redirect to this returned value, never to the raw input.
export function normalizeRedirectUri(uri: string): string | null {
  if (typeof uri !== 'string' || NON_CANONICAL_CHARS.test(uri)) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.username || u.password) return null; // no userinfo smuggling
  if (u.search || u.hash) return null; // no query/fragment smuggling

  // RFC 8252 §7.3 — native/CLI clients bind an ephemeral loopback port; port
  // and path are intentionally unconstrained.
  const loopback = u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !loopback) return null;

  const normalized = `${u.protocol}//${u.host}${u.pathname}`;
  if (loopback || EXACT_REDIRECT_URIS.has(normalized) || allowlistRegexes.some((re) => re.test(normalized))) {
    return normalized;
  }
  return null;
}

export function isRedirectUriAllowed(uri: string): boolean {
  return normalizeRedirectUri(uri) !== null;
}

// ─── Registered OAuth clients (RFC 7591 dynamic client registration) ──────────
// Stateless: the client_id itself carries the registered redirect URIs and name,
// signed with HMAC-SHA256. A Railway redeploy or restart therefore no longer
// forgets clients — before this, every deploy wiped the in-memory registry and
// connectors (Claude, Cursor, …) had to be removed and re-added. Registration is
// still unauthenticated, but it now stores nothing, so registration spam cannot
// grow memory. Redirect URIs were validated at /oauth/register and are re-checked
// at /oauth/authorize, so a valid signature can only ever name allowlisted URIs.
//
// Signing key: OAUTH_CLIENT_SIGNING_KEY when set, otherwise a key derived from
// SUPABASE_SERVICE_ROLE_KEY. Changing the key invalidates every client_id
// (users would re-add the connector), so set OAUTH_CLIENT_SIGNING_KEY before
// rotating the Supabase key.

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
  registeredAt: number;
}

const CLIENT_ID_PREFIX = 'bt_client_v2.';
let ephemeralKey: Buffer | undefined;

function clientSigningKey(): Buffer {
  const explicit = process.env.OAUTH_CLIENT_SIGNING_KEY;
  if (explicit) return createHash('sha256').update(explicit).digest();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (service) return createHmac('sha256', service).update('braintube-oauth-client-id-v2').digest();
  // No secret configured (local dev / tests): a per-process key.
  ephemeralKey ??= randomBytes(32);
  return ephemeralKey;
}

function sign(payload: string): string {
  return createHmac('sha256', clientSigningKey()).update(payload).digest('base64url');
}

export function registerClient(redirectUris: string[], clientName: string): OAuthClient {
  const registeredAt = Date.now();
  const payload = Buffer.from(
    JSON.stringify({ r: redirectUris, n: clientName.slice(0, 100), t: registeredAt }),
  ).toString('base64url');
  const clientId = `${CLIENT_ID_PREFIX}${payload}.${sign(payload)}`;
  return {
    clientId,
    // client_secret is issued for RFC 7591 compliance; the token endpoint
    // authenticates with PKCE (token_endpoint_auth_methods: none) instead.
    clientSecret: sign(`secret:${clientId}`),
    redirectUris,
    clientName,
    registeredAt,
  };
}

export function getClient(clientId: string): OAuthClient | undefined {
  if (typeof clientId !== 'string' || !clientId.startsWith(CLIENT_ID_PREFIX)) return undefined;
  const parts = clientId.slice(CLIENT_ID_PREFIX.length).split('.');
  if (parts.length !== 2) return undefined;
  const [payload, mac] = parts;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      r?: unknown; n?: unknown; t?: unknown;
    };
    if (!Array.isArray(data.r) || !data.r.every((u) => typeof u === 'string')) return undefined;
    return {
      clientId,
      clientSecret: sign(`secret:${clientId}`),
      redirectUris: data.r as string[],
      clientName: typeof data.n === 'string' ? data.n : 'MCP Client',
      registeredAt: typeof data.t === 'number' ? data.t : 0,
    };
  } catch {
    return undefined;
  }
}

// ─── Pending authorize requests (state → PKCE params + meta) ─────────────────
// Stored while the user is on the login form. Expire after 10 minutes.

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  createdAt: number;
}

const pendingAuths = new Map<string, PendingAuth>();

export function storePendingAuth(data: Omit<PendingAuth, 'createdAt'>): void {
  // Sweep expired entries on each write to avoid unbounded growth
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of pendingAuths) {
    if (val.createdAt < cutoff) pendingAuths.delete(key);
  }
  pendingAuths.set(data.state, { ...data, createdAt: Date.now() });
}

export function consumePendingAuth(state: string): PendingAuth | undefined {
  const val = pendingAuths.get(state);
  if (!val) return undefined;
  pendingAuths.delete(state);
  if (Date.now() - val.createdAt > 10 * 60 * 1000) return undefined;
  return val;
}

// Read a pending auth without consuming it. Used by side-channel flows
// (e.g. Google sign-in start) that need to confirm the Claude OAuth flow
// is still alive but must leave the entry in place for the eventual
// callback to consume.
export function peekPendingAuth(state: string): PendingAuth | undefined {
  const val = pendingAuths.get(state);
  if (!val) return undefined;
  if (Date.now() - val.createdAt > 10 * 60 * 1000) return undefined;
  return val;
}

// Re-store a pending auth (e.g. after a failed login attempt so the user can retry)
export function restorePendingAuth(data: PendingAuth): void {
  pendingAuths.set(data.state, data);
}

// ─── Auth codes (code → Supabase token pair, single-use, 60 s TTL) ────────────
// Issued after successful login, consumed by the MCP client's token request.

export interface AuthCodeEntry {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: string;
  createdAt: number;
}

const authCodes = new Map<string, AuthCodeEntry>();

export function issueAuthCode(entry: Omit<AuthCodeEntry, 'createdAt'>): string {
  const code = randomBytes(32).toString('hex');
  authCodes.set(code, { ...entry, createdAt: Date.now() });
  return code;
}

export function consumeAuthCode(code: string): AuthCodeEntry | undefined {
  const entry = authCodes.get(code);
  if (!entry) return undefined;
  authCodes.delete(code); // single-use: delete regardless of expiry
  if (Date.now() - entry.createdAt > 60_000) return undefined; // 60 s TTL
  return entry;
}

// ─── PKCE verification (RFC 7636) ────────────────────────────────────────────
// Only S256 is accepted — matches code_challenge_methods_supported in
// /.well-known/oauth-authorization-server. 'plain' is intentionally not
// supported: it offers no protection against an observer who saw the
// code_challenge in the initial /authorize request replaying it as the verifier.

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string
): boolean {
  if (method !== 'S256') return false;
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

// ─── Refresh failures (RFC 6749 §5.2) ────────────────────────────────────────
// How a failed Supabase refresh is reported to the MCP client. A 4xx from
// Supabase means the refresh token is dead (revoked, reused, or its session was
// signed out everywhere): that is invalid_grant, which RFC 6749 sends as 400,
// and the client should ask the user to sign in again. A 429, a 5xx or a network error
// is our problem, not the user's: answer 503 temporarily_unavailable so the
// client keeps its refresh token and retries, instead of dropping a connector
// that is still valid.

export interface RefreshFailure {
  status: number;
  body: { error: string; error_description: string };
}

export function refreshFailure(upstreamStatus: number | null): RefreshFailure {
  if (upstreamStatus !== null && upstreamStatus >= 400 && upstreamStatus < 500 && upstreamStatus !== 429) {
    return {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Refresh token invalid or expired. User must re-authenticate.' },
    };
  }
  return {
    status: 503,
    body: { error: 'temporarily_unavailable', error_description: 'Could not refresh the token right now. Try again shortly.' },
  };
}

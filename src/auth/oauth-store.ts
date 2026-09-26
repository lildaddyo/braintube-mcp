import { createHash, randomBytes } from 'crypto';

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
// Stored in-memory — clients re-register each session, so loss on restart is fine.
// Registration is unauthenticated (anyone can POST /oauth/register), so entries
// are swept on a TTL the same way pendingAuths is, to bound memory growth from
// anonymous registration spam. There is currently no admin list/revoke endpoint
// for this store — see the CLIENT_TTL_MS comment below before adding one.

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
  registeredAt: number;
}

const clients = new Map<string, OAuthClient>();
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous vs. "clients re-register each session"

export function registerClient(redirectUris: string[], clientName: string): OAuthClient {
  const cutoff = Date.now() - CLIENT_TTL_MS;
  for (const [key, val] of clients) {
    if (val.registeredAt < cutoff) clients.delete(key);
  }

  const clientId = `bt_client_${randomBytes(16).toString('hex')}`;
  const clientSecret = randomBytes(32).toString('hex');
  const client: OAuthClient = {
    clientId,
    clientSecret,
    redirectUris,
    clientName,
    registeredAt: Date.now(),
  };
  clients.set(clientId, client);
  return client;
}

export function getClient(clientId: string): OAuthClient | undefined {
  return clients.get(clientId);
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

import { createHash, randomBytes } from 'crypto';

// ─── redirect_uri allowlist ───────────────────────────────────────────────────
// Patterns that any client may register. `*` matches a single path/host segment
// (no slashes); `**` matches across slashes. Adjust deliberately — these gate
// every redirect we emit, so a permissive entry is an open-redirect oracle.
const REDIRECT_URI_ALLOWLIST = [
  'https://claude.ai/**',
  'https://*.claude.ai/**',
  'https://*.anthropic.com/**',
  'https://cursor.sh/**',
  'https://*.cursor.sh/**',
  'https://codeium.com/**',
  'https://*.windsurf.dev/**',
  'http://localhost:*/**',
  'http://127.0.0.1:*/**',
  'https://smithery.run/oauth/callback',
];

function globToRegex(p: string): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*') + '$');
}

const allowlistRegexes = REDIRECT_URI_ALLOWLIST.map(globToRegex);

export function isRedirectUriAllowed(uri: string): boolean {
  return allowlistRegexes.some((re) => re.test(uri));
}

// ─── Registered OAuth clients (RFC 7591 dynamic client registration) ──────────
// Stored in-memory — clients re-register each session, so loss on restart is fine.

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
  registeredAt: number;
}

const clients = new Map<string, OAuthClient>();

export function registerClient(redirectUris: string[], clientName: string): OAuthClient {
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

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string
): boolean {
  if (method === 'S256') {
    const computed = createHash('sha256').update(codeVerifier).digest('base64url');
    return computed === codeChallenge;
  }
  if (method === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

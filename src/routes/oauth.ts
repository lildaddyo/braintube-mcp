/**
 * MCP OAuth 2.0 Authorization Server
 *
 * Implements the OAuth 2.0 Authorization Code + PKCE flow so that Claude.ai
 * can authenticate users via its native "Connect" button rather than requiring
 * manual token pasting.
 *
 * Flow:
 *   1. Claude.ai discovers /.well-known/oauth-authorization-server
 *   2. Claude.ai registers itself via POST /oauth/register (RFC 7591)
 *   3. Claude.ai redirects the user to GET /oauth/authorize (we show a login form)
 *   4. User submits email + password → we call Supabase signInWithPassword
 *   5. On success we issue a short-lived auth code and redirect to Claude.ai
 *   6. Claude.ai calls POST /oauth/token with the code → we return Supabase tokens
 *   7. On expiry Claude.ai calls POST /oauth/token with grant_type=refresh_token
 *      → we proxy to Supabase and return fresh tokens (silent, no user action)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  registerClient,
  getClient,
  storePendingAuth,
  consumePendingAuth,
  peekPendingAuth,
  restorePendingAuth,
  recordFailedLogin,
  issueAuthCode,
  consumeAuthCode,
  verifyPkce,
  normalizeRedirectUri,
  refreshFailure,
  codeBindingMatches,
} from '../auth/oauth-store.js';
import { BRAND_LOGO_DATA_URI } from './brand-logo.js';

export const oauthRouter = Router();

const supabaseUrl = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

// ─── Rate limits (BTMCP-03) ──────────────────────────────────────────────────
// Every password login and refresh is proxied to Supabase GoTrue from this one
// server, so GoTrue sees only Railway's egress IP and its per-IP buckets
// (sign-in, token refresh) are shared by every connector user. Without our own
// limits one client could drain them and lock every user out. Keys are the
// caller's IP as Railway's edge reports it: the LAST X-Forwarded-For entry is
// the one the edge appended (earlier entries are caller-supplied), falling back
// to the socket address.

export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff ?? '';
  const last = raw.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last ?? req.socket?.remoteAddress ?? 'unknown';
}

const ipKey = (req: Request): string => ipKeyGenerator(clientIp(req));

// Password logins per caller IP. A person signing in needs a handful.
const loginIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: ipKey,
  validate: { xForwardedForHeader: false, trustProxy: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).send(errorPage('Too many sign-in attempts from this network. Please wait 15 minutes and try again.'));
  },
});

// FAILED password logins per account email (successful logins are not counted), so
// one account cannot be guessed at from many IPs.
const loginEmailLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return 'email:' + (typeof email === 'string' ? email.trim().toLowerCase() : '');
  },
  skip: (req) => typeof (req.body as { email?: unknown } | undefined)?.email !== 'string',
  skipSuccessfulRequests: true,
  validate: { xForwardedForHeader: false, trustProxy: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).send(errorPage('Too many failed sign-in attempts for this account. Please wait 15 minutes and try again.'));
  },
});

// Refresh-token grants per caller IP. Connector refreshes come from the MCP
// client's servers (Claude, ChatGPT), so this is set at half of GoTrue's
// default token_refresh bucket (150 / 5 min): one source can never drain the
// whole shared budget. Answered like any transient refresh failure (503
// temporarily_unavailable) so clients keep their refresh token and retry.
const refreshIpLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 75,
  keyGenerator: ipKey,
  skip: (req) => (req.body as { grant_type?: unknown } | undefined)?.grant_type !== 'refresh_token',
  validate: { xForwardedForHeader: false, trustProxy: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    const failure = refreshFailure(429);
    res.status(failure.status).json(failure.body);
  },
});

function baseUrl(req: Request): string {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : `${req.protocol}://${req.get('host')}`;
}

// ─── Google OAuth round-trip state (in-memory, short-lived) ──────────────────
// Maps an opaque cookie value (gstate) to the in-flight Claude OAuth state plus
// the Supabase PKCE verifier we generated for the provider exchange.

interface GoogleAuthState {
  claudeState: string;
  supabaseVerifier: string;
  createdAt: number;
}

const googleAuthStates = new Map<string, GoogleAuthState>();
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of googleAuthStates.entries()) {
    if (now - v.createdAt > GOOGLE_STATE_TTL_MS) googleAuthStates.delete(k);
  }
}, 60_000).unref();

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const t = part.trim();
    if (t.startsWith(`${name}=`)) return decodeURIComponent(t.slice(name.length + 1));
  }
  return null;
}

// ─── OAuth Protected Resource Metadata (RFC 9728) ────────────────────────────
// Claude.ai's MCP OAuth discovery starts here. The client fetches this first,
// reads authorization_servers[0], then fetches the RFC 8414 doc from that host.
// Serving this as the entry point is the modern pattern; the RFC 8414 doc below
// is what Claude.ai actually needs to complete DCR and the auth flow.

oauthRouter.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    resource: base,
    authorization_servers: [base],
  });
});

// ─── OAuth Authorization Server Metadata (RFC 8414) ──────────────────────────
// Claude.ai fetches this after reading oauth-protected-resource above.
// Advertises the authorize, token, and DCR endpoints.

oauthRouter.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: ['openid', 'profile', 'email'],
  });
});

// ─── Dynamic Client Registration (RFC 7591) ───────────────────────────────────
// Claude.ai registers itself before starting the auth flow.

oauthRouter.post('/oauth/register', (req: Request, res: Response) => {
  const body = req.body as {
    redirect_uris?: string[];
    client_name?: string;
    [key: string]: unknown;
  };

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required',
    });
    return;
  }

  const redirectUris: string[] = [];
  for (const uri of body.redirect_uris) {
    const normalized = typeof uri === 'string' ? normalizeRedirectUri(uri) : null;
    if (normalized === null) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        uri: typeof uri === 'string' ? uri : null,
      });
      return;
    }
    redirectUris.push(normalized); // only the normalised value is stored
  }

  const client = registerClient(
    redirectUris,
    typeof body.client_name === 'string' ? body.client_name : 'MCP Client'
  );

  res.status(201).json({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    client_secret_expires_at: 0,
    redirect_uris: client.redirectUris,
    client_name: client.clientName,
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

// ─── Authorization endpoint — GET renders the login form ─────────────────────

oauthRouter.get('/oauth/authorize', (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = q;

  if (!client_id || !redirect_uri || !state || !code_challenge || response_type !== 'code') {
    res.status(400).send(errorPage('Missing required OAuth parameters (client_id, redirect_uri, state, code_challenge, response_type=code).'));
    return;
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    res.status(400).send(errorPage('Only code_challenge_method=S256 is supported.'));
    return;
  }

  const client = getClient(client_id);
  if (!client) {
    res.status(400).send(errorPage('Unknown client_id. Please reconnect from Claude.ai.'));
    return;
  }
  const requestedRedirect = normalizeRedirectUri(redirect_uri);
  if (requestedRedirect === null || !client.redirectUris.includes(requestedRedirect)) {
    res.status(400).send(errorPage('redirect_uri not registered for this client.'));
    return;
  }

  storePendingAuth({
    clientId: client_id,
    redirectUri: requestedRedirect,
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method ?? 'S256',
  });

  res.send(loginForm(state, undefined, requesterOf(client.clientName, requestedRedirect)));
});

// ─── Authorization endpoint — POST processes the login form ──────────────────

oauthRouter.post('/oauth/authorize', loginIpLimit, loginEmailLimit, async (req: Request, res: Response) => {
  const { state, email, password } = req.body as Record<string, string>;

  if (!state || !email || !password) {
    res.status(400).send(errorPage('Missing form fields.'));
    return;
  }

  const pending = consumePendingAuth(state);
  if (!pending) {
    res.status(400).send(errorPage('Login session expired or invalid. Please click Connect in Claude.ai again.'));
    return;
  }

  // Authenticate the user against Supabase via the public anon key.
  // We call the Supabase REST token endpoint directly so we get the raw
  // refresh_token (the JS SDK omits it in some configurations).
  let accessToken: string;
  let refreshToken: string;
  let userId: string;
  let userEmail: string | undefined;

  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error_description: 'Authentication failed' })) as { error_description?: string };
      // No email in the log: failed logins are where typos and other people's addresses show up.
      console.warn('[oauth] login failed —', err.error_description);
      if (!recordFailedLogin(pending)) {
        res.status(401).send(errorPage('Too many failed sign-in attempts. Go back and click Connect again to start over.'));
        return;
      }
      // 401 (not 200) so the per-email limiter counts it as a failure; the browser still shows the form.
      res.status(401).send(loginForm(state, err.error_description ?? 'Invalid email or password.', requesterOfPending(pending)));
      return;
    }

    const session = await resp.json() as {
      access_token: string;
      refresh_token: string;
      user: { id: string; email?: string };
    };

    accessToken = session.access_token;
    refreshToken = session.refresh_token;
    userId = session.user.id;
    userEmail = session.user.email;
  } catch (err) {
    console.error('[oauth] login error:', err);
    restorePendingAuth(pending);
    res.send(loginForm(state, 'A server error occurred. Please try again.', requesterOfPending(pending)));
    return;
  }

  const code = issueAuthCode({
    accessToken,
    refreshToken,
    userId,
    email: userEmail,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
  });

  console.error(`[oauth] auth code issued — email: ${userEmail}`);

  // Defense-in-depth: re-validate immediately before redirect. Upstream gates
  // exist (allowlist at /oauth/register, registered-URI check at /oauth/authorize),
  // but SAST taint can't trace through consumePendingAuth and a future migration
  // of clientStore to Supabase could break the chain silently.
  const redirectTarget = normalizeRedirectUri(pending.redirectUri);
  if (redirectTarget === null) {
    console.warn('[oauth] rejected redirect to non-allowlisted URI:', pending.redirectUri);
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  const redirectUrl = new URL(redirectTarget);
  redirectUrl.searchParams.set('code', code);
  redirectUrl.searchParams.set('state', pending.state);
  res.redirect(redirectUrl.toString());
});

// ─── Google sign-in — start ──────────────────────────────────────────────────
// Reached by clicking "Continue with Google" in the login form. We confirm the
// Claude OAuth flow is still pending (peek, don't consume), generate a Supabase
// PKCE verifier, drop a short-lived cookie tying the browser to that verifier,
// and redirect the user to Supabase's Google authorize endpoint.

oauthRouter.get('/oauth/google/start', (req: Request, res: Response) => {
  const claudeState = String(req.query.state ?? '');
  if (!claudeState) {
    res.status(400).send(errorPage('Missing state.'));
    return;
  }

  const pending = peekPendingAuth(claudeState);
  if (!pending) {
    res.status(400).send(errorPage('Authorization session expired. Please retry from Claude.'));
    return;
  }

  const supabaseVerifier = randomBytes(32).toString('base64url');
  const supabaseChallenge = createHash('sha256').update(supabaseVerifier).digest('base64url');
  const gstate = randomBytes(16).toString('hex');

  googleAuthStates.set(gstate, {
    claudeState,
    supabaseVerifier,
    createdAt: Date.now(),
  });

  res.cookie('bt_oauth_gstate', gstate, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: GOOGLE_STATE_TTL_MS,
    path: '/oauth/google',
  });

  const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('redirect_to', `${baseUrl(req)}/oauth/google/callback`);
  url.searchParams.set('code_challenge', supabaseChallenge);
  url.searchParams.set('code_challenge_method', 's256');
  res.redirect(url.toString());
});

// ─── Google sign-in — callback ───────────────────────────────────────────────
// Supabase redirects here after Google authentication. We trade the Supabase
// auth_code (PKCE) for a Supabase session, then complete the original Claude
// authorization-code redirect with our own short-lived MCP code.

oauthRouter.get('/oauth/google/callback', async (req: Request, res: Response) => {
  const code = String(req.query.code ?? '');
  const errorParam = String(req.query.error_description ?? req.query.error ?? '');
  if (errorParam) {
    res.status(400).send(errorPage(`Google sign-in failed: ${errorParam}`));
    return;
  }
  if (!code) {
    res.status(400).send(errorPage('Missing code from provider.'));
    return;
  }

  const gstate = readCookie(req, 'bt_oauth_gstate');
  if (!gstate) {
    res.status(400).send(errorPage('Missing session cookie. Try again from Claude.'));
    return;
  }

  const entry = googleAuthStates.get(gstate);
  googleAuthStates.delete(gstate);
  res.clearCookie('bt_oauth_gstate', { path: '/oauth/google' });

  if (!entry) {
    res.status(400).send(errorPage('Sign-in session expired. Please retry from Claude.'));
    return;
  }
  if (Date.now() - entry.createdAt > GOOGLE_STATE_TTL_MS) {
    res.status(400).send(errorPage('Sign-in session expired. Please retry from Claude.'));
    return;
  }

  // Exchange the Supabase auth_code for tokens using our PKCE verifier.
  let tokenJson: {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string; email?: string };
  };
  try {
    const tokenResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: entry.supabaseVerifier,
      }),
    });

    if (!tokenResp.ok) {
      console.error('[oauth/google/callback] Supabase token exchange failed — status', tokenResp.status);
      res.status(400).send(errorPage('Could not complete Google sign-in.'));
      return;
    }

    tokenJson = await tokenResp.json();
  } catch (err) {
    console.error('[oauth/google/callback] token exchange error:', err);
    res.status(500).send(errorPage('A server error occurred during Google sign-in.'));
    return;
  }

  if (!tokenJson.access_token || !tokenJson.refresh_token || !tokenJson.user?.id) {
    res.status(400).send(errorPage('Invalid token response from Supabase.'));
    return;
  }

  // Now consume the pending Claude OAuth state and complete the redirect to Claude.
  const pending = consumePendingAuth(entry.claudeState);
  if (!pending) {
    res.status(400).send(errorPage('Authorization session expired.'));
    return;
  }

  const mcpCode = issueAuthCode({
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    userId: tokenJson.user.id,
    email: tokenJson.user.email,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
  });

  console.error(`[oauth/google/callback] auth code issued — email: ${tokenJson.user.email ?? '(no email)'}`);

  // Defense-in-depth: see /oauth/authorize POST for the rationale.
  const claudeRedirectTarget = normalizeRedirectUri(pending.redirectUri);
  if (claudeRedirectTarget === null) {
    console.warn('[oauth/google/callback] rejected redirect to non-allowlisted URI:', pending.redirectUri);
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  const claudeRedirect = new URL(claudeRedirectTarget);
  claudeRedirect.searchParams.set('code', mcpCode);
  claudeRedirect.searchParams.set('state', pending.state);
  //noaikido
  // pending.redirectUri is validated three times before reaching here:
  //   (1) at /oauth/register against REDIRECT_URI_ALLOWLIST,
  //   (2) at /oauth/authorize against client.redirectUris,
  //   (3) inline guard immediately above this block.
  // Aikido's SAST taint analysis cannot trace the validation chain through
  // consumePendingAuth(). Confirmed false positive 2026-05-02.
  res.redirect(claudeRedirect.toString());
});

// ─── Token endpoint ───────────────────────────────────────────────────────────

oauthRouter.post('/oauth/token', refreshIpLimit, async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const { grant_type } = body;

  // ── authorization_code grant ─────────────────────────────────────────────
  if (grant_type === 'authorization_code') {
    const { code, code_verifier } = body;

    if (!code || !code_verifier) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code and code_verifier required' });
      return;
    }

    const entry = consumeAuthCode(code);
    if (!entry) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code not found or expired (60 s TTL)' });
      return;
    }

    if (!codeBindingMatches(entry, body)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code was issued to a different client or redirect_uri' });
      return;
    }

    if (!verifyPkce(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    console.error(`[oauth] token issued — email: ${entry.email}`);

    res.json({
      access_token: entry.accessToken,
      refresh_token: entry.refreshToken,
      token_type: 'bearer',
      expires_in: 3600,
    });
    return;
  }

  // ── refresh_token grant ──────────────────────────────────────────────────
  if (grant_type === 'refresh_token') {
    const { refresh_token } = body;

    if (!refresh_token) {
      res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
      return;
    }

    try {
      const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
        },
        body: JSON.stringify({ refresh_token }),
      });

      if (!resp.ok) {
        console.warn('[oauth] refresh failed — status', resp.status);
        const failure = refreshFailure(resp.status);
        res.status(failure.status).json(failure.body);
        return;
      }

      const tokens = await resp.json() as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
      };

      console.error('[oauth] token refreshed silently');

      res.json({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: 'bearer',
        expires_in: tokens.expires_in ?? 3600,
      });
    } catch (err) {
      console.error('[oauth] refresh error:', err);
      const failure = refreshFailure(null);
      res.status(failure.status).json(failure.body);
    }
    return;
  }

  res.status(400).json({ error: 'unsupported_grant_type', error_description: `grant_type '${grant_type}' is not supported` });
});

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Shared brand styles for OAuth pages ─────────────────────────────────────
// Values from the brand canon (bt-brand-canon §1–§2, brain-tube-reborn
// src/lib/editorial-theme.ts): DARK_PALETTE by default, LIGHT_PALETTE when the
// browser prefers light. Fraunces sets headings and prose; Space Grotesk sets
// labels, buttons and eyebrows (uppercase, letter-spaced), never body copy.

const BRAND_HEAD = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="theme-color" content="#0d0a1f" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#F9FAFB" media="(prefers-color-scheme: light)" />
<link rel="icon" type="image/png" href="${BRAND_LOGO_DATA_URI}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Space+Grotesk:wght@500;600&display=swap">`;

const BRAND_BASE_CSS = `:root {
    --ink:#f5f0ff; --muted:#b8a8d9; --faint:#8a7dab; --hair:#5a4d7a; --accent:#a78bfa;
    --rule:rgba(167,139,250,.15); --card:rgba(167,139,250,.06); --card-edge:rgba(167,139,250,.18);
    --field:rgba(7,6,15,.55); --field-edge:rgba(167,139,250,.22); --focus-ring:rgba(167,139,250,.22);
    --page:radial-gradient(ellipse at 50% 0%, #2a1a4a 0%, #1a0f33 35%, #0d0a1f 70%, #07060f 100%);
    --page-solid:#0d0a1f;
    --cta:linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); --cta-shadow:0 8px 24px -8px rgba(139,92,246,.6);
    --card-shadow:0 30px 80px -40px rgba(0,0,0,.8);
    --error-ink:#fda4af; --error-bg:rgba(244,63,94,.08); --error-edge:rgba(244,63,94,.28);
    --serif:'Fraunces','Iowan Old Style','Apple Garamond','Baskerville','Times New Roman',serif;
    --sans:'Space Grotesk','Source Code Pro','IBM Plex Mono',ui-monospace,monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --ink:#020817; --muted:#6B7280; --faint:#6B7280; --hair:#717171; --accent:#6D4DE6;
      --rule:#E4E7EB; --card:#FFFFFF; --card-edge:#E4E7EB;
      --field:#FFFFFF; --field-edge:#E4E7EB; --focus-ring:rgba(109,77,230,.18);
      --page:#F9FAFB; --page-solid:#F9FAFB;
      --cta:linear-gradient(135deg, #6D4DE6 0%, #9F4DBF 60%, #BD6FA3 100%); --cta-shadow:0 6px 20px -8px rgba(109,77,230,.45);
      --card-shadow:0 24px 60px -36px rgba(2,8,23,.25);
      --error-ink:#be123c; --error-bg:#fff1f2; --error-edge:#fecdd3;
    }
  }
  *,*::before,*::after { box-sizing:border-box; }
  html { background:var(--page-solid); }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;
    background:var(--page); background-attachment:fixed; color:var(--ink); font-family:var(--serif);
    -webkit-font-smoothing:antialiased; }
  .card { width:100%; max-width:420px; background:var(--card); border:1px solid var(--card-edge); border-radius:20px;
    padding:36px 32px 28px; box-shadow:var(--card-shadow); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); }
  .lockup { display:flex; align-items:center; gap:10px; margin:0 0 28px; color:var(--ink); }
  .lockup img { width:34px; height:auto; display:block; }
  .lockup span { font-family:var(--serif); font-weight:600; font-size:21px; letter-spacing:-.01em; }
  .eyebrow { font-family:var(--sans); font-weight:500; font-size:11px; letter-spacing:2.5px; text-transform:uppercase; color:var(--faint); margin:0 0 10px; }
  .title { font-family:var(--serif); font-weight:400; font-size:30px; line-height:1.12; letter-spacing:-.015em; margin:0 0 12px; color:var(--ink); }
  .title em { font-style:italic; color:var(--accent); }
  .title .dot { color:var(--hair); }
  .lede { font-family:var(--serif); font-size:15px; line-height:1.55; color:var(--muted); margin:0 0 26px; }
  .footer { font-family:var(--serif); font-size:13px; line-height:1.55; color:var(--faint); margin:22px 0 0; padding-top:18px; border-top:1px solid var(--rule); }
  .error { font-family:var(--serif); font-size:14px; line-height:1.5; color:var(--error-ink); background:var(--error-bg);
    border:1px solid var(--error-edge); border-radius:10px; padding:10px 12px; margin:0 0 18px; }
  @media (max-width:420px) { .card { padding:28px 20px 22px; } .title { font-size:26px; } }`;

const BRAND_LOCKUP = `<div class="lockup"><img src="${BRAND_LOGO_DATA_URI}" alt="" width="34" height="33" /><span>BrainTube</span></div>`;

// Who is asking for access, shown on the login form so the user can tell a
// connection they started from one somebody sent them a link to (BTMCP-04).
export interface Requester {
  clientName: string;
  redirectHost: string;
}

function requesterOf(clientName: string, redirectUri: string): Requester | undefined {
  try {
    return { clientName: clientName.slice(0, 100), redirectHost: new URL(redirectUri).host };
  } catch {
    return undefined;
  }
}

function requesterOfPending(pending: { clientId: string; redirectUri: string }): Requester | undefined {
  const client = getClient(pending.clientId);
  return requesterOf(client?.clientName ?? 'MCP Client', pending.redirectUri);
}

export function loginForm(state: string, errorMsg?: string, requester?: Requester): string {
  const errorHtml = errorMsg ? `<div class="error" role="alert">${esc(errorMsg)}</div>` : '';
  const requesterHtml = requester
    ? `<p class="requester"><strong>${esc(requester.clientName)}</strong> is asking for access to your BrainTube knowledge base. After you sign in you will be sent to <strong>${esc(requester.redirectHost)}</strong>. Only continue if you started this connection yourself.</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
${BRAND_HEAD}
<title>Connect BrainTube to Claude</title>
<style>
  ${BRAND_BASE_CSS}
  .google-btn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:13px 16px;
    background:#fff; color:#1f1f1f; border:1px solid #dadce0; border-radius:12px; font-family:var(--sans); font-size:14px;
    font-weight:500; cursor:pointer; text-decoration:none; transition:background 120ms ease, transform 120ms ease; }
  .google-btn:hover { background:#f6f6f8; }
  .google-btn:active { transform:translateY(1px); }
  .google-btn svg { width:18px; height:18px; flex-shrink:0; }
  .divider { display:flex; align-items:center; gap:14px; margin:22px 0; font-family:var(--sans); font-size:10px;
    font-weight:500; letter-spacing:3px; text-transform:uppercase; color:var(--faint); }
  .divider::before,.divider::after { content:''; flex:1; height:1px; background:var(--rule); }
  label { display:block; font-family:var(--sans); font-size:11px; font-weight:500; letter-spacing:1.5px; text-transform:uppercase;
    color:var(--muted); margin:0 0 7px; }
  input[type=email],input[type=password] { width:100%; padding:12px 14px; margin:0 0 16px; background:var(--field);
    border:1px solid var(--field-edge); border-radius:12px; color:var(--ink); font-family:var(--serif); font-size:15px;
    outline:none; transition:border-color 120ms ease, box-shadow 120ms ease; }
  input::placeholder { color:var(--faint); opacity:.8; }
  input[type=email]:focus,input[type=password]:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--focus-ring); }
  .submit-btn { width:100%; margin-top:6px; padding:14px 16px; background:var(--cta); color:#fff; border:0; border-radius:12px;
    box-shadow:var(--cta-shadow); font-family:var(--sans); font-size:12px; font-weight:600; letter-spacing:2px; text-transform:uppercase;
    cursor:pointer; transition:filter 120ms ease, transform 120ms ease; }
  .submit-btn:hover { filter:brightness(1.08); }
  .submit-btn:active { transform:translateY(1px); }
  .submit-btn:focus-visible,.google-btn:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  .requester { font-family:var(--serif); font-size:14px; line-height:1.5; color:var(--ink); background:var(--card);
    border:1px solid var(--card-edge); border-radius:10px; padding:10px 12px; margin:0 0 18px; overflow-wrap:anywhere; }
</style>
</head>
<body>
<main class="card">
  ${BRAND_LOCKUP}
  <p class="eyebrow">Connect to Claude</p>
  <h1 class="title">Bring your <em>memory</em><span class="dot">.</span></h1>
  <p class="lede">Sign in so Claude can search your BrainTube knowledge base. Your credentials go straight to BrainTube, never through Claude.</p>
  ${requesterHtml}
  ${errorHtml}
  <a href="/oauth/google/start?state=${esc(state)}" class="google-btn">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
    Continue with Google
  </a>
  <div class="divider">or</div>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="state" value="${esc(state)}" />
    <label for="email">Email</label>
    <input type="email" id="email" name="email" placeholder="you@example.com" required autocomplete="email" />
    <label for="password">Password</label>
    <input type="password" id="password" name="password" placeholder="••••••••" required autocomplete="current-password" />
    <button type="submit" class="submit-btn">Connect to Claude</button>
  </form>
  <p class="footer">Claude will be able to search and read your BrainTube knowledge base. You can disconnect any time in Claude's connector settings.</p>
</main>
</body>
</html>`;
}

export function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${BRAND_HEAD}
<title>BrainTube — sign-in error</title>
<style>
  ${BRAND_BASE_CSS}
  .message { font-family:var(--serif); font-size:15px; line-height:1.55; color:var(--muted); margin:0; }
</style>
</head>
<body>
<main class="card">
  ${BRAND_LOCKUP}
  <p class="eyebrow">Sign-in error</p>
  <h1 class="title">That didn't <em>connect</em><span class="dot">.</span></h1>
  <p class="message">${esc(message)}</p>
  <p class="footer">Go back to Claude and click Connect to try again.</p>
</main>
</body>
</html>`;
}

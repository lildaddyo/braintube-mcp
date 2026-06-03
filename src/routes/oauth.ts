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
import {
  registerClient,
  getClient,
  storePendingAuth,
  consumePendingAuth,
  peekPendingAuth,
  restorePendingAuth,
  issueAuthCode,
  consumeAuthCode,
  verifyPkce,
  isRedirectUriAllowed,
} from '../auth/oauth-store.js';

export const oauthRouter = Router();

const supabaseUrl = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

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

// ─── OAuth Authorization Server Metadata (RFC 8414) ──────────────────────────
// Claude.ai fetches this to discover the authorize + token endpoints.

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

  for (const uri of body.redirect_uris) {
    if (typeof uri !== 'string' || !isRedirectUriAllowed(uri)) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        uri: typeof uri === 'string' ? uri : null,
      });
      return;
    }
  }

  const client = registerClient(
    body.redirect_uris,
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

  const client = getClient(client_id);
  if (!client) {
    res.status(400).send(errorPage('Unknown client_id. Please reconnect from Claude.ai.'));
    return;
  }
  if (!client.redirectUris.includes(redirect_uri)) {
    res.status(400).send(errorPage('redirect_uri not registered for this client.'));
    return;
  }

  storePendingAuth({
    clientId: client_id,
    redirectUri: redirect_uri,
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method ?? 'S256',
  });

  res.send(loginForm(state));
});

// ─── Authorization endpoint — POST processes the login form ──────────────────

oauthRouter.post('/oauth/authorize', async (req: Request, res: Response) => {
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
      console.warn('[oauth] login failed for', email, '—', err.error_description);
      restorePendingAuth(pending);
      res.send(loginForm(state, err.error_description ?? 'Invalid email or password.'));
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
    res.send(loginForm(state, 'A server error occurred. Please try again.'));
    return;
  }

  const code = issueAuthCode({
    accessToken,
    refreshToken,
    userId,
    email: userEmail,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
  });

  console.log(`[oauth] auth code issued — email: ${userEmail}`);

  // Defense-in-depth: re-validate immediately before redirect. Upstream gates
  // exist (allowlist at /oauth/register, registered-URI check at /oauth/authorize),
  // but SAST taint can't trace through consumePendingAuth and a future migration
  // of clientStore to Supabase could break the chain silently.
  if (!isRedirectUriAllowed(pending.redirectUri)) {
    console.warn('[oauth] rejected redirect to non-allowlisted URI:', pending.redirectUri);
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  const redirectUrl = new URL(pending.redirectUri);
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
  });

  console.log(`[oauth/google/callback] auth code issued — email: ${tokenJson.user.email ?? '(no email)'}`);

  // Defense-in-depth: see /oauth/authorize POST for the rationale.
  if (!isRedirectUriAllowed(pending.redirectUri)) {
    console.warn('[oauth/google/callback] rejected redirect to non-allowlisted URI:', pending.redirectUri);
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  const claudeRedirect = new URL(pending.redirectUri);
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

oauthRouter.post('/oauth/token', async (req: Request, res: Response) => {
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

    if (!verifyPkce(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    console.log(`[oauth] token issued — email: ${entry.email}`);

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
        res.status(401).json({ error: 'invalid_grant', error_description: 'Refresh token invalid or expired. User must re-authenticate.' });
        return;
      }

      const tokens = await resp.json() as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
      };

      console.log('[oauth] token refreshed silently');

      res.json({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: 'bearer',
        expires_in: tokens.expires_in ?? 3600,
      });
    } catch (err) {
      console.error('[oauth] refresh error:', err);
      res.status(500).json({ error: 'server_error', error_description: 'Failed to refresh token' });
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
// Fraunces (display) + Space Grotesk (body) — matches brain-tube.com landing.

const BRAND_HEAD = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Space+Grotesk:wght@400;500;600&display=swap">`;

const BRAND_BASE_CSS = `*,*::before,*::after { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:#0a0a0a; color:#e8e8e8; font-family:'Space Grotesk',system-ui,-apple-system,sans-serif; min-height:100vh; }
  body { display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:420px; background:#141414; border:1px solid rgba(255,255,255,.06); border-radius:16px; padding:36px 32px; }
  .wordmark { font-family:'Fraunces',Georgia,serif; font-weight:700; font-size:32px; letter-spacing:-.02em; margin:0 0 12px; line-height:1; }
  .wordmark .brain { color:#fff; }
  .wordmark .tube { color:#FF6B1A; }
  .subtitle { margin:0 0 28px; font-size:14px; color:#9a9a9a; line-height:1.5; }
  .footer { margin:24px 0 0; text-align:center; font-size:12px; color:#6a6a6a; line-height:1.5; }
  .error { background:rgba(255,87,87,.08); border:1px solid rgba(255,87,87,.2); color:#ff8a8a; padding:10px 12px; border-radius:8px; font-size:13px; margin-bottom:16px; }`;

function loginForm(state: string, errorMsg?: string): string {
  const errorHtml = errorMsg ? `<div class="error">${esc(errorMsg)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
${BRAND_HEAD}
<title>Connect BrainTube to Claude</title>
<style>
  ${BRAND_BASE_CSS}
  .google-btn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:12px 16px; background:#fff; color:#1f1f1f; border:0; border-radius:10px; font-family:inherit; font-size:14px; font-weight:500; cursor:pointer; text-decoration:none; transition:background 120ms ease; }
  .google-btn:hover { background:#f4f4f4; }
  .google-btn svg { width:18px; height:18px; flex-shrink:0; }
  .divider { display:flex; align-items:center; gap:12px; margin:20px 0; font-size:12px; color:#5a5a5a; text-transform:uppercase; letter-spacing:.08em; }
  .divider::before,.divider::after { content:''; flex:1; height:1px; background:rgba(255,255,255,.08); }
  label { display:block; font-size:13px; font-weight:500; color:#c8c8c8; margin:0 0 6px; }
  input[type=email],input[type=password] { width:100%; padding:11px 14px; background:#1c1c1c; border:1px solid rgba(255,255,255,.08); border-radius:10px; color:#fff; font-family:inherit; font-size:14px; margin-bottom:16px; outline:none; transition:border-color 120ms ease; }
  input[type=email]:focus,input[type=password]:focus { border-color:#866CEF; }
  .submit-btn { width:100%; padding:12px 16px; background:#866CEF; color:#fff; border:0; border-radius:10px; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:background 120ms ease; margin-top:4px; }
  .submit-btn:hover { background:#9a82f2; }
</style>
</head>
<body>
<div class="card">
  <h1 class="wordmark"><span class="brain">Brain</span><span class="tube">Tube</span></h1>
  <p class="subtitle">Sign in to connect BrainTube to Claude.<br>Your credentials go directly to BrainTube — never through Claude.</p>
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
  <p class="footer">Claude will be able to query your BrainTube knowledge base. You can disconnect any time from Claude.ai settings.</p>
</div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${BRAND_HEAD}
<title>BrainTube — Auth Error</title>
<style>
  ${BRAND_BASE_CSS}
  .card { text-align:left; }
  .heading { font-family:'Fraunces',Georgia,serif; font-weight:500; font-size:20px; color:#fff; margin:0 0 12px; line-height:1.3; }
  .message { color:#bdbdbd; font-size:14px; line-height:1.55; margin:0; }
</style>
</head>
<body>
<div class="card">
  <h1 class="wordmark"><span class="brain">Brain</span><span class="tube">Tube</span></h1>
  <p class="heading">Authentication error</p>
  <p class="message">${esc(message)}</p>
  <p class="footer">Return to Claude.ai and click Connect to try again.</p>
</div>
</body>
</html>`;
}

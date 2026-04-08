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
import {
  registerClient,
  getClient,
  storePendingAuth,
  consumePendingAuth,
  restorePendingAuth,
  issueAuthCode,
  consumeAuthCode,
  verifyPkce,
} from '../auth/oauth-store.js';

export const oauthRouter = Router();

const supabaseUrl = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

function baseUrl(req: Request): string {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : `${req.protocol}://${req.get('host')}`;
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

  const client = registerClient(
    body.redirect_uris,
    typeof body.client_name === 'string' ? body.client_name : 'MCP Client'
  );

  res.status(201).json({
    client_id: client.clientId,
    client_secret: client.clientSecret,
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

  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set('code', code);
  redirectUrl.searchParams.set('state', pending.state);
  res.redirect(redirectUrl.toString());
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

function loginForm(state: string, errorMsg?: string): string {
  const errorHtml = errorMsg
    ? `<div class="error">${esc(errorMsg)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect BrainTube to Claude</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0c0c0c;
      color: #e8e8e8;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .card {
      background: #161616;
      border: 1px solid #252525;
      border-radius: 14px;
      padding: 44px 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 24px 64px rgba(0,0,0,.5);
    }
    .brand { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 6px; }
    .brand span { color: #f97316; }
    .subtitle { color: #777; font-size: 13.5px; line-height: 1.5; margin-bottom: 32px; }
    label { display: block; font-size: 12.5px; font-weight: 500; color: #999; margin-bottom: 6px; }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 10px 13px;
      background: #0f0f0f;
      border: 1px solid #2e2e2e;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      margin-bottom: 18px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #f97316; }
    .btn {
      width: 100%;
      padding: 11px;
      background: #f97316;
      color: #fff;
      font-size: 14.5px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover { background: #ea6c0a; }
    .btn:active { background: #d9600a; }
    .error {
      color: #fca5a5;
      font-size: 13px;
      background: #1f1010;
      border: 1px solid #3f1010;
      border-radius: 7px;
      padding: 10px 13px;
      margin-bottom: 18px;
    }
    .footer {
      margin-top: 22px;
      font-size: 11.5px;
      color: #444;
      text-align: center;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">Brain<span>Tube</span></div>
    <p class="subtitle">Sign in to connect your knowledge base to Claude. Your credentials go directly to BrainTube.</p>
    ${errorHtml}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="state" value="${esc(state)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required autofocus autocomplete="email">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••" required autocomplete="current-password">
      <button class="btn" type="submit">Connect to Claude</button>
    </form>
    <p class="footer">
      BrainTube will have access to your saved knowledge base.<br>
      You can disconnect at any time from Claude.ai settings.
    </p>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BrainTube — Auth Error</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0c0c0c; color: #e8e8e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161616; border: 1px solid #252525; border-radius: 14px; padding: 40px; max-width: 420px; text-align: center; }
    h1 { font-size: 18px; margin-bottom: 12px; }
    p { color: #888; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Error</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
}

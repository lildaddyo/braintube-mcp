import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Request } from 'express';

// Lazy singleton — avoids throwing at import time when env vars aren't set
// yet (e.g. Glama's sandbox boot/ping check, which starts the process with
// an empty environment before any real request is made).
let _adminClient: SupabaseClient | null = null;
function getAdminClient(): SupabaseClient {
  if (!_adminClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    _adminClient = createClient(supabaseUrl, serviceKey);
  }
  return _adminClient;
}

export interface AuthContext {
  userId: string;
  email?: string;
  authMethod: 'jwt' | 'apikey';
  rawToken?: string; // original JWT — forwarded to edge functions that require user auth
}

// Validate a Supabase JWT via the Auth API (no local JWT secret needed).
//
// Calls GET {SUPABASE_URL}/auth/v1/user directly instead of
// supabase-js auth.getUser(): after the 2.101 → 2.117 bump (PR #28) getUser
// rejected every valid access token, so every MCP request 401'd and Claude
// connectors showed "Authentication failed". The REST endpoint is the
// contract getUser wraps, so this keeps auth independent of client versions.
async function validateJWT(token: string): Promise<AuthContext | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !apiKey) return null;
  try {
    const resp = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: apiKey, Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      console.warn(`[auth] jwt rejected by Supabase — status ${resp.status}`);
      return null;
    }
    const user = (await resp.json()) as { id?: string; email?: string };
    if (!user?.id) return null;
    console.error(`[auth] jwt validated — user: ${String(user.id).slice(0, 8)}`); // no email in logs (BTMCP-10)
    return {
      userId: user.id,
      email: user.email,
      authMethod: 'jwt',
      rawToken: token,
    };
  } catch (err) {
    console.error('[auth] jwt validation error:', err);
    return null;
  }
}

// API key auth — looks up bt_... keys in the api_keys table (same table used by obsidian-sync)
async function validateApiKey(apiKey: string): Promise<AuthContext | null> {
  if (!apiKey.startsWith('bt_')) return null;
  try {
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(apiKey).digest('hex');
    const { data } = await getAdminClient()
      .from('api_keys')
      .select('user_id')
      .eq('key_hash', hash)
      .eq('is_active', true)
      .single();
    if (!data?.user_id) return null;
    // Fire-and-forget last_used update
    void getAdminClient()
      .from('api_keys')
      .update({ last_used: new Date().toISOString() })
      .eq('key_hash', hash)
      .then(
        ({ error }) => {
          if (error) console.error(`[auth] last_used update failed for key hash ${hash.slice(0, 8)}…: ${error.message}`);
        },
        (err: unknown) => {
          console.error(`[auth] last_used update threw for key hash ${hash.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
        }
      );
    console.error('[auth] api key validated');
    return { userId: data.user_id as string, authMethod: 'apikey' };
  } catch {
    return null;
  }
}

// Extract and validate auth from request — tries JWT first, then API key header
export async function getAuthContext(req: Request): Promise<AuthContext | null> {
  // Method 1: Authorization: Bearer <jwt>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const ctx = await validateJWT(token);
    if (ctx) return ctx;
  }

  // Method 2: X-BrainTube-Token: <api_key>
  const apiKey = req.headers['x-braintube-token'] as string | undefined;
  if (apiKey) {
    const ctx = await validateApiKey(apiKey);
    if (ctx) return ctx;
  }

  // A ?token=<jwt> query parameter used to be accepted here (Method 3). It was removed on
  // 2026-10-09: tokens in URLs end up in proxy/edge request logs and browser history.
  // Claude.ai uses OAuth; other clients send the Authorization or X-BrainTube-Token header.

  return null;
}

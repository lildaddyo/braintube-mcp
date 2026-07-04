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

// Validate a Supabase JWT via the Auth API (no local JWT secret needed)
async function validateJWT(token: string): Promise<AuthContext | null> {
  try {
    const { data, error } = await getAdminClient().auth.getUser(token);
    if (error || !data.user) return null;
    console.error(`[auth] jwt validated — email: ${data.user.email}`);
    return {
      userId: data.user.id,
      email: data.user.email,
      authMethod: 'jwt',
      rawToken: token,
    };
  } catch {
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

// Extract and validate auth from request — tries JWT first, then API key header, then query param
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

  // Method 3: ?token=<jwt> query parameter
  // For clients that cannot set custom headers (e.g. Claude.ai custom connectors).
  // The full MCP URL becomes: /mcp?token=<supabase-jwt>
  const queryToken = (req as Request & { query?: Record<string, string> }).query?.token;
  if (typeof queryToken === 'string' && queryToken) {
    const ctx = await validateJWT(queryToken);
    if (ctx) return ctx;
  }

  return null;
}

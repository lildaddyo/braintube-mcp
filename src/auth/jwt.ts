import { createClient } from '@supabase/supabase-js';
import { Request } from 'express';

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const adminClient = createClient(supabaseUrl, serviceKey);

export interface AuthContext {
  userId: string;
  email?: string;
  authMethod: 'jwt' | 'apikey';
}

// Validate a Supabase JWT via the Auth API (no local JWT secret needed)
async function validateJWT(token: string): Promise<AuthContext | null> {
  try {
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data.user) return null;
    console.log(`[auth] jwt validated — email: ${data.user.email}`);
    return {
      userId: data.user.id,
      email: data.user.email,
      authMethod: 'jwt'
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
    const { data } = await adminClient
      .from('api_keys')
      .select('user_id')
      .eq('key_hash', hash)
      .single();
    if (!data?.user_id) return null;
    // Fire-and-forget last_used update
    void adminClient
      .from('api_keys')
      .update({ last_used: new Date().toISOString() })
      .eq('key_hash', hash);
    console.log('[auth] api key validated');
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

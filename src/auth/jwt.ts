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

// API key auth — no user_api_keys table exists yet (research_api_keys is not user-scoped)
// Returns null always; extend when a proper user_api_keys table is available
async function validateApiKey(_apiKey: string): Promise<AuthContext | null> {
  return null;
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

  return null;
}

import { dbAdmin } from '../db/supabase.js';
import { TtlCache } from './ttl-cache.js';

/**
 * MCP/REST call limits per user, from the user's plan (public.mcp_limits_for: latest active or
 * trialing subscription → plans.limits.mcp_calls_per_15m / mcp_calls_per_day). A plan without
 * those keys keeps the old flat limit: 60 calls per 15 minutes and no daily cap. Cached 5 min per
 * user; a failed lookup falls back to the defaults so a database hiccup never locks anyone out.
 */
export interface PlanLimits {
  tier: string;
  per15m: number;
  perDay: number | null;
}

export const DEFAULT_LIMITS: PlanLimits = { tier: 'free', per15m: 60, perDay: null };

export function parseLimits(raw: unknown): PlanLimits {
  if (!raw || typeof raw !== 'object') return DEFAULT_LIMITS;
  const r = raw as { tier?: unknown; per_15m?: unknown; per_day?: unknown };
  const per15m = typeof r.per_15m === 'number' && r.per_15m > 0 ? Math.floor(r.per_15m) : DEFAULT_LIMITS.per15m;
  const perDay = typeof r.per_day === 'number' && r.per_day > 0 ? Math.floor(r.per_day) : null;
  return { tier: typeof r.tier === 'string' ? r.tier : 'free', per15m, perDay };
}

const cache = new TtlCache<PlanLimits>(5000, 5 * 60 * 1000);

export async function limitsFor(userId: string | undefined): Promise<PlanLimits> {
  if (!userId || process.env.NODE_TEST_CONTEXT) return DEFAULT_LIMITS;
  const hit = cache.get(userId);
  if (hit) return hit;
  try {
    const { data, error } = await dbAdmin.rpc('mcp_limits_for', { p_user: userId });
    if (error) throw new Error(error.message);
    const limits = parseLimits(data);
    cache.set(userId, limits);
    return limits;
  } catch (err) {
    console.error('[plan-limits] lookup failed, using defaults:', err instanceof Error ? err.message : err);
    return DEFAULT_LIMITS;
  }
}

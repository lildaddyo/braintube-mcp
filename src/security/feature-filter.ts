/**
 * L5 feature filter: hide tools whose product feature is off for the caller.
 *
 * Design: lildaddyo/dark-n-cozy docs/investigations/feature-guard-protocol.md
 * (layer L5, abuse case 5b, §6.1). Tools carry a feature key in TOOL_FEATURES
 * (tool-access.ts). The filter runs at registration (tools/list, and so the
 * router's routable set) and again at call time in secureWrap.
 *
 * Switch: MCP_FEATURE_FILTER=off|shadow|enforce (default off).
 *   off      — behave exactly as before this filter existed.
 *   shadow   — hide nothing; log each would-be hide to security_events
 *              (event_type 'mcp_feature_hidden').
 *   enforce  — hide tools whose feature is not enabled for the caller.
 *
 * Source: the feature_flags evaluator proposed in dark-n-cozy
 * docs/investigations/feature-guard/0001_feature_guard.sql. That file's
 * get_my_features() reads auth.uid(), which is null under this server's
 * service-role client (and API-key sessions carry no user JWT), so the server
 * asks feature_enabled(p_key, p_user_id) for each key a tool uses — the same
 * evaluator get_my_features() wraps, which lets the service role ask about a
 * given user. If that RPC is missing or fails, the filter is skipped for the
 * session (behave as today); the edge functions behind the tools still check
 * their feature (L3).
 */

import { dbAdmin } from '../db/supabase.js';
import { TOOL_FEATURES, getToolFeature } from './tool-access.js';

export type FeatureFilterMode = 'off' | 'shadow' | 'enforce';

/** MCP_FEATURE_FILTER, read per call so tests can set it. Anything unknown is 'off'. */
export function featureFilterMode(raw: string | undefined = process.env.MCP_FEATURE_FILTER): FeatureFilterMode {
  const v = raw?.trim().toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

/** Feature keys any tool is tagged with. */
export function taggedFeatureKeys(): string[] {
  return [...new Set(Object.values(TOOL_FEATURES))].sort();
}

/** PostgREST "function not found" / Postgres undefined_function. */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || error.code === '42883';
}

/**
 * The caller's enabled feature keys among `keys`, or null when the feature
 * RPC is missing or fails (the caller then behaves as if the filter were off).
 */
export async function resolveUserFeatures(userId: string, keys: string[] = taggedFeatureKeys()): Promise<Set<string> | null> {
  try {
    const results = await Promise.all(keys.map(async (key) => {
      const { data, error } = await dbAdmin.rpc('feature_enabled', { p_key: key, p_user_id: userId });
      if (error) throw error;
      return [key, data === true] as const;
    }));
    return new Set(results.filter(([, on]) => on).map(([key]) => key));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (isMissingFunction(e)) {
      console.error('[features] feature_enabled RPC not found — feature filter skipped');
    } else {
      console.error(`[features] feature lookup failed for ${userId}: ${e?.message ?? String(err)} — feature filter skipped`);
    }
    return null;
  }
}

export type FeaturePhase = 'register' | 'call';

/**
 * Fire-and-forget log of a tool the filter hid (enforce) or would hide (shadow).
 * Never awaited — must not block the response path.
 */
export function logFeatureHidden(
  userId:  string,
  tool:    string,
  feature: string,
  mode:    Exclude<FeatureFilterMode, 'off'>,
  phase:   FeaturePhase,
): void {
  void dbAdmin
    .from('security_events')
    .insert({
      user_id:    userId,
      event_type: 'mcp_feature_hidden',
      severity:   'low',
      evidence:   { tool, feature, mode, phase },
    })
    .then(({ error }) => {
      if (error) console.error(`[features] failed to log hidden tool: ${error.message}`);
    });
}

export interface FeatureGate {
  mode: FeatureFilterMode;
  /** Enabled keys for this session; null = unknown (RPC missing), filter skipped. */
  enabled: Set<string> | null;
}

export const FEATURE_GATE_OFF: FeatureGate = { mode: 'off', enabled: null };

/** Resolve the gate once per MCP session (like the role). Off costs no DB call. */
export async function resolveFeatureGate(userId: string, mode: FeatureFilterMode = featureFilterMode()): Promise<FeatureGate> {
  if (mode === 'off') return FEATURE_GATE_OFF;
  return { mode, enabled: await resolveUserFeatures(userId) };
}

/**
 * Whether the tool may be listed / called under this gate. In shadow mode a
 * would-be hide is logged and the tool is allowed. In enforce it is refused;
 * only call-time refusals are logged (a call to a tool that was never listed),
 * not the routine hides at registration.
 */
export function featureAllows(
  gate:   FeatureGate,
  userId: string,
  tool:   string,
  phase:  FeaturePhase,
  log:    typeof logFeatureHidden = logFeatureHidden,
): boolean {
  if (gate.mode === 'off' || gate.enabled === null) return true;
  const feature = getToolFeature(tool);
  if (!feature || gate.enabled.has(feature)) return true;
  if (gate.mode === 'shadow' || phase === 'call') log(userId, tool, feature, gate.mode, phase);
  return gate.mode === 'shadow';
}

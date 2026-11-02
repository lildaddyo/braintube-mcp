/**
 * L5 feature filter: hide tools whose product feature is off for the caller.
 *
 * Design: lildaddyo/dark-n-cozy docs/investigations/feature-guard-protocol.md
 * (layer L5, abuse case 5b, §6.1). Tools carry a feature key in TOOL_FEATURES
 * (tool-access.ts). The filter runs at registration (tools/list, and so the
 * router's routable set) and again at call time in secureWrap.
 *
 * Switch: MCP_FEATURE_FILTER=off|shadow|enforce (default off).
 *   off      — behave exactly as before this filter existed (no DB call).
 *   shadow   — hide nothing; log each would-be hide to security_events
 *              (event_type 'mcp_feature_hidden').
 *   enforce  — hide tools whose feature is not enabled for the caller.
 *
 * Source: the evaluator in dark-n-cozy docs/investigations/feature-guard/
 * 0001_feature_guard.sql. get_my_features() there reads auth.uid(), which is
 * null under this server's service-role client (and API-key sessions carry no
 * user JWT), so the server calls get_features_for(p_user_id) — one call per
 * user, service role only. If that function is missing it falls back to
 * feature_enabled(p_key, p_user_id) per tagged key.
 *
 * Failures (resolver below):
 *   - answers are cached 60 s per user, shared by all of that user's sessions,
 *     so a kill switch or revoke reaches open sessions at call time within a minute;
 *   - when a lookup fails, the user's last good answer is used for up to 6 h;
 *   - with no answer at all the filter is skipped (behave as today). The edge
 *     functions behind the tools still check their feature (L3).
 *   - real failures are logged to security_events ('mcp_feature_lookup_failed')
 *     at most once a minute; a missing RPC (SQL not applied yet) only logs to
 *     the console, at most every 10 minutes.
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
export function isMissingFunction(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST202' || code === '42883';
}

// ─── Lookup (one user) ────────────────────────────────────────────────────────

const BATCH_RETRY_MS = 10 * 60_000;
let batchMissingUntil = 0;

/** Enabled feature keys for a user, straight from the DB. Throws on any error. */
async function dbLookup(userId: string): Promise<Set<string>> {
  if (Date.now() >= batchMissingUntil) {
    const { data, error } = await dbAdmin.rpc('get_features_for', { p_user_id: userId });
    if (!error) return new Set((data as string[] | null) ?? []);
    if (!isMissingFunction(error)) throw error;
    batchMissingUntil = Date.now() + BATCH_RETRY_MS; // older SQL: per-key until it is retried
  }
  const results = await Promise.all(taggedFeatureKeys().map(async (key) => {
    const { data, error } = await dbAdmin.rpc('feature_enabled', { p_key: key, p_user_id: userId });
    if (error) throw error;
    return [key, data === true] as const;
  }));
  return new Set(results.filter(([, on]) => on).map(([key]) => key));
}

// ─── Resolver: cache + last good answer ───────────────────────────────────────

export interface FeatureResolverOptions {
  lookup:      (userId: string) => Promise<Set<string>>;
  ttlMs?:      number;
  lastGoodMs?: number;
  maxUsers?:   number;
  now?:        () => number;
  onFailure?:  (userId: string, err: unknown, usedLastGood: boolean) => void;
}

export interface FeatureResolver {
  /** Enabled keys for the user, or null when unknown (lookup failing, no last good answer). */
  get(userId: string): Promise<Set<string> | null>;
  clear(): void;
}

export function createFeatureResolver(opts: FeatureResolverOptions): FeatureResolver {
  const ttlMs      = opts.ttlMs      ?? 60_000;
  const lastGoodMs = opts.lastGoodMs ?? 6 * 60 * 60_000;
  const maxUsers   = opts.maxUsers   ?? 10_000;
  const now        = opts.now        ?? Date.now;
  const cache    = new Map<string, { keys: Set<string>; at: number }>();
  const inflight = new Map<string, Promise<Set<string> | null>>();

  async function refresh(userId: string): Promise<Set<string> | null> {
    try {
      const keys = await opts.lookup(userId);
      cache.delete(userId); // re-insert so Map order stays oldest-first
      cache.set(userId, { keys, at: now() });
      while (cache.size > maxUsers) cache.delete(cache.keys().next().value as string);
      return keys;
    } catch (err) {
      const hit = cache.get(userId);
      const lastGood = hit && now() - hit.at < lastGoodMs ? hit.keys : null;
      opts.onFailure?.(userId, err, lastGood !== null);
      return lastGood;
    }
  }

  return {
    async get(userId) {
      const hit = cache.get(userId);
      if (hit && now() - hit.at < ttlMs) return hit.keys;
      let p = inflight.get(userId);
      if (!p) {
        p = refresh(userId).finally(() => inflight.delete(userId));
        inflight.set(userId, p);
      }
      return p;
    },
    clear() { cache.clear(); inflight.clear(); },
  };
}

const FAIL_EVENT_INTERVAL_MS = 60_000;
const MISSING_LOG_INTERVAL_MS = 10 * 60_000;
let lastFailEvent = 0;
let lastMissingLog = 0;

function reportLookupFailure(userId: string, err: unknown, usedLastGood: boolean): void {
  const fallback = usedLastGood ? 'using the last good answer' : 'feature filter skipped';
  const t = Date.now();
  if (isMissingFunction(err)) {
    if (t - lastMissingLog < MISSING_LOG_INTERVAL_MS) return;
    lastMissingLog = t;
    console.error(`[features] feature RPCs not found (SQL not applied?) — ${fallback}`);
    return;
  }
  const e = err as { code?: string; message?: string };
  const message = e?.message ?? String(err);
  console.error(`[features] feature lookup failed for ${userId}: ${message} — ${fallback}`);
  if (t - lastFailEvent < FAIL_EVENT_INTERVAL_MS) return;
  lastFailEvent = t;
  void dbAdmin
    .from('security_events')
    .insert({
      user_id:    userId,
      event_type: 'mcp_feature_lookup_failed',
      severity:   'medium',
      evidence:   { code: e?.code ?? null, message: message.slice(0, 300), used_last_good: usedLastGood },
    })
    .then(({ error }) => {
      if (error) console.error(`[features] failed to log lookup failure: ${error.message}`);
    });
}

const defaultResolver = createFeatureResolver({ lookup: dbLookup, onFailure: reportLookupFailure });

/** The user's enabled feature keys (cached 60 s), or null when unknown. */
export function resolveUserFeatures(userId: string): Promise<Set<string> | null> {
  return defaultResolver.get(userId);
}

// ─── Hidden-tool log ──────────────────────────────────────────────────────────

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

// ─── Gate ─────────────────────────────────────────────────────────────────────

export interface FeatureGate {
  mode: FeatureFilterMode;
  /** Enabled keys when the session was built; null = unknown, filter skipped. */
  enabled: Set<string> | null;
  /** Current keys (cached) for the call-time check. Absent: `enabled` is used. */
  current?: () => Promise<Set<string> | null>;
}

export const FEATURE_GATE_OFF: FeatureGate = { mode: 'off', enabled: null };

/** Resolve the gate once per MCP session (like the role). Off costs no DB call. */
export async function resolveFeatureGate(
  userId: string,
  mode: FeatureFilterMode = featureFilterMode(),
  resolve: (userId: string) => Promise<Set<string> | null> = resolveUserFeatures,
): Promise<FeatureGate> {
  if (mode === 'off') return FEATURE_GATE_OFF;
  return { mode, enabled: await resolve(userId), current: () => resolve(userId) };
}

/**
 * Whether the tool may be listed / called under this gate. In shadow mode a
 * would-be hide is logged and the tool is allowed. In enforce it is refused;
 * only call-time refusals are logged (a call to a tool that was never listed,
 * or whose feature was turned off mid-session), not the routine hides at
 * registration.
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

/** Call-time check against the current (cached) keys, so a revoke or kill switch reaches open sessions. */
export async function featureAllowsNow(
  gate:   FeatureGate,
  userId: string,
  tool:   string,
  log:    typeof logFeatureHidden = logFeatureHidden,
): Promise<boolean> {
  if (gate.mode === 'off' || !getToolFeature(tool)) return true;
  const enabled = gate.current ? await gate.current() : gate.enabled;
  return featureAllows({ mode: gate.mode, enabled }, userId, tool, 'call', log);
}

// ─── Startup check ────────────────────────────────────────────────────────────

async function dbFeatureKeys(): Promise<Set<string>> {
  const { data, error } = await dbAdmin.from('feature_flags').select('key');
  if (error) throw error;
  return new Set((data as Array<{ key: string }> | null ?? []).map((r) => r.key));
}

/**
 * At startup (shadow / enforce only): every key in TOOL_FEATURES must exist in
 * feature_flags. An unknown key is never enabled, so under enforce its tools
 * would vanish for everyone. Returns the unknown keys, or null when the check
 * did not run.
 */
export async function checkFeatureTags(
  mode: FeatureFilterMode = featureFilterMode(),
  readKeys: () => Promise<Set<string>> = dbFeatureKeys,
): Promise<string[] | null> {
  if (mode === 'off') return null;
  let known: Set<string>;
  try {
    known = await readKeys();
  } catch (err) {
    console.error(`[features] startup check: feature_flags unreadable (${(err as Error)?.message ?? String(err)}) — the filter skips every session until the SQL is applied`);
    return null;
  }
  const unknown = taggedFeatureKeys().filter((k) => !known.has(k));
  if (unknown.length === 0) {
    console.error(`[features] startup check: ${taggedFeatureKeys().length} feature tags all exist (mode: ${mode})`);
    return unknown;
  }
  const tools = Object.entries(TOOL_FEATURES).filter(([, k]) => unknown.includes(k)).map(([t]) => t);
  console.error(`[features] STARTUP CHECK FAILED: feature keys ${unknown.join(', ')} are not in feature_flags — under enforce these tools are hidden from everyone: ${tools.join(', ')}`);
  void dbAdmin
    .from('security_events')
    .insert({
      event_type: 'mcp_feature_tag_unknown',
      severity:   'high',
      evidence:   { unknown_keys: unknown, tools, mode },
    })
    .then(({ error }) => {
      if (error) console.error(`[features] failed to log unknown feature tags: ${error.message}`);
    });
  return unknown;
}

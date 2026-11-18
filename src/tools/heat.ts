import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

/**
 * Content heat: which saved items are in use, and by whom.
 *
 *   agent_heat  an AI client reached the item over MCP (search hit, direct read, agent-written note)
 *   user_heat   the person did, in the app (search or chat hit, open, highlight, note, star, watch)
 *   heat        both together, 0..1
 *
 * The score is computed in the database (supabase/migrations/20261119000000_item_heat.sql) from
 * distinct touch-days with a 21-day half-life; no LLM is involved. A nightly cron rebuilds it for
 * everyone; these tools rebuild the caller's rows first when they are older than HEAT_MAX_AGE_MS.
 */

export const HEAT_MAX_AGE_MS = 60 * 60 * 1000;

export const HEAT_TIERS = ['hot', 'warm', 'cool', 'cold'] as const;
export const HEAT_ACTORS = ['both', 'agent', 'user', 'none'] as const;

/** True when the newest heat row is missing or older than maxAgeMs. */
export function heatIsStale(computedAt: string | null | undefined, now: number = Date.now(), maxAgeMs: number = HEAT_MAX_AGE_MS): boolean {
  if (!computedAt) return true;
  const t = Date.parse(computedAt);
  if (Number.isNaN(t)) return true;
  return now - t > maxAgeMs;
}

/** Rebuild the caller's heat rows when stale. Returns when they were computed. Never throws. */
export async function ensureFreshHeat(userId: string): Promise<string | null> {
  try {
    const { data } = await dbAdmin
      .from('item_heat')
      .select('computed_at')
      .eq('user_id', userId)
      .order('computed_at', { ascending: false })
      .limit(1);
    const latest = (data?.[0] as { computed_at?: string } | undefined)?.computed_at ?? null;
    if (!heatIsStale(latest)) return latest;
    const { error } = await dbAdmin.rpc('compute_item_heat', { for_user_id: userId });
    if (error) {
      console.warn('[heat] compute_item_heat failed (serving the last scores):', error.message);
      return latest;
    }
    return new Date().toISOString();
  } catch (err) {
    console.warn('[heat] freshness check failed (non-fatal):', err);
    return null;
  }
}

// ── content_heat ──────────────────────────────────────────────────────────────

export const contentHeatSchema = z.object({
  tier: z.enum(HEAT_TIERS).optional().describe(
    'Only items in this tier. hot = top 15% of touched items in this library, warm = the next 35%, cool = touched but rarely, cold = nobody touched it in about 3 months. Omit for all tiers.'
  ),
  touched_by: z.enum(HEAT_ACTORS).optional().describe(
    'Only items touched by this actor: agent = AI clients over MCP only, user = the person in the app only, both = each of them, none = neither. Omit for all.'
  ),
  coldest_first: z.boolean().default(false).describe(
    'true lists the coldest, oldest items first (stale saves); false (default) lists the hottest first.'
  ),
  limit: z.number().int().min(1).max(100).default(20).describe('Number of items to return (default 20, max 100)'),
});

const heatItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  heat: z.number(),
  agent_heat: z.number(),
  user_heat: z.number(),
  tier: z.string(),
  touched_by: z.string(),
}).passthrough();

export const contentHeatOutputSchema = z.object({
  items: z.array(heatItemSchema),
  counts: z.record(z.string(), z.number()),
  computed_at: z.string().nullable(),
});

interface HeatRow {
  id: string; title: string | null; source_type: string | null; url: string | null;
  topic_primary: string | null; created_at: string; taint_level: number | null; provenance: string | null;
  heat: number | string; agent_heat: number | string; user_heat: number | string;
  tier: string; touched_by: string; agent_days: number; user_days: number;
  last_agent_touch: string | null; last_user_touch: string | null;
}

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : 'never');

export function formatHeatLine(r: Pick<HeatRow, 'title' | 'heat' | 'agent_heat' | 'user_heat' | 'tier' | 'touched_by' | 'last_agent_touch' | 'last_user_touch'>): string {
  return `[${r.tier}] ${r.title ?? '(untitled)'}  heat ${num(r.heat).toFixed(2)}`
    + ` (agent ${num(r.agent_heat).toFixed(2)}, you ${num(r.user_heat).toFixed(2)})`
    + `  last agent ${day(r.last_agent_touch)}, last you ${day(r.last_user_touch)}`;
}

async function heatCounts(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await Promise.all(HEAT_TIERS.map(async (tier) => {
    const { count } = await dbAdmin
      .from('item_heat')
      .select('item_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tier', tier);
    counts[tier] = count ?? 0;
  }));
  return counts;
}

export async function contentHeat(input: z.infer<typeof contentHeatSchema>, userId: string) {
  const computedAt = await ensureFreshHeat(userId);
  const [{ data, error }, counts] = await Promise.all([
    dbAdmin.rpc('item_heat_list', {
      for_user_id: userId,
      p_tier: input.tier ?? null,
      p_touched_by: input.touched_by ?? null,
      p_coldest: input.coldest_first,
      p_limit: input.limit,
    }),
    heatCounts(userId),
  ]);
  if (error) throw new Error(`item_heat_list RPC failed: ${error.message}`);

  const items = ((data ?? []) as HeatRow[]).map((r) => ({
    ...r,
    heat: num(r.heat), agent_heat: num(r.agent_heat), user_heat: num(r.user_heat),
  }));

  const header = `Library heat: ${counts.hot ?? 0} hot, ${counts.warm ?? 0} warm, ${counts.cool ?? 0} cool, ${counts.cold ?? 0} cold.`;
  const text = items.length === 0
    ? `${header}\nNo items match this filter.`
    : [header, '', ...items.map((r, i) => `${String(i + 1).padStart(2)}. ${formatHeatLine(r)}`)].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { items, counts, computed_at: computedAt } as unknown as Record<string, unknown>,
  };
}

// ── compile_suggestions ───────────────────────────────────────────────────────

export const compileSuggestionsSchema = z.object({
  min_items: z.number().int().min(2).max(100).default(5).describe(
    'Smallest stack worth reporting: how many stale, uncompiled saves a topic must hold (default 5).'
  ),
  limit: z.number().int().min(1).max(50).default(10).describe('Number of stacks to return (default 10)'),
});

const stackSchema = z.object({
  kind: z.string(),
  name: z.string().nullable().optional(),
  cluster_id: z.string().nullable().optional(),
  stale_uncompiled: z.number(),
  total_items: z.number(),
  suggestion: z.string(),
}).passthrough();

export const compileSuggestionsOutputSchema = z.object({
  stacks: z.array(stackSchema),
  computed_at: z.string().nullable(),
});

export interface StackRow {
  kind: 'cluster' | 'topic' | string;
  cluster_id: string | null;
  name: string | null;
  stale_uncompiled: number;
  uncompiled: number;
  total_items: number;
  active_items: number;
  has_article: boolean;
  oldest_stale: string | null;
  newest_uncompiled: string | null;
  taint_level: number;
  sample_titles: string[];
}

/** What to do about a stack, in one line an agent can act on. */
export function stackSuggestion(s: Pick<StackRow, 'kind' | 'cluster_id' | 'name' | 'stale_uncompiled' | 'has_article'>): string {
  const name = s.name ?? 'this topic';
  if (s.kind === 'cluster' && s.cluster_id) {
    return s.has_article
      ? `${s.stale_uncompiled} unused saves are not in the "${name}" article yet. Recompile it: compile_knowledge with cluster_id ${s.cluster_id}.`
      : `${s.stale_uncompiled} unused saves on "${name}" have no article. Compile them: compile_knowledge with cluster_id ${s.cluster_id}.`;
  }
  return `${s.stale_uncompiled} unused saves on "${name}" are in no topic cluster, so they cannot be compiled yet. Read a few (search_knowledge "${name}") and keep, tag or archive them.`;
}

async function loadStacks(userId: string, minItems: number, limit: number): Promise<Array<StackRow & { suggestion: string }>> {
  const { data, error } = await dbAdmin.rpc('heat_compile_suggestions', {
    for_user_id: userId, p_min_items: minItems, p_limit: limit,
  });
  if (error) throw new Error(`heat_compile_suggestions RPC failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as StackRow[];
  return rows.map((s) => ({
    ...s,
    sample_titles: Array.isArray(s.sample_titles) ? s.sample_titles : [],
    suggestion: stackSuggestion(s),
  }));
}

export function formatStackLine(s: StackRow & { suggestion: string }): string {
  const lines = [
    `${s.name ?? '(unnamed)'}: ${s.stale_uncompiled} stale and uncompiled of ${s.total_items} (${s.active_items} in active use)`,
    `   ${s.suggestion}`,
  ];
  if (s.sample_titles.length > 0) lines.push(`   e.g. ${s.sample_titles.slice(0, 3).join(' | ')}`);
  return lines.join('\n');
}

export async function compileSuggestions(input: z.infer<typeof compileSuggestionsSchema>, userId: string) {
  const computedAt = await ensureFreshHeat(userId);
  const stacks = await loadStacks(userId, input.min_items, input.limit);
  const text = stacks.length === 0
    ? `No stack of ${input.min_items}+ stale, uncompiled saves. Nothing is piling up.`
    : [`${stacks.length} stack(s) of saves that nobody is using and no article covers:`, '',
        ...stacks.map((s, i) => `${i + 1}. ${formatStackLine(s)}`)].join('\n');
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { stacks, computed_at: computedAt } as unknown as Record<string, unknown>,
  };
}

// ── daily_digest ──────────────────────────────────────────────────────────────

export const dailyDigestSchema = z.object({
  hours: z.number().int().min(1).max(336).default(24).describe(
    'How far back to look for new saves, in hours (default 24, max 336 = 14 days).'
  ),
  limit: z.number().int().min(1).max(200).default(60).describe('Most saves to return (default 60)'),
});

const digestItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
}).passthrough();

export const dailyDigestOutputSchema = z.object({
  window_hours: z.number(),
  since: z.string(),
  saved_count: z.number(),
  by_topic: z.record(z.string(), z.number()),
  by_source: z.record(z.string(), z.number()),
  items: z.array(digestItemSchema),
  stacks: z.array(stackSchema),
  heat_counts: z.record(z.string(), z.number()),
});

interface DigestRow {
  id: string; title: string | null; source_type: string | null; url: string | null; channel: string | null;
  created_at: string; topic_primary: string | null; content_type: string | null;
  summary_oneliner: string | null; core_thesis: string | null;
  key_takeaways: string[] | null; key_concepts: string[] | null; entities: string[] | null;
  taint_level: number | null; provenance: string | null; save_origin: string | null; status: string | null;
  tier: string; touched_by: string;
}

export function tally(values: Array<string | null | undefined>, fallback: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = v && v.trim() ? v : fallback;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Everything an agent needs for a daily review in one call: what was saved in the window (with the
 * summary, thesis and takeaways of each), how the library's heat stands, and which stale stacks
 * are worth compiling. The agent writes the conclusions; this tool only gathers.
 */
export async function dailyDigest(input: z.infer<typeof dailyDigestSchema>, userId: string) {
  await ensureFreshHeat(userId);
  const [{ data, error }, stacks, counts] = await Promise.all([
    dbAdmin.rpc('saves_digest', { for_user_id: userId, p_hours: input.hours, p_limit: input.limit }),
    loadStacks(userId, 5, 5),
    heatCounts(userId),
  ]);
  if (error) throw new Error(`saves_digest RPC failed: ${error.message}`);

  const rows = (data ?? []) as DigestRow[];
  // `summary` (not summary_oneliner) so the untrusted-content envelope moves it with the other body fields.
  const items = rows.map(({ summary_oneliner, ...r }) => ({ ...r, summary: summary_oneliner }));
  const since = new Date(Date.now() - input.hours * 3600 * 1000).toISOString();
  const byTopic = tally(rows.map((r) => r.topic_primary), 'untagged');
  const bySource = tally(rows.map((r) => r.source_type), 'unknown');

  const lines: string[] = [];
  lines.push(rows.length === 0
    ? `Nothing was saved in the last ${input.hours} hours.`
    : `${rows.length} item(s) saved in the last ${input.hours} hours.`);
  if (rows.length > 0) {
    lines.push(`Topics: ${Object.entries(byTopic).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');
    for (const [i, r] of rows.entries()) {
      lines.push(`${i + 1}. ${r.title ?? '(untitled)'}  [${r.source_type ?? 'unknown'}${r.topic_primary ? `, ${r.topic_primary}` : ''}]  id ${r.id}`);
      const gist = r.core_thesis ?? r.summary_oneliner;
      if (gist) lines.push(`   ${gist}`);
      for (const t of (r.key_takeaways ?? []).slice(0, 3)) lines.push(`   - ${t}`);
    }
  }
  lines.push('', `Library heat: ${counts.hot ?? 0} hot, ${counts.warm ?? 0} warm, ${counts.cool ?? 0} cool, ${counts.cold ?? 0} cold.`);
  if (stacks.length > 0) {
    lines.push('', 'Stale stacks worth compiling:');
    for (const s of stacks) lines.push(`- ${formatStackLine(s)}`);
  }

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      window_hours: input.hours,
      since,
      saved_count: rows.length,
      by_topic: byTopic,
      by_source: bySource,
      items,
      stacks,
      heat_counts: counts,
    } as unknown as Record<string, unknown>,
  };
}

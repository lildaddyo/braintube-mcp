/**
 * Ingest gateway: the ONE place that writes saved content (`items`, `item_notes`) and decides how
 * far it is trusted.
 *
 * Why it exists (audit 2026-11-01, finding 1): ingest_content and bulk_ingest stored whatever an
 * AI agent sent with `taint_level: 0` ("clean"), and notion ingest left taint to the DB default.
 * An agent that read a poisoned web page could save the attacker's instructions, and every later
 * session got them back marked clean. Content written by an agent is not content the user typed.
 *
 * Rules enforced here, never by the caller:
 *   - Provenance comes from the CHANNEL the write arrived on (MCP tool, REST, extension, import),
 *     not from anything in the payload. The caller cannot pass a provenance or a taint level.
 *   - `user_typed` (taint 0) is reserved for text a human typed in the BrainTube app UI. No channel
 *     of this server maps to it: the app writes through its own Supabase path, not through here.
 *   - Everything else is untrusted: taint >= 1. A hit from the injection detector raises it to 2.
 *   - Overwriting an existing item never lowers its taint, and the new writer becomes its provenance.
 *   - Agent-written items carry the visible tag `agent-written`, so the app and every later
 *     retrieval show where the text came from even before the `provenance` column exists.
 *
 * src/lib/ingest-gateway.test.ts fails the build if any file outside this module inserts into, or
 * changes the content of, `items` or `item_notes`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { dbAdmin } from '../db/supabase.js';
import { detectInjection, logInjectionAttempt } from '../security/injection.js';

// ─── Provenance ───────────────────────────────────────────────────────────────

export type Provenance =
  | 'user_typed'
  | 'agent_written'
  | `third_party:${string}`
  | `import:${string}`;

export type ImportSource = 'notion' | 'obsidian' | 'readwise' | 'claude_session';

/** Where a write came from. Deliberately has no variant for the app UI (see header). */
export type WriteChannel =
  | { kind: 'mcp_tool'; tool: string }
  | { kind: 'rest_api'; route: string }
  | { kind: 'extension'; sourceUrl?: string | null }
  | { kind: 'import'; source: ImportSource };

export const AGENT_WRITTEN_TAG = 'agent-written';

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

export function provenanceFor(channel: WriteChannel): Provenance {
  switch (channel.kind) {
    case 'mcp_tool':
    case 'rest_api':
      // An AI client (or a script holding the user's key) wrote these bytes. Even with a
      // source_url, BrainTube never fetched the page: the agent's copy is what gets stored.
      return 'agent_written';
    case 'extension':
      // Captured from a third-party page by the browser extension, summarised server-side.
      return `third_party:${hostOf(channel.sourceUrl) ?? 'unknown'}`;
    case 'import':
      return `import:${channel.source}`;
  }
}

export const TAINT_UNTRUSTED = 1;
export const TAINT_SUSPICIOUS = 2;

export function taintFor(provenance: Provenance, signals: { injection: boolean }): number {
  let taint = provenance === 'user_typed' ? 0 : TAINT_UNTRUSTED;
  if (signals.injection) taint = Math.max(taint, TAINT_SUSPICIOUS);
  return taint;
}

// ─── Detector signal ──────────────────────────────────────────────────────────

const SCAN_CHUNK = 20_000;
const SCAN_OVERLAP = 400;
const SCAN_MAX = 2_000_000;

/** Run the injection detector over the WHOLE text (overlapping chunks), not just the first 10k. */
export function scanForInjection(...texts: Array<string | null | undefined>): boolean {
  for (const t of texts) {
    if (!t) continue;
    const text = t.length > SCAN_MAX ? t.slice(0, SCAN_MAX) : t;
    if (text.length <= SCAN_CHUNK) {
      if (detectInjection(text)) return true;
      continue;
    }
    for (let i = 0; i < text.length; i += SCAN_CHUNK - SCAN_OVERLAP) {
      if (detectInjection(text.slice(i, i + SCAN_CHUNK))) return true;
    }
  }
  return false;
}

export interface TrustStamp {
  provenance: Provenance;
  taint_level: number;
}

/** The provenance + taint a write on this channel gets for this text. */
export function stampFor(channel: WriteChannel, ...texts: Array<string | null | undefined>): TrustStamp {
  const provenance = provenanceFor(channel);
  return { provenance, taint_level: taintFor(provenance, { injection: scanForInjection(...texts) }) };
}

function channelLabel(channel: WriteChannel): string {
  switch (channel.kind) {
    case 'mcp_tool': return `mcp:${channel.tool}`;
    case 'rest_api': return `rest:${channel.route}`;
    case 'extension': return 'extension';
    case 'import': return `import:${channel.source}`;
  }
}

// ─── Optional-column fallback ─────────────────────────────────────────────────
// The `provenance` columns arrive with supabase/migrations/20261101000000_item_provenance.sql.
// Until the owner applies it, PostgREST rejects a write that names them (PGRST204). Then the
// write is retried without those columns, so production keeps working. taint_level on `items`
// already exists, so the taint part of the fix is live either way.

const OPTIONAL_COLUMNS = ['provenance', 'taint_level'] as const;
const warnedMissing = new Set<string>();

function missingColumn(error: { code?: string; message?: string } | null | undefined): string | null {
  if (!error) return null;
  const msg = error.message ?? '';
  for (const col of OPTIONAL_COLUMNS) {
    if ((error.code === 'PGRST204' || /column/i.test(msg)) && msg.includes(`'${col}'`)) return col;
    if (new RegExp(`column "?[\\w.]*${col}"? .*does not exist`, 'i').test(msg)) return col;
  }
  return null;
}

type DbResult<T> = { data: T | null; error: { code?: string; message?: string } | null };

type Row = Record<string, unknown>;

function dropKey<R extends Row | Row[]>(rows: R, col: string): R {
  const strip = (r: Row) => {
    const { [col]: _dropped, ...rest } = r;
    void _dropped;
    return rest;
  };
  return (Array.isArray(rows) ? rows.map(strip) : strip(rows)) as R;
}

async function withColumnFallback<T, R extends Row | Row[]>(
  table: string,
  rows: R,
  run: (rows: R) => PromiseLike<DbResult<T>>,
  required: ReadonlyArray<string> = [],
): Promise<DbResult<T>> {
  let current = rows;
  for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length + 1; attempt++) {
    const res = await run(current);
    const col = missingColumn(res.error);
    const sample = Array.isArray(current) ? current[0] : current;
    if (!col || !sample || !(col in sample) || required.includes(col)) return res;
    const key = `${table}.${col}`;
    if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      console.error(`[ingest-gateway] ${key} column missing — apply migration 20261101000000_item_provenance.sql; writing without it`);
    }
    current = dropKey(current, col);
  }
  return run(current);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/** Content fields a caller may set. No provenance / taint / is_user_created: the gateway owns those. */
export interface ItemContentInput {
  title: string;
  summary?: string | null;
  full_transcript?: string | null;
  source_url?: string | null;
  url?: string;
  source_type: string;
  tags?: string[];
  /** Non-content columns specific to a channel (notion_page_id, status). */
  extra?: Record<string, unknown>;
}

const FORBIDDEN_EXTRA = new Set(['provenance', 'taint_level', 'is_user_created', 'user_id', 'id']);

function cleanExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra ?? {})) if (!FORBIDDEN_EXTRA.has(k)) out[k] = v;
  return out;
}

function labelTags(provenance: Provenance, tags: string[] | undefined): string[] {
  const out = [...(tags ?? [])];
  if (provenance === 'agent_written' && !out.includes(AGENT_WRITTEN_TAG)) out.push(AGENT_WRITTEN_TAG);
  return out;
}

export interface GatewayDeps {
  db?: SupabaseClient;
  userId: string;
  channel: WriteChannel;
}

function logSignal(deps: GatewayDeps, stamp: TrustStamp, snippet: string): void {
  if (stamp.taint_level >= TAINT_SUSPICIOUS) {
    // A signal, not a gate: the write goes through, flagged, and the security log records it.
    logInjectionAttempt(deps.userId, `${channelLabel(deps.channel)}:stored`, snippet);
  }
}

/** Insert a new item. Returns its id and the trust stamp it was stored with. */
export async function insertItem(
  deps: GatewayDeps,
  input: ItemContentInput,
): Promise<{ id: string; stamp: TrustStamp; tags: string[] }> {
  const db = deps.db ?? dbAdmin;
  const stamp = stampFor(deps.channel, input.title, input.summary, input.full_transcript);
  const tags = labelTags(stamp.provenance, input.tags);
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    ...cleanExtra(input.extra),
    user_id: deps.userId,
    source_type: input.source_type,
    title: input.title,
    summary: input.summary ?? null,
    ...(input.full_transcript !== undefined ? { full_transcript: input.full_transcript } : {}),
    source_url: input.source_url ?? null,
    url: input.url ?? input.source_url ?? `braintube://manual/${Date.now()}`,
    is_user_created: stamp.provenance === 'user_typed',
    is_archived: false,
    tags,
    created_at: now,
    updated_at: now,
    provenance: stamp.provenance,
    taint_level: stamp.taint_level,
  };
  const res = await withColumnFallback<{ id: string }, Row>('items', row,
    (r) => db.from('items').insert(r).select('id').single() as unknown as PromiseLike<DbResult<{ id: string }>>,
    ['taint_level']);
  if (res.error || !res.data) throw new Error(`insert failed — ${res.error?.message ?? 'no row returned'}`);
  logSignal(deps, stamp, input.title);
  return { id: res.data.id, stamp, tags };
}

/**
 * Replace an existing item's content. The item must belong to the user. Taint only ever goes up:
 * an agent overwriting a typed note does not inherit the note's trust.
 */
export async function updateItemContent(
  deps: GatewayDeps,
  itemId: string,
  input: Omit<ItemContentInput, 'source_type'> & { source_type?: string },
): Promise<{ stamp: TrustStamp }> {
  const db = deps.db ?? dbAdmin;
  const { data: current, error: readErr } = await db
    .from('items')
    .select('id, taint_level, tags')
    .eq('id', itemId)
    .eq('user_id', deps.userId)
    .maybeSingle();
  if (readErr) throw new Error(`update failed — ${readErr.message}`);
  if (!current) throw new Error('Item not found or does not belong to this user');

  const fresh = stampFor(deps.channel, input.title, input.summary, input.full_transcript);
  const stamp: TrustStamp = {
    provenance: fresh.provenance,
    taint_level: Math.max(fresh.taint_level, Number((current as { taint_level?: number }).taint_level ?? 0)),
  };
  const existingTags = ((current as { tags?: string[] | null }).tags ?? []) as string[];
  const patch: Record<string, unknown> = {
    ...cleanExtra(input.extra),
    title: input.title,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.full_transcript !== undefined ? { full_transcript: input.full_transcript } : {}),
    ...(input.source_url ? { source_url: input.source_url, url: input.url ?? input.source_url } : {}),
    is_user_created: false,
    tags: labelTags(stamp.provenance, [...new Set([...existingTags, ...(input.tags ?? [])])]),
    updated_at: new Date().toISOString(),
    provenance: stamp.provenance,
    taint_level: stamp.taint_level,
  };
  const res = await withColumnFallback<null, Row>('items', patch,
    (r) => db.from('items').update(r).eq('id', itemId).eq('user_id', deps.userId) as unknown as PromiseLike<DbResult<null>>,
    ['taint_level']);
  if (res.error) throw new Error(`update failed — ${res.error.message}`);
  logSignal(deps, stamp, input.title);
  return { stamp };
}

/**
 * Change an item's tag list (tag_item). Tags are agent-chosen text that is returned with the item,
 * so the item's taint is raised to at least 1; its content provenance is left as it was.
 */
export async function updateItemTags(deps: GatewayDeps, itemId: string, tags: string[]): Promise<void> {
  const db = deps.db ?? dbAdmin;
  const { data: current, error: readErr } = await db
    .from('items')
    .select('id, taint_level')
    .eq('id', itemId)
    .eq('user_id', deps.userId)
    .maybeSingle();
  if (readErr) throw new Error(`Failed to update tags: ${readErr.message}`);
  if (!current) throw new Error('Item not found or does not belong to this user');
  const stamp = stampFor(deps.channel, tags.join(' '));
  const taint = Math.max(stamp.taint_level, Number((current as { taint_level?: number }).taint_level ?? 0));
  const { error } = await db
    .from('items')
    .update({ tags, taint_level: taint })
    .eq('id', itemId)
    .eq('user_id', deps.userId);
  if (error) throw new Error(`Failed to update tags: ${error.message}`);
  logSignal(deps, { provenance: stamp.provenance, taint_level: taint }, tags.join(' '));
}

/** Upsert the one note an item holds (add_note). Notes written here are agent-written. */
export async function upsertItemNote(
  deps: GatewayDeps,
  itemId: string,
  note: string,
): Promise<{ stamp: TrustStamp }> {
  const db = deps.db ?? dbAdmin;
  const { data: item } = await db
    .from('items')
    .select('id')
    .eq('id', itemId)
    .eq('user_id', deps.userId)
    .maybeSingle();
  if (!item) throw new Error('Item not found or does not belong to this user');

  const stamp = stampFor(deps.channel, note);
  const row: Record<string, unknown> = {
    item_id: itemId,
    user_id: deps.userId,
    content: note,
    updated_at: new Date().toISOString(),
    provenance: stamp.provenance,
    taint_level: stamp.taint_level,
  };
  const res = await withColumnFallback<null, Row>('item_notes', row,
    (r) => db.from('item_notes').upsert(r, { onConflict: 'item_id,user_id' }) as unknown as PromiseLike<DbResult<null>>);
  if (res.error) throw new Error(`Failed to write note: ${res.error.message}`);
  logSignal(deps, stamp, note);
  return { stamp };
}

/** Columns a session-archive row is stamped with (claude_sessions / session_rounds). */
export function sessionArchiveStamp(...texts: Array<string | null | undefined>): TrustStamp {
  return stampFor({ kind: 'import', source: 'claude_session' }, ...texts);
}

/** Exposed for session-ingest, which owns its own tables but must stamp them the same way. */
export { withColumnFallback as writeWithOptionalColumns };

/**
 * `grep`: exact-text search over the saved library (retrieval gap vs Recall, 2026-11-19).
 *
 * Semantic search answers "what did I save about X"; this answers "where exactly does it say X": a name, a number, a
 * quote, an error string. It matches the literal text, case-insensitively by default, in
 *   - the body of every item (transcript / page text, read per passage, so a match knows its position `n` and, for a
 *     video, the second `t` it is spoken at and a link to it), and
 *   - the item's title, summary and description (and the stored text of items that have no passages).
 * Results are grouped by item, each match with a snippet around the hit. No embeddings, no re-rank, no AI call.
 * Scoped to the caller's items; archived, adult, AI-excluded and taint-3 items are left out, as in search.
 */
import { z } from 'zod';
import { numArg } from '../lib/num-arg.js';
import { dbAdmin } from '../db/supabase.js';
import { shortQuote, timestampUrl } from '../lib/moments.js';
import { itemUrl } from './chatgpt-compat.js';

export const GREP_DEFAULT_LIMIT = 20;
export const GREP_MAX_LIMIT = 50;
const SNIPPET_RADIUS = 160;
const FIELD_ITEMS = 20;

export const grepSchema = z.object({
  pattern: z.string().min(2).max(200).describe(
    'The exact text to find (a word, name, number or phrase), matched literally. Not a regular expression. Example: "Bevy", "18 days", "glance, not a gaze".'
  ),
  item_id: z.string().min(1).max(200).optional().describe(
    'Only look inside this one item (an id from search or grep). Omit to search the whole library.'
  ),
  case_sensitive: z.boolean().default(false).describe('Match upper and lower case exactly (default false).'),
  limit: numArg(z.number().int().min(1).max(GREP_MAX_LIMIT).default(GREP_DEFAULT_LIMIT)).describe(
    `Matching passages per page (default ${GREP_DEFAULT_LIMIT}, max ${GREP_MAX_LIMIT}).`
  ),
  cursor: z.string().max(40).optional().describe('next_cursor from the previous page, to get the next one.'),
});

const grepMatchSchema = z.object({
  field: z.string(),             // text | title | summary | description
  snippet: z.string(),           // the text around the first hit in this passage or field
  hits: z.number().optional(),   // how often the pattern occurs in this passage or field
  n: z.number().optional(),      // text matches: position of the passage in the item (pass to fetch as from_passage)
  t: z.number().optional(),      // timed sources: second the passage starts at
  url: z.string().optional(),    // timed sources: source URL opening at t
});
export type GrepMatch = z.infer<typeof grepMatchSchema>;

export const grepOutputSchema = z.object({
  pattern: z.string(),
  results: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    source_type: z.string().optional(),
    matches: z.array(grepMatchSchema).optional(),
    trust: z.string().optional(),
    provenance: z.string().optional(),
    taint_level: z.number().optional(),
    untrusted_content: z.object({ matches: z.array(grepMatchSchema).optional() }).optional(),
  })),
  match_count: z.number(),
  next_cursor: z.string().optional(),
});

/** LIKE pattern for a literal: `\`, `%` and `_` escaped; `*` (PostgREST's alias for `%`) becomes the one-character wildcard. */
export function likeLiteral(pattern: string): string {
  return `%${pattern.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_')}%`;
}

function indexOfMatch(text: string, pattern: string, caseSensitive: boolean, from = 0): number {
  return caseSensitive ? text.indexOf(pattern, from) : text.toLowerCase().indexOf(pattern.toLowerCase(), from);
}

export function countHits(text: string, pattern: string, caseSensitive: boolean): number {
  let n = 0;
  for (let i = indexOfMatch(text, pattern, caseSensitive); i >= 0; i = indexOfMatch(text, pattern, caseSensitive, i + pattern.length)) n++;
  return n;
}

/** The text around the first hit, cut at word boundaries, with … where text was left out. Null when there is no hit. */
export function snippetAround(text: string, pattern: string, caseSensitive: boolean, radius = SNIPPET_RADIUS): string | null {
  const at = indexOfMatch(text, pattern, caseSensitive);
  if (at < 0) return null;
  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, at + pattern.length + radius);
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < at) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > at + pattern.length) end = sp; }
  const body = shortQuote(text.slice(start, end), radius * 2 + pattern.length + 40);
  return `${start > 0 ? '…' : ''}${body}${end < text.length && !body.endsWith('…') ? '…' : ''}`;
}

interface ItemMeta {
  id: string; title?: string | null; url?: string | null; video_id?: string | null; source_type?: string | null;
  taint_level?: number | null; provenance?: string | null; summary?: string | null; description?: string | null;
}
interface Group { meta: ItemMeta; matches: GrepMatch[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_COLS = 'id, title, url, video_id, source_type, taint_level, provenance';

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor.replace(/^o:/, ''));
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Error('Invalid cursor. Pass the next_cursor value of the previous grep page unchanged, or omit it to start from the first match.');
  return n;
}

/** The caller's item id for a UUID or a YouTube video id; null when the caller has no such item. */
async function resolveItemId(itemId: string, userId: string): Promise<string | null> {
  const col = UUID.test(itemId) ? 'id' : 'video_id';
  const { data } = await dbAdmin.from('items').select('id').eq('user_id', userId).eq(col, itemId).not('is_adult', 'is', true).limit(1);
  return ((data ?? [])[0] as { id?: string } | undefined)?.id ?? null;
}

export async function grepLibrary(input: z.infer<typeof grepSchema>, userId: string) {
  const pattern = input.pattern.trim();
  if (pattern.length < 2) throw new Error('pattern must be at least 2 characters after trimming.');
  const caseSensitive = input.case_sensitive ?? false;
  const limit = input.limit ?? GREP_DEFAULT_LIMIT;
  const offset = parseCursor(input.cursor);
  const like = likeLiteral(pattern);
  const op = caseSensitive ? 'like' : 'ilike';

  let scope: string | null = null;
  if (input.item_id) {
    scope = await resolveItemId(input.item_id, userId);
    if (!scope) throw new Error(`No saved item with id "${input.item_id}". Use an id returned by search, search_knowledge or grep.`);
  }

  // ── Body text, per passage (paged) ─────────────────────────────────────────────
  let q = dbAdmin
    .from('transcript_segments')
    .select(`item_id, segment_index, start_time_sec, text, items!inner(${ITEM_COLS}, user_id)`)
    .eq('items.user_id', userId)
    .not('items.is_archived', 'is', true)
    .not('items.is_adult', 'is', true)
    .not('items.ai_excluded', 'is', true)
    .or('taint_level.is.null,taint_level.lt.3', { referencedTable: 'items' })
    .or('taint_level.is.null,taint_level.lt.3');
  q = caseSensitive ? q.like('text', like) : q.ilike('text', like);
  if (scope) q = q.eq('item_id', scope);
  const { data: segData, error: segError } = await q
    .order('item_id', { ascending: true })
    .order('segment_index', { ascending: true })
    .range(offset, offset + limit)            // one extra row tells whether there is a next page
    .abortSignal(AbortSignal.timeout(8000));
  if (segError) throw new Error(`grep failed: ${segError.message}`);

  const groups = new Map<string, Group>();
  const group = (meta: ItemMeta): Group => {
    let g = groups.get(meta.id);
    if (!g) { g = { meta, matches: [] }; groups.set(meta.id, g); }
    return g;
  };
  const segRows = (segData ?? []) as unknown as Array<{ item_id: string; segment_index: number | null; start_time_sec: unknown; text: string | null; items: ItemMeta | ItemMeta[] }>;
  const hasMore = segRows.length > limit;
  let matchCount = 0;
  for (const r of segRows.slice(0, limit)) {
    const meta = Array.isArray(r.items) ? r.items[0] : r.items;
    const text = r.text ?? '';
    const snippet = snippetAround(text, pattern, caseSensitive);
    if (!meta || !snippet) continue;          // LIKE and the JS match can disagree on unusual characters: skip, never guess
    const m: GrepMatch = { field: 'text', snippet, hits: countHits(text, pattern, caseSensitive) };
    if (typeof r.segment_index === 'number') m.n = r.segment_index;
    const start = Number(r.start_time_sec);
    if (r.start_time_sec != null && Number.isFinite(start)) {
      const t = Math.max(0, Math.floor(start));
      const link = timestampUrl(meta.url, t, meta.video_id);
      if (link) { m.t = t; m.url = link; }
    }
    group({ ...meta }).matches.push(m);
    matchCount++;
  }

  // ── Title, summary, description; stored text of items without passages (first page only) ──
  if (offset === 0) {
    const fields = ['title', 'summary', 'description', 'full_transcript'];
    const value = like.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let iq = dbAdmin
      .from('items')
      .select(`${ITEM_COLS}, summary, description`)
      .eq('user_id', userId)
      .not('is_archived', 'is', true)
      .not('is_adult', 'is', true)
      .not('ai_excluded', 'is', true)
      .or('taint_level.is.null,taint_level.lt.3')
      .or(fields.map((c) => `${c}.${op}."${value}"`).join(','));
    if (scope) iq = iq.eq('id', scope);
    const { data: itemData, error: itemError } = await iq.order('created_at', { ascending: false }).limit(FIELD_ITEMS).abortSignal(AbortSignal.timeout(8000));
    if (itemError) console.error(`[grep] item fields skipped: ${String(itemError.message).slice(0, 120)}`);
    const itemRows = (itemData ?? []) as unknown as ItemMeta[];
    const bodyOnly: ItemMeta[] = [];
    for (const it of itemRows) {
      const found: GrepMatch[] = [];
      for (const f of ['title', 'summary', 'description'] as const) {
        const text = typeof it[f] === 'string' ? (it[f] as string) : '';
        const snippet = text ? snippetAround(text, pattern, caseSensitive) : null;
        if (snippet) found.push({ field: f, snippet, hits: countHits(text, pattern, caseSensitive) });
      }
      const { summary: _s, description: _d, ...meta } = it;
      if (found.length > 0) { group(meta).matches.unshift(...found); matchCount += found.length; }
      else if (!groups.has(it.id)) bodyOnly.push(meta);   // matched in its stored text only, and no passage row came back for it
    }
    // Items whose stored text matches but that have no passages at all (short notes, captions): read the text itself.
    if (bodyOnly.length > 0) {
      const ids = bodyOnly.map((b) => b.id);
      const { data: withSegs } = await dbAdmin.from('transcript_segments').select('item_id').in('item_id', ids).eq('segment_index', 0).abortSignal(AbortSignal.timeout(4000));
      const segmented = new Set(((withSegs ?? []) as Array<{ item_id: string }>).map((r) => r.item_id));
      const plain = bodyOnly.filter((b) => !segmented.has(b.id)).slice(0, 10);
      if (plain.length > 0) {
        const { data: texts } = await dbAdmin.from('items').select('id, full_transcript').eq('user_id', userId).in('id', plain.map((p) => p.id)).abortSignal(AbortSignal.timeout(4000));
        const byId = new Map(((texts ?? []) as Array<{ id: string; full_transcript: string | null }>).map((r) => [r.id, r.full_transcript ?? '']));
        for (const meta of plain) {
          const text = byId.get(meta.id) ?? '';
          const snippet = text ? snippetAround(text, pattern, caseSensitive) : null;
          if (snippet) { group(meta).matches.push({ field: 'text', snippet, hits: countHits(text, pattern, caseSensitive) }); matchCount++; }
        }
      }
    }
  }

  const results = [...groups.values()].map(({ meta, matches }) => ({
    id: meta.id,
    title: (typeof meta.title === 'string' && meta.title) || 'Untitled',
    url: itemUrl(meta),
    ...(meta.source_type ? { source_type: meta.source_type } : {}),
    matches,
    ...(typeof meta.provenance === 'string' && meta.provenance ? { provenance: meta.provenance } : {}),
    ...(typeof meta.taint_level === 'number' ? { taint_level: meta.taint_level } : {}),
  }));
  const out: z.infer<typeof grepOutputSchema> = {
    pattern,
    results,
    match_count: matchCount,
    ...(hasMore ? { next_cursor: `o:${offset + limit}` } : {}),
  };
  const text = results.length === 0
    ? `No exact match for "${pattern}"${scope ? ' in that item' : ' in your library'}. grep matches literal text only; for a topic or a paraphrase use search_knowledge.`
    : JSON.stringify(out);
  return { content: [{ type: 'text' as const, text }], structuredContent: out as unknown as Record<string, unknown> };
}

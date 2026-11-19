/**
 * `search` and `fetch`: the two read-only tools ChatGPT needs before it will use
 * an MCP server for deep research and company knowledge, and before it accepts a
 * custom connector outside Developer Mode (developers.openai.com/docs/mcp).
 *
 * Thin adapters over search_knowledge and get_video: same retrieval, same item
 * lookup, same per-user scoping. Only the result shape differs, as OpenAI asks:
 *   search(query)  → { results: [{ id, title, url, moments? }] }
 *   fetch(id)      → { id, title, text, url, metadata? }
 * returned as structuredContent plus the same object as JSON in one text item.
 * ChatGPT only builds a citation when `url` is non-empty.
 */
import { z } from 'zod';
import { numArg } from '../lib/num-arg.js';
import { searchKnowledge } from './search.js';
import { getVideo } from './video.js';
import { dbAdmin } from '../db/supabase.js';
import { momentSchema, type Moment } from '../lib/moments.js';
import { passageSchema, type Passage } from '../lib/passages.js';

export const chatgptSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('Search query over your saved BrainTube library, in natural language.'),
  item_id: z.string().min(1).max(200).optional().describe('Search inside this one item only (an id from a previous result) and return its best-matching passages. Omit to search the whole library.'),
});

export const FETCH_PAGE_CHARS = 40_000;
export const FETCH_MAX_PAGE_CHARS = 100_000;

export const chatgptFetchSchema = z.object({
  id: z.string().min(1).max(200).describe('Item id returned by the search tool.'),
  cursor: z.string().max(40).optional().describe('next_cursor from the previous page of this item (in metadata), to read on. Omit for the first page.'),
  from_passage: numArg(z.number().int().min(0).max(100_000)).optional().describe('Start reading the item text at this passage: the `n` of a search passage or a grep match. Omit to read from the top (summary first).'),
  max_chars: numArg(z.number().int().min(2000).max(FETCH_MAX_PAGE_CHARS).default(FETCH_PAGE_CHARS)).describe(`Characters of text per page (default ${FETCH_PAGE_CHARS}, max ${FETCH_MAX_PAGE_CHARS}).`),
});

export const chatgptSearchOutputSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    // The text of the item that matches the query (src/lib/passages.ts); videos also get moments, each linking to that
    // second (src/lib/moments.ts). On the wire both sit under `untrusted_content` with one trust label per result
    // (src/security/untrusted-envelope.ts); the top-level fields are what the handler builds before the envelope.
    passages: z.array(passageSchema).optional(),
    moments: z.array(momentSchema).optional(),
    trust: z.string().optional(),
    provenance: z.string().optional(),
    taint_level: z.number().optional(),
    untrusted_content: z.object({
      passages: z.array(passageSchema).optional(),
      moments: z.array(momentSchema).optional(),
    }).optional(),
  })),
});

export const chatgptFetchOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const SEARCH_LIMIT = 10;
const IN_ITEM_PASSAGES = 8;

interface ItemRow {
  id?: unknown;
  video_id?: unknown;
  title?: unknown;
  url?: unknown;
  source_type?: unknown;
  channel?: unknown;
  created_at?: unknown;
  summary?: unknown;
  core_thesis?: unknown;
  key_takeaways?: unknown;
  description?: unknown;
  full_transcript?: unknown;
  tags?: unknown;
  moments?: unknown;
  passages?: unknown;
  provenance?: unknown;
  taint_level?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The item's own source URL; a YouTube watch URL when only the video id is stored;
 * otherwise the item's page in the BrainTube app (screenshots, notes and uploads have
 * no source URL, and ChatGPT only cites results whose url is non-empty).
 */
export function itemUrl(row: ItemRow): string {
  const url = str(row.url);
  if (/^https?:\/\//i.test(url)) return url;
  const videoId = str(row.video_id);
  if (/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return `https://www.youtube.com/watch?v=${videoId}`;
  const id = str(row.id);
  if (UUID.test(id)) return `https://app.brain-tube.com/item/${id}`;
  return '';
}

function jsonResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function toSearchResults(rows: ItemRow[]): z.infer<typeof chatgptSearchOutputSchema> {
  const seen = new Set<string>();
  const results: Array<{ id: string; title: string; url: string; passages?: Passage[]; moments?: Moment[]; provenance?: string; taint_level?: number }> = [];
  for (const row of rows) {
    const id = str(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const moments = Array.isArray(row.moments) && row.moments.length > 0 ? (row.moments as Moment[]) : undefined;
    const passages = Array.isArray(row.passages) && row.passages.length > 0 ? (row.passages as Passage[]) : undefined;
    // Carried so the envelope labels the result with the item's own provenance and taint, not the defaults.
    const label = passages || moments
      ? { ...(str(row.provenance) ? { provenance: str(row.provenance) } : {}), ...(typeof row.taint_level === 'number' ? { taint_level: row.taint_level } : {}) }
      : {};
    results.push({ id, title: str(row.title) || 'Untitled', url: itemUrl(row), ...(passages ? { passages } : {}), ...(moments ? { moments } : {}), ...label });
  }
  return { results };
}

export interface FetchPage { offset?: number; maxChars?: number }

/** "c:<offset>" (characters into the document) or "p:<n>" (start at passage n). Anything else is refused with what to pass. */
export function parseFetchCursor(cursor: string | undefined): { kind: 'chars'; offset: number } | { kind: 'passage'; n: number } | null {
  if (!cursor) return null;
  const m = /^([cp]):(\d{1,9})$/.exec(cursor.trim());
  if (!m) throw new Error('Invalid cursor. Pass the next_cursor value from the previous fetch of this item unchanged, or omit it to start from the top.');
  return m[1] === 'c' ? { kind: 'chars', offset: Number(m[2]) } : { kind: 'passage', n: Number(m[2]) };
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

export interface PassageRow { segment_index: number; text: string | null; start_time_sec?: unknown }

/**
 * A page of an item's text read passage by passage from `rows` (ordered, starting at the asked passage): whole
 * passages until `maxChars` is reached, at least one. Timed passages are prefixed with their [m:ss] time.
 * `next` is the first passage that did not fit, or undefined when `rows` was read to its end.
 */
export function passagePage(rows: PassageRow[], maxChars: number): { text: string; first: number; last: number; next?: number } | null {
  const parts: string[] = [];
  let used = 0;
  let last = -1;
  let next: number | undefined;
  for (const r of rows) {
    const body = (r.text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) { last = r.segment_index; continue; }
    const start = Number(r.start_time_sec);
    const line = r.start_time_sec != null && Number.isFinite(start) ? `[${clock(start)}] ${body}` : body;
    if (parts.length > 0 && used + line.length + 2 > maxChars) { next = r.segment_index; break; }
    parts.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
    used += line.length + 2;
    last = r.segment_index;
  }
  if (parts.length === 0) return null;
  return { text: parts.join('\n\n'), first: rows[0].segment_index, last, ...(next !== undefined ? { next } : {}) };
}

export function toFetchDocument(row: ItemRow, taintWarning?: string, page: FetchPage = {}): z.infer<typeof chatgptFetchOutputSchema> {
  const sections: string[] = [];
  const add = (label: string, value: string) => { if (value.trim()) sections.push(`${label}\n${value.trim()}`); };
  add('Summary', str(row.summary));
  add('Core thesis', str(row.core_thesis));
  if (Array.isArray(row.key_takeaways) && row.key_takeaways.length > 0) {
    add('Key takeaways', row.key_takeaways.filter((t) => typeof t === 'string').map((t) => `- ${t}`).join('\n'));
  }
  add('Description', str(row.description));
  add('Transcript', str(row.full_transcript));
  // A long transcript runs to hundreds of thousands of characters: it is read in pages, never cut off silently.
  const full = sections.join('\n\n') || str(row.title);
  const maxChars = page.maxChars ?? FETCH_PAGE_CHARS;
  const offset = Math.min(Math.max(page.offset ?? 0, 0), full.length);
  let end = Math.min(full.length, offset + maxChars);
  if (end < full.length) { const sp = full.lastIndexOf(' ', end); if (sp > offset + maxChars * 0.8) end = sp; }
  let text = full.slice(offset, end);
  const metadata: Record<string, string> = {};
  if (end < full.length || offset > 0) {
    metadata.total_chars = String(full.length);
    metadata.chars = `${offset}-${end}`;
    if (end < full.length) {
      metadata.next_cursor = `c:${end}`;
      text += `\n\n[Characters ${offset} to ${end} of ${full.length}. To read on, call fetch with the same id and cursor "c:${end}".]`;
    }
  }

  if (str(row.source_type)) metadata.source_type = str(row.source_type);
  if (str(row.channel)) metadata.author = str(row.channel);
  if (str(row.created_at)) metadata.saved_at = str(row.created_at);
  if (Array.isArray(row.tags) && row.tags.length > 0) metadata.tags = row.tags.filter((t) => typeof t === 'string').join(', ');
  if (taintWarning) metadata.taint_warning = taintWarning;

  return {
    id: str(row.id),
    title: str(row.title) || 'Untitled',
    text,
    url: itemUrl(row),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export async function chatgptSearch(input: z.infer<typeof chatgptSearchSchema>, userId: string) {
  const res = input.item_id
    ? await searchKnowledge({ query: input.query, limit: IN_ITEM_PASSAGES, item_id: input.item_id }, userId)
    : await searchKnowledge({ query: input.query, limit: SEARCH_LIMIT }, userId);
  const rows = (res.structuredContent as { data?: unknown }).data;
  return jsonResult(toSearchResults(Array.isArray(rows) ? (rows as ItemRow[]) : []));
}

const PASSAGE_ROWS_PER_PAGE = 400;

/** The item's passages from `from` on, as one page of text. The item was already checked to be the caller's. */
async function fetchFromPassage(row: ItemRow, from: number, maxChars: number, taintWarning?: string): Promise<z.infer<typeof chatgptFetchOutputSchema>> {
  const itemId = str(row.id);
  const { data, error } = await dbAdmin
    .from('transcript_segments')
    .select('segment_index, text, start_time_sec')
    .eq('item_id', itemId)
    .gte('segment_index', from)
    .order('segment_index', { ascending: true })
    .limit(PASSAGE_ROWS_PER_PAGE);
  if (error) throw new Error(`Could not read the item text: ${String(error.message).slice(0, 160)}`);
  const rows = (data ?? []) as PassageRow[];
  const page = passagePage(rows, maxChars);
  if (!page) {
    const { data: lastRow } = await dbAdmin.from('transcript_segments').select('segment_index').eq('item_id', itemId).order('segment_index', { ascending: false }).limit(1);
    const max = ((lastRow ?? [])[0] as { segment_index?: number } | undefined)?.segment_index;
    throw new Error(typeof max === 'number'
      ? `This item has no passage ${from}: its passages are numbered 0 to ${max}. Pass a from_passage in that range, or omit it to read from the top.`
      : 'This item is not stored as passages. Omit from_passage (and use cursor for the next page) to read its text.');
  }
  // The last row read may not be the item's last passage: a full batch means there may be more after it.
  const next = page.next ?? (rows.length === PASSAGE_ROWS_PER_PAGE ? rows[rows.length - 1].segment_index + 1 : undefined);
  const base = toFetchDocument({ ...row, summary: '', core_thesis: '', key_takeaways: [], description: '', full_transcript: '' }, taintWarning);
  const metadata: Record<string, string> = { ...(base.metadata ?? {}), passages: `${page.first}-${page.last}` };
  let text = page.text;
  if (next !== undefined) {
    metadata.next_cursor = `p:${next}`;
    text += `\n\n[Passages ${page.first} to ${page.last}. To read on, call fetch with the same id and cursor "p:${next}".]`;
  }
  return { ...base, text, metadata };
}

export async function chatgptFetch(input: z.infer<typeof chatgptFetchSchema>, userId: string) {
  const cursor = parseFetchCursor(input.cursor);
  const maxChars = input.max_chars ?? FETCH_PAGE_CHARS;
  const res = await getVideo({ id: input.id }, userId);
  const tainted = res.structuredContent as { data?: ItemRow; taint_warning?: string };
  const row = tainted.data ?? {};
  const fromPassage = cursor?.kind === 'passage' ? cursor.n : cursor ? undefined : input.from_passage;
  if (fromPassage !== undefined) return jsonResult(await fetchFromPassage(row, fromPassage, maxChars, tainted.taint_warning));
  return jsonResult(toFetchDocument(row, tainted.taint_warning, { offset: cursor?.kind === 'chars' ? cursor.offset : 0, maxChars }));
}

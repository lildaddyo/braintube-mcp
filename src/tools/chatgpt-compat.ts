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
import { searchKnowledge } from './search.js';
import { getVideo } from './video.js';
import { momentSchema, type Moment } from '../lib/moments.js';

export const chatgptSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('Search query over your saved BrainTube library, in natural language.'),
});

export const chatgptFetchSchema = z.object({
  id: z.string().min(1).max(200).describe('Item id returned by the search tool.'),
});

export const chatgptSearchOutputSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    // Videos only: the passages that match the query, each linking to that second (src/lib/moments.ts).
    moments: z.array(momentSchema).optional(),
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
// A long transcript can run to megabytes; fetch returns a readable document, not the raw row.
const MAX_TEXT_CHARS = 100_000;

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
  const results: Array<{ id: string; title: string; url: string; moments?: Moment[] }> = [];
  for (const row of rows) {
    const id = str(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const moments = Array.isArray(row.moments) && row.moments.length > 0 ? (row.moments as Moment[]) : undefined;
    results.push({ id, title: str(row.title) || 'Untitled', url: itemUrl(row), ...(moments ? { moments } : {}) });
  }
  return { results };
}

export function toFetchDocument(row: ItemRow, taintWarning?: string): z.infer<typeof chatgptFetchOutputSchema> {
  const sections: string[] = [];
  const add = (label: string, value: string) => { if (value.trim()) sections.push(`${label}\n${value.trim()}`); };
  add('Summary', str(row.summary));
  add('Core thesis', str(row.core_thesis));
  if (Array.isArray(row.key_takeaways) && row.key_takeaways.length > 0) {
    add('Key takeaways', row.key_takeaways.filter((t) => typeof t === 'string').map((t) => `- ${t}`).join('\n'));
  }
  add('Description', str(row.description));
  add('Transcript', str(row.full_transcript));
  let text = sections.join('\n\n') || str(row.title);
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]`;

  const metadata: Record<string, string> = {};
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
  const res = await searchKnowledge({ query: input.query, limit: SEARCH_LIMIT }, userId);
  const rows = (res.structuredContent as { data?: unknown }).data;
  return jsonResult(toSearchResults(Array.isArray(rows) ? (rows as ItemRow[]) : []));
}

export async function chatgptFetch(input: z.infer<typeof chatgptFetchSchema>, userId: string) {
  const res = await getVideo({ id: input.id }, userId);
  const tainted = res.structuredContent as { data?: ItemRow; taint_warning?: string };
  return jsonResult(toFetchDocument(tainted.data ?? {}, tainted.taint_warning));
}

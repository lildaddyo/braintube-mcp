// Passage-level "moments" for timed search results (PH demo, 2026-10-22): the 1-3 transcript segments of a video that
// best match the query, each with a link that opens the video at that second. Ranking is not done here: the rows come
// from the search_segments RPC, the same hybrid segment ranking the in-app chat uses (dark-n-cozy brain-chat,
// supabase/functions/_shared/rag-retriever.ts), already ordered best first. This module only picks and formats.
import { z } from 'zod';

export const momentSchema = z.object({
  t: z.number(),        // start of the segment, whole seconds
  url: z.string(),      // source URL opening at t (YouTube: &t=<t>s)
  quote: z.string(),    // the segment text, trimmed to a short quote
});
export type Moment = z.infer<typeof momentSchema>;

/** Source types whose transcript segments carry real start times (only YouTube has any today). */
export const TIMED_SOURCES = new Set(['youtube', 'podcast', 'video', 'tiktok', 'voice_memo']);

export const MAX_MOMENTS = 3;
// Same floor as rag-retriever.ts (minScore 0.3 on combined_score).
export const MIN_MOMENT_SCORE = 0.3;
// Two picks closer than this are the same moment (neighbouring segments of one passage).
const MIN_GAP_SEC = 30;
const QUOTE_CHARS = 220;

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** The item's URL opened at `sec`: YouTube watch/youtu.be/shorts/live links get t=<sec>s; other URLs are returned as is. */
export function timestampUrl(url: string | null | undefined, sec: number, videoId?: string | null): string {
  const s = Math.max(0, Math.floor(sec));
  let u: URL | null = null;
  try { u = url ? new URL(url) : null; } catch { u = null; }
  const host = u?.hostname.replace(/^(www\.|m\.|music\.)/, '') ?? '';
  let id: string | null = null;
  if (u && host === 'youtube.com') {
    id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] ?? null;
  } else if (u && host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0] || null;
  } else if (!u && videoId) {
    id = videoId;
  }
  if (id && YT_ID.test(id)) return `https://www.youtube.com/watch?v=${id}&t=${s}s`;
  return u ? u.href : '';
}

// YouTube captions arrive HTML-escaped ("we don&#39;t").
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});

/** Decode caption entities, collapse whitespace and cut to a short quote at a word boundary. */
export function shortQuote(text: string, max = QUOTE_CHARS): string {
  const t = decodeEntities(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

export interface SegmentRow {
  item_id?: unknown;
  segment_text?: unknown;
  start_time_sec?: unknown;
  combined_score?: unknown;
}

/** Best-first segment rows of ONE item -> up to MAX_MOMENTS moments (score floor, no two within MIN_GAP_SEC). */
export function pickMoments(rows: SegmentRow[], url: string | null | undefined, videoId?: string | null): Moment[] {
  const out: Moment[] = [];
  for (const r of rows) {
    if (out.length >= MAX_MOMENTS) break;
    const start = Number(r.start_time_sec);
    const score = Number(r.combined_score);
    const text = typeof r.segment_text === 'string' ? r.segment_text : '';
    if (r.start_time_sec == null || !Number.isFinite(start) || !text.trim()) continue;
    if (Number.isFinite(score) && score < MIN_MOMENT_SCORE) continue;
    const t = Math.max(0, Math.floor(start));
    if (out.some(m => Math.abs(m.t - t) < MIN_GAP_SEC)) continue;
    const link = timestampUrl(url, t, videoId);
    if (!link) continue;
    out.push({ t, url: link, quote: shortQuote(text) });
  }
  return out;
}

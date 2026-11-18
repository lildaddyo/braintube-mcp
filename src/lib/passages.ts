// Answer passages for every search hit (retrieval gap vs Recall, 2026-11-18): the text of the item's segments that best
// match the query, for articles, PDFs, notes and posts as well as videos. Before this only videos carried text below the
// summary (three 220-character moment quotes), so an agent needed a second call (fetch) to answer most questions.
// Ranking is not done here: the rows come from search_segments scoped to one item, best first. This module picks,
// trims and formats. A passage of a timed source also carries `t` and a `url` that opens the source at that second.
import { z } from 'zod';
import { shortQuote, timestampUrl, type SegmentRow } from './moments.js';

export const passageSchema = z.object({
  text: z.string(),              // the matching passage, whitespace collapsed, cut at a word boundary
  n: z.number().optional(),      // position of the passage in the item (0-based), when known
  t: z.number().optional(),      // timed sources: start of the passage, whole seconds
  url: z.string().optional(),    // timed sources: source URL opening at t
});
export type Passage = z.infer<typeof passageSchema>;

/** Passages for the best-ranked results; later rows get fewer (they are rarely the answer, and every passage costs tokens). */
export const MAX_PASSAGES = 4;
export const MAX_PASSAGES_TAIL = 2;
export const FULL_PASSAGE_ROWS = 3;
export const PASSAGE_CHARS = 700;

export interface PassageSegmentRow extends SegmentRow {
  segment_id?: unknown;
}

/** How many passages the result at `rank` (0-based) gets. */
export function passageBudget(rank: number): number {
  return rank < FULL_PASSAGE_ROWS ? MAX_PASSAGES : MAX_PASSAGES_TAIL;
}

/**
 * Best-first segment rows of ONE item -> up to `max` passages. `indexById` maps segment id -> position in the item.
 * Rows with no text are skipped; the same segment is never returned twice.
 */
export function pickPassages(
  rows: PassageSegmentRow[],
  url: string | null | undefined,
  videoId: string | null | undefined,
  max: number = MAX_PASSAGES,
  indexById?: Map<string, number>,
): Passage[] {
  const out: Passage[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (out.length >= max) break;
    const raw = typeof r.segment_text === 'string' ? r.segment_text : '';
    const text = shortQuote(raw, PASSAGE_CHARS);
    if (!text) continue;
    const key = typeof r.segment_id === 'string' ? r.segment_id : text;
    if (seen.has(key)) continue;
    seen.add(key);
    const p: Passage = { text };
    const n = typeof r.segment_id === 'string' ? indexById?.get(r.segment_id) : undefined;
    if (typeof n === 'number' && Number.isFinite(n)) p.n = n;
    const start = Number(r.start_time_sec);
    if (r.start_time_sec != null && Number.isFinite(start)) {
      const t = Math.max(0, Math.floor(start));
      const link = timestampUrl(url, t, videoId);
      if (link) { p.t = t; p.url = link; }
    }
    out.push(p);
  }
  return out;
}

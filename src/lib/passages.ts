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
// Rows after the third: 1 passage (was 2 until 2026-11-19; the second one was almost never the answer, payload trim).
export const MAX_PASSAGES_TAIL = 1;
/** Passages cut from an item's stored text when it has no segments. */
export const MAX_FALLBACK_PASSAGES = 2;
export const FULL_PASSAGE_ROWS = 3;
export const PASSAGE_CHARS = 700;

export interface PassageSegmentRow extends SegmentRow {
  segment_id?: unknown;
}

/** How many passages the result at `rank` (0-based) gets. */
export function passageBudget(rank: number): number {
  return rank < FULL_PASSAGE_ROWS ? MAX_PASSAGES : MAX_PASSAGES_TAIL;
}

/** A passage shorter than this is widened with the segments next to it (web pages are often cut into fragments). */
export const MIN_PASSAGE_CHARS = 240;
/** Widening stops once the passage is this long, or spans this many segments. */
export const WIDE_PASSAGE_CHARS = 320;
export const MAX_SPAN_SEGMENTS = 7;

/** One item's segments by position, for widening: text and start time of the segments around a short pick. */
export type Neighbours = Map<number, { text: string; start_time_sec?: unknown }>;

/**
 * Best-first segment rows of ONE item -> up to `max` passages. `indexById` maps segment id -> position in the item.
 * Rows with no text are skipped; no segment is returned twice. A short segment ("AI Mode). Is") is joined with its
 * neighbours from `neighbours` into one readable passage that starts at the earliest joined segment; a later pick
 * that falls inside an earlier passage is skipped.
 */
export function pickPassages(
  rows: PassageSegmentRow[],
  url: string | null | undefined,
  videoId: string | null | undefined,
  max: number = MAX_PASSAGES,
  indexById?: Map<string, number>,
  neighbours?: Neighbours,
  coveredOut?: Set<number>,
): Passage[] {
  const out: Passage[] = [];
  const seen = new Set<string>();
  const covered = coveredOut ?? new Set<number>();
  for (const r of rows) {
    if (out.length >= max) break;
    const raw = typeof r.segment_text === 'string' ? r.segment_text.trim() : '';
    if (!raw) continue;
    const key = typeof r.segment_id === 'string' ? r.segment_id : raw;
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = typeof r.segment_id === 'string' ? indexById?.get(r.segment_id) : undefined;
    const n = typeof idx === 'number' && Number.isFinite(idx) ? idx : undefined;
    if (n !== undefined && covered.has(n)) continue;

    let joined = raw;
    let lo = n;
    let startRaw: unknown = r.start_time_sec;
    if (n !== undefined) {
      let hi = n;
      let low = n;
      if (neighbours && raw.length < MIN_PASSAGE_CHARS) {
        // Forward first (the sentence continues), then one step back, alternating; never into another passage.
        let forward = true;
        let stuck = 0;
        while (joined.length < WIDE_PASSAGE_CHARS && hi - low + 1 < MAX_SPAN_SEGMENTS && stuck < 2) {
          const at = forward ? hi + 1 : low - 1;
          const nb = at >= 0 && !covered.has(at) ? neighbours.get(at) : undefined;
          const text = nb?.text?.trim();
          if (text) {
            stuck = 0;
            if (forward) { joined = `${joined} ${text}`; hi = at; }
            else { joined = `${text} ${joined}`; low = at; startRaw = nb?.start_time_sec; }
          } else {
            stuck++;
          }
          forward = !forward;
        }
      }
      for (let i = low; i <= hi; i++) covered.add(i);
      lo = low;
    }

    const text = shortQuote(joined, PASSAGE_CHARS);
    if (!text) continue;
    const p: Passage = { text };
    if (lo !== undefined) p.n = lo;
    const start = Number(startRaw);
    if (startRaw != null && Number.isFinite(start)) {
      const t = Math.max(0, Math.floor(start));
      const link = timestampUrl(url, t, videoId);
      if (link) { p.t = t; p.url = link; }
    }
    out.push(p);
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'from', 'what', 'which', 'how', 'does', 'did', 'are', 'was', 'were', 'has', 'have', 'had', 'you', 'your', 'about', 'into', 'than', 'then', 'they', 'their', 'not', 'but', 'can', 'its', 'who', 'why', 'when', 'where']);

/** Lower-cased content words of a query (3+ characters, no stop words), for the window score below. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words.filter(w => !STOP.has(w)))];
}

/**
 * Passages for an item that has no stored segments (short notes, captions, a few papers): windows of its own text,
 * the ones holding the most query words first. A text that fits one passage is returned whole. No position: these
 * windows are not segments, so they cannot be passed to fetch as from_passage.
 */
export function fallbackPassages(text: string, query: string, max: number = MAX_FALLBACK_PASSAGES): Passage[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || max <= 0) return [];
  if (clean.length <= PASSAGE_CHARS) return [{ text: shortQuote(clean, PASSAGE_CHARS) }];
  const size = 500;
  const windows: string[] = [];
  for (let at = 0; at < clean.length;) {
    let end = Math.min(clean.length, at + size);
    if (end < clean.length) { const sp = clean.lastIndexOf(' ', end); if (sp > at + size * 0.6) end = sp; }
    windows.push(clean.slice(at, end).trim());
    at = end;
  }
  const terms = queryTerms(query);
  const scored = windows.map((w, i) => {
    const low = w.toLowerCase();
    return { w, i, score: terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0) };
  });
  // Best windows first; with no query word anywhere the opening of the text is the passage.
  const best = scored.sort((a, b) => (b.score - a.score) || (a.i - b.i)).slice(0, max).filter((x, k) => x.score > 0 || k === 0);
  return best.map(x => ({ text: shortQuote(x.w, PASSAGE_CHARS) }));
}

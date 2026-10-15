// Query filter (retrieval QA 2026-10-15b). Reads an explicit save date ("in July", "back in May 2026", "през юли",
// "last week") and an explicit source container ("the reel", "the web page", "my claude chat", "the PDF") out of a
// search query, and reduces the query to its topic ("what did I save in July about jailbreaking AI models?" ->
// "jailbreaking AI models"). Search uses it to add date/source-scoped candidates (RPC search_items_window) to the
// re-rank pool and to give items inside the filter a small boost; it never drops results.
//
// This file has no imports and is copied byte for byte into dark-n-cozy supabase/functions/brain-chat/query-filter.ts
// (search parity). Change both copies together.

export type QueryFilter = { from: string | null; to: string | null; sources: string[] };

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  'януари': 1, 'февруари': 2, 'март': 3, 'април': 4, 'май': 5, 'юни': 6, 'юли': 7, 'август': 8, 'септември': 9,
  'октомври': 10, 'ноември': 11, 'декември': 12,
};
// Month words that are also ordinary words ("may", "march", "май") count only with a date context: a preposition
// before them ("in May", "през май") or a year after them ("may 2026").
const AMBIG = new Set(['may', 'march', 'mar', 'jan', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'apr', 'feb', 'sept', 'май', 'март']);
const PREP = String.raw`(?:(?:back\s+)?(?:in|from|during|since|around|of|at|през|в|от|до|около)\s+)?(?:(?:the\s+)?(?:early|late|mid|start of|end of|beginning of|началото на|края на|средата на)\s+)?`;
const W = '[a-zа-я0-9]';
const MONTH_KEYS = Object.keys(MONTHS).sort((a, b) => b.length - a.length);
const monthRe = () => new RegExp(String.raw`(?<!${W})(?<prep>${PREP})(?<m>${MONTH_KEYS.join('|')})(?!${W})(?:\s+(?<y>20\d\d))?`, 'giu');

// Relative windows as [first day, day after the last] in days before today (UTC).
type Rel = { re: RegExp; days?: [number, number]; monthOffset?: number };
const REL: Rel[] = [
  { re: /\b(?:last|past|previous) week\b|миналата седмица/giu, days: [13, -1] },
  { re: /\bthis week\b|тази седмица/giu, days: [6, -1] },
  { re: /\b(?:last|past|previous) month\b|миналия месец/giu, monthOffset: -1 },
  { re: /\bthis month\b|този месец/giu, monthOffset: 0 },
  { re: /\byesterday\b|вчера/giu, days: [1, 0] },
  { re: /\btoday\b|днес/giu, days: [0, -1] },
];

// Only explicit "the <container>" mentions count, not topical ones ("ads on YouTube", "my website", "LinkedIn posts").
const DET = String.raw`(?:^|\b(?:the|that|this|my|a|an|one|some)\s+)`;
const SOURCES: Array<{ re: RegExp; types: string[] }> = [
  { re: new RegExp(DET + String.raw`pdfs?\b|(?<![a-z])pdf-[а-я]+`, 'iu'), types: ['pdf', 'document'] },
  { re: /youtube music|ютуб мюзик/iu, types: ['youtube_music'] },
  { re: new RegExp(DET + String.raw`(?:youtube|yt) (?:video|clip|short)s?\b|\b(?:saved |save )?from youtube\b|клип(?:а|ът)? (?:в|от|на) (?:youtube|ютуб)`, 'iu'), types: ['youtube'] },
  { re: new RegExp(DET + String.raw`(?:instagram |insta |ig )?reels?\b|` + DET + String.raw`(?:instagram|insta|ig) posts?\b|\bon instagram\b|(?<![а-я])рийл|пост[а-я]* (?:в|от) (?:инстаграм|instagram)|(?:инстаграм|instagram) пост`, 'iu'), types: ['instagram', 'screenshot'] },
  { re: new RegExp(DET + String.raw`(?:github )?(?:repo|repository)\b|^github repo|репо(?:то)? в github|github репо`, 'iu'), types: ['github'] },
  { re: new RegExp(DET + String.raw`web ?pages?\b|уеб ?страница[а-я]*`, 'iu'), types: ['web', 'article'] },
  { re: /(?:claude|клод) (?:chat|conversation|session)|(?:chat|conversation|чат[а-я]*(?: ми)?) (?:with|in|с|в) (?:claude|клод)/iu, types: ['claude'] },
  { re: new RegExp(DET + String.raw`screen ?shots?\b|^скрийншот|(?<![а-я])онзи скрийншот|screenshot-а`, 'iu'), types: ['screenshot'] },
  { re: new RegExp(DET + String.raw`(?:linkedin post|tweet)s?\b`, 'iu'), types: ['linkedin', 'twitter'] },
];

const BOILER: RegExp[] = [
  /\b(?:what|which)\s+(?:did|have)\s+i\s+(?:save|saved|bookmark(?:ed)?|keep|kept)\b/giu,
  /\b(?:i|we)\s+(?:have\s+)?(?:saved|save|bookmarked|kept)\b/giu,
  /\b(?:back|early|late)\b(?=\s*$)/giu,
  /^\s*(?:the|that|this|my|a|an)\s+/giu,
  /^\s*(?:about|on|regarding)\s+/giu,
  /\s+(?:about|on|from|in|at|of|the)\s*\??\s*$/giu,
  /\s+(?:about|on|from|in|at|of|the)\s*\??\s*$/giu,
];

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const addDays = (t: Date, n: number) => new Date(t.getTime() + n * 86_400_000);

type MonthHit = { text: string; month: number; year: number | null };
function firstMonth(q: string): MonthHit | null {
  for (const m of q.matchAll(monthRe())) {
    const w = (m.groups?.m ?? '').toLowerCase();
    const prep = (m.groups?.prep ?? '').trim();
    const y = m.groups?.y;
    if (AMBIG.has(w) && !(prep || y)) continue;
    return { text: m[0], month: MONTHS[w], year: y ? Number(y) : null };
  }
  return null;
}

/** Date window and source types the query asks for, or null when it names neither. */
export function parseQueryFilter(q: string, now: Date = new Date()): QueryFilter | null {
  let from: Date | null = null;
  let to: Date | null = null;
  const hit = firstMonth(q);
  if (hit) {
    const year = hit.year ?? (hit.month <= now.getUTCMonth() + 1 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
    from = utcDay(year, hit.month, 1);
    to = hit.month === 12 ? utcDay(year + 1, 1, 1) : utcDay(year, hit.month + 1, 1);
  } else {
    const today = utcDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
    for (const r of REL) {
      r.re.lastIndex = 0;
      if (!r.re.test(q)) continue;
      if (r.days) {
        from = addDays(today, -r.days[0]);
        to = addDays(today, -r.days[1]);
      } else {
        let y = now.getUTCFullYear();
        let mo = now.getUTCMonth() + 1 + (r.monthOffset ?? 0);
        if (mo < 1) { y -= 1; mo += 12; }
        from = utcDay(y, mo, 1);
        to = mo === 12 ? utcDay(y + 1, 1, 1) : utcDay(y, mo + 1, 1);
      }
      break;
    }
  }
  let sources: string[] = [];
  for (const s of SOURCES) {
    if (s.re.test(q)) { sources = s.types; break; }
  }
  if (!from && sources.length === 0) return null;
  return { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null, sources };
}

/** The query's topic: date phrase, explicit source container and "what did I save" boilerplate removed.
 *  Embedded for the date/source-scoped search and used as the re-rank query (the re-ranker cannot see save dates). */
export function queryTopic(q: string): string {
  let out = q;
  const hit = firstMonth(out);
  if (hit) out = out.split(hit.text).join(' ');
  for (const r of REL) out = out.replace(r.re, ' ');
  for (const s of SOURCES) {
    const m = s.re.exec(out);
    if (m) { out = out.slice(0, m.index) + ' ' + out.slice(m.index + m[0].length); break; }
  }
  for (const b of BOILER) out = out.replace(b, ' ');
  out = out.replace(/\s+/gu, ' ').replace(/^[ ,.\-?]+|[ ,.\-?]+$/gu, '');
  return out.length >= 3 ? out : q;
}

/** True when the row was saved inside the filter's date window (always true without a window). */
export function inDateWindow(f: QueryFilter, createdAt: unknown): boolean {
  if (!f.from || !f.to) return true;
  const t = typeof createdAt === 'string' || createdAt instanceof Date ? new Date(createdAt).getTime() : NaN;
  return Number.isFinite(t) && t >= Date.parse(f.from) && t < Date.parse(f.to);
}

// Soft prior after the JEV re-rank: rows inside the date window get +0.3, rows of the asked source type +0.1, but only
// when the re-ranker already finds them relevant (score >= 0.4). Tuned on the retrieval QA benchmark (dev and test).
export const FILTER_PRIOR = { date: 0.3, source: 0.1, minRelevance: 0.4 } as const;

/** Re-orders re-ranked rows (relevance_score set) by score + prior. Rows without a score keep their place at the end. */
export function applyFilterPrior<T extends { relevance_score?: number | null; created_at?: unknown; source_type?: unknown }>(rows: T[], f: QueryFilter | null): T[] {
  if (!f || rows.some(r => typeof r.relevance_score !== 'number')) return rows;
  const boosted = (r: T) => {
    const s = r.relevance_score as number;
    if (s < FILTER_PRIOR.minRelevance) return s;
    let b = s;
    if (f.from && inDateWindow(f, r.created_at)) b += FILTER_PRIOR.date;
    if (f.sources.length && typeof r.source_type === 'string' && f.sources.includes(r.source_type)) b += FILTER_PRIOR.source;
    return b;
  };
  return rows.map((r, i) => ({ r, i, s: boosted(r) })).sort((a, b) => (b.s - a.s) || (a.i - b.i)).map(x => x.r);
}

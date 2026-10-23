// Script detector for search queries and chat questions (Korean retrieval brief v2, Phase 1, 2026-10-24).
// One rule for every surface. braintube-mcp src/lib/script.ts and dark-n-cozy supabase/functions/_shared/script.ts
// are byte-identical copies, and both test suites run the same table (script-cases.ts). Change both together.
//
// Letters are \p{L}. A Hangul syllable, a Han character or a kana stands for a whole syllable or word, so it
// weighs 2; every other letter (Latin, Cyrillic, Hangul jamo, Greek, ...) weighs 1. A text is non-Latin when the
// non-Latin share of the weighted letters is at least 0.3 and the non-Latin weight is at least 3. So "영상"
// (2 syllables, weight 4), "памет" and "iPhone 리뷰" are non-Latin; "café", "iPhone review", "책", numbers and
// emoji are not.

export type Script =
  | "latin" | "cyrillic" | "hangul" | "han" | "kana" | "greek" | "arabic" | "hebrew" | "thai" | "devanagari"
  | "other" | "none";

export interface ScriptInfo {
  /** Script with the largest weighted letter count ("none" when the text has no letters). */
  script: Script;
  /** Weighted share of non-Latin letters, 0..1 (0 when the text has no letters). */
  nonLatinShare: number;
  /** Weighted count of non-Latin letters. */
  nonLatinWeight: number;
  /** True when the text should also be searched with an English translation. */
  nonLatin: boolean;
}

export const NON_LATIN_MIN_SHARE = 0.3;
export const NON_LATIN_MIN_WEIGHT = 3;

const SCRIPTS: Array<[Exclude<Script, "other" | "none">, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["han", /\p{Script=Han}/u],
  ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["greek", /\p{Script=Greek}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["thai", /\p{Script=Thai}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
];
const LETTER = /\p{L}/gu;

function scriptOf(ch: string): Exclude<Script, "none"> {
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  return "other";
}

function weightOf(ch: string, script: Script): number {
  if (script === "han" || script === "kana") return 2;
  const cp = ch.codePointAt(0) ?? 0;
  return script === "hangul" && cp >= 0xac00 && cp <= 0xd7a3 ? 2 : 1;
}

/** Dominant script and non-Latin share of a query or question (first 2,000 characters). */
export function detectScript(text: string | null | undefined): ScriptInfo {
  const counts = new Map<Exclude<Script, "none">, number>();
  let total = 0;
  for (const ch of (text ?? "").slice(0, 2000).match(LETTER) ?? []) {
    const script = scriptOf(ch);
    const w = weightOf(ch, script);
    counts.set(script, (counts.get(script) ?? 0) + w);
    total += w;
  }
  if (total === 0) return { script: "none", nonLatinShare: 0, nonLatinWeight: 0, nonLatin: false };
  let script: Script = "none";
  let best = 0;
  for (const [name, w] of counts) if (w > best) { script = name; best = w; }
  const nonLatinWeight = total - (counts.get("latin") ?? 0);
  const nonLatinShare = nonLatinWeight / total;
  return {
    script,
    nonLatinShare,
    nonLatinWeight,
    nonLatin: nonLatinShare >= NON_LATIN_MIN_SHARE && nonLatinWeight >= NON_LATIN_MIN_WEIGHT,
  };
}

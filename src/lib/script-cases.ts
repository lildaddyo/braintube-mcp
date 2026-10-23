// Shared test table for the script detector (script.ts). braintube-mcp src/lib/script-cases.ts and dark-n-cozy
// supabase/functions/_shared/script-cases.ts are byte-identical copies; script.test.ts (node) and script_test.ts
// (Deno) both run every row. share = nonLatinShare rounded to 2 decimals.

export const SCRIPT_CASES: Array<{ text: string; script: string; share: number; nonLatin: boolean; note: string }> = [
  // Korean, short: a Hangul syllable weighs 2, so two syllables pass the minimum of 3.
  { text: "영상", script: "hangul", share: 1, nonLatin: true, note: "Korean, 2 syllables" },
  { text: "영상 저장", script: "hangul", share: 1, nonLatin: true, note: "Korean, 4 syllables (old brain-chat rule: 4 letters < 6, skipped)" },
  { text: "책", script: "hangul", share: 1, nonLatin: false, note: "Korean, 1 syllable: below the minimum weight" },
  // Korean-English code-switching (mostly nouns).
  { text: "아이폰 리뷰", script: "hangul", share: 1, nonLatin: true, note: "mixed noun written in Hangul" },
  { text: "iPhone 리뷰", script: "latin", share: 0.4, nonLatin: true, note: "Latin product name + Korean noun" },
  { text: "ChatGPT 사용법", script: "latin", share: 0.46, nonLatin: true, note: "Latin product name + Korean noun" },
  { text: "iPhone review", script: "latin", share: 0, nonLatin: false, note: "English" },
  // Bulgarian / Cyrillic.
  { text: "Изкуствен интелект в образованието", script: "cyrillic", share: 1, nonLatin: true, note: "Bulgarian" },
  { text: "памет", script: "cyrillic", share: 1, nonLatin: true, note: "Bulgarian, 5 letters (old brain-chat rule: < 6, skipped)" },
  { text: "да", script: "cyrillic", share: 1, nonLatin: false, note: "Bulgarian, 2 letters: below the minimum weight" },
  { text: "React хукове", script: "cyrillic", share: 0.55, nonLatin: true, note: "Latin name + Bulgarian noun" },
  { text: "Какво казва видеото за Claude Code?", script: "cyrillic", share: 0.66, nonLatin: true, note: "Bulgarian question with a Latin name" },
  { text: "how to use useEffect в React", script: "latin", share: 0.04, nonLatin: false, note: "English with one Cyrillic letter" },
  // Japanese and other scripts.
  { text: "東京の天気", script: "han", share: 1, nonLatin: true, note: "Japanese, kanji + kana" },
  { text: "カメラのレビュー", script: "kana", share: 1, nonLatin: true, note: "Japanese, katakana" },
  { text: "μηχανική μάθηση", script: "greek", share: 1, nonLatin: true, note: "Greek" },
  { text: "تعلم الآلة", script: "arabic", share: 1, nonLatin: true, note: "Arabic" },
  // English with accents, numbers and emoji only.
  { text: "café", script: "latin", share: 0, nonLatin: false, note: "accented Latin is Latin" },
  { text: "naïve résumé at the café", script: "latin", share: 0, nonLatin: false, note: "accented Latin is Latin" },
  { text: "How do I save a YouTube video to my library?", script: "latin", share: 0, nonLatin: false, note: "English question" },
  { text: "2026 🎬🎬 100%", script: "none", share: 0, nonLatin: false, note: "numbers and emoji only" },
  { text: "", script: "none", share: 0, nonLatin: false, note: "empty" },
];

// The one text recipe for items.content_embedding_v2 (text-embedding-3-large @1536).
//
// TypeScript port of dark-n-cozy supabase/functions/_shared/item-embed-text.ts (the app, eager embedding,
// embed-item-content and the v2 backfill use that file). Keep the two identical: both repos test the same
// fixtures (item-embed-text_test.ts there, item-embed-text.test.ts here).
//
// Recipe = the one benchmarked in the 2026-10-16 embedding audit (braintube-retrieval-qa
// src/embed_bench.py doc_text, +0.046 condensed nDCG@10 for 3-large @1536 over production):
// title, one-liner, summary, key concepts, then the head of the body. Screenshot extracts are
// added when present (screenshots have no transcript). Before this, five recipes wrote
// content_embedding (eager 500 chars, embed-item-content 2,000 + metadata prefix,
// reembed-with-metadata 6,000, v3-reembed 500, MCP contextual prefix).

export const ITEM_TEXT_BODY_CHARS = 1200;
export const ITEM_TEXT_MAX_CHARS = 6000;

export interface ItemEmbedFields {
  title?: string | null;
  summary_oneliner?: string | null;
  summary?: string | null;
  key_concepts?: string[] | null;
  description?: string | null;
  full_transcript?: string | null;
  /** screenshot_extracts.visual_description */
  visual_description?: string | null;
  /** screenshot_extracts.key_facts */
  key_facts?: string[] | null;
}

const clean = (s: string | null | undefined): string => (s ?? "").trim();

export function buildItemEmbedText(f: ItemEmbedFields): string {
  const body = clean(f.full_transcript) || clean(f.description);
  const parts = [
    clean(f.title),
    clean(f.summary_oneliner),
    clean(f.summary),
    (f.key_concepts ?? []).map(clean).filter(Boolean).join(", "),
    clean(f.visual_description),
    (f.key_facts ?? []).map(clean).filter(Boolean).join(". "),
    body.slice(0, ITEM_TEXT_BODY_CHARS),
  ];
  const text = parts.filter(Boolean).join("\n").trim().slice(0, ITEM_TEXT_MAX_CHARS);
  return text || clean(f.title) || "untitled";
}

/** The items columns buildItemEmbedText reads (screenshot fields come from screenshot_extracts). */
export const ITEM_EMBED_COLUMNS = "title, summary_oneliner, summary, key_concepts, description, full_transcript";

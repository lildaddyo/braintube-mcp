import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItemEmbedText } from "./item-embed-text.js";

// Same fixtures as dark-n-cozy supabase/functions/_shared/item-embed-text_test.ts: the two builders must agree.
const FIXTURES: Array<[string, Parameters<typeof buildItemEmbedText>[0], string]> = [
  [
    "video",
    {
      title: " Deep Work ",
      summary_oneliner: "Focus beats hours.",
      summary: "Cal Newport on attention.",
      key_concepts: ["focus", " attention ", ""],
      full_transcript: "a".repeat(1500),
      description: "ignored when a transcript exists",
    },
    "Deep Work\nFocus beats hours.\nCal Newport on attention.\nfocus, attention\n" + "a".repeat(1200),
  ],
  [
    "screenshot",
    { title: "Receipt", visual_description: "A paper receipt", key_facts: ["Total 12 EUR", "Paid by card"] },
    "Receipt\nA paper receipt\nTotal 12 EUR. Paid by card",
  ],
  ["description only", { title: "Note", description: "short body" }, "Note\nshort body"],
  ["empty", { title: null }, "untitled"],
  ["capped", { title: "T", summary: "s".repeat(7000) }, ("T\n" + "s".repeat(7000)).slice(0, 6000)],
];

for (const [name, fields, expected] of FIXTURES) {
  test(`buildItemEmbedText: ${name}`, () => {
    assert.equal(buildItemEmbedText(fields), expected);
  });
}

import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

// ── tag_cooccurrence ──────────────────────────────────────────────────────────

export const tagCooccurrenceSchema = z.object({});

export const tagCooccurrenceOutputSchema = z.object({
  pairs: z.array(z.object({
    tag_a: z.string(),
    tag_b: z.string(),
    cooccurrence_count: z.number().optional(),
    items_with_a: z.number().optional(),
    items_with_b: z.number().optional(),
  }).passthrough()),
});

export async function tagCooccurrence(_input: z.infer<typeof tagCooccurrenceSchema>, userId: string) {
  const { data, error } = await dbAdmin.rpc('tag_cooccurrence', {
    for_user_id: userId,
    min_cooccurrence: 2,
  });
  if (error) throw new Error(`tag_cooccurrence RPC failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    tag_a: string; tag_b: string;
    cooccurrence_count: number; items_with_a: number; items_with_b: number;
  }>;

  const text = rows.length === 0
    ? 'No tag co-occurrences found (min 2).'
    : [`Top ${Math.min(rows.length, 20)} tag pairs:`, '',
        ...rows.slice(0, 20).map(r =>
          `  ${r.tag_a} ↔ ${r.tag_b}  (${r.cooccurrence_count} items)`
        )].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { pairs: rows } as unknown as Record<string, unknown>,
  };
}

// ── entity_cooccurrence ───────────────────────────────────────────────────────

export const entityCooccurrenceSchema = z.object({});

export const entityCooccurrenceOutputSchema = z.object({
  pairs: z.array(z.object({
    entity_a: z.string(),
    entity_b: z.string(),
    cooccurrence_count: z.number().optional(),
    items_with_a: z.number().optional(),
    items_with_b: z.number().optional(),
  }).passthrough()),
});

export async function entityCooccurrence(_input: z.infer<typeof entityCooccurrenceSchema>, userId: string) {
  const { data, error } = await dbAdmin.rpc('entity_cooccurrence', {
    for_user_id: userId,
    min_cooccurrence: 2,
  });
  if (error) throw new Error(`entity_cooccurrence RPC failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    entity_a: string; entity_b: string;
    cooccurrence_count: number; items_with_a: number; items_with_b: number;
  }>;

  const text = rows.length === 0
    ? 'No entity co-occurrences found (min 2).'
    : [`Top ${Math.min(rows.length, 20)} entity pairs:`, '',
        ...rows.slice(0, 20).map(r =>
          `  ${r.entity_a} ↔ ${r.entity_b}  (${r.cooccurrence_count} items)`
        )].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { pairs: rows } as unknown as Record<string, unknown>,
  };
}

// ── detect_gaps ───────────────────────────────────────────────────────────────

export const detectGapsSchema = z.object({});

export const detectGapsOutputSchema = z.object({
  thin_topics: z.array(z.unknown()).optional(),
  entities_without_depth: z.array(z.unknown()).optional(),
  stale_high_value: z.array(z.unknown()).optional(),
  missing_concept_articles: z.array(z.unknown()).optional(),
  unconnected_items: z.array(z.unknown()).optional(),
}).passthrough();

export async function detectGaps(_input: z.infer<typeof detectGapsSchema>, userId: string) {
  const { data, error } = await dbAdmin.rpc('detect_knowledge_gaps', { for_user_id: userId });
  if (error) throw new Error(`detect_knowledge_gaps RPC failed: ${error.message}`);

  const d = data as {
    thin_topics?: unknown[];
    entities_without_depth?: unknown[];
    stale_high_value?: unknown[];
    missing_concept_articles?: unknown[];
    unconnected_items?: unknown[];
  } | null;

  if (!d) return {
    content: [{ type: 'text' as const, text: 'No gap data returned.' }],
    structuredContent: {} as unknown as Record<string, unknown>,
  };

  const lines = [
    'Knowledge Gaps:',
    '',
    `Thin topics:              ${Array.isArray(d.thin_topics) ? d.thin_topics.length : d.thin_topics ?? 0}`,
    `Entities without depth:   ${Array.isArray(d.entities_without_depth) ? d.entities_without_depth.length : d.entities_without_depth ?? 0}`,
    `Stale high-value items:   ${Array.isArray(d.stale_high_value) ? d.stale_high_value.length : d.stale_high_value ?? 0}`,
    `Missing concept articles: ${Array.isArray(d.missing_concept_articles) ? d.missing_concept_articles.length : d.missing_concept_articles ?? 0}`,
    `Unconnected items:        ${Array.isArray(d.unconnected_items) ? d.unconnected_items.length : d.unconnected_items ?? 0}`,
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: d as unknown as Record<string, unknown>,
  };
}

// ── most_retrieved ────────────────────────────────────────────────────────────

export const mostRetrievedSchema = z.object({
  top_n: z.number().int().min(1).max(100).default(10).describe(
    'Number of top items to return (default 10)'
  ),
});

export const mostRetrievedOutputSchema = z.object({
  items: z.array(z.object({
    item_id: z.string(),
    title: z.string().nullable().optional(),
    retrieval_count: z.number().optional(),
    last_retrieved: z.string().nullable().optional(),
  }).passthrough()),
});

export async function mostRetrieved(input: z.infer<typeof mostRetrievedSchema>, userId: string) {
  const { data, error } = await dbAdmin.rpc('most_retrieved_items', {
    for_user_id: userId,
    top_n: input.top_n,
  });
  if (error) throw new Error(`most_retrieved_items RPC failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    item_id: string; title: string;
    retrieval_count: number; last_retrieved: string | null;
  }>;

  if (rows.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No retrieval data yet.' }],
      structuredContent: { items: [] } as unknown as Record<string, unknown>,
    };
  }

  const lines = [
    `Top ${rows.length} most-retrieved items:`, '',
    ...rows.map((r, i) =>
      `${String(i + 1).padStart(2)}. ${r.title}  — ${r.retrieval_count}x` +
      (r.last_retrieved ? `  (last: ${r.last_retrieved.slice(0, 10)})` : '')
    ),
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { items: rows } as unknown as Record<string, unknown>,
  };
}

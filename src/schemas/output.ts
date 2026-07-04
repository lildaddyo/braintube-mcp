import { z } from 'zod';

/**
 * Shared shape for src/security/taint.ts's wrapWithTaint() envelope:
 * `{ data, taint_level, taint_warning? }`. Every tool that calls
 * wrapWithTaint() should build its outputSchema with one of these two
 * helpers rather than re-declaring the envelope by hand.
 */
export function taintedSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    taint_level: z.number(),
    taint_warning: z.string().optional(),
  });
}

export function taintedListSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return taintedSchema(z.array(itemSchema));
}

/**
 * Loose shape for `items` rows and RPC result rows (adaptive_search,
 * get_related_items, get_review_queue, etc). Row shape varies per query path
 * and isn't fully controlled by this codebase, so only `id` is required —
 * everything else is optional/passthrough to avoid the MCP SDK's hard-fail
 * structuredContent validation rejecting a legitimate row that's missing a
 * column some other query path happens to include.
 */
export const looseItemSchema = z.object({
  id: z.string(),
  video_id: z.string().nullable().optional(),
  source_type: z.string().optional(),
  title: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  url: z.string().optional(),
  description: z.string().nullable().optional(),
  full_transcript: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  core_thesis: z.string().nullable().optional(),
  key_takeaways: z.array(z.string()).nullable().optional(),
  tags: z.array(z.string()).optional(),
  taint_level: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  match_type: z.string().optional(),
  centrality_score: z.number().nullable().optional(),
}).passthrough();

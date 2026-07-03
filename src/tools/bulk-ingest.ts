import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';
import { findItemBySourceUrl, findItemByTitle, linkTags, countIngestsToday } from '../db/supabase.js';
import { embedItemsBatch } from './embedding.js';
import { sourceTypeEnum } from '../schemas/source-types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DAILY_LIMIT = 500;   // max new items per user per day
const MAX_PER_CALL = 50;   // max items per single bulk_ingest call
const EMBED_BATCH  = 20;   // embed in groups of 20

// ─── Schema ───────────────────────────────────────────────────────────────────

const bulkItemSchema = z.object({
  title:       z.string().min(1).max(500),
  content:     z.string().min(1),
  source_url:  z.string().url().optional(),
  source_type: sourceTypeEnum.default('manual'),
  tags:        z.array(z.string().min(1).max(100)).max(20).optional(),
});

export const bulkIngestSchema = z.object({
  items: z.array(bulkItemSchema).min(1).max(MAX_PER_CALL).describe(
    `Array of items to ingest (max ${MAX_PER_CALL} per call)`
  ),
  force_new: z.boolean().default(false).describe(
    'Skip dedup check for all items and always insert (default: false)'
  ),
});

export const bulkIngestOutputSchema = z.object({
  inserted: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errors: z.array(z.string()),
});

// ─── Result types ─────────────────────────────────────────────────────────────

export interface BulkIngestResult {
  inserted: number;
  updated:  number;
  skipped:  number;
  errors:   string[];
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function bulkIngest(
  input: z.infer<typeof bulkIngestSchema>,
  userId: string
): Promise<BulkIngestResult> {
  const { items, force_new } = input;

  // ── Daily limit check ──────────────────────────────────────────────────────
  const todayCount = await countIngestsToday(userId);
  const remaining  = DAILY_LIMIT - todayCount;

  if (remaining <= 0) {
    return {
      inserted: 0,
      updated:  0,
      skipped:  items.length,
      errors:   [`Daily ingest limit reached (${DAILY_LIMIT} items/day). Resets at UTC midnight.`],
    };
  }

  const result: BulkIngestResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const toEmbed: string[] = [];
  const now = new Date().toISOString();

  // Items that would exceed the daily limit are skipped (not errored)
  let insertBudget = remaining;

  for (const item of items) {
    try {
      const { title, content, source_url, source_type, tags } = item;

      // ── Dedup ──────────────────────────────────────────────────────────────
      let existingId: string | null = null;

      if (!force_new) {
        if (source_url) {
          existingId = await findItemBySourceUrl(source_url, userId);
        }
        if (!existingId) {
          existingId = await findItemByTitle(title, userId);
        }
      }

      const summary = content.slice(0, 500) || null;
      let itemId: string;

      if (existingId) {
        // UPDATE — does not count against daily insert budget
        const { error } = await dbAdmin
          .from('items')
          .update({
            title,
            summary,
            full_transcript: content,
            ...(source_url ? { source_url, url: source_url } : {}),
            updated_at: now,
          })
          .eq('id', existingId);

        if (error) throw new Error(`update failed — ${error.message}`);
        itemId = existingId;
        result.updated++;
      } else {
        // INSERT — check budget
        if (insertBudget <= 0) {
          result.skipped++;
          result.errors.push(`"${title}": skipped — daily limit reached (${DAILY_LIMIT}/day)`);
          continue;
        }

        const { data, error } = await dbAdmin
          .from('items')
          .insert({
            user_id:        userId,
            source_type,
            title,
            summary,
            full_transcript: content,
            source_url:     source_url ?? null,
            url:            source_url ?? `braintube://manual/${Date.now()}`,
            taint_level:    0,
            is_user_created: true,
            is_archived:    false,
            created_at:     now,
            updated_at:     now,
          })
          .select('id')
          .single();

        if (error || !data) throw new Error(`insert failed — ${error?.message}`);
        itemId = data.id;
        result.inserted++;
        insertBudget--;
      }

      // Link tags (best-effort)
      if (tags && tags.length > 0) {
        await linkTags(itemId, tags, userId);
      }

      toEmbed.push(itemId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`"${item.title}": ${msg}`);
      result.skipped++;
    }
  }

  // ── Batch embed all inserted/updated items ─────────────────────────────────
  if (toEmbed.length > 0) {
    const { errors: embedErrors } = await embedItemsBatch(toEmbed, EMBED_BATCH);
    // Log embed failures — items are already saved with embedding = NULL
    for (const e of embedErrors) {
      console.error(`[bulk-ingest] embed failure (item saved, embedding NULL): ${e}`);
    }
  }

  return result;
}

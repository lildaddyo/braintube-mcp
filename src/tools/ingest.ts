import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';
import { findItemBySourceUrl, findItemByTitle, linkTags, countIngestsToday } from '../db/supabase.js';
import { insertItem, updateItemContent } from '../lib/ingest-gateway.js';
import type { WriteChannel, TrustStamp } from '../lib/ingest-gateway.js';
import { embedItem } from './embedding.js';
import { sourceTypeEnum } from '../schemas/source-types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const ingestContentSchema = z.object({
  title: z.string().min(1).max(500).describe(
    'Title of the content'
  ),
  content: z.string().min(1).describe(
    'Full text body of the content'
  ),
  source_url: z.string().url().optional().describe(
    'Source URL — used as the primary dedup key. Strongly recommended.'
  ),
  source_type: sourceTypeEnum.default('manual').describe(
    'Content type (default: manual)'
  ),
  tags: z.array(z.string().min(1).max(100)).max(20).optional().describe(
    'Optional list of tag names to attach'
  ),
  force_new: z.boolean().default(false).describe(
    'Skip dedup check and always insert as a new item (default: false)'
  ),
});

export const ingestContentOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  action: z.enum(['inserted', 'updated']),
  provenance: z.string().describe('Who wrote this content: agent_written for anything saved by an AI client'),
  taint_level: z.number().describe('Trust level stored with the item (0 = typed by the user in the app, >= 1 = untrusted)'),
});

// ─── Daily limit ──────────────────────────────────────────────────────────────
// Same cap as bulk_ingest: at most 500 NEW items per user per UTC day (updates of an
// existing item are not counted). Without it ingest_content / POST /api/ingest let a
// free account insert and embed without bound (BTMCP-01).

export const DAILY_INGEST_LIMIT = 500;

export class DailyIngestLimitError extends Error {
  constructor() {
    super(`Daily ingest limit reached (${DAILY_INGEST_LIMIT} new items/day). Resets at UTC midnight.`);
    this.name = 'DailyIngestLimitError';
  }
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * `channel` says where the write came from; the ingest gateway turns it into provenance + taint.
 * There is no way to pass a taint level or provenance from the caller.
 */
export async function ingestContent(
  input: z.infer<typeof ingestContentSchema>,
  userId: string,
  channel: WriteChannel,
): Promise<{ id: string; title: string; action: 'inserted' | 'updated'; provenance: string; taint_level: number }> {
  const { title, content, source_url, source_type, tags, force_new } = input;

  // ── Dedup check ────────────────────────────────────────────────────────────
  let existingId: string | null = null;

  if (!force_new) {
    // 1. Match by source_url (most reliable)
    if (source_url) {
      existingId = await findItemBySourceUrl(source_url, userId);
    }
    // 2. Fallback: match by exact title
    if (!existingId) {
      existingId = await findItemByTitle(title, userId);
    }
  }

  const summary = content.slice(0, 500) || null;
  const gw = { userId, channel };
  let itemId: string;
  let action: 'inserted' | 'updated';
  let stamp: TrustStamp;
  let storedTags: string[] = tags ?? [];

  if (existingId) {
    // ── UPDATE existing item (taint never goes down; provenance becomes this writer) ──
    try {
      ({ stamp } = await updateItemContent(gw, existingId, {
        title, summary, full_transcript: content, source_url: source_url ?? null, tags,
      }));
    } catch (err) {
      throw new Error(`ingest_content: ${err instanceof Error ? err.message : String(err)}`);
    }
    itemId = existingId;
    action = 'updated';
  } else {
    // ── INSERT new item ───────────────────────────────────────────────────
    if ((await countIngestsToday(userId)) >= DAILY_INGEST_LIMIT) throw new DailyIngestLimitError();
    try {
      const inserted = await insertItem(gw, {
        source_type, title, summary, full_transcript: content, source_url: source_url ?? null, tags,
        extra: { status: 'indexed' },
      });
      ({ stamp } = inserted);
      storedTags = inserted.tags;
      itemId = inserted.id;
    } catch (err) {
      throw new Error(`ingest_content: ${err instanceof Error ? err.message : String(err)}`);
    }
    action = 'inserted';
  }

  // ── Link tags (best-effort), incl. the visible `agent-written` label ────────
  if (storedTags.length > 0) {
    await linkTags(itemId, storedTags, userId);
  }

  // ── Auto-embed (best-effort — failure saves item with embedding = NULL) ───
  try {
    await embedItem(itemId);
  } catch (err) {
    console.error(`[ingest] embed failed for ${itemId} (item saved, embedding NULL):`, err);
  }

  // ── Log to ingest_log (best-effort) ──────────────────────────────────────
  try {
    await dbAdmin.from('ingest_log').insert({
      user_id:     userId,
      item_id:     itemId,
      source_type: source_type ?? 'manual',
      action,
      title,
    });
  } catch (err) {
    console.error(`[ingest] ingest_log write failed (non-fatal):`, err);
  }

  return { id: itemId, title, action, provenance: stamp.provenance, taint_level: stamp.taint_level };
}

import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';
import { findItemBySourceUrl, findItemByTitle, linkTags } from '../db/supabase.js';
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

// ─── Implementation ───────────────────────────────────────────────────────────

export async function ingestContent(
  input: z.infer<typeof ingestContentSchema>,
  userId: string
): Promise<{ id: string; title: string; action: 'inserted' | 'updated' }> {
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
  const now = new Date().toISOString();
  let itemId: string;
  let action: 'inserted' | 'updated';

  if (existingId) {
    // ── UPDATE existing item ───────────────────────────────────────────────
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

    if (error) throw new Error(`ingest_content: update failed — ${error.message}`);
    itemId = existingId;
    action = 'updated';
  } else {
    // ── INSERT new item ───────────────────────────────────────────────────
    const { data, error } = await dbAdmin
      .from('items')
      .insert({
        user_id: userId,
        source_type,
        title,
        summary,
        full_transcript: content,
        source_url: source_url ?? null,
        url: source_url ?? `braintube://manual/${Date.now()}`,
        taint_level: 0,
        is_user_created: true,
        is_archived: false,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !data) throw new Error(`ingest_content: insert failed — ${error?.message}`);
    itemId = data.id;
    action = 'inserted';
  }

  // ── Link tags (best-effort) ────────────────────────────────────────────────
  if (tags && tags.length > 0) {
    await linkTags(itemId, tags, userId);
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

  return { id: itemId, title, action };
}

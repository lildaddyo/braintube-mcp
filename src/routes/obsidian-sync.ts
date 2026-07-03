import { createHash } from 'crypto';
import type express from 'express';
import { dbAdmin } from '../db/supabase.js';
import { embedItem } from '../tools/embedding.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ObsidianNote {
  path: string;
  title: string;
  content: string;
  tags: string[];
  modified_at: string;
}

interface SyncBody {
  notes: ObsidianNote[];
}

// ─── API key auth helper ──────────────────────────────────────────────────────

async function resolveApiKey(token: string): Promise<string | null> {
  const hash = createHash('sha256').update(token).digest('hex');

  const { data } = await dbAdmin
    .from('api_keys')
    .select('user_id')
    .eq('key_hash', hash)
    .eq('is_active', true)
    .single();

  if (!data) return null;

  // Fire-and-forget last_used update
  void dbAdmin
    .from('api_keys')
    .update({ last_used: new Date().toISOString() })
    .eq('key_hash', hash)
    .then(
      ({ error }) => {
        if (error) console.error(`[obsidian-sync] last_used update failed for key hash ${hash.slice(0, 8)}…: ${error.message}`);
      },
      (err: unknown) => {
        console.error(`[obsidian-sync] last_used update threw for key hash ${hash.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
      }
    );

  return data.user_id as string;
}

// ─── Tag helper ───────────────────────────────────────────────────────────────

async function linkTags(itemId: string, tagNames: string[], userId: string): Promise<void> {
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;

    try {
      // Get or create tag (scoped to user)
      const { data: existing } = await dbAdmin
        .from('tags')
        .select('id')
        .eq('name', name)
        .eq('user_id', userId)
        .limit(1);

      let tagId: string | undefined = (existing ?? [])[0]?.id;

      if (!tagId) {
        const { data: created } = await dbAdmin
          .from('tags')
          .insert({ name, user_id: userId })
          .select('id')
          .single();
        tagId = created?.id;
      }

      if (!tagId) continue;

      // Link item ↔ tag (ignore duplicate errors)
      try {
        await dbAdmin
          .from('item_tags')
          .insert({ item_id: itemId, tag_id: tagId });
      } catch { /* ignore duplicate constraint violations */ }
    } catch {
      // Non-fatal — tag linking failure should not abort the note sync
    }
  }
}

// ─── Ingest log helper ────────────────────────────────────────────────────────

async function writeIngestLog(
  userId: string,
  itemId: string,
  title: string,
  action: 'inserted' | 'updated'
): Promise<void> {
  try {
    await dbAdmin.from('ingest_log').insert({
      user_id: userId,
      item_id: itemId,
      source_type: 'obsidian',
      title,
      action,
    });
  } catch {
    // Table may not exist yet — silently skip
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function handleObsidianSync(
  req: express.Request,
  res: express.Response
): Promise<void> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = (req.headers.authorization as string | undefined) ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ error: 'Missing API key', hint: 'Authorization: Bearer bt_...' });
    return;
  }

  const userId = await resolveApiKey(token);
  if (!userId) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // ── Body validation ───────────────────────────────────────────────────────
  const body = req.body as SyncBody;
  if (!Array.isArray(body?.notes) || body.notes.length === 0) {
    res.status(400).json({ error: 'Body must contain a non-empty notes array' });
    return;
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  // ── Process each note ─────────────────────────────────────────────────────
  for (const note of body.notes) {
    try {
      if (!note.path || !note.title) {
        skipped++;
        errors.push(`Skipped note with missing path or title`);
        continue;
      }

      const summary = (note.content ?? '').slice(0, 500);

      // Check if item already exists (user_id + source_type + url)
      const { data: existing } = await dbAdmin
        .from('items')
        .select('id')
        .eq('user_id', userId)
        .eq('source_type', 'obsidian')
        .eq('url', note.path)
        .limit(1);

      const existingItem = (existing ?? [])[0];
      let itemId: string;

      if (existingItem) {
        // Update existing item
        const { error: updateErr } = await dbAdmin
          .from('items')
          .update({
            title: note.title,
            summary,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingItem.id);

        if (updateErr) throw new Error(updateErr.message);
        itemId = existingItem.id;
        updated++;
        await writeIngestLog(userId, itemId, note.title, 'updated');
      } else {
        // Insert new item
        const { data: newItem, error: insertErr } = await dbAdmin
          .from('items')
          .insert({
            user_id: userId,
            source_type: 'obsidian',
            url: note.path,
            title: note.title,
            summary,
            taint_level: 0,
            is_archived: false,
          })
          .select('id')
          .single();

        if (insertErr || !newItem) throw new Error(insertErr?.message ?? 'Insert returned no data');
        itemId = newItem.id;
        inserted++;
        await writeIngestLog(userId, itemId, note.title, 'inserted');
      }

      // Link tags (best-effort)
      if (Array.isArray(note.tags) && note.tags.length > 0) {
        await linkTags(itemId, note.tags, userId);
      }

      // Generate embedding (best-effort — failure should not fail the sync)
      try {
        await embedItem(itemId);
      } catch (embedErr) {
        console.warn(`[obsidian-sync] embed failed for ${itemId}: ${embedErr}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[obsidian-sync] error processing "${note.path}": ${msg}`);
      errors.push(`${note.path}: ${msg}`);
      skipped++;
    }
  }

  res.json({ inserted, updated, skipped, errors });
}

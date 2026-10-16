import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';
import { buildItemEmbedText, ITEM_EMBED_COLUMNS, type ItemEmbedFields } from '../lib/item-embed-text.js';

export const backfillEmbeddingsOutputSchema = z.object({
  embedded: z.number(),
  errors: z.number(),
  firstError: z.string().optional(),
});

// ─── Single item embed ────────────────────────────────────────────────────────

/**
 * Fetch an item by internal UUID, build its embedding text with the shared recipe
 * (src/lib/item-embed-text.ts, identical to the app's), embed it with text-embedding-3-large
 * @1536 and write items.content_embedding_v2. The legacy 1536-d items.embedding column
 * (3-small, read only by search_knowledge_semantic) is no longer written.
 */
export async function embedItem(itemId: string): Promise<void> {
  const { data: item, error } = await dbAdmin
    .from('items')
    .select(`id, ${ITEM_EMBED_COLUMNS}`).eq('ai_excluded', false)
    .eq('id', itemId)
    .single();

  if (error || !item) throw new Error(`embedItem: item not found — ${itemId}`);

  const { data: ext } = await dbAdmin
    .from('screenshot_extracts')
    .select('visual_description, key_facts')
    .eq('item_id', itemId)
    .maybeSingle();

  const text = buildItemEmbedText({ ...(item as ItemEmbedFields), ...((ext ?? {}) as ItemEmbedFields) });
  const embedding = await generateEmbedding(text);

  const { error: updateError } = await dbAdmin
    .from('items')
    .update({
      content_embedding_v2: '[' + embedding.join(',') + ']',
      embedding_quality: 'full',
      last_embedded_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (updateError) throw new Error(`embedItem: update failed — ${updateError.message}`);
}

// ─── Embed a specific list of items in batches ────────────────────────────────

/**
 * Embed a given list of item IDs, processing in groups of `batchSize` with
 * 200ms delays between batches. Used by ingest_content and bulk_ingest.
 * Returns { embedded, errors[] } — never throws.
 */
export async function embedItemsBatch(
  itemIds: string[],
  batchSize = 20
): Promise<{ embedded: number; errors: string[] }> {
  let embedded = 0;
  const errors: string[] = [];

  for (let i = 0; i < itemIds.length; i += batchSize) {
    const batch = itemIds.slice(i, i + batchSize);

    await Promise.all(batch.map(async (id) => {
      try {
        await embedItem(id);
        embedded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[embed] failed for ${id}:`, msg);
        errors.push(`${id}: ${msg}`);
      }
    }));

    if (i + batchSize < itemIds.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { embedded, errors };
}

// ─── Batch backfill ────────────────────────────────────────────────────────────

/**
 * Backfill embeddings for all items where content_embedding_v2 IS NULL.
 *
 * Fetches ALL null-embedding IDs upfront (avoids offset-pagination skipping items
 * whose embedding flips from NULL → filled mid-run), then processes in batches of
 * `batchSize` with 200ms delays to avoid rate limits.
 */
export async function backfillEmbeddings(
  userId: string,
  batchSize = 20
): Promise<{ embedded: number; errors: number; firstError?: string }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — add it as a Railway environment variable');
  }

  // Fetch all IDs upfront so offset-drift doesn't skip items
  const { data: allItems, error: fetchError } = await dbAdmin
    .from('items')
    .select('id').eq('ai_excluded', false)
    .eq('user_id', userId)
    .is('content_embedding_v2', null)
    .eq('is_archived', false)
    .order('created_at', { ascending: false });

  if (fetchError) throw new Error(`backfillEmbeddings: fetch failed — ${fetchError.message}`);
  if (!allItems || allItems.length === 0) return { embedded: 0, errors: 0 };

  let embedded = 0;
  let errors = 0;
  let firstError: string | undefined;

  for (let i = 0; i < allItems.length; i += batchSize) {
    const batch = allItems.slice(i, i + batchSize);

    await Promise.all(batch.map(async ({ id }) => {
      try {
        await embedItem(id);
        embedded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[embed] failed for item ${id}:`, msg);
        if (!firstError) firstError = `item ${id}: ${msg}`;
        errors++;
      }
    }));

    if (i + batchSize < allItems.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { embedded, errors, firstError };
}

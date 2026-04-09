import { dbAdmin } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';

// ─── Text builder ─────────────────────────────────────────────────────────────

interface EmbedFields {
  title?: string | null;
  summary?: string | null;
  tags?: string[] | null;
  channel_name?: string | null; // maps to items.channel
}

/**
 * Build the string that gets embedded for an item.
 * Order: title > channel > tags > summary — most discriminative fields first.
 */
export function buildEmbedText(fields: EmbedFields): string {
  const parts: string[] = [];
  if (fields.title)        parts.push(fields.title.trim());
  if (fields.channel_name) parts.push(`Channel: ${fields.channel_name.trim()}`);
  if (fields.tags?.length) parts.push(`Tags: ${fields.tags.join(', ')}`);
  if (fields.summary)      parts.push(fields.summary.trim());
  return parts.join('\n');
}

// ─── Single item embed ────────────────────────────────────────────────────────

/**
 * Fetch an item by internal UUID, build embed text, generate embedding,
 * and write it back to items.embedding + items.last_embedded_at.
 */
export async function embedItem(itemId: string): Promise<void> {
  // Fetch fields needed for embed text, plus existing tags via join
  const { data: item, error } = await dbAdmin
    .from('items')
    .select('id, title, summary, channel')
    .eq('id', itemId)
    .single();

  if (error || !item) throw new Error(`embedItem: item not found — ${itemId}`);

  // Resolve tag names
  const { data: tagRows } = await dbAdmin
    .from('item_tags')
    .select('tags(name)')
    .eq('item_id', itemId);

  const tags = (tagRows ?? [])
    .map(r => (r.tags as unknown as { name: string } | null)?.name)
    .filter((n): n is string => !!n);

  const text = buildEmbedText({
    title: item.title,
    summary: item.summary,
    tags,
    channel_name: item.channel
  });

  if (!text.trim()) return; // nothing to embed

  const embedding = await generateEmbedding(text);

  const { error: updateError } = await dbAdmin
    .from('items')
    .update({
      embedding,
      last_embedded_at: new Date().toISOString()
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
 * Backfill embeddings for all items where embedding IS NULL.
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
    .select('id')
    .eq('user_id', userId)
    .is('embedding', null)
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

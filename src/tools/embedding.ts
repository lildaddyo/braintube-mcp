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
 * Page through all items where embedding IS NULL for a given user,
 * embed each one, with a 200ms delay between batches to avoid rate limits.
 */
export async function backfillEmbeddings(
  userId: string,
  batchSize = 20
): Promise<{ embedded: number; errors: number }> {
  let embedded = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    const { data: batch, error } = await dbAdmin
      .from('items')
      .select('id')
      .eq('user_id', userId)
      .is('embedding', null)
      .eq('is_archived', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + batchSize - 1);

    if (error) throw new Error(`backfillEmbeddings: fetch failed — ${error.message}`);
    if (!batch || batch.length === 0) break;

    for (const item of batch) {
      try {
        await embedItem(item.id);
        embedded++;
      } catch (err) {
        console.error(`[embed] failed for item ${item.id}:`, err);
        errors++;
      }
    }

    offset += batchSize;

    // 200ms delay between batches
    if (batch.length === batchSize) {
      await new Promise(r => setTimeout(r, 200));
    } else {
      break; // last batch was smaller than batchSize — done
    }
  }

  return { embedded, errors };
}

import { dbAdmin } from '../db/supabase.js';
import { generateEmbedding } from '../lib/openai.js';

// ─── Text builder ─────────────────────────────────────────────────────────────

interface EmbedFields {
  title?: string | null;
  summary?: string | null;
  summary_oneliner?: string | null;
  tags?: string[] | null;
  channel_name?: string | null; // maps to items.channel
  // Enrichment metadata — present on items that have been through enrich-metadata
  topic_primary?: string | null;
  topic_secondary?: string[] | null;
  entities?: string[] | null;
  key_concepts?: string[] | null;
  content_type?: string | null;
  domain?: string | null;
}

/**
 * Build the string that gets embedded for an item.
 *
 * If enrichment metadata is present (topic_primary set), uses prefix-fusion
 * format to match the re-embed-batch edge function (embedding_version = 2).
 * Otherwise falls back to the legacy format (embedding_version = 1).
 */
export function buildEmbedText(fields: EmbedFields): { text: string; version: 1 | 2 } {
  if (fields.topic_primary) {
    // Prefix-fusion path — embedding_version 2
    const prefixParts: string[] = [];
    prefixParts.push(`Topic: ${fields.topic_primary}`);
    if (fields.topic_secondary?.length) prefixParts.push(`Subtopics: ${fields.topic_secondary.join(', ')}`);
    if (fields.entities?.length)        prefixParts.push(`Entities: ${fields.entities.join(', ')}`);
    if (fields.key_concepts?.length)    prefixParts.push(`Concepts: ${fields.key_concepts.join(', ')}`);
    if (fields.content_type)            prefixParts.push(`Type: ${fields.content_type}`);
    if (fields.domain)                  prefixParts.push(`Domain: ${fields.domain}`);

    const parts: string[] = [`[${prefixParts.join(' | ')}]`];
    if (fields.title)            parts.push(fields.title.trim());
    if (fields.summary_oneliner) parts.push(fields.summary_oneliner.trim());
    if (fields.summary)          parts.push(fields.summary.trim());
    return { text: parts.join('\n'), version: 2 };
  }

  // Legacy path — embedding_version 1
  const parts: string[] = [];
  if (fields.title)        parts.push(fields.title.trim());
  if (fields.channel_name) parts.push(`Channel: ${fields.channel_name.trim()}`);
  if (fields.tags?.length) parts.push(`Tags: ${fields.tags.join(', ')}`);
  if (fields.summary)      parts.push(fields.summary.trim());
  return { text: parts.join('\n'), version: 1 };
}

// ─── Single item embed ────────────────────────────────────────────────────────

/**
 * Fetch an item by internal UUID, build embed text, generate embedding,
 * and write it back to items.embedding + items.last_embedded_at.
 */
export async function embedItem(itemId: string): Promise<void> {
  // Fetch core fields + enrichment metadata
  const { data: item, error } = await dbAdmin
    .from('items')
    .select('id, title, summary, summary_oneliner, channel, topic_primary, topic_secondary, entities, key_concepts, content_type, domain')
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

  const { text, version } = buildEmbedText({
    title: item.title,
    summary: item.summary,
    summary_oneliner: item.summary_oneliner,
    tags,
    channel_name: item.channel,
    topic_primary: item.topic_primary,
    topic_secondary: item.topic_secondary,
    entities: item.entities,
    key_concepts: item.key_concepts,
    content_type: item.content_type,
    domain: item.domain,
  });

  if (!text.trim()) return; // nothing to embed

  const embedding = await generateEmbedding(text);

  const { error: updateError } = await dbAdmin
    .from('items')
    .update({
      embedding,
      embedding_version: version,
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

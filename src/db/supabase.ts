import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Single service-role client — bypasses RLS.
// Per-user isolation is enforced manually via .eq('user_id', userId) on every query.
export const dbAdmin = createClient(url, serviceKey);

// ─── Tags helper ────────────────────────────────────────────────────────────

async function fetchTagsForItems(itemIds: string[]): Promise<Record<string, string[]>> {
  if (itemIds.length === 0) return {};
  const { data } = await dbAdmin
    .from('item_tags')
    .select('item_id, tags(name)')
    .in('item_id', itemIds);

  const map: Record<string, string[]> = {};
  for (const row of data ?? []) {
    const name = (row.tags as unknown as { name: string } | null)?.name;
    if (name) map[row.item_id] = [...(map[row.item_id] ?? []), name];
  }
  return map;
}

// ─── Search ─────────────────────────────────────────────────────────────────

// Searches all source types (youtube, instagram, web, screenshot, linkedin, twitter…)
// Hits title (100%), description (~70%), summary (~35%), full_transcript (~40%)
export async function semanticSearch(query: string, userId: string, limit = 5) {
  const q = `%${query}%`;
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, source_type, title, channel, url, description, summary, taint_level, created_at')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .or(`title.ilike.${q},description.ilike.${q},summary.ilike.${q},full_transcript.ilike.${q}`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Search failed: ${error.message}`);
  const results = data ?? [];
  if (results.length === 0) return [];

  const tagsMap = await fetchTagsForItems(results.map(r => r.id));
  return results.map(r => ({ ...r, tags: tagsMap[r.id] ?? [] }));
}

// ─── Get single item ─────────────────────────────────────────────────────────

export async function getVideoById(id: string, userId: string) {
  // Try YouTube video_id first
  let { data, error } = await dbAdmin
    .from('items')
    .select('*')
    .eq('user_id', userId)
    .eq('video_id', id)
    .single();

  // Fallback to internal UUID
  if (!data) {
    ({ data, error } = await dbAdmin
      .from('items')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .single());
  }

  if (error) throw new Error(`Item not found: ${error.message}`);
  if (!data) throw new Error(`Item not found for id: ${id}`);

  const tagsMap = await fetchTagsForItems([data.id]);
  return { ...data, tags: tagsMap[data.id] ?? [] };
}

// ─── Recent items ─────────────────────────────────────────────────────────────

export async function getRecentVideos(userId: string, limit = 10) {
  const { data, error } = await dbAdmin
    .from('items')
    .select('id, video_id, source_type, title, channel, url, summary, taint_level, created_at')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to list recent: ${error.message}`);
  const items = data ?? [];
  const tagsMap = await fetchTagsForItems(items.map(i => i.id));
  return items.map(i => ({ ...i, tags: tagsMap[i.id] ?? [] }));
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getCorpusStats(userId: string) {
  const [itemsResult, notesCountResult] = await Promise.all([
    dbAdmin
      .from('items')
      .select('id, source_type, taint_level')
      .eq('user_id', userId)
      .eq('is_archived', false),
    dbAdmin
      .from('item_notes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
  ]);

  if (itemsResult.error) throw new Error(itemsResult.error.message);
  const items = itemsResult.data ?? [];

  const sourceCounts: Record<string, number> = {};
  const taintDist: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 };

  for (const item of items) {
    const st = item.source_type ?? 'unknown';
    sourceCounts[st] = (sourceCounts[st] ?? 0) + 1;
    taintDist[String(item.taint_level ?? 0)] = (taintDist[String(item.taint_level ?? 0)] ?? 0) + 1;
  }

  const topSources = Object.entries(sourceCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([source_type, count]) => ({ source_type, count }));

  return {
    total_items: items.length,
    total_notes: notesCountResult.count ?? 0,
    top_sources: topSources,
    taint_distribution: taintDist,
    last_updated: new Date().toISOString()
  };
}

// ─── Write note ───────────────────────────────────────────────────────────────

export async function writeNote(videoId: string, note: string, userId: string) {
  // Ownership check — prevents writing to another user's item even with valid JWT
  const { data: item } = await dbAdmin
    .from('items')
    .select('id')
    .eq('id', videoId)
    .eq('user_id', userId)
    .single();

  if (!item) throw new Error('Item not found or does not belong to this user');

  // Upsert into item_notes (unique constraint: item_id, user_id)
  const { error } = await dbAdmin
    .from('item_notes')
    .upsert(
      {
        item_id: videoId,
        user_id: userId,
        content: note,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'item_id,user_id' }
    );

  if (error) throw new Error(`Failed to write note: ${error.message}`);
}

// ─── Dedup helpers ────────────────────────────────────────────────────────────

/** Return the existing item UUID if a row exists with this source_url for the user. */
export async function findItemBySourceUrl(sourceUrl: string, userId: string): Promise<string | null> {
  const { data } = await dbAdmin
    .from('items')
    .select('id')
    .eq('user_id', userId)
    .eq('source_url', sourceUrl)
    .limit(1);
  return (data ?? [])[0]?.id ?? null;
}

/** Return the existing item UUID if a row exists with this exact title for the user. */
export async function findItemByTitle(title: string, userId: string): Promise<string | null> {
  const { data } = await dbAdmin
    .from('items')
    .select('id')
    .eq('user_id', userId)
    .eq('title', title)
    .limit(1);
  return (data ?? [])[0]?.id ?? null;
}

// ─── Tag helper (shared across ingest paths) ──────────────────────────────────

/**
 * Get-or-create tags by name and link them to the given item.
 * Non-fatal — a tag linking failure never aborts an ingest.
 */
export async function linkTags(itemId: string, tagNames: string[]): Promise<void> {
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    try {
      const { data: existing } = await dbAdmin
        .from('tags')
        .select('id')
        .eq('name', name)
        .limit(1);

      let tagId: string | undefined = (existing ?? [])[0]?.id;

      if (!tagId) {
        const { data: created } = await dbAdmin
          .from('tags')
          .insert({ name })
          .select('id')
          .single();
        tagId = created?.id;
      }

      if (!tagId) continue;

      try {
        await dbAdmin.from('item_tags').insert({ item_id: itemId, tag_id: tagId });
      } catch { /* ignore duplicate constraint violations */ }
    } catch { /* non-fatal */ }
  }
}

// ─── Retrieval tracking ───────────────────────────────────────────────────────

/**
 * Atomically increment retrieval_count + set last_retrieved_at for a batch of items.
 * Fire-and-forget from search — never throws.
 */
export async function incrementRetrievalStats(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    await dbAdmin.rpc('increment_retrieval_stats', { item_ids: itemIds });
  } catch (err) {
    console.warn('[db] incrementRetrievalStats failed (non-fatal):', err);
  }
}

// ─── Daily ingest count ───────────────────────────────────────────────────────

/** Count items this user has created (inserted) since the start of today (UTC). */
export async function countIngestsToday(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count } = await dbAdmin
    .from('items')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startOfDay.toISOString());
  return count ?? 0;
}

// ─── Semantic search via pgvector RPC ─────────────────────────────────────────

export interface SemanticResult {
  id: string;
  title: string;
  summary: string | null;
  source_type: string;
  source_url: string | null;
  channel_name: string | null;
  tags: string[] | null;
  saved_at: string;
  similarity: number;
  match_type: 'semantic';
  taint_level?: number;  // not returned by RPC — fetched in search.ts when needed
}

/**
 * Call the search_knowledge_semantic RPC.
 * Takes a pre-computed embedding (number[]) and returns ranked results.
 * RPC signature: (query_embedding vector, match_user_id uuid, match_count int, similarity_threshold float8)
 */
export async function semanticSearchRpc(
  embedding: number[],
  userId: string,
  limit = 10,
  threshold = 0.3
): Promise<SemanticResult[]> {
  const { data, error } = await dbAdmin.rpc('search_knowledge_semantic', {
    query_embedding: embedding,
    match_user_id: userId,
    match_count: limit,
    similarity_threshold: threshold
  });

  if (error) throw new Error(`Semantic search RPC failed: ${error.message}`);
  return (data ?? []).map((row: SemanticResult) => ({ ...row, match_type: 'semantic' as const }));
}

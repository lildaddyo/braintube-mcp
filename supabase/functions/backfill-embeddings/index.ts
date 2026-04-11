import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;
const BATCH_SIZE = 25;

// ── Build embedding input text (mirrors src/tools/embedding.ts) ───────────────

function buildEmbedText(item: {
  title: string | null;
  channel_name?: string | null;
  channel?: string | null;
  summary: string | null;
  tags?: string[] | null;
}): string {
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  const channel = item.channel_name ?? item.channel ?? null;
  if (channel) parts.push(channel);
  if (item.summary) parts.push(item.summary);
  if (item.tags?.length) parts.push(item.tags.join(', '));
  return parts.join('\n').slice(0, 8000);
}

// ── OpenAI embedding call ─────────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embeddings API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let embedded = 0;
  let errors = 0;
  let total = 0;
  let offset = 0;

  // Count total items needing embeddings
  const { count } = await db
    .from('items')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);
  total = count ?? 0;

  console.log(`[backfill] ${total} items need embeddings`);

  while (true) {
    // Fetch a batch of items missing embeddings
    const { data: items, error: fetchError } = await db
      .from('items')
      .select('id, title, channel, summary')
      .is('embedding', null)
      .range(offset, offset + BATCH_SIZE - 1);

    if (fetchError) {
      console.error('[backfill] fetch error:', fetchError.message);
      break;
    }
    if (!items || items.length === 0) break;

    // Fetch tags for this batch
    const ids = items.map((i: { id: string }) => i.id);
    const { data: tagRows } = await db
      .from('item_tags')
      .select('item_id, tags(name)')
      .in('item_id', ids);

    const tagsMap: Record<string, string[]> = {};
    for (const row of tagRows ?? []) {
      const name = (row.tags as unknown as { name: string } | null)?.name;
      if (name) tagsMap[row.item_id] = [...(tagsMap[row.item_id] ?? []), name];
    }

    // Embed each item
    for (const item of items as Array<{ id: string; title: string | null; channel: string | null; summary: string | null }>) {
      try {
        const text = buildEmbedText({ ...item, tags: tagsMap[item.id] ?? [] });
        if (!text.trim()) {
          console.warn(`[backfill] skipping ${item.id} — no embeddable text`);
          errors++;
          continue;
        }

        const embedding = await generateEmbedding(text);

        const { error: updateError } = await db
          .from('items')
          .update({
            embedding,
            last_embedded_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        if (updateError) throw new Error(updateError.message);
        embedded++;
        console.log(`[backfill] ✓ ${item.id} (${item.title?.slice(0, 40)})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] ✗ ${item.id}: ${msg}`);
        errors++;
      }

      // 200ms delay to stay within OpenAI rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    offset += BATCH_SIZE;
    if (items.length < BATCH_SIZE) break;
  }

  const result = { embedded, errors, total };
  console.log('[backfill] done:', result);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
});

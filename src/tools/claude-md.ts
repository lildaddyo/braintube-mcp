import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const exportClaudeMdSchema = z.object({});

export async function exportClaudeMd(
  _input: z.infer<typeof exportClaudeMdSchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {

  // Run all queries in parallel
  const [itemsResult, articlesResult, statsResult, entitiesResult] = await Promise.all([
    // Top 20 items by salience_score
    dbAdmin
      .from('items')
      .select('title, summary_oneliner, topic_primary, salience_score')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .not('salience_score', 'is', null)
      .order('salience_score', { ascending: false })
      .limit(20),

    // All concept articles
    dbAdmin
      .from('concept_articles')
      .select('title, content')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),

    // Corpus stats (topic counts)
    dbAdmin
      .from('items')
      .select('topic_primary')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .not('topic_primary', 'is', null),

    // Top entities by frequency via RPC (non-fatal if RPC missing)
    Promise.resolve(
      dbAdmin.rpc('top_entities', { for_user_id: userId, top_n: 10 })
    ).catch(() => ({ data: null, error: null })),
  ]);

  if (itemsResult.error) throw new Error(`Failed to fetch items: ${itemsResult.error.message}`);

  const items = itemsResult.data ?? [];
  const articles = articlesResult.data ?? [];
  const allItems = statsResult.data ?? [];

  // Build topic counts
  const topicMap = new Map<string, number>();
  for (const row of allItems) {
    const t = row.topic_primary as string;
    topicMap.set(t, (topicMap.get(t) ?? 0) + 1);
  }
  const topTopics = [...topicMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  // Entities — from RPC if available, else derive from items
  let entities: string[] = [];
  if (entitiesResult.data && Array.isArray(entitiesResult.data)) {
    entities = (entitiesResult.data as Array<{ entity: string; count: number }>)
      .map(e => `${e.entity} (${e.count})`);
  }

  // Build CLAUDE.md content
  const lines: string[] = [
    '## Knowledge Base Context',
    '',
    `This project has access to a BrainTube knowledge base with ${allItems.length} items across ${topicMap.size} topics.`,
    '',
    '## Key Topics',
    '',
    ...topTopics.map(([topic, count]) => `- **${topic}** — ${count} items`),
    '',
  ];

  if (items.length > 0) {
    lines.push('## Highest-Salience Items', '');
    for (const item of items) {
      lines.push(`- **${item.title}**${item.summary_oneliner ? ` — ${item.summary_oneliner}` : ''}`);
    }
    lines.push('');
  }

  if (articles.length > 0) {
    lines.push('## Compiled Knowledge', '');
    for (const article of articles) {
      const excerpt = (article.content as string ?? '').slice(0, 200).replace(/\n/g, ' ').trim();
      lines.push(`### ${article.title}`);
      lines.push(excerpt + (article.content?.length > 200 ? '…' : ''));
      lines.push('');
    }
  }

  if (entities.length > 0) {
    lines.push('## Top Entities', '');
    for (const e of entities) lines.push(`- ${e}`);
    lines.push('');
  }

  lines.push(
    '## How to Query',
    '',
    'Use the BrainTube MCP tools: `search_knowledge`, `get_knowledge_graph`, `detect_gaps`',
    '',
    '> Add this file to your project as `CLAUDE.md` to give Claude automatic context about your knowledge base.',
  );

  const md = lines.join('\n');

  return {
    content: [{ type: 'text' as const, text: md }],
    structuredContent: {
      total_items: allItems.length,
      total_topics: topicMap.size,
      total_articles: articles.length,
      markdown: md,
    } as unknown as Record<string, unknown>,
  };
}

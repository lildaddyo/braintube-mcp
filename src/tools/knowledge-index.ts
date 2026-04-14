import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const knowledgeIndexSchema = z.object({});

interface TopicRow {
  topic_primary: string;
  item_count: number;
  synthesis_count: number;
  avg_salience: number | null;
  latest_item: string;
  source_types: string[];
}

export async function getKnowledgeIndex(_input: z.infer<typeof knowledgeIndexSchema>, userId: string) {
  const { data, error } = await dbAdmin
    .from('items')
    .select('topic_primary, content_type, salience_score, created_at, source_type')
    .eq('user_id', userId)
    .neq('is_archived', true)
    .not('topic_primary', 'is', null);

  if (error) throw new Error(`knowledge_index query failed: ${error.message}`);

  const rows = data ?? [];

  // Group by topic_primary in JS (avoids needing a raw SQL RPC)
  const topicMap = new Map<string, {
    item_count: number;
    synthesis_count: number;
    salience_sum: number;
    salience_n: number;
    latest_item: string;
    source_types: Set<string>;
  }>();

  for (const row of rows) {
    const topic = row.topic_primary as string;
    const existing = topicMap.get(topic) ?? {
      item_count: 0,
      synthesis_count: 0,
      salience_sum: 0,
      salience_n: 0,
      latest_item: '',
      source_types: new Set<string>(),
    };

    existing.item_count += 1;
    if (row.content_type === 'synthesis') existing.synthesis_count += 1;
    if (row.salience_score != null) {
      existing.salience_sum += row.salience_score as number;
      existing.salience_n += 1;
    }
    if (!existing.latest_item || row.created_at > existing.latest_item) {
      existing.latest_item = row.created_at as string;
    }
    if (row.source_type) existing.source_types.add(row.source_type as string);

    topicMap.set(topic, existing);
  }

  const topics: TopicRow[] = [...topicMap.entries()]
    .map(([topic, agg]) => ({
      topic_primary: topic,
      item_count: agg.item_count,
      synthesis_count: agg.synthesis_count,
      avg_salience: agg.salience_n > 0
        ? Math.round((agg.salience_sum / agg.salience_n) * 1000) / 1000
        : null,
      latest_item: agg.latest_item,
      source_types: [...agg.source_types].sort(),
    }))
    .sort((a, b) => b.item_count - a.item_count);

  const result = {
    total_items: rows.length,
    total_topics: topics.length,
    topics,
  };

  const topN = topics.slice(0, 15);
  const lines = [
    `Knowledge Index — ${result.total_topics} topics, ${result.total_items} items`,
    ``,
    ...topN.map(t =>
      `${t.topic_primary.padEnd(30)} ${String(t.item_count).padStart(4)} items` +
      (t.synthesis_count > 0 ? `  ${t.synthesis_count} synth` : '') +
      (t.avg_salience != null ? `  salience ${t.avg_salience}` : '')
    ),
    topics.length > 15 ? `…and ${topics.length - 15} more topics` : '',
  ].filter(l => l !== '');

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

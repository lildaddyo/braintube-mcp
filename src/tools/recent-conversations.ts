import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const recentConversationsSchema = z.object({
  n: z.number().int().min(1).max(20).default(5).describe(
    'Number of recent AI conversations to return (default 5)'
  )
});

export interface ConversationItem {
  title: string;
  summary: string;
  date: string;
  source_url: string | null;
}

export async function getRecentConversations(
  input: z.infer<typeof recentConversationsSchema>,
  userId: string
) {
  const { n } = input;

  const { data, error } = await dbAdmin
    .from('items')
    .select('id, title, content, source_url, created_at')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .in('source_type', ['claude', 'chatgpt'])
    .order('created_at', { ascending: false })
    .limit(n);

  if (error) throw new Error(`get_recent_conversations failed: ${error.message}`);

  const results: ConversationItem[] = (data ?? []).map(row => ({
    title: row.title ?? 'Untitled',
    summary: row.content ?? '',
    date: row.created_at,
    source_url: row.source_url ?? null,
  }));

  if (results.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No saved AI conversations found. Save Claude or ChatGPT conversations via the extension to populate this.'
      }],
      structuredContent: { items: [] } as unknown as Record<string, unknown>
    };
  }

  const lines = results.map((r, i) =>
    `${i + 1}. [${new Date(r.date).toLocaleDateString()}] ${r.title}${r.source_url ? ` — ${r.source_url}` : ''}\n   ${r.summary.slice(0, 200)}${r.summary.length > 200 ? '…' : ''}`
  );

  return {
    content: [{ type: 'text' as const, text: `Recent AI conversations (${results.length}):\n\n${lines.join('\n\n')}` }],
    structuredContent: results as unknown as Record<string, unknown>
  };
}

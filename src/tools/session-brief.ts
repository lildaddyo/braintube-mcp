import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';
import { getExpertiseProfile } from './expertise-profile.js';
import { getRecentConversations } from './recent-conversations.js';

export const sessionBriefSchema = z.object({});

export const getSessionBriefOutputSchema = z.object({
  expertise: z.object({
    expert_topics: z.array(z.string()).optional(),
    intermediate_topics: z.array(z.string()).optional(),
    surface_topics: z.array(z.string()).optional(),
    blind_spots: z.array(z.string()).optional(),
    recent_focus: z.array(z.string()).optional(),
    dominant_sources: z.array(z.object({ source: z.string(), count: z.number() })).optional(),
  }).passthrough(),
  recent_work: z.array(z.object({
    title: z.string().optional(),
    summary: z.string().optional(),
    date: z.string().optional(),
    source_url: z.string().nullable().optional(),
  }).passthrough()),
  corpus_stats: z.object({
    total: z.number(),
    last_added: z.string().optional(),
  }).passthrough(),
});

function timeAgo(date: string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export async function getSessionBrief(
  _input: z.infer<typeof sessionBriefSchema>,
  userId: string
) {
  // Run all three queries in parallel
  const [expertiseResult, recentConvsResult, statsResult] = await Promise.all([
    getExpertiseProfile(userId),
    getRecentConversations({ n: 5 }, userId),
    dbAdmin
      .from('items')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('created_at', { ascending: false })
      .limit(1)
  ]);

  // Total count via a separate count query
  const { count: totalCount } = await dbAdmin
    .from('items')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_archived', false);

  const lastAdded = statsResult.data?.[0]?.created_at
    ? timeAgo(statsResult.data[0].created_at)
    : 'never';

  // Extract recent_work from the structured content of getRecentConversations
  // structuredContent is { conversations: [...] } — unwrap the array
  const structuredObj = recentConvsResult.structuredContent as unknown as {
    conversations: Array<{ title: string; summary: string; date: string; source_url: string | null }>
  };
  const recentWork = Array.isArray(structuredObj?.conversations) ? structuredObj.conversations : [];

  const brief = {
    expertise: {
      expert_topics: expertiseResult.expert_topics,
      intermediate_topics: expertiseResult.intermediate_topics,
      surface_topics: expertiseResult.surface_topics.slice(0, 10),
      blind_spots: expertiseResult.blind_spots.slice(0, 10),
      recent_focus: expertiseResult.recent_focus,
      dominant_sources: expertiseResult.dominant_sources.slice(0, 5),
    },
    recent_work: recentWork,
    corpus_stats: {
      total: totalCount ?? 0,
      last_added: lastAdded,
    },
  };

  // Human-readable summary
  const expertStr = brief.expertise.expert_topics.length
    ? `Expert in: ${brief.expertise.expert_topics.slice(0, 5).join(', ')}`
    : 'No expert-level topics yet';
  const recentStr = brief.expertise.recent_focus.length
    ? `Recent focus: ${brief.expertise.recent_focus.join(', ')}`
    : 'No recent tagging activity';
  const statsStr = `Corpus: ${brief.corpus_stats.total} items, last added ${brief.corpus_stats.last_added}`;
  const workStr = recentWork.length
    ? `Last conversations: ${(recentWork as Array<{ title: string }>).map(r => r.title).join(' | ')}`
    : 'No recent AI conversations saved';

  const text = [expertStr, recentStr, statsStr, workStr].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: brief as unknown as Record<string, unknown>
  };
}

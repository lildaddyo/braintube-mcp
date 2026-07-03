import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const expertiseProfileSchema = z.object({});

export const getExpertiseProfileOutputSchema = z.object({
  expert_topics: z.array(z.string()),
  intermediate_topics: z.array(z.string()),
  surface_topics: z.array(z.string()),
  blind_spots: z.array(z.string()),
  dominant_sources: z.array(z.object({ source: z.string(), count: z.number() })),
  recent_focus: z.array(z.string()),
});

export interface ExpertiseProfile {
  expert_topics: string[];
  intermediate_topics: string[];
  surface_topics: string[];
  blind_spots: string[];
  dominant_sources: Array<{ source: string; count: number }>;
  recent_focus: string[];
}

export async function getExpertiseProfile(userId: string): Promise<ExpertiseProfile> {
  // Fetch all items with tags, source_type, created_at in one query
  const { data, error } = await dbAdmin
    .from('items')
    .select('tags, source_type, created_at')
    .eq('user_id', userId)
    .eq('is_archived', false);

  if (error) throw new Error(`get_expertise_profile failed: ${error.message}`);
  const items = data ?? [];

  // ── Tag frequency across entire corpus ────────────────────────────────────
  const tagCounts: Record<string, number> = {};
  for (const item of items) {
    for (const tag of (item.tags as string[] | null) ?? []) {
      const t = tag.trim().toLowerCase();
      if (t) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
  }

  const expert_topics: string[] = [];
  const intermediate_topics: string[] = [];
  const surface_topics: string[] = [];
  const blind_spots: string[] = [];

  for (const [tag, count] of Object.entries(tagCounts).sort(([, a], [, b]) => b - a)) {
    if (count > 50)      expert_topics.push(tag);
    else if (count >= 20) intermediate_topics.push(tag);
    else if (count >= 5)  surface_topics.push(tag);
    else                  blind_spots.push(tag);
  }

  // ── Source type distribution ────────────────────────────────────────────────
  const sourceCounts: Record<string, number> = {};
  for (const item of items) {
    const st = item.source_type ?? 'unknown';
    sourceCounts[st] = (sourceCounts[st] ?? 0) + 1;
  }
  const dominant_sources = Object.entries(sourceCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([source, count]) => ({ source, count }));

  // ── Recent focus: top tags from last 7 days ────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentTagCounts: Record<string, number> = {};
  for (const item of items) {
    if (new Date(item.created_at) < sevenDaysAgo) continue;
    for (const tag of (item.tags as string[] | null) ?? []) {
      const t = tag.trim().toLowerCase();
      if (t) recentTagCounts[t] = (recentTagCounts[t] ?? 0) + 1;
    }
  }
  const recent_focus = Object.entries(recentTagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([topic]) => topic);

  return {
    expert_topics,
    intermediate_topics,
    surface_topics: surface_topics.slice(0, 20), // cap for readability
    blind_spots: blind_spots.slice(0, 20),
    dominant_sources,
    recent_focus,
  };
}

export async function getExpertiseProfileTool(
  _input: z.infer<typeof expertiseProfileSchema>,
  userId: string
) {
  const profile = await getExpertiseProfile(userId);

  const lines: string[] = [];
  if (profile.expert_topics.length)       lines.push(`🎯 Expert (>50 items): ${profile.expert_topics.join(', ')}`);
  if (profile.intermediate_topics.length) lines.push(`📚 Intermediate (20-50): ${profile.intermediate_topics.join(', ')}`);
  if (profile.surface_topics.length)      lines.push(`🔍 Surface (5-20): ${profile.surface_topics.join(', ')}`);
  if (profile.blind_spots.length)         lines.push(`⚠️  Blind spots (<5): ${profile.blind_spots.join(', ')}`);
  if (profile.recent_focus.length)        lines.push(`🚀 Recent focus (7d): ${profile.recent_focus.join(', ')}`);
  if (profile.dominant_sources.length) {
    const src = profile.dominant_sources.slice(0, 5).map(s => `${s.source} (${s.count})`).join(', ');
    lines.push(`📂 Top sources: ${src}`);
  }

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') || 'No tagged items yet. Use tag_item to label your corpus.' }],
    structuredContent: profile as unknown as Record<string, unknown>
  };
}

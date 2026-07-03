import { z } from 'zod';
import { getCorpusStats } from '../db/supabase.js';

export const statsSchema = z.object({});

export const getStatsOutputSchema = z.object({
  total_items: z.number(),
  top_sources: z.array(z.object({ source_type: z.string(), count: z.number() })).optional(),
  taint_distribution: z.record(z.string(), z.number()).optional(),
  last_updated: z.string().optional(),
}).passthrough();

export async function getStats(_input: z.infer<typeof statsSchema>, userId: string) {
  const stats = await getCorpusStats(userId);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
    structuredContent: stats as unknown as Record<string, unknown>
  };
}

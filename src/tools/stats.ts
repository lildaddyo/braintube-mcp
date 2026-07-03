import { z } from 'zod';
import { getCorpusStats } from '../db/supabase.js';

export const statsSchema = z.object({});

export async function getStats(_input: z.infer<typeof statsSchema>, userId: string) {
  const stats = await getCorpusStats(userId);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
    structuredContent: stats as unknown as Record<string, unknown>
  };
}

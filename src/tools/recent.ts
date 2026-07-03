import { z } from 'zod';
import { getRecentVideos } from '../db/supabase.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';

export const recentSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10).describe(
    'Number of recent items to return (default 10)'
  )
});

export async function listRecent(input: z.infer<typeof recentSchema>, userId: string) {
  const items = await getRecentVideos(userId, input.limit);
  const tainted = wrapWithTaint(items as Array<{ taint_level?: number }>);
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

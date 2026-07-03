import { z } from 'zod';
import { getVideoById } from '../db/supabase.js';
import { wrapWithTaint, formatTaintedResponse } from '../security/taint.js';

export const videoSchema = z.object({
  id: z.string().describe(
    'Video ID — either the YouTube video ID (e.g. "dQw4w9WgXcQ") or the internal UUID'
  )
});

export async function getVideo(input: z.infer<typeof videoSchema>, userId: string) {
  const item = await getVideoById(input.id, userId);
  const tainted = wrapWithTaint(item as { taint_level?: number });
  return {
    content: [{ type: 'text' as const, text: formatTaintedResponse(tainted) }],
    structuredContent: tainted as unknown as Record<string, unknown>
  };
}

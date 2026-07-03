import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const retrievalQualitySchema = z.object({
  days_back: z.number().int().min(1).max(365).default(30).describe(
    'Look-back window in days (default 30)'
  ),
});

export const retrievalQualityOutputSchema = z.object({}).passthrough();

export async function retrievalQuality(
  input: z.infer<typeof retrievalQualitySchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { data, error } = await dbAdmin.rpc('retrieval_quality_report', {
    for_user_id: userId,
    days_back:   input.days_back,
  });

  if (error) throw new Error(`retrieval_quality_report RPC failed: ${error.message}`);

  const d = data as Record<string, unknown> | null;
  if (!d) return { content: [{ type: 'text' as const, text: 'No retrieval data yet.' }], structuredContent: {} };

  const lines = [
    `Retrieval Quality Report — last ${input.days_back} days`,
    '',
    ...Object.entries(d).map(([k, v]) =>
      `${k.replace(/_/g, ' ').padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`
    ),
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: d,
  };
}

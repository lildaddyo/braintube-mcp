import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const knowledgeHealthSchema = z.object({});

export const knowledgeHealthOutputSchema = z.object({
  total_items: z.number().optional(),
  missing_embeddings: z.number().optional(),
  missing_enrichment: z.number().optional(),
  missing_tags: z.number().optional(),
  orphan_items: z.number().optional(),
  stale_items_90d: z.number().optional(),
  contradictions: z.number().optional(),
  review_overdue: z.number().optional(),
  topic_gaps: z.union([z.array(z.object({ topic: z.string(), count: z.number() }).passthrough()), z.number()]).optional(),
  health_score: z.number().optional(),
}).passthrough();

export async function knowledgeHealth(_input: z.infer<typeof knowledgeHealthSchema>, userId: string) {
  const { data, error } = await dbAdmin.rpc('knowledge_health', { for_user_id: userId });

  if (error) throw new Error(`knowledge_health RPC failed: ${error.message}`);

  const h = data as {
    total_items?: number;
    missing_embeddings?: number;
    missing_enrichment?: number;
    missing_tags?: number;
    orphan_items?: number;
    stale_items_90d?: number;
    contradictions?: number;
    review_overdue?: number;
    // DB returns array of {topic, count} objects, not a scalar
    topic_gaps?: Array<{ topic: string; count: number }> | number;
    // DB returns 0–1 float
    health_score?: number;
  } | null;

  if (!h) {
    return {
      content: [{ type: 'text' as const, text: 'No health data returned.' }],
      structuredContent: {} as unknown as Record<string, unknown>
    };
  }

  // health_score is 0–1 float from DB — convert to 0–100 for display
  const score = h.health_score != null ? `${(h.health_score * 100).toFixed(1)}/100` : 'n/a';

  // topic_gaps may be an array of objects or a scalar count
  let topicGapsDisplay: string;
  if (Array.isArray(h.topic_gaps)) {
    topicGapsDisplay = h.topic_gaps.length > 0
      ? h.topic_gaps.map(g => `${g.topic} (${g.count})`).join(', ')
      : '0';
  } else {
    topicGapsDisplay = String(h.topic_gaps ?? 0);
  }

  const lines = [
    `Knowledge Health Score: ${score}`,
    ``,
    `Total items:          ${h.total_items ?? 0}`,
    `Missing embeddings:   ${h.missing_embeddings ?? 0}`,
    `Missing enrichment:   ${h.missing_enrichment ?? 0}`,
    `Missing tags:         ${h.missing_tags ?? 0}`,
    `Orphan items:         ${h.orphan_items ?? 0}`,
    `Stale (90d+):         ${h.stale_items_90d ?? 0}`,
    `Contradictions:       ${h.contradictions ?? 0}`,
    `Review overdue:       ${h.review_overdue ?? 0}`,
    `Topic gaps:           ${topicGapsDisplay}`,
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: h as unknown as Record<string, unknown>,
  };
}

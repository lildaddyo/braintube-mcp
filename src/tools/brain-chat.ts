/**
 * chat_with_brain — query a public BrainTube Brain via the brain-chat edge function.
 * list_brains     — list the authenticated user's Brains.
 */

import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

// ── chat_with_brain ───────────────────────────────────────────────────────────

export const chatWithBrainSchema = z.object({
  brain_slug:   z.string().min(1).describe('URL slug of the Brain to query (e.g. "my-ai-notes")'),
  question:     z.string().min(1).describe('The question to ask the Brain'),
  chat_history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .optional()
    .default([])
    .describe('Prior turns in the conversation for multi-turn context'),
  session_id:   z.string().optional().describe('Session ID from a previous turn — pass to continue the same conversation thread'),
});

const BRAIN_CHAT_URL = 'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/brain-chat';

export async function chatWithBrain(
  input: z.infer<typeof chatWithBrainSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const res = await fetch(BRAIN_CHAT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brain_slug:   input.brain_slug,
      question:     input.question,
      chat_history: input.chat_history ?? [],
      session_id:   input.session_id,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`brain-chat returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json() as {
    answer:     string;
    sources?:   Array<{ title: string; url?: string }>;
    session_id?: string;
  };

  const answer = data.answer ?? '';
  const sources = data.sources ?? [];

  const sourcesText = sources.length
    ? '\n\nSources:\n' + sources.map((s, i) => `${i + 1}. ${s.title}${s.url ? ' — ' + s.url : ''}`).join('\n')
    : '';

  return {
    content: [{ type: 'text' as const, text: answer + sourcesText }],
    structuredContent: data as unknown as Record<string, unknown>,
  };
}

// ── list_brains ───────────────────────────────────────────────────────────────

export const listBrainsSchema = z.object({});

export interface BrainRow {
  slug:        string;
  name:        string;
  description: string | null;
  item_count:  number;
  tier:        string;
  is_public:   boolean;
}

export async function listBrains(
  _input: z.infer<typeof listBrainsSchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { data, error } = await dbAdmin
    .from('brains')
    .select('slug, name, description, item_count, tier, is_public')
    .eq('user_id', userId)
    .order('item_count', { ascending: false });

  if (error) throw new Error(`Failed to list brains: ${error.message}`);

  const brains = (data ?? []) as BrainRow[];

  const text = brains.length === 0
    ? 'No Brains found. Create one at https://brain-tube.com.'
    : brains.map((b, i) =>
        `${i + 1}. **${b.name}** (slug: ${b.slug})\n` +
        `   ${b.description ?? 'No description'}\n` +
        `   Items: ${b.item_count} | Tier: ${b.tier} | ${b.is_public ? 'Public' : 'Private'}`
      ).join('\n\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { brains } as unknown as Record<string, unknown>,
  };
}

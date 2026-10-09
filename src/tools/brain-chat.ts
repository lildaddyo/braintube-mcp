/**
 * chat_with_brain — query a public BrainTube Brain, or one of the user's own, via the brain-chat edge function.
 * list_brains     — list the authenticated user's Brains.
 */

import { z } from 'zod';
import { dbAdmin, logMcpRetrieval } from '../db/supabase.js';
import { actingUserHeaders } from '../lib/edge-auth.js';

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

export const chatWithBrainOutputSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({
    title: z.string().optional(),
    url: z.string().optional(),
  }).passthrough()).optional(),
  session_id: z.string().optional(),
}).passthrough();

const BRAIN_CHAT_URL = 'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/brain-chat';

/**
 * Headers that tell brain-chat who is asking. brain-chat honours x-bt-acting-user only
 * when the bearer is the service-role key (constant-time compared), so a client can't
 * forge it. The acting user gets owner access to their own private/personal brains and
 * per-user visitor limits on everyone else's, instead of sharing one anonymous quota
 * keyed on Railway's egress IP.
 *
 * Metering happens exactly once, here in the MCP server: every chat_with_brain call site
 * runs assertBrainReachable, then requireFairUse('chat'), and x-bt-fair-use: counted tells
 * brain-chat to skip its own consume_fair_use for owner calls.
 */
export function brainChatHeaders(userId: string): Record<string, string> {
  return actingUserHeaders(userId, { fairUseCounted: true });
}

/**
 * Why brain-chat would refuse this caller, or null if it would serve them. Mirrors
 * brain-chat's own 404 / 403 checks so chat_with_brain can refuse BEFORE requireFairUse
 * charges the chat. brain-chat stays the authority; this only avoids billing a sure refusal.
 */
export function brainAccessError(
  brain: { user_id: string; is_public: boolean } | null,
  slug: string,
  userId: string
): string | null {
  if (!brain) return `Brain "${slug}" not found. Use list_brains to see your Brains.`;
  if (!brain.is_public && brain.user_id !== userId) return `Brain "${slug}" is private.`;
  return null;
}

/** Throws (uncharged) when brain-chat would refuse; a lookup error falls through to brain-chat. */
export async function assertBrainReachable(slug: string, userId: string): Promise<void> {
  const { data, error } = await dbAdmin
    .from('brains')
    .select('user_id, is_public')
    .eq('slug', slug)
    .maybeSingle();
  if (error) {
    console.error(`[chat_with_brain] brain lookup failed, deferring to brain-chat: ${error.message}`);
    return;
  }
  const reason = brainAccessError(data as { user_id: string; is_public: boolean } | null, slug, userId);
  if (reason) throw new Error(reason);
}

export async function chatWithBrain(
  input: z.infer<typeof chatWithBrainSchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const res = await fetch(BRAIN_CHAT_URL, {
    method:  'POST',
    headers: brainChatHeaders(userId),
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

  void logMcpRetrieval(userId, input.question, 'mcp_chat_with_brain', sources.length, []);

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

export const listBrainsOutputSchema = z.object({
  brains: z.array(z.object({
    slug: z.string(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    item_count: z.number().optional(),
    tier: z.string().optional(),
    is_public: z.boolean().optional(),
  }).passthrough()),
});

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

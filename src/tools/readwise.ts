import { z } from 'zod';
import { edgeAuthHeaders } from '../lib/edge-auth.js';

const READWISE_SYNC_URL =
  'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/readwise-sync';

// ─── connect_readwise ─────────────────────────────────────────────────────────

export const connectReadwiseSchema = z.object({
  access_token: z.string().min(20).describe(
    'Your Readwise API access token (from readwise.io/access_token)'
  ),
});

export const connectReadwiseOutputSchema = z.object({}).passthrough();

export async function connectReadwise(
  input: z.infer<typeof connectReadwiseSchema>,
  userId: string,
  userJwt?: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> }> {
  const res = await fetch(READWISE_SYNC_URL, {
    method: 'POST',
    headers: edgeAuthHeaders(userId, userJwt),
    body: JSON.stringify({ action: 'connect', access_token: input.access_token }),
  });

  const data = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
  if (!res.ok) throw new Error(`Could not connect Readwise: ${data?.error ?? res.statusText}. Check the token at readwise.io/access_token.`);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: (data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }) as Record<string, unknown>
  };
}

// ─── sync_readwise ────────────────────────────────────────────────────────────

export const syncReadwiseSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('incremental').describe(
    'Sync mode: full re-imports all highlights, incremental fetches only new ones since last sync (default: incremental)'
  ),
});

export const syncReadwiseOutputSchema = z.object({}).passthrough();

export async function syncReadwise(
  input: z.infer<typeof syncReadwiseSchema>,
  userId: string,
  userJwt?: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> }> {
  const res = await fetch(READWISE_SYNC_URL, {
    method: 'POST',
    headers: edgeAuthHeaders(userId, userJwt),
    body: JSON.stringify({ action: 'sync', mode: input.mode }),
  });

  const data = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
  if (!res.ok) {
    const reason = String(data?.error ?? res.statusText);
    if (/not connected/i.test(reason)) {
      throw new Error('Readwise is not connected for this account yet. Connect it first with connect_readwise, using the access token from readwise.io/access_token.');
    }
    throw new Error(`Readwise sync failed: ${reason}`);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: (data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }) as Record<string, unknown>
  };
}

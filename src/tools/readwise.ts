import { z } from 'zod';

const READWISE_SYNC_URL =
  'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/readwise-sync';

// ─── connect_readwise ─────────────────────────────────────────────────────────

export const connectReadwiseSchema = z.object({
  access_token: z.string().min(20).describe(
    'Your Readwise API access token (from readwise.io/access_token)'
  ),
});

export async function connectReadwise(
  input: z.infer<typeof connectReadwiseSchema>,
  userJwt: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const res = await fetch(READWISE_SYNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${userJwt}`,
      'apikey':        userJwt,
    },
    body: JSON.stringify({ action: 'connect', access_token: input.access_token }),
  });

  const data = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
  if (!res.ok) throw new Error(`connect_readwise: ${data?.error ?? res.statusText}`);

  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

// ─── sync_readwise ────────────────────────────────────────────────────────────

export const syncReadwiseSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('incremental').describe(
    'Sync mode: full re-imports all highlights, incremental fetches only new ones since last sync (default: incremental)'
  ),
});

export async function syncReadwise(
  input: z.infer<typeof syncReadwiseSchema>,
  userJwt: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const res = await fetch(READWISE_SYNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${userJwt}`,
      'apikey':        userJwt,
    },
    body: JSON.stringify({ action: 'sync', mode: input.mode }),
  });

  const data = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
  if (!res.ok) throw new Error(`sync_readwise: ${data?.error ?? res.statusText}`);

  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

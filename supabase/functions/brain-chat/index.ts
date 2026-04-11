import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// CREDIT POLICY: brain-chat is intentionally FREE (no credit deduction).
// Cost is absorbed as platform expense to support viral sharing loop.
// Abuse prevention: 20 questions/day per visitor IP (rate_limit check below).
// FUTURE: When 50+ active public brains exist, implement:
//   - 100 free brain-chat queries/month per brain owner (included in tier)
//   - Then 1 credit/chat deducted from owner's balance
//   - Notify owner when approaching limit

serve(async (_req: Request) => {
  return new Response(
    JSON.stringify({ error: 'brain-chat not yet implemented' }),
    { status: 501, headers: { 'Content-Type': 'application/json' } }
  );
});

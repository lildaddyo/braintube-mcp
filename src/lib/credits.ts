/**
 * Credit gating helpers for BrainTube MCP tools.
 *
 * Calls the `deduct_credits` Supabase RPC. The SQL function handles:
 *  - Creator bypass (creators are never charged)
 *  - Atomic decrement with insufficient-funds check
 *  - Returning { success: boolean, remaining: number, reason?: string }
 */

import { dbAdmin } from '../db/supabase.js';

export type CreditAction = 'ai_search' | 'ai_chat' | 'deep_research';

/**
 * Entitlement gate: throws a user-facing MCP error if the user has no active
 * paid subscription. Free users get 0 monthly credits — we distinguish them
 * from paid users who exhausted their balance so each gets a different message.
 *
 * Canonical source: subscriptions table (status='active'). profiles.plan_tier
 * is denormalized and can lag Stripe webhook delivery.
 */
export async function requirePaidPlan(userId: string): Promise<void> {
  const { data, error } = await dbAdmin
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[credits] subscription check error for ${userId}:`, error.message);
    // On DB error, fail open only for billing — still allow the tool call.
    // Rationale: a billing check outage should not break the product entirely.
    return;
  }

  if (!data) {
    throw new Error(
      'MCP access requires a paid BrainTube plan. Upgrade at https://brain-tube.com/pricing'
    );
  }
}

/**
 * Deduct credits for a tool call.
 * Throws a user-facing Error (which becomes an MCP error response) if the user
 * has insufficient credits. Creator bypass is handled transparently by the RPC.
 *
 * @param userId   Authenticated user's UUID
 * @param action   Credit action type: 'ai_search' (1 credit) | 'ai_chat' (2 credits)
 * @param toolName Human-readable tool name for metadata/logging
 */
export async function requireCredits(
  userId: string,
  action: CreditAction,
  toolName: string
): Promise<void> {
  const { data, error } = await dbAdmin.rpc('deduct_credits', {
    p_user_id: userId,
    p_action: action,
    p_item_id: null,
    p_metadata: { source: 'mcp', tool: toolName },
  });

  if (error) {
    console.error(`[credits] deduct_credits RPC error for ${toolName}:`, error.message);
    // RPC-level error (not a business logic failure) — treat as insufficient credits
    // to avoid silently serving requests when billing is broken.
    throw new Error(
      `Monthly query limit reached for your plan — top up or upgrade at https://brain-tube.com/pricing`
    );
  }

  const result = data as { success: boolean; remaining?: number; reason?: string } | null;

  if (!result?.success) {
    const reason = result?.reason ?? 'insufficient credits';
    console.warn(`[credits] deduct denied for ${toolName} (user=${userId}): ${reason}`);
    throw new Error(
      `Monthly query limit reached for your plan — top up or upgrade at https://brain-tube.com/pricing`
    );
  }

  console.error(
    `[credits] deducted for ${toolName} (user=${userId}, action=${action}, remaining=${result.remaining ?? '?'})`
  );
}

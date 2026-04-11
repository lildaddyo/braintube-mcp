/**
 * Credit gating helpers for BrainTube MCP tools.
 *
 * Calls the `deduct_credits` Supabase RPC. The SQL function handles:
 *  - Creator bypass (creators are never charged)
 *  - Atomic decrement with insufficient-funds check
 *  - Returning { success: boolean, remaining: number, reason?: string }
 */

import { dbAdmin } from '../db/supabase.js';

export type CreditAction = 'ai_search' | 'ai_chat';

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
      `Insufficient credits. Top up at https://brain-tube.com/credits`
    );
  }

  const result = data as { success: boolean; remaining?: number; reason?: string } | null;

  if (!result?.success) {
    const reason = result?.reason ?? 'insufficient credits';
    console.warn(`[credits] deduct denied for ${toolName} (user=${userId}): ${reason}`);
    throw new Error(
      `Insufficient credits. Top up at https://brain-tube.com/credits`
    );
  }

  console.log(
    `[credits] deducted for ${toolName} (user=${userId}, action=${action}, remaining=${result.remaining ?? '?'})`
  );
}

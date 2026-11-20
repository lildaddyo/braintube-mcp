/**
 * Credits for MCP / REST bulk_ingest (Spuck 2026-11-20, decision card):
 *   1 credit per NEW item, +1 per extra 25,000 characters (at most 4 per item).
 *   Items that update an existing item (dedup by source_url / title) are free.
 *   Free plan: 5 new items a month at no charge (fair_use_allowances metric 'mcp_ingest').
 * Charged before the insert, refunded when the insert fails.
 */
import { dbAdmin } from '../db/supabase.js';

export const INGEST_ACTION = 'mcp_ingest_item';
export const INGEST_CHARS_PER_CREDIT = 25_000;
export const INGEST_MAX_CREDITS = 4;

/** Credits one new item costs, before any free allowance. */
export function ingestItemCredits(chars: number): number {
  return Math.min(INGEST_MAX_CREDITS, Math.max(1, Math.ceil(Math.max(0, chars) / INGEST_CHARS_PER_CREDIT)));
}

export interface IngestCharge { ok: boolean; txIds: string[]; free: boolean }

/** Charges one new item. ok=false means the balance does not cover it (nothing is left charged). */
export async function chargeIngestItem(userId: string, chars: number, meta: Record<string, unknown>): Promise<IngestCharge> {
  const units = ingestItemCredits(chars);
  const { data, error } = await dbAdmin.rpc('consume_fair_use', {
    p_user_id: userId, p_metric: 'mcp_ingest', p_action: INGEST_ACTION,
    p_metadata: { source: 'mcp', tool: 'bulk_ingest', chars, ...meta },
  });
  if (error) {
    console.error('[ingest-credits] consume_fair_use error:', error.message);
    return { ok: false, txIds: [], free: false };
  }
  const r = data as { success?: boolean; charged?: boolean; transaction_id?: string } | null;
  if (!r?.success) return { ok: false, txIds: [], free: false };
  const txIds = r.transaction_id ? [r.transaction_id] : [];
  const free = r.charged === false;
  // Length surcharge applies to long items whether or not the base was inside the free allowance.
  if (units > 1) {
    const { data: d2, error: e2 } = await dbAdmin.rpc('deduct_credits_units', {
      p_user_id: userId, p_action: INGEST_ACTION, p_units: units - 1, p_item_id: null,
      p_metadata: { source: 'mcp', tool: 'bulk_ingest', chars, length_surcharge: true, ...meta },
    });
    const r2 = d2 as { success?: boolean; transaction_id?: string } | null;
    if (e2 || !r2?.success) {
      await refundIngest(txIds, 'bulk_ingest: length surcharge not covered');
      return { ok: false, txIds: [], free };
    }
    if (r2.transaction_id) txIds.push(r2.transaction_id);
  }
  return { ok: true, txIds, free };
}

export async function refundIngest(txIds: string[], reason: string): Promise<void> {
  for (const id of txIds) {
    const { error } = await dbAdmin.rpc('refund_credits', { p_transaction_id: id, p_reason: reason });
    if (error) console.error('[ingest-credits] refund error:', error.message);
  }
}

export const INGEST_NO_CREDITS_MSG =
  'not saved: not enough credits. Top up or upgrade at https://brain-tube.com/pricing';

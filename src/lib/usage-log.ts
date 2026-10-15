import { AsyncLocalStorage } from 'node:async_hooks';
import { dbAdmin } from '../db/supabase.js';

/**
 * Cost rows for the OpenAI calls this server makes directly (embeddings, query translation),
 * written to the BrainTube api_usage_logs table like the edge functions do, so MCP spend shows
 * up in the same cost views. Prices match dark-n-cozy supabase/functions/_shared/api-prices.ts
 * (PRICES_AS_OF below); keep the two in step.
 *
 * Only real provider calls are logged: callers log inside the ttl-cache compute step, so a
 * cache hit writes nothing. Logging is fire-and-forget and never throws into the caller.
 */

export const PRICES_AS_OF = '2026-10-09';

// $ per 1K tokens, as in api-prices.ts.
const PRICES: Record<string, { input: number; output: number }> = {
  'text-embedding-3-small': { input: 0.00002, output: 0 },
  'text-embedding-3-large': { input: 0.00013, output: 0 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
};

export function costCents(model: string, inputTokens: number, outputTokens = 0): number {
  const p = PRICES[model.replace(/^openai\//, '')];
  if (!p) return 0;
  const cents = ((inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output) * 100;
  // 4 decimals of a cent, matching the column.
  return Math.round(cents * 10000) / 10000;
}

export interface UsageContext {
  userId?: string;
  /** MCP tool or REST route name; becomes the endpoint after 'mcp/'. */
  tool: string;
}

const store = new AsyncLocalStorage<UsageContext>();

/** Runs fn with the caller's user and tool attached to any cost row written inside it. */
export function withUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export interface UsageRow {
  model: string;
  inputTokens: number;
  outputTokens?: number;
  latencyMs: number;
  status: number;
  metadata?: Record<string, unknown>;
}

export function buildUsageRow(row: UsageRow, ctx: UsageContext | undefined) {
  const outputTokens = row.outputTokens ?? 0;
  return {
    api_name: row.model,
    endpoint: `mcp/${ctx?.tool ?? 'unknown'}`,
    user_id: ctx?.userId ?? null,
    tokens_used: row.inputTokens + outputTokens || null,
    cost_cents: row.status >= 400 || row.status === 0 ? 0 : costCents(row.model, row.inputTokens, outputTokens),
    response_status: row.status,
    latency_ms: row.latencyMs,
    // provider is a generated column (from api_name); writing it fails the insert.
    metadata: {
      ...row.metadata,
      input_tokens: row.inputTokens,
      output_tokens: outputTokens,
      source: 'mcp',
      prices_as_of: PRICES_AS_OF,
    },
  };
}

/** Fire-and-forget insert of one cost row. Kill switch: MCP_USAGE_LOG=off. */
export function logOpenAiUsage(row: UsageRow): void {
  if (process.env.MCP_USAGE_LOG === 'off') return;
  try {
    const record = buildUsageRow(row, store.getStore());
    void Promise.resolve(dbAdmin.from('api_usage_logs').insert(record)).then(
      ({ error }) => { if (error) console.error('[usage-log] insert failed:', error.message); },
      (err) => console.error('[usage-log] insert failed:', err instanceof Error ? err.message : err),
    );
  } catch (err) {
    console.error('[usage-log] skipped:', err instanceof Error ? err.message : err);
  }
}

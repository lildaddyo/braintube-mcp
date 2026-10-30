/**
 * Outbound-call budgets (F6). Before 3.15.5 several calls had no timeout at all (GoTrue, Anthropic,
 * readwise-sync) and the OpenAI embedding clients used the SDK default of 600 s x 3 attempts, so a
 * provider brownout piled requests up until memory or sockets ran out.
 *
 * Each value sits well above that call's normal latency; the point is to bound a hung call, not to
 * cut a slow-but-healthy one. Calls that already had a budget (translation 4 s, jev-rerank 2.5 s,
 * search sub-RPCs 1.5-2.5 s, obsidian-search 8 s, compile/export 60 s, session-ingest embeddings
 * 60 s) keep theirs.
 */
export const TIMEOUTS = {
  /** One query-sized embedding (search, ingest of one item). Normally 0.2-1 s. */
  openAiEmbedMs: 15_000,
  /** A batch of up to 50 inputs of 8000 chars. Normally a few seconds. */
  openAiEmbedBatchMs: 30_000,
  /** One retry on 408/429/5xx/connection errors instead of the SDK's two. */
  openAiMaxRetries: 1,
  /** GoTrue GET /auth/v1/user on every authenticated request. Normally < 300 ms. */
  supabaseAuthUserMs: 5_000,
  /** api_keys lookup for bt_ keys (one indexed SELECT). */
  apiKeyLookupMs: 5_000,
  /** GoTrue /token (password, PKCE, refresh) from the OAuth routes. Normally < 1 s. */
  supabaseTokenMs: 10_000,
  /** Anthropic Haiku summary of up to 50k chars, 400 output tokens. Normally 3-10 s. */
  anthropicSummaryMs: 45_000,
  /** brain-chat edge function (retrieval + LLM answer, JSON response). p95 about 17 s today. */
  brainChatMs: 60_000,
  /** readwise-sync connect (validates the token against Readwise). */
  readwiseConnectMs: 30_000,
  /** readwise-sync sync; a full re-import can run long, so this matches the edge runtime's 150 s request idle timeout. */
  readwiseSyncMs: 150_000,
} as const;

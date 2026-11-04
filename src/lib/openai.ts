import OpenAI from 'openai';
import { embeddingCache, translationCache, normaliseQuery, hashKey } from './ttl-cache.js';
import { logOpenAiUsage, currentUsageContext } from './usage-log.js';
import { TIMEOUTS } from './timeouts.js';

/**
 * D-211 (2026-11-04): embeddings and query translation go through the app's `mcp-ai` edge function
 * on the app's OpenAI key, so this server holds no OpenAI key of its own. Railway's key died on
 * 11-02 (429, then revoked) and every search silently fell back to keyword-only for two days.
 * The edge function writes the cost row (endpoint mcp/<tool>, acting user). OPENAI_VIA_APP=off
 * calls OpenAI directly with OPENAI_API_KEY again.
 */
export function viaApp(): boolean {
  return process.env.OPENAI_VIA_APP !== 'off' && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function appAi<T>(body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const ctx = currentUsageContext();
  // Pinned next to the database and the function's own OpenAI calls (eu-west-1).
  const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/mcp-ai?forceFunctionRegion=eu-west-1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ ...body, tool: ctx?.tool, user_id: ctx?.userId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(`mcp-ai ${res.status}: ${json?.error ?? 'no body'}`.slice(0, 300));
  return json;
}

async function appEmbed(texts: string[], timeoutMs: number): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const { embeddings } = await appAi<{ embeddings: (number[] | null)[] }>({ mode: 'embed', texts: texts.slice(i, i + 100) }, timeoutMs);
    for (const v of embeddings ?? []) {
      if (!Array.isArray(v) || v.length !== EMBED_DIMS) throw new Error(`mcp-ai: bad embedding (${Array.isArray(v) ? v.length : 'none'})`);
      out.push(v);
    }
  }
  if (out.length !== texts.length) throw new Error(`mcp-ai: ${out.length} embeddings for ${texts.length} texts`);
  return out;
}

/**
 * OpenAI client for embeddings with a bounded budget (F6): the SDK default is 600 s and 2 retries,
 * so a hung request could hold a search for half an hour. Built per call, so the server still
 * boots without OPENAI_API_KEY.
 */
export function embeddingClient(timeoutMs: number = TIMEOUTS.openAiEmbedMs): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: timeoutMs, maxRetries: TIMEOUTS.openAiMaxRetries });
}

// Texts up to this length are query-sized and get memoised; longer ones (item bodies at ingest) rarely repeat.
const CACHEABLE_EMBED_CHARS = 2000;

/** Embedding model for every vector the server writes or queries with (same as the app's _shared/embedding-v2.ts). */
export const EMBED_MODEL = 'text-embedding-3-large';
/** Stored in halfvec(1536) `*_v2` columns; the search SQL routes 1536-d queries to them. */
export const EMBED_DIMS = 1536;

/**
 * Embed text with text-embedding-3-large @1536 (input cut to 8000 chars).
 * There is deliberately no model or dimensions parameter: a query and the documents it is
 * compared with must come from the same model, and the search functions pick the column by
 * the vector's length. (Until 2026-10-16 this was 3-small, @768 for search, 1536 for items.embedding.)
 * Client is instantiated on demand so the server starts cleanly without OPENAI_API_KEY.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (text.length > CACHEABLE_EMBED_CHARS) return embedUncached(text);
  const key = hashKey(EMBED_MODEL, String(EMBED_DIMS), normaliseQuery(text));
  const vec = await embeddingCache.getOrCompute(key, async () => Float32Array.from(await embedUncached(text)));
  return Array.from(vec);
}

/** Embed many texts in one request (order kept). */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (viaApp()) return appEmbed(texts.map((t) => t.slice(0, 8000)), TIMEOUTS.openAiEmbedBatchMs);
  const openai = embeddingClient(TIMEOUTS.openAiEmbedBatchMs);
  const t0 = Date.now();
  try {
    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts.map((t) => t.slice(0, 8000)), dimensions: EMBED_DIMS });
    logOpenAiUsage({ model: `openai/${EMBED_MODEL}`, inputTokens: res.usage?.prompt_tokens ?? 0, latencyMs: Date.now() - t0, status: 200, metadata: { kind: 'embedding', dimensions: EMBED_DIMS, inputs: texts.length } });
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (err) {
    logOpenAiUsage({ model: `openai/${EMBED_MODEL}`, inputTokens: 0, latencyMs: Date.now() - t0, status: (err as { status?: number })?.status ?? 0, metadata: { kind: 'embedding', failed: true } });
    throw err;
  }
}

async function embedUncached(text: string): Promise<number[]> {
  if (viaApp()) return (await appEmbed([text.slice(0, 8000)], TIMEOUTS.openAiEmbedMs))[0];
  const openai = embeddingClient();
  const t0 = Date.now();
  // Logged here, inside the cache's compute step, so a cache hit writes no cost row.
  try {
    const response = await openai.embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 8000), dimensions: EMBED_DIMS });
    logOpenAiUsage({ model: `openai/${EMBED_MODEL}`, inputTokens: response.usage?.prompt_tokens ?? 0, latencyMs: Date.now() - t0, status: 200, metadata: { kind: 'embedding', dimensions: EMBED_DIMS } });
    return response.data[0].embedding;
  } catch (err) {
    logOpenAiUsage({ model: `openai/${EMBED_MODEL}`, inputTokens: 0, latencyMs: Date.now() - t0, status: (err as { status?: number })?.status ?? 0, metadata: { kind: 'embedding', failed: true } });
    throw err;
  }
}

/**
 * Query translation model (2026-11-02, was gpt-4o-mini, which OpenAI shuts down 2027-01-14).
 * Timed on 20 real Korean queries x 3: p50 865 ms, max 1.15 s against the 4 s budget (4o-mini 621 / 938 ms),
 * translations equal or better, and cheaper ($0.10 / $0.50 per M).
 */
export const TRANSLATE_MODEL = 'gpt-6-luna';

/**
 * gpt-6 models reject max_tokens, and temperature unless reasoning_effort is 'none' (a 400, so
 * every search would silently lose its translation); other efforts also spend ~60 reasoning tokens
 * of the 120 cap. Temperature 0 keeps a query's translation stable across cache misses.
 * gpt-4* keeps the old shape so QUERY_TRANSLATE_MODEL can still roll back.
 */
export function translationParams(model: string) {
  return model.startsWith('gpt-4')
    ? { temperature: 0, max_tokens: 120 }
    : { temperature: 0, max_completion_tokens: 120, reasoning_effort: 'none' as const };
}

/**
 * Translate a non-English search query to English for cross-lingual retrieval.
 * Items are embedded/indexed mostly in English and full-text uses the 'english'
 * config, so a Cyrillic query gets zero keyword hits and a weaker semantic match.
 * Returns null on any failure — callers must fall back to the original query.
 */
export async function translateQueryToEnglish(text: string): Promise<string | null> {
  const model = process.env.QUERY_TRANSLATE_MODEL ?? TRANSLATE_MODEL;
  // null (failure) is never stored, so a transient OpenAI error is retried on the next search.
  return translationCache.getOrCompute(hashKey(model, normaliseQuery(text)), () => translateUncached(text, model));
}

async function translateUncached(text: string, model: string): Promise<string | null> {
  try {
    // The app's function translates with gpt-6-luna; the edge hop adds ~0.1-0.2 s to the 4 s budget.
    if (viaApp()) return (await appAi<{ text: string | null }>({ mode: 'translate', text: text.slice(0, 500) }, 5000)).text ?? null;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 4000, maxRetries: 0 });
    const t0 = Date.now();
    const res = await openai.chat.completions.create({
      model,
      ...translationParams(model),
      messages: [
        { role: 'system', content: 'Translate the user\'s search query into English. Keep technical terms, names and English words unchanged. Output only the translated query, nothing else.' },
        { role: 'user', content: text.slice(0, 500) },
      ],
    });
    logOpenAiUsage({ model, inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0, latencyMs: Date.now() - t0, status: 200, metadata: { kind: 'query_translation' } });
    const out = res.choices[0]?.message?.content?.trim();
    return out && out.length > 0 ? out : null;
  } catch (err) {
    console.error('[translateQueryToEnglish] failed (non-fatal):', err);
    return null;
  }
}

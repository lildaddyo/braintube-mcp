import OpenAI from 'openai';
import { embeddingCache, translationCache, normaliseQuery, hashKey } from './ttl-cache.js';
import { logOpenAiUsage } from './usage-log.js';

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
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
 * Translate a non-English search query to English for cross-lingual retrieval.
 * Items are embedded/indexed mostly in English and full-text uses the 'english'
 * config, so a Cyrillic query gets zero keyword hits and a weaker semantic match.
 * Returns null on any failure — callers must fall back to the original query.
 */
export async function translateQueryToEnglish(text: string): Promise<string | null> {
  const model = process.env.QUERY_TRANSLATE_MODEL ?? 'gpt-4o-mini';
  // null (failure) is never stored, so a transient OpenAI error is retried on the next search.
  return translationCache.getOrCompute(hashKey(model, normaliseQuery(text)), () => translateUncached(text, model));
}

async function translateUncached(text: string, model: string): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 4000, maxRetries: 0 });
    const t0 = Date.now();
    const res = await openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 120,
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

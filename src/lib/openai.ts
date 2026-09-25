import OpenAI from 'openai';

/**
 * Generate a text embedding via OpenAI.
 * model defaults to text-embedding-3-small.
 * Input is sliced to 8000 chars to stay within token limits.
 * Client is instantiated on demand so the server starts cleanly without OPENAI_API_KEY.
 *
 * @param text       Text to embed.
 * @param dimensions Optional output dimensions (text-embedding-3-* only).
 *                   Pass 768 when calling hybrid_search (halfvec(768) column).
 *                   Omit / pass undefined for the default 1536-dim output used
 *                   by search_knowledge_semantic and the items embedding column.
 */
export async function generateEmbedding(text: string, dimensions?: number): Promise<number[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const input = text.slice(0, 8000);
  const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const response = await openai.embeddings.create({
    model,
    input,
    ...(dimensions !== undefined ? { dimensions } : {}),
  });
  return response.data[0].embedding;
}

/**
 * Translate a non-English search query to English for cross-lingual retrieval.
 * Items are embedded/indexed mostly in English and full-text uses the 'english'
 * config, so a Cyrillic query gets zero keyword hits and a weaker semantic match.
 * Returns null on any failure — callers must fall back to the original query.
 */
export async function translateQueryToEnglish(text: string): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 4000, maxRetries: 0 });
    const res = await openai.chat.completions.create({
      model: process.env.QUERY_TRANSLATE_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Translate the user\'s search query into English. Keep technical terms, names and English words unchanged. Output only the translated query, nothing else.' },
        { role: 'user', content: text.slice(0, 500) },
      ],
    });
    const out = res.choices[0]?.message?.content?.trim();
    return out && out.length > 0 ? out : null;
  } catch (err) {
    console.error('[translateQueryToEnglish] failed (non-fatal):', err);
    return null;
  }
}

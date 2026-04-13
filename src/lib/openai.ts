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

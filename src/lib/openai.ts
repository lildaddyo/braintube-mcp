import OpenAI from 'openai';

/**
 * Generate a text embedding via OpenAI.
 * model defaults to text-embedding-3-small (1536 dims — matches items.embedding vector type).
 * Input is sliced to 8000 chars to stay within token limits.
 * Client is instantiated on demand so the server starts cleanly without OPENAI_API_KEY.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const input = text.slice(0, 8000);
  const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const response = await openai.embeddings.create({ model, input });
  return response.data[0].embedding;
}

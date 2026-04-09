/**
 * Shared embedding utility — generates text embeddings via OpenAI's API.
 * Uses text-embedding-3-small (768 dimensions) to match our vector column.
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 768;

export interface EmbeddingResult {
  text: string;
  embedding: number[];
}

/**
 * Generate embeddings for one or more texts in a single batch call.
 * OpenAI supports up to 2048 inputs per request.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  if (texts.length === 0) return [];

  // Batch in groups of 100 to stay safe
  const batchSize = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[embeddings] OpenAI error ${response.status}:`, errText);
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json();
    const embeddings = data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);

    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}

/**
 * Generate a single embedding for a query string.
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([query]);
  return embedding;
}

/**
 * Smart chunking: merge small consecutive segments into optimal chunks
 * for embedding. Targets ~500 tokens per chunk for best retrieval quality.
 */
export function chunkSegments(
  segments: { text: string; start_time_sec: number; end_time_sec: number; segment_index: number }[],
  targetTokens = 500
): { text: string; startTimeSec: number; endTimeSec: number; segmentIndices: number[] }[] {
  if (segments.length === 0) return [];

  const chunks: { text: string; startTimeSec: number; endTimeSec: number; segmentIndices: number[] }[] = [];
  let currentText = "";
  let currentStart = segments[0].start_time_sec;
  let currentEnd = segments[0].end_time_sec;
  let currentIndices: number[] = [];

  for (const seg of segments) {
    const segTokens = Math.ceil(seg.text.split(/\s+/).length * 1.3);
    const currentTokens = Math.ceil(currentText.split(/\s+/).length * 1.3);

    if (currentText && currentTokens + segTokens > targetTokens) {
      // Flush current chunk
      chunks.push({
        text: currentText.trim(),
        startTimeSec: currentStart,
        endTimeSec: currentEnd,
        segmentIndices: [...currentIndices],
      });
      currentText = seg.text;
      currentStart = seg.start_time_sec;
      currentEnd = seg.end_time_sec;
      currentIndices = [seg.segment_index];
    } else {
      currentText += " " + seg.text;
      currentEnd = seg.end_time_sec;
      currentIndices.push(seg.segment_index);
    }
  }

  // Flush remaining
  if (currentText.trim()) {
    chunks.push({
      text: currentText.trim(),
      startTimeSec: currentStart,
      endTimeSec: currentEnd,
      segmentIndices: [...currentIndices],
    });
  }

  return chunks;
}

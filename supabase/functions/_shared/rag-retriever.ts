/**
 * Shared RAG retriever — performs hybrid vector + keyword search
 * and returns ranked, deduplicated context chunks with citations.
 */

import { generateQueryEmbedding } from "./embeddings.ts";

export interface RetrievedChunk {
  segmentId: string;
  itemId: string;
  text: string;
  startTimeSec: number;
  endTimeSec: number;
  title: string | null;
  channel: string | null;
  thumbnailUrl: string | null;
  score: number;
  scoreType: "hybrid" | "vector" | "text";
}

export interface RAGContext {
  chunks: RetrievedChunk[];
  contextText: string;
  totalTokens: number;
}

/**
 * Retrieve relevant context for a user query using hybrid search.
 * Combines vector similarity with full-text search for best recall.
 *
 * @param supabase - Service-role Supabase client
 * @param userId - Authenticated user ID
 * @param query - User's natural language query
 * @param opts - Configuration options
 */
export async function retrieveContext(
  supabase: any,
  userId: string,
  query: string,
  opts: {
    limit?: number;
    itemId?: string; // Restrict to a single item
    itemIds?: string[]; // Restrict to a set of items (collection)
    maxTokens?: number; // Max context tokens to return
    minScore?: number; // Minimum relevance threshold
  } = {}
): Promise<RAGContext> {
  const {
    limit = 15,
    itemId,
    maxTokens = 6000,
    minScore = 0.3,
  } = opts;

  // Generate query embedding
  const queryEmbedding = await generateQueryEmbedding(query);

  // Use the appropriate RPC for single-item or cross-library search
  const rpcName = itemId ? "search_segments_for_item" : "search_segments";
  const rpcParams: any = {
    p_user_id: userId,
    p_query: query,
    p_query_embedding: JSON.stringify(queryEmbedding),
    p_limit: limit,
  };
  if (itemId) rpcParams.p_item_id = itemId;

  const { data: results, error } = await supabase.rpc(rpcName, rpcParams);

  if (error) {
    console.error("[rag-retriever] Search error:", error);
    return { chunks: [], contextText: "", totalTokens: 0 };
  }

  // Filter by minimum score and map to chunks
  const chunks: RetrievedChunk[] = (results || [])
    .filter((r: any) => r.combined_score >= minScore)
    .map((r: any) => ({
      segmentId: r.segment_id,
      itemId: r.item_id,
      text: r.segment_text,
      startTimeSec: parseFloat(r.start_time_sec),
      endTimeSec: parseFloat(r.end_time_sec),
      title: r.title,
      channel: r.channel,
      thumbnailUrl: r.thumbnail_url,
      score: r.combined_score,
      scoreType: r.vector_score > r.text_score ? "vector" : r.text_score > r.vector_score ? "text" : "hybrid",
    }));

  // Build context string within token budget
  let totalTokens = 0;
  const includedChunks: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    const chunkTokens = Math.ceil(chunk.text.split(/\s+/).length * 1.3);
    if (totalTokens + chunkTokens > maxTokens) break;
    totalTokens += chunkTokens;
    includedChunks.push(chunk);
  }

  // Format context with citations
  const contextText = formatContext(includedChunks);

  return { chunks: includedChunks, contextText, totalTokens };
}

/**
 * Format retrieved chunks into a structured context block with citations.
 */
function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";

  // Group by item for cleaner context
  const byItem = new Map<string, RetrievedChunk[]>();
  for (const chunk of chunks) {
    const list = byItem.get(chunk.itemId) || [];
    list.push(chunk);
    byItem.set(chunk.itemId, list);
  }

  const sections: string[] = [];
  let sourceIndex = 1;

  for (const [_itemId, itemChunks] of byItem.entries()) {
    const first = itemChunks[0];
    const header = `📹 Source ${sourceIndex}: "${first.title || "Untitled"}" by ${first.channel || "Unknown"}`;

    // Sort chunks by timestamp
    itemChunks.sort((a, b) => a.startTimeSec - b.startTimeSec);

    const excerpts = itemChunks.map((c) => {
      const ts = formatTimestamp(c.startTimeSec);
      return `[${ts}] ${c.text}`;
    });

    sections.push(`${header}\n${excerpts.join("\n")}`);
    sourceIndex++;
  }

  return sections.join("\n\n---\n\n");
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Descriptions of the overlapping retrieval tools, shared by server.ts and the
 * server card. Each says when to use the tool and when to pick another one,
 * so a model choosing between six search-like tools does not guess.
 */

export const RETRIEVAL_DESCRIPTIONS = {
  search:
    'Search your saved BrainTube library (videos, articles, posts, notes). Returns matching item ids, titles and source URLs; pass an id to fetch for the full text. Use it for a quick lookup, or when your client works with search + fetch. For ranked results with snippets, tags and filters use search_knowledge. Video results carry `moments` ({ t, url, quote }) whose url opens the video at the matching second: cite those timestamp links when answering from a video.',
  search_knowledge:
    'The main search over your saved BrainTube knowledge: YouTube, web, Instagram, LinkedIn, GitHub, X, notes, PDFs and more. Hybrid ranking (semantic + keyword, reciprocal-rank fusion); non-Latin queries are also searched in English. Use it first for most questions about what you have saved. Use search_by_date_range instead when the user names a time window, deep_search when the answer needs ideas connected across several items. Video results carry `moments` ({ t, url, quote }): cite the moment url, which opens the video at the matching second. Returns taint warnings.',
  deep_search:
    'Multi-hop search: runs a normal search, then follows the knowledge graph from the top 3 results up to max_hops deep to surface connected items a flat search misses. Returns direct_results + graph_connected + total_nodes_explored. Use it for research questions that span several saved items or topics. It spends credits and is slower, so for a plain lookup use search_knowledge.',
  search_by_date_range:
    'Search only the items saved between two dates (ISO 8601 `after` and `before`). Use it when the user names a time window ("what did I save in March", "during the launch week"). Without a time window use search_knowledge; to just list the latest saves use list_recent.',
  search_by_source:
    'Search only one source type: "youtube", "instagram", "web", "notion", "linkedin", "twitter", "github", "reddit", "pdf", "note", etc. Semantic with keyword fallback. Use it when the user limits the search to where the content came from ("in my YouTube saves"). Otherwise use search_knowledge, which covers every source.',
  chat_with_brain:
    'Ask a question to a BrainTube Brain (a curated knowledge base built from someone\'s corpus) and get a written answer with source citations: any public Brain, or one of your own, including private and personal Brains listed by list_brains. Pass the brain_slug (visible in the Brain\'s URL), your question, and optionally prior chat_history for multi-turn conversations. Use it only when the user names a Brain or wants an answer from one. To search your own library use search_knowledge: it is faster and spends no chat credits.',
} as const;

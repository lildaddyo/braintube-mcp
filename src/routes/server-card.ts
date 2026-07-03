/**
 * GET /.well-known/mcp/server-card.json
 *
 * Smithery server card — lets Smithery populate the listing without doing a
 * live MCP scan (which hangs when the server advertises OAuth discovery docs).
 *
 * The tools array is built from the same Zod schemas (and the same annotation
 * literals) used at runtime in server.ts, so it stays accurate without manual
 * maintenance. Run `scripts/verify-server-card-parity.ts` after touching either
 * file to confirm the two surfaces haven't drifted apart.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { searchSchema, searchKnowledgeOutputSchema } from '../tools/search.js';
import { videoSchema, getVideoOutputSchema } from '../tools/video.js';
import { recentSchema, listRecentOutputSchema } from '../tools/recent.js';
import { statsSchema, getStatsOutputSchema } from '../tools/stats.js';
import { noteSchema, addNoteOutputSchema } from '../tools/note.js';
import { backfillEmbeddingsOutputSchema } from '../tools/embedding.js';
import { ingestContentSchema, ingestContentOutputSchema } from '../tools/ingest.js';
import { bulkIngestSchema, bulkIngestOutputSchema } from '../tools/bulk-ingest.js';
import { relatedSchema, getRelatedOutputSchema } from '../tools/related.js';
import { searchBySourceSchema, searchBySourceOutputSchema } from '../tools/search-by-source.js';
import { tagItemSchema, tagItemOutputSchema } from '../tools/tag-item.js';
import { resurfaceSchema, randomResurfaceOutputSchema } from '../tools/resurface.js';
import { searchByDateSchema, searchByDateOutputSchema } from '../tools/search-by-date.js';
import { recentConversationsSchema, getRecentConversationsOutputSchema } from '../tools/recent-conversations.js';
import { expertiseProfileSchema, getExpertiseProfileOutputSchema } from '../tools/expertise-profile.js';
import { sessionBriefSchema, getSessionBriefOutputSchema } from '../tools/session-brief.js';
import { listBookmarksSchema, listBookmarksOutputSchema, toggleBookmarkSchema, toggleBookmarkOutputSchema } from '../tools/bookmarks.js';
import { searchObsidianSchema, searchObsidianOutputSchema } from '../tools/obsidian-search.js';
import { chatWithBrainSchema, chatWithBrainOutputSchema, listBrainsSchema, listBrainsOutputSchema } from '../tools/brain-chat.js';
import { knowledgeGraphSchema, getKnowledgeGraphOutputSchema } from '../tools/knowledge-graph.js';
import { knowledgeHealthSchema, knowledgeHealthOutputSchema } from '../tools/knowledge-health.js';
import { knowledgeIndexSchema, getKnowledgeIndexOutputSchema } from '../tools/knowledge-index.js';
import { compileKnowledgeSchema, compileKnowledgeOutputSchema, getConceptArticlesSchema, getConceptArticlesOutputSchema } from '../tools/concept-articles.js';
import { exportCorpusSchema, exportCorpusOutputSchema } from '../tools/export-corpus.js';
import {
  tagCooccurrenceSchema, tagCooccurrenceOutputSchema,
  entityCooccurrenceSchema, entityCooccurrenceOutputSchema,
  detectGapsSchema, detectGapsOutputSchema,
  mostRetrievedSchema, mostRetrievedOutputSchema,
} from '../tools/analytics.js';
import { exportClaudeMdSchema, exportClaudeMdOutputSchema } from '../tools/claude-md.js';
import { recomputeSalienceSchema, recomputeSalienceOutputSchema } from '../tools/salience.js';
import { deepSearchSchema, deepSearchOutputSchema } from '../tools/deep-search.js';
import { retrievalQualitySchema, retrievalQualityOutputSchema } from '../tools/retrieval-quality.js';
import { edgeHistorySchema, getEdgeHistoryOutputSchema } from '../tools/edge-history.js';
import { findPathSchema, findPathOutputSchema } from '../tools/path.js';
import { computeCentralitySchema, computeCentralityOutputSchema } from '../tools/centrality.js';
import {
  securityDashboardSchema, securityDashboardOutputSchema,
  acknowledgeAlertSchema, acknowledgeSecurityAlertOutputSchema,
  suppressAlertSchema, suppressAlertTypeOutputSchema,
} from '../tools/security-admin.js';
import {
  firewallStatusSchema, firewallStatusOutputSchema,
  firewallPromoteCheckSchema, firewallPromoteCheckOutputSchema,
  firewallUpdateThresholdSchema, firewallUpdateThresholdOutputSchema,
  firewallRollbackRulesSchema, firewallRollbackRulesOutputSchema,
  firewallRuleHistorySchema, firewallRuleHistoryOutputSchema,
} from '../tools/firewall-admin.js';
import { connectReadwiseSchema, connectReadwiseOutputSchema, syncReadwiseSchema, syncReadwiseOutputSchema } from '../tools/readwise.js';
import {
  ingestNotionPageSchema, ingestNotionPageOutputSchema,
  ingestNotionDatabaseSchema, ingestNotionDatabaseOutputSchema,
  setNotionApiKeySchema, setNotionApiKeyOutputSchema,
} from '../tools/notion-schemas.js';
function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
}

// Deliberately NOT unioned with shortCircuitEnvelopeSchema — see
// src/security/tool-envelope.ts for why a top-level union breaks the MCP
// SDK's runtime output validation (incident: commit 0cbcf01). This must
// match exactly what's registered at runtime in server.ts.
function toOutputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
}

// generate_api_key has no backing src/tools/ file (same as its inputSchema below,
// which is also duplicated as a literal rather than imported) — mirrors
// generateApiKeyOutputSchema defined inline in src/server.ts.
const generateApiKeyOutputSchema = z.object({
  key: z.string(),
  label: z.string().nullable(),
});

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Full-text search over your personal BrainTube knowledge corpus. Searches across YouTube, Instagram, web, LinkedIn, GitHub, Twitter and more.',
    inputSchema: toInputSchema(searchSchema),
    outputSchema: toOutputSchema(searchKnowledgeOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_video',
    description: 'Get full details for a specific saved item including transcript, description, summary, key takeaways. Pass YouTube video ID or internal UUID.',
    inputSchema: toInputSchema(videoSchema),
    outputSchema: toOutputSchema(getVideoOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_recent',
    description: 'List your most recently saved items across all source types.',
    inputSchema: toInputSchema(recentSchema),
    outputSchema: toOutputSchema(listRecentOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_stats',
    description: 'Get your personal corpus statistics: total items saved, breakdown by source type, taint distribution.',
    inputSchema: toInputSchema(statsSchema),
    outputSchema: toOutputSchema(getStatsOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_related',
    description: 'Find items semantically similar to a given item using vector similarity.',
    inputSchema: toInputSchema(relatedSchema),
    outputSchema: toOutputSchema(getRelatedOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_by_source',
    description: 'Search your corpus filtered to a specific source type (youtube, web, notion, twitter, pdf, etc).',
    inputSchema: toInputSchema(searchBySourceSchema),
    outputSchema: toOutputSchema(searchBySourceOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_by_date_range',
    description: 'Semantic search scoped to items saved between two dates.',
    inputSchema: toInputSchema(searchByDateSchema),
    outputSchema: toOutputSchema(searchByDateOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tag_item',
    description: 'Add or remove tags on a saved item.',
    inputSchema: toInputSchema(tagItemSchema),
    outputSchema: toOutputSchema(tagItemOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'list_bookmarks',
    description: 'List saved bookmarks from your corpus. Filter by read/unread status.',
    inputSchema: toInputSchema(listBookmarksSchema),
    outputSchema: toOutputSchema(listBookmarksOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'toggle_bookmark',
    description: 'Bookmark an item, remove a bookmark, or toggle its read/unread state.',
    inputSchema: toInputSchema(toggleBookmarkSchema),
    outputSchema: toOutputSchema(toggleBookmarkOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'connect_readwise',
    description: 'Connect your Readwise account to BrainTube by saving your Readwise API token.',
    inputSchema: toInputSchema(connectReadwiseSchema),
    outputSchema: toOutputSchema(connectReadwiseOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'sync_readwise',
    description: 'Import highlights from your Readwise library into your BrainTube corpus.',
    inputSchema: toInputSchema(syncReadwiseSchema),
    outputSchema: toOutputSchema(syncReadwiseOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'ingest_notion_page',
    description: 'Ingest a single Notion page into your BrainTube corpus.',
    inputSchema: toInputSchema(ingestNotionPageSchema),
    outputSchema: toOutputSchema(ingestNotionPageOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'add_note',
    description: 'Write a note or AI-generated synthesis back to a specific item in your corpus.',
    inputSchema: toInputSchema(noteSchema),
    outputSchema: toOutputSchema(addNoteOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_recent_conversations',
    description: 'Retrieve your most recently saved Claude and ChatGPT conversations.',
    inputSchema: toInputSchema(recentConversationsSchema),
    outputSchema: toOutputSchema(getRecentConversationsOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_expertise_profile',
    description: 'Analyse your corpus to build a knowledge expertise profile — expert, intermediate, surface, and blind spots by topic.',
    inputSchema: toInputSchema(expertiseProfileSchema),
    outputSchema: toOutputSchema(getExpertiseProfileOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_session_brief',
    description: 'One-shot session bootstrap: expertise profile, last 5 AI conversations, and corpus stats in a single call.',
    inputSchema: toInputSchema(sessionBriefSchema),
    outputSchema: toOutputSchema(getSessionBriefOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'ingest_content',
    description: 'Ingest a single piece of content (note, article, document, etc.) into your BrainTube corpus.',
    inputSchema: toInputSchema(ingestContentSchema),
    outputSchema: toOutputSchema(ingestContentOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'bulk_ingest',
    description: 'Ingest up to 50 items in a single call with dedup and embedding.',
    inputSchema: toInputSchema(bulkIngestSchema),
    outputSchema: toOutputSchema(bulkIngestOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'random_resurface',
    description: 'Surface forgotten items from your corpus using weighted randomness.',
    inputSchema: toInputSchema(resurfaceSchema),
    outputSchema: toOutputSchema(randomResurfaceOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'ingest_notion_database',
    description: 'Ingest all pages from a Notion database into your BrainTube corpus.',
    inputSchema: toInputSchema(ingestNotionDatabaseSchema),
    outputSchema: toOutputSchema(ingestNotionDatabaseOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'set_notion_api_key',
    description: 'Save your Notion integration API key for ingest_notion_page and ingest_notion_database.',
    inputSchema: toInputSchema(setNotionApiKeySchema),
    outputSchema: toOutputSchema(setNotionApiKeyOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'backfill_embeddings',
    description: 'Generate vector embeddings for all items that are missing them. Required before semantic search.',
    inputSchema: toInputSchema(z.object({})),
    outputSchema: toOutputSchema(backfillEmbeddingsOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'generate_api_key',
    description: 'Generate a personal API key for Obsidian Sync CLI or other integrations. Key shown once only.',
    inputSchema: toInputSchema(z.object({
      label: z.string().optional().describe('Human-readable label (e.g. "Obsidian MacBook")'),
    })),
    outputSchema: toOutputSchema(generateApiKeyOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'search_obsidian',
    description: 'Search your local Obsidian vault via the Obsidian Local REST API plugin.',
    inputSchema: toInputSchema(searchObsidianSchema),
    outputSchema: toOutputSchema(searchObsidianOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'chat_with_brain',
    description: 'Ask a question to a public BrainTube Brain (curated knowledge base). Returns answer + source citations.',
    inputSchema: toInputSchema(chatWithBrainSchema),
    outputSchema: toOutputSchema(chatWithBrainOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'list_brains',
    description: 'List all Brains you have created with slug, name, item count, and visibility.',
    inputSchema: toInputSchema(listBrainsSchema),
    outputSchema: toOutputSchema(listBrainsOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_knowledge_graph',
    description: 'Build a knowledge graph around a specific item, showing how it connects to others via knowledge_edges.',
    inputSchema: toInputSchema(knowledgeGraphSchema),
    outputSchema: toOutputSchema(getKnowledgeGraphOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'knowledge_health',
    description: 'Run a health check on your knowledge corpus: missing embeddings, stale items, gaps, overall score out of 100.',
    inputSchema: toInputSchema(knowledgeHealthSchema),
    outputSchema: toOutputSchema(knowledgeHealthOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_knowledge_index',
    description: 'Get a topic-level index of your entire knowledge corpus grouped by primary topic.',
    inputSchema: toInputSchema(knowledgeIndexSchema),
    outputSchema: toOutputSchema(getKnowledgeIndexOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'export_corpus',
    description: 'Export your entire BrainTube knowledge corpus as a ZIP of Markdown files. Returns a signed download URL.',
    inputSchema: toInputSchema(exportCorpusSchema),
    outputSchema: toOutputSchema(exportCorpusOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'compile_knowledge',
    description: 'Generate concept articles from a topic cluster or Brain via the compile-knowledge edge function.',
    inputSchema: toInputSchema(compileKnowledgeSchema),
    outputSchema: toOutputSchema(compileKnowledgeOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'get_concept_articles',
    description: 'Query compiled concept articles from your knowledge base, filter by cluster, brain, or search text.',
    inputSchema: toInputSchema(getConceptArticlesSchema),
    outputSchema: toOutputSchema(getConceptArticlesOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tag_cooccurrence',
    description: 'Find tags that frequently appear together across your corpus.',
    inputSchema: toInputSchema(tagCooccurrenceSchema),
    outputSchema: toOutputSchema(tagCooccurrenceOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'entity_cooccurrence',
    description: 'Find named entities (people, orgs, tools) that frequently co-appear across your corpus.',
    inputSchema: toInputSchema(entityCooccurrenceSchema),
    outputSchema: toOutputSchema(entityCooccurrenceOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'detect_gaps',
    description: 'Detect knowledge gaps: thin topics, entities without depth, stale high-value items.',
    inputSchema: toInputSchema(detectGapsSchema),
    outputSchema: toOutputSchema(detectGapsOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'most_retrieved',
    description: 'Return the items you retrieve most often, ranked by retrieval_count.',
    inputSchema: toInputSchema(mostRetrievedSchema),
    outputSchema: toOutputSchema(mostRetrievedOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'export_claude_md',
    description: 'Generate a CLAUDE.md-compatible knowledge context file for any Claude Code project.',
    inputSchema: toInputSchema(exportClaudeMdSchema),
    outputSchema: toOutputSchema(exportClaudeMdOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'recompute_salience',
    description: 'Trigger a salience score recompute across your corpus.',
    inputSchema: toInputSchema(recomputeSalienceSchema),
    outputSchema: toOutputSchema(recomputeSalienceOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'deep_search',
    description: 'Multi-hop knowledge search: semantic search + graph traversal from top results.',
    inputSchema: toInputSchema(deepSearchSchema),
    outputSchema: toOutputSchema(deepSearchOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'retrieval_quality',
    description: 'Get a retrieval quality dashboard: search hit rates, zero-result queries, top terms.',
    inputSchema: toInputSchema(retrievalQualitySchema),
    outputSchema: toOutputSchema(retrievalQualityOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'find_path',
    description: 'Find the shortest path between two items in your knowledge graph.',
    inputSchema: toInputSchema(findPathSchema),
    outputSchema: toOutputSchema(findPathOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'compute_centrality',
    description: 'Recompute graph centrality scores across your corpus.',
    inputSchema: toInputSchema(computeCentralitySchema),
    outputSchema: toOutputSchema(computeCentralityOutputSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'get_edge_history',
    description: 'Get temporal history of knowledge edges between two specific items.',
    inputSchema: toInputSchema(edgeHistorySchema),
    outputSchema: toOutputSchema(getEdgeHistoryOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'security_dashboard',
    description: 'Get current security alert status, recent events, taint distribution. Admin only.',
    inputSchema: toInputSchema(securityDashboardSchema),
    outputSchema: toOutputSchema(securityDashboardOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'acknowledge_security_alert',
    description: 'Acknowledge a security alert by UUID. Admin only.',
    inputSchema: toInputSchema(acknowledgeAlertSchema),
    outputSchema: toOutputSchema(acknowledgeSecurityAlertOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'suppress_alert_type',
    description: 'Temporarily suppress a specific alert type for maintenance windows. Admin only.',
    inputSchema: toInputSchema(suppressAlertSchema),
    outputSchema: toOutputSchema(suppressAlertTypeOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'firewall_status',
    description: 'Get LLM firewall status, analytics, shadow mode state, and threshold recommendations. Admin only.',
    inputSchema: toInputSchema(firewallStatusSchema),
    outputSchema: toOutputSchema(firewallStatusOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'firewall_promote_check',
    description: 'Promote a firewall check from shadow mode to enforcement or demote back. Admin only.',
    inputSchema: toInputSchema(firewallPromoteCheckSchema),
    outputSchema: toOutputSchema(firewallPromoteCheckOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'firewall_update_threshold',
    description: 'Update a firewall threshold value with automatic versioning. Admin only.',
    inputSchema: toInputSchema(firewallUpdateThresholdSchema),
    outputSchema: toOutputSchema(firewallUpdateThresholdOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'firewall_rollback_rules',
    description: 'Rollback firewall rules to a previous version. Admin only.',
    inputSchema: toInputSchema(firewallRollbackRulesSchema),
    outputSchema: toOutputSchema(firewallRollbackRulesOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'firewall_rule_history',
    description: 'View version history for a firewall rule type. Admin only.',
    inputSchema: toInputSchema(firewallRuleHistorySchema),
    outputSchema: toOutputSchema(firewallRuleHistoryOutputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

export const serverCardRouter = Router();

serverCardRouter.get('/.well-known/mcp/server-card.json', (_req: Request, res: Response) => {
  res.json({
    serverInfo: {
      name: 'BrainTube',
      version: '3.12.2',
    },
    homepage: 'https://brain-tube.com',
    authentication: {
      required: true,
      schemes: ['oauth2'],
    },
    tools: TOOLS,
    resources: [],
    prompts: [],
  });
});

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

import { searchSchema } from '../tools/search.js';
import { videoSchema } from '../tools/video.js';
import { recentSchema } from '../tools/recent.js';
import { statsSchema } from '../tools/stats.js';
import { noteSchema } from '../tools/note.js';
import { ingestContentSchema } from '../tools/ingest.js';
import { bulkIngestSchema } from '../tools/bulk-ingest.js';
import { relatedSchema } from '../tools/related.js';
import { searchBySourceSchema } from '../tools/search-by-source.js';
import { tagItemSchema } from '../tools/tag-item.js';
import { resurfaceSchema } from '../tools/resurface.js';
import { searchByDateSchema } from '../tools/search-by-date.js';
import { recentConversationsSchema } from '../tools/recent-conversations.js';
import { expertiseProfileSchema } from '../tools/expertise-profile.js';
import { sessionBriefSchema } from '../tools/session-brief.js';
import { listBookmarksSchema, toggleBookmarkSchema } from '../tools/bookmarks.js';
import { searchObsidianSchema } from '../tools/obsidian-search.js';
import { chatWithBrainSchema, listBrainsSchema } from '../tools/brain-chat.js';
import { knowledgeGraphSchema } from '../tools/knowledge-graph.js';
import { knowledgeHealthSchema } from '../tools/knowledge-health.js';
import { knowledgeIndexSchema } from '../tools/knowledge-index.js';
import { compileKnowledgeSchema, getConceptArticlesSchema } from '../tools/concept-articles.js';
import { exportCorpusSchema } from '../tools/export-corpus.js';
import {
  tagCooccurrenceSchema,
  entityCooccurrenceSchema,
  detectGapsSchema,
  mostRetrievedSchema,
} from '../tools/analytics.js';
import { exportClaudeMdSchema } from '../tools/claude-md.js';
import { recomputeSalienceSchema } from '../tools/salience.js';
import { deepSearchSchema } from '../tools/deep-search.js';
import { retrievalQualitySchema } from '../tools/retrieval-quality.js';
import { edgeHistorySchema } from '../tools/edge-history.js';
import { findPathSchema } from '../tools/path.js';
import { computeCentralitySchema } from '../tools/centrality.js';
import {
  securityDashboardSchema,
  acknowledgeAlertSchema,
  suppressAlertSchema,
} from '../tools/security-admin.js';
import {
  firewallStatusSchema,
  firewallPromoteCheckSchema,
  firewallUpdateThresholdSchema,
  firewallRollbackRulesSchema,
  firewallRuleHistorySchema,
} from '../tools/firewall-admin.js';
import { connectReadwiseSchema, syncReadwiseSchema } from '../tools/readwise.js';
import {
  ingestNotionPageSchema,
  ingestNotionDatabaseSchema,
  setNotionApiKeySchema,
} from '../tools/notion-schemas.js';

function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
}

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
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_video',
    description: 'Get full details for a specific saved item including transcript, description, summary, key takeaways. Pass YouTube video ID or internal UUID.',
    inputSchema: toInputSchema(videoSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_recent',
    description: 'List your most recently saved items across all source types.',
    inputSchema: toInputSchema(recentSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_stats',
    description: 'Get your personal corpus statistics: total items saved, breakdown by source type, taint distribution.',
    inputSchema: toInputSchema(statsSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_related',
    description: 'Find items semantically similar to a given item using vector similarity.',
    inputSchema: toInputSchema(relatedSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_by_source',
    description: 'Search your corpus filtered to a specific source type (youtube, web, notion, twitter, pdf, etc).',
    inputSchema: toInputSchema(searchBySourceSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_by_date_range',
    description: 'Semantic search scoped to items saved between two dates.',
    inputSchema: toInputSchema(searchByDateSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tag_item',
    description: 'Add or remove tags on a saved item.',
    inputSchema: toInputSchema(tagItemSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'list_bookmarks',
    description: 'List saved bookmarks from your corpus. Filter by read/unread status.',
    inputSchema: toInputSchema(listBookmarksSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'toggle_bookmark',
    description: 'Bookmark an item, remove a bookmark, or toggle its read/unread state.',
    inputSchema: toInputSchema(toggleBookmarkSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'connect_readwise',
    description: 'Connect your Readwise account to BrainTube by saving your Readwise API token.',
    inputSchema: toInputSchema(connectReadwiseSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'sync_readwise',
    description: 'Import highlights from your Readwise library into your BrainTube corpus.',
    inputSchema: toInputSchema(syncReadwiseSchema),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'ingest_notion_page',
    description: 'Ingest a single Notion page into your BrainTube corpus.',
    inputSchema: toInputSchema(ingestNotionPageSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'add_note',
    description: 'Write a note or AI-generated synthesis back to a specific item in your corpus.',
    inputSchema: toInputSchema(noteSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_recent_conversations',
    description: 'Retrieve your most recently saved Claude and ChatGPT conversations.',
    inputSchema: toInputSchema(recentConversationsSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_expertise_profile',
    description: 'Analyse your corpus to build a knowledge expertise profile — expert, intermediate, surface, and blind spots by topic.',
    inputSchema: toInputSchema(expertiseProfileSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_session_brief',
    description: 'One-shot session bootstrap: expertise profile, last 5 AI conversations, and corpus stats in a single call.',
    inputSchema: toInputSchema(sessionBriefSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'ingest_content',
    description: 'Ingest a single piece of content (note, article, document, etc.) into your BrainTube corpus.',
    inputSchema: toInputSchema(ingestContentSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'bulk_ingest',
    description: 'Ingest up to 50 items in a single call with dedup and embedding.',
    inputSchema: toInputSchema(bulkIngestSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'random_resurface',
    description: 'Surface forgotten items from your corpus using weighted randomness.',
    inputSchema: toInputSchema(resurfaceSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'ingest_notion_database',
    description: 'Ingest all pages from a Notion database into your BrainTube corpus.',
    inputSchema: toInputSchema(ingestNotionDatabaseSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'set_notion_api_key',
    description: 'Save your Notion integration API key for ingest_notion_page and ingest_notion_database.',
    inputSchema: toInputSchema(setNotionApiKeySchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'backfill_embeddings',
    description: 'Generate vector embeddings for all items that are missing them. Required before semantic search.',
    inputSchema: toInputSchema(z.object({})),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'generate_api_key',
    description: 'Generate a personal API key for Obsidian Sync CLI or other integrations. Key shown once only.',
    inputSchema: toInputSchema(z.object({
      label: z.string().optional().describe('Human-readable label (e.g. "Obsidian MacBook")'),
    })),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'search_obsidian',
    description: 'Search your local Obsidian vault via the Obsidian Local REST API plugin.',
    inputSchema: toInputSchema(searchObsidianSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'chat_with_brain',
    description: 'Ask a question to a public BrainTube Brain (curated knowledge base). Returns answer + source citations.',
    inputSchema: toInputSchema(chatWithBrainSchema),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'list_brains',
    description: 'List all Brains you have created with slug, name, item count, and visibility.',
    inputSchema: toInputSchema(listBrainsSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_knowledge_graph',
    description: 'Build a knowledge graph around a specific item, showing how it connects to others via knowledge_edges.',
    inputSchema: toInputSchema(knowledgeGraphSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'knowledge_health',
    description: 'Run a health check on your knowledge corpus: missing embeddings, stale items, gaps, overall score out of 100.',
    inputSchema: toInputSchema(knowledgeHealthSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_knowledge_index',
    description: 'Get a topic-level index of your entire knowledge corpus grouped by primary topic.',
    inputSchema: toInputSchema(knowledgeIndexSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'export_corpus',
    description: 'Export your entire BrainTube knowledge corpus as a ZIP of Markdown files. Returns a signed download URL.',
    inputSchema: toInputSchema(exportCorpusSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'compile_knowledge',
    description: 'Generate concept articles from a topic cluster or Brain via the compile-knowledge edge function.',
    inputSchema: toInputSchema(compileKnowledgeSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'get_concept_articles',
    description: 'Query compiled concept articles from your knowledge base, filter by cluster, brain, or search text.',
    inputSchema: toInputSchema(getConceptArticlesSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tag_cooccurrence',
    description: 'Find tags that frequently appear together across your corpus.',
    inputSchema: toInputSchema(tagCooccurrenceSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'entity_cooccurrence',
    description: 'Find named entities (people, orgs, tools) that frequently co-appear across your corpus.',
    inputSchema: toInputSchema(entityCooccurrenceSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'detect_gaps',
    description: 'Detect knowledge gaps: thin topics, entities without depth, stale high-value items.',
    inputSchema: toInputSchema(detectGapsSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'most_retrieved',
    description: 'Return the items you retrieve most often, ranked by retrieval_count.',
    inputSchema: toInputSchema(mostRetrievedSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'export_claude_md',
    description: 'Generate a CLAUDE.md-compatible knowledge context file for any Claude Code project.',
    inputSchema: toInputSchema(exportClaudeMdSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'recompute_salience',
    description: 'Trigger a salience score recompute across your corpus.',
    inputSchema: toInputSchema(recomputeSalienceSchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'deep_search',
    description: 'Multi-hop knowledge search: semantic search + graph traversal from top results.',
    inputSchema: toInputSchema(deepSearchSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'retrieval_quality',
    description: 'Get a retrieval quality dashboard: search hit rates, zero-result queries, top terms.',
    inputSchema: toInputSchema(retrievalQualitySchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'find_path',
    description: 'Find the shortest path between two items in your knowledge graph.',
    inputSchema: toInputSchema(findPathSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'compute_centrality',
    description: 'Recompute graph centrality scores across your corpus.',
    inputSchema: toInputSchema(computeCentralitySchema),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'get_edge_history',
    description: 'Get temporal history of knowledge edges between two specific items.',
    inputSchema: toInputSchema(edgeHistorySchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'security_dashboard',
    description: 'Get current security alert status, recent events, taint distribution. Admin only.',
    inputSchema: toInputSchema(securityDashboardSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'acknowledge_security_alert',
    description: 'Acknowledge a security alert by UUID. Admin only.',
    inputSchema: toInputSchema(acknowledgeAlertSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'suppress_alert_type',
    description: 'Temporarily suppress a specific alert type for maintenance windows. Admin only.',
    inputSchema: toInputSchema(suppressAlertSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'firewall_status',
    description: 'Get LLM firewall status, analytics, shadow mode state, and threshold recommendations. Admin only.',
    inputSchema: toInputSchema(firewallStatusSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'firewall_promote_check',
    description: 'Promote a firewall check from shadow mode to enforcement or demote back. Admin only.',
    inputSchema: toInputSchema(firewallPromoteCheckSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'firewall_update_threshold',
    description: 'Update a firewall threshold value with automatic versioning. Admin only.',
    inputSchema: toInputSchema(firewallUpdateThresholdSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'firewall_rollback_rules',
    description: 'Rollback firewall rules to a previous version. Admin only.',
    inputSchema: toInputSchema(firewallRollbackRulesSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'firewall_rule_history',
    description: 'View version history for a firewall rule type. Admin only.',
    inputSchema: toInputSchema(firewallRuleHistorySchema),
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

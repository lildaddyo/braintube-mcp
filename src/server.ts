import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchSchema, searchKnowledge } from './tools/search.js';
import { videoSchema, getVideo } from './tools/video.js';
import { recentSchema, listRecent } from './tools/recent.js';
import { statsSchema, getStats } from './tools/stats.js';
import { noteSchema, addNote } from './tools/note.js';
import { backfillEmbeddings } from './tools/embedding.js';
import { ingestNotionPage, ingestNotionDatabase, setNotionApiKey } from './tools/notion-ingest.js';
import type { AuthContext } from './types.js';

// Every tool call is scoped to the authenticated user
export function createMcpServer(auth: AuthContext) {
  const server = new McpServer({
    name: 'braintube-mcp',
    version: '3.0.0',
  });

  server.registerTool(
    'search_knowledge',
    {
      description: 'Full-text search over your personal BrainTube knowledge corpus. Searches across YouTube, Instagram, web, LinkedIn, GitHub, Twitter and more. Returns results ranked by recency with taint warnings.',
      inputSchema: searchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) => searchKnowledge(input, auth.userId)
  );

  server.registerTool(
    'get_video',
    {
      description: 'Get full details for a specific saved item including transcript, description, summary, key takeaways and taint level. Pass YouTube video ID or internal UUID.',
      inputSchema: videoSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) => getVideo(input, auth.userId)
  );

  server.registerTool(
    'list_recent',
    {
      description: 'List your most recently saved items across all source types. Use to resume a research session or review what was captured lately.',
      inputSchema: recentSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) => listRecent(input, auth.userId)
  );

  server.registerTool(
    'get_stats',
    {
      description: 'Get your personal corpus statistics: total items saved, breakdown by source type (youtube/instagram/web/etc), taint distribution. Call this before searching to understand what knowledge is available.',
      inputSchema: statsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) => getStats(input, auth.userId)
  );

  server.registerTool(
    'add_note',
    {
      description: 'Write a note or AI-generated synthesis back to a specific item in your corpus. No write_token needed — your JWT proves ownership. Ownership is verified server-side.',
      inputSchema: noteSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (input) => addNote(input, auth.userId)
  );

  // ── Embedding tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'backfill_embeddings',
    {
      description: 'Generate and store vector embeddings for all your items that are missing them. Required before semantic search works. Processes in batches of 20 with 200ms delays. Returns { embedded, errors } count.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async () => {
      const result = await backfillEmbeddings(auth.userId);
      return {
        content: [{
          type: 'text' as const,
          text: `Backfill complete. Embedded: ${result.embedded}, Errors: ${result.errors}`
        }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  // ── Notion ingest tools ───────────────────────────────────────────────────────

  server.registerTool(
    'ingest_notion_page',
    {
      description: 'Ingest a single Notion page into your BrainTube corpus. Accepts a full Notion URL or raw page UUID. Extracts title + body text, upserts to items table, and immediately generates an embedding. Requires set_notion_api_key first.',
      inputSchema: z.object({
        page_url: z.string().min(1).describe('Notion page URL (e.g. https://notion.so/My-Page-abc123) or raw UUID')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async (input) => {
      const result = await ingestNotionPage(input.page_url, auth.userId);
      return {
        content: [{
          type: 'text' as const,
          text: `Notion page ${result.action}: "${result.title}" (id: ${result.id})`
        }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  server.registerTool(
    'ingest_notion_database',
    {
      description: 'Ingest all pages from a Notion database into your BrainTube corpus. Processes up to `limit` pages with 350ms delay between each. Requires set_notion_api_key first.',
      inputSchema: z.object({
        database_id: z.string().min(1).describe('Notion database ID (UUID format or from database URL)'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max pages to ingest (default 50)')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async (input) => {
      const result = await ingestNotionDatabase(input.database_id, auth.userId, input.limit);
      return {
        content: [{
          type: 'text' as const,
          text: `Notion database ingested. New: ${result.ingested}, Updated: ${result.updated}, Errors: ${result.errors.length}${result.errors.length ? '\n' + result.errors.join('\n') : ''}`
        }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  server.registerTool(
    'set_notion_api_key',
    {
      description: 'Save your Notion integration API key so ingest_notion_page and ingest_notion_database can access your Notion workspace. Get your key from https://www.notion.so/my-integrations.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('Notion integration secret (starts with secret_...)')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async (input) => {
      await setNotionApiKey(input.api_key, auth.userId);
      return {
        content: [{
          type: 'text' as const,
          text: 'Notion API key saved. You can now use ingest_notion_page and ingest_notion_database.'
        }]
      };
    }
  );

  return server;
}

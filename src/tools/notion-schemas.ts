/**
 * Canonical input schemas for the Notion ingest tools.
 *
 * Split out from notion-ingest.ts (which pulls in the Supabase admin client
 * and the Notion SDK) so that schema-only consumers — notably
 * src/routes/server-card.ts, the public unauthenticated Smithery listing
 * route — don't transitively require DB credentials just to build their
 * route table. Both src/server.ts (runtime registration) and
 * src/routes/server-card.ts (static listing) import from here, so the two
 * surfaces can never drift out of sync.
 */

import { z } from 'zod';

export const ingestNotionPageSchema = z.object({
  page_url:  z.string().min(1).describe('Notion page URL (e.g. https://notion.so/My-Page-abc123) or raw UUID'),
  force_new: z.boolean().default(false).describe('Skip dedup and always insert as new item')
});

export const ingestNotionDatabaseSchema = z.object({
  database_id: z.string().min(1).describe('Notion database ID (UUID format or from database URL)'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max pages to ingest (default 50)')
});

export const setNotionApiKeySchema = z.object({
  api_key: z.string().min(1).describe('Notion integration secret (starts with secret_...)')
});

export const ingestNotionPageOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  action: z.enum(['inserted', 'updated']),
});

export const ingestNotionDatabaseOutputSchema = z.object({
  ingested: z.number(),
  updated: z.number(),
  errors: z.array(z.string()),
});

export const setNotionApiKeyOutputSchema = z.object({
  saved: z.literal(true),
});

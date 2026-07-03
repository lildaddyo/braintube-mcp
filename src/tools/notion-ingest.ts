import { Client, isFullBlock, isFullPage } from '@notionhq/client';
import type {
  BlockObjectResponse,
  RichTextItemResponse,
  PageObjectResponse
} from '@notionhq/client/build/src/api-endpoints.js';
import { dbAdmin } from '../db/supabase.js';
import { findItemBySourceUrl, findItemByTitle } from '../db/supabase.js';
import { embedItem } from './embedding.js';

export { ingestNotionPageSchema, ingestNotionDatabaseSchema, setNotionApiKeySchema } from './notion-schemas.js';

// ─── Notion client factory ────────────────────────────────────────────────────

export async function getNotionClient(userId: string): Promise<Client> {
  // 1. Try OAuth token from notion_connections (preferred)
  const { data: oauthConn } = await dbAdmin
    .from('notion_connections')
    .select('access_token')
    .eq('user_id', userId)
    .single();

  if (oauthConn?.access_token) {
    return new Client({ auth: oauthConn.access_token });
  }

  // 2. Fall back to legacy API key from user_settings
  const { data, error } = await dbAdmin
    .from('user_settings')
    .select('setting_value')
    .eq('user_id', userId)
    .eq('setting_key', 'notion_api_key')
    .single();

  if (error || !data?.setting_value) {
    throw new Error('No Notion connection found. Connect via OAuth at brain-tube.com/settings or use set_notion_api_key.');
  }

  return new Client({ auth: data.setting_value });
}

// ─── Block text extraction ────────────────────────────────────────────────────

function extractRichText(richText: RichTextItemResponse[]): string {
  return richText.map(r => r.plain_text).join('');
}

export function extractPageText(blocks: BlockObjectResponse[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    if (!isFullBlock(block)) continue;

    switch (block.type) {
      case 'paragraph':
        lines.push(extractRichText(block.paragraph.rich_text));
        break;
      case 'heading_1':
        lines.push(extractRichText(block.heading_1.rich_text));
        break;
      case 'heading_2':
        lines.push(extractRichText(block.heading_2.rich_text));
        break;
      case 'heading_3':
        lines.push(extractRichText(block.heading_3.rich_text));
        break;
      case 'bulleted_list_item':
        lines.push(extractRichText(block.bulleted_list_item.rich_text));
        break;
      case 'numbered_list_item':
        lines.push(extractRichText(block.numbered_list_item.rich_text));
        break;
      case 'quote':
        lines.push(extractRichText(block.quote.rich_text));
        break;
      case 'callout':
        lines.push(extractRichText(block.callout.rich_text));
        break;
      case 'toggle':
        lines.push(extractRichText(block.toggle.rich_text));
        break;
      case 'code':
        lines.push(extractRichText(block.code.rich_text));
        break;
      // table_row, child_page, image, etc. — skip
    }
  }

  return lines.filter(l => l.trim()).join('\n');
}

// ─── Block fetcher (paginated) ────────────────────────────────────────────────

export async function fetchAllBlocks(
  notion: Client,
  pageId: string
): Promise<BlockObjectResponse[]> {
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100
    });

    for (const block of response.results) {
      if (isFullBlock(block)) blocks.push(block);
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return blocks;
}

// ─── Page ID extraction ───────────────────────────────────────────────────────

function extractPageId(input: string): string {
  // Strip query string and trailing slashes
  const clean = input.split('?')[0].replace(/\/$/, '');

  // Already a UUID with hyphens
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
    return clean;
  }

  // 32-char hex at end of a notion.so URL
  const hexMatch = clean.match(/([0-9a-f]{32})$/i);
  if (hexMatch) {
    const h = hexMatch[1];
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  throw new Error(`Cannot extract page ID from: ${input}`);
}

// ─── Get page title ───────────────────────────────────────────────────────────

function getPageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title.length > 0) {
      return prop.title.map(t => t.plain_text).join('');
    }
  }
  return 'Untitled';
}

// ─── Ingest single page ───────────────────────────────────────────────────────

export async function ingestNotionPage(
  pageUrl: string,
  userId: string,
  forceNew = false
): Promise<{ id: string; title: string; action: 'inserted' | 'updated' }> {
  const notion = await getNotionClient(userId);
  const pageId = extractPageId(pageUrl);

  // Fetch page metadata + blocks in parallel
  const [pageRes, blocks] = await Promise.all([
    notion.pages.retrieve({ page_id: pageId }),
    fetchAllBlocks(notion, pageId)
  ]);

  if (!isFullPage(pageRes)) throw new Error('Could not retrieve full page object');

  const title = getPageTitle(pageRes);
  const bodyText = extractPageText(blocks);
  const summary = bodyText.slice(0, 500) || null;
  const pageUrlNormalized = `https://www.notion.so/${pageId.replace(/-/g, '')}`;

  // ── Dedup: notion_page_id first, then source_url, then title ─────────────
  let existingId: string | null = null;

  if (!forceNew) {
    // 1. Canonical: match by notion_page_id (most reliable for Notion pages)
    const { data: byPageId } = await dbAdmin
      .from('items')
      .select('id')
      .eq('user_id', userId)
      .eq('notion_page_id', pageId)
      .single();
    existingId = byPageId?.id ?? null;

    // 2. Fallback: source_url match (catches pages re-ingested without notion_page_id)
    if (!existingId) {
      existingId = await findItemBySourceUrl(pageUrlNormalized, userId);
    }

    // 3. Fallback: exact title match
    if (!existingId) {
      existingId = await findItemByTitle(title, userId);
    }
  }

  let itemId: string;
  let action: 'inserted' | 'updated';

  if (existingId) {
    // Update existing item
    const { error } = await dbAdmin
      .from('items')
      .update({
        title,
        summary,
        source_url: pageUrlNormalized,
        updated_at: new Date().toISOString()
      })
      .eq('id', existingId);

    if (error) throw new Error(`Failed to update notion item: ${error.message}`);
    itemId = existingId;
    action = 'updated';
  } else {
    // Insert new item — generate UUID via crypto
    const { data: inserted, error } = await dbAdmin
      .from('items')
      .insert({
        user_id: userId,
        source_type: 'notion',
        notion_page_id: pageId,
        title,
        summary,
        url: pageUrlNormalized,
        source_url: pageUrlNormalized,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error || !inserted) throw new Error(`Failed to insert notion item: ${error?.message}`);
    itemId = inserted.id;
    action = 'inserted';
  }

  // Embed immediately after ingest
  try {
    await embedItem(itemId);
  } catch (err) {
    console.error(`[notion] embed failed for ${itemId}:`, err);
    // Non-fatal — item is ingested, embedding will be picked up by backfill
  }

  return { id: itemId, title, action };
}

// ─── Ingest database ─────────────────────────────────────────────────────────

export async function ingestNotionDatabase(
  databaseId: string,
  userId: string,
  limit = 50
): Promise<{ ingested: number; updated: number; errors: string[] }> {
  const notion = await getNotionClient(userId);
  const errors: string[] = [];
  let ingested = 0;
  let updated = 0;
  let cursor: string | undefined;
  let total = 0;

  do {
    // Note: databases.query moved to dataSources.query in @notionhq/client v5
    const response = await (notion.dataSources as unknown as {
      query: (args: { database_id: string; start_cursor?: string; page_size?: number }) => Promise<{
        results: Array<{ id: string; url: string; object: string }>;
        has_more: boolean;
        next_cursor: string | null;
      }>;
    }).query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: Math.min(100, limit - total)
    });

    for (const page of response.results) {
      if (total >= limit) break;
      if (page.object !== 'page') continue;

      try {
        const result = await ingestNotionPage(page.url, userId);
        if (result.action === 'inserted') ingested++;
        else updated++;
        total++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${page.id}: ${msg}`);
        total++;
      }

      // 350ms delay between pages
      await new Promise(r => setTimeout(r, 350));
    }

    cursor = response.has_more && total < limit
      ? response.next_cursor ?? undefined
      : undefined;
  } while (cursor && total < limit);

  return { ingested, updated, errors };
}

// ─── Set Notion API key ───────────────────────────────────────────────────────

export async function setNotionApiKey(apiKey: string, userId: string): Promise<void> {
  const { error } = await dbAdmin
    .from('user_settings')
    .upsert(
      {
        user_id: userId,
        setting_key: 'notion_api_key',
        setting_value: apiKey,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,setting_key' }
    );

  if (error) throw new Error(`Failed to save Notion API key: ${error.message}`);
}

/**
 * BrainTube REST API router
 * Mirrors all 16 MCP tools as plain HTTP endpoints.
 * Mounted at /api — auth + rate-limiting applied in index.ts before this router.
 */

import express from 'express';
import type { AuthContext } from '../types.js';
import { searchKnowledge } from '../tools/search.js';
import { getStats } from '../tools/stats.js';
import { listRecent } from '../tools/recent.js';
import { getRelated } from '../tools/related.js';
import { listBookmarks, toggleBookmark } from '../tools/bookmarks.js';
import { getExpertiseProfileTool } from '../tools/expertise-profile.js';
import { getRecentConversations } from '../tools/recent-conversations.js';
import { getSessionBrief } from '../tools/session-brief.js';
import { ingestContent } from '../tools/ingest.js';
import { bulkIngest } from '../tools/bulk-ingest.js';
import { tagItem } from '../tools/tag-item.js';
import { addNote } from '../tools/note.js';
import { searchBySource } from '../tools/search-by-source.js';
import { searchByDate } from '../tools/search-by-date.js';
import { randomResuface } from '../tools/resurface.js';
import { chatWithBrain, listBrains } from '../tools/brain-chat.js';
import { requireCredits } from '../lib/credits.js';

export const restRouter = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pull the AuthContext attached by requireAuth middleware */
const auth = (req: express.Request): AuthContext =>
  (req as express.Request & { auth: AuthContext }).auth;

/**
 * MCP tool functions return { content: [...], structuredContent: {...} }.
 * Plain tools (ingestContent, bulkIngest, etc.) return data directly.
 * This helper normalises both cases to the bare data object.
 */
function unwrap(result: unknown): unknown {
  if (result !== null && typeof result === 'object' && 'structuredContent' in result) {
    return (result as Record<string, unknown>).structuredContent;
  }
  return result;
}

function parseIntQ(val: unknown, fallback: number): number {
  const n = parseInt(val as string, 10);
  return isNaN(n) ? fallback : n;
}

function send500(res: express.Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[REST]', msg);
  if (msg.startsWith('Insufficient credits')) {
    res.status(402).json({ error: msg });
    return;
  }
  res.status(500).json({ error: msg });
}

// ── Read endpoints ─────────────────────────────────────────────────────────────

/**
 * GET /api/search?q=...&limit=5
 * Full-text + semantic search across the user's corpus.
 */
restRouter.get('/search', async (req, res) => {
  const { q, limit } = req.query;
  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }
  try {
    await requireCredits(auth(req).userId, 'ai_search', 'search_knowledge');
    const result = await searchKnowledge(
      { query: q, limit: parseIntQ(limit, 5) },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/stats
 * Corpus statistics: total items, breakdown by source type, taint distribution.
 */
restRouter.get('/stats', async (req, res) => {
  try {
    const result = await getStats({}, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/recent?limit=10
 * Most recently saved items across all source types.
 */
restRouter.get('/recent', async (req, res) => {
  try {
    const result = await listRecent(
      { limit: parseIntQ(req.query.limit, 10) },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/related/:item_id?limit=5
 * Items semantically similar to the given item (vector similarity).
 */
restRouter.get('/related/:item_id', async (req, res) => {
  try {
    const result = await getRelated(
      { item_id: req.params.item_id, limit: parseIntQ(req.query.limit, 5) },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/bookmarks?filter=unread&limit=20
 * List bookmarked items. filter: all | unread | read
 */
restRouter.get('/bookmarks', async (req, res) => {
  const filter = (req.query.filter as string) ?? 'unread';
  if (!['all', 'unread', 'read'].includes(filter)) {
    res.status(400).json({ error: 'filter must be one of: all, unread, read' });
    return;
  }
  try {
    const result = await listBookmarks(
      {
        filter: filter as 'all' | 'unread' | 'read',
        limit:  parseIntQ(req.query.limit, 20),
      },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/expertise
 * Knowledge expertise profile: expert/intermediate/surface/blind-spot topics.
 */
restRouter.get('/expertise', async (req, res) => {
  try {
    await requireCredits(auth(req).userId, 'ai_search', 'get_expertise_profile');
    const result = await getExpertiseProfileTool({}, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/conversations?limit=5
 * Most recently saved Claude and ChatGPT conversations.
 */
restRouter.get('/conversations', async (req, res) => {
  try {
    const result = await getRecentConversations(
      { n: parseIntQ(req.query.limit, 5) },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/session-brief
 * One-shot bootstrap: expertise + recent conversations + corpus stats.
 */
restRouter.get('/session-brief', async (req, res) => {
  try {
    await requireCredits(auth(req).userId, 'ai_chat', 'get_session_brief');
    const result = await getSessionBrief({}, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/resurface?n=5
 * Surface forgotten items using weighted randomness (spaced repetition).
 */
restRouter.get('/resurface', async (req, res) => {
  try {
    const n = parseIntQ(req.query.n, 5);
    const result = await randomResuface({ n }, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

// ── Search sub-routes ──────────────────────────────────────────────────────────

/**
 * GET /api/search/source?type=youtube&q=...&limit=5
 * Search filtered to a specific source type.
 */
restRouter.get('/search/source', async (req, res) => {
  const { type, q, limit } = req.query;
  if (!type || !q) {
    res.status(400).json({ error: 'Parameters "type" and "q" are required' });
    return;
  }
  try {
    await requireCredits(auth(req).userId, 'ai_search', 'search_by_source');
    const result = await searchBySource(
      { source_type: type as string, query: q as string, limit: parseIntQ(limit, 5) },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/search/date?q=...&after=2025-01-01&before=2025-12-31&limit=5
 * Semantic search scoped to a date range (ISO 8601 dates).
 */
restRouter.get('/search/date', async (req, res) => {
  const { q, after, before, limit } = req.query;
  if (!q || !after || !before) {
    res.status(400).json({ error: 'Parameters "q", "after", and "before" are required' });
    return;
  }
  try {
    await requireCredits(auth(req).userId, 'ai_search', 'search_by_date_range');
    const result = await searchByDate(
      {
        query:  q as string,
        after:  after as string,
        before: before as string,
        limit:  parseIntQ(limit, 5),
      },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

// ── Write endpoints ────────────────────────────────────────────────────────────

/**
 * POST /api/ingest
 * Body: { title, content, source_url?, source_type?, tags?, force_new? }
 * Ingest a single item. Deduplicates by source_url then title.
 */
restRouter.post('/ingest', async (req, res) => {
  const { title, content, source_url, source_type, tags, force_new } = req.body ?? {};
  if (!title || !content) {
    res.status(400).json({ error: '"title" and "content" are required' });
    return;
  }
  try {
    const result = await ingestContent(
      { title, content, source_url, source_type, tags, force_new: force_new ?? false },
      auth(req).userId
    );
    res.status(201).json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * POST /api/bulk-ingest
 * Body: { items: [{ title, content, source_url?, source_type?, tags? }], force_new? }
 * Ingest up to 50 items. Returns { inserted, updated, skipped, errors }.
 */
restRouter.post('/bulk-ingest', async (req, res) => {
  const { items, force_new } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: '"items" must be a non-empty array' });
    return;
  }
  try {
    const result = await bulkIngest(
      { items, force_new: force_new ?? false },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * POST /api/bookmark/:item_id
 * Body: { action: "bookmark" | "unbookmark" | "mark_read" | "mark_unread" }
 * Toggle bookmark or read state on an item.
 */
restRouter.post('/bookmark/:item_id', async (req, res) => {
  const { item_id } = req.params;
  const { action } = req.body ?? {};
  const validActions = ['bookmark', 'unbookmark', 'mark_read', 'mark_unread'];
  if (!action || !validActions.includes(action)) {
    res.status(400).json({ error: `"action" must be one of: ${validActions.join(', ')}` });
    return;
  }
  try {
    const result = await toggleBookmark(
      { item_id, action },
      auth(req).userId
    );
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * POST /api/tag/:item_id
 * Body: { add?: string[], remove?: string[] }
 * Add or remove tags on an item.
 */
restRouter.post('/tag/:item_id', async (req, res) => {
  const { item_id } = req.params;
  const { add = [], remove = [] } = req.body ?? {};
  if (add.length === 0 && remove.length === 0) {
    res.status(400).json({ error: 'Provide at least one tag in "add" or "remove"' });
    return;
  }
  try {
    const result = await tagItem({ item_id, add, remove }, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * GET /api/brains
 * List all Brains owned by the authenticated user.
 */
restRouter.get('/brains', async (req, res) => {
  try {
    const result = await listBrains({}, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * POST /api/brain-chat/:slug
 * Body: { question: string, chat_history?: [{role, content}][], session_id?: string }
 * Query a public Brain by its slug.
 */
restRouter.post('/brain-chat/:slug', async (req, res) => {
  const brain_slug = req.params.slug;
  const { question, chat_history, session_id } = req.body ?? {};
  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: '"question" string is required' });
    return;
  }
  try {
    await requireCredits(auth(req).userId, 'ai_chat', 'chat_with_brain');
    const result = await chatWithBrain({ brain_slug, question, chat_history, session_id });
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

/**
 * POST /api/note/:item_id
 * Body: { note: string }
 * Write a note or synthesis back to an item.
 */
restRouter.post('/note/:item_id', async (req, res) => {
  const video_id = req.params.item_id; // the tool uses video_id as the UUID field name
  const { note } = req.body ?? {};
  if (!note || typeof note !== 'string') {
    res.status(400).json({ error: '"note" string is required' });
    return;
  }
  try {
    const result = await addNote({ video_id, note }, auth(req).userId);
    res.json(unwrap(result));
  } catch (e) { send500(res, e); }
});

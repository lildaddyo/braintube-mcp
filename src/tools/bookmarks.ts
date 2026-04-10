import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

// ─── list_bookmarks ───────────────────────────────────────────────────────────

export const listBookmarksSchema = z.object({
  filter: z.enum(['all', 'unread', 'read']).default('unread').describe(
    'Which bookmarks to return: all, unread (default), or read'
  ),
  limit: z.number().int().min(1).max(100).default(20).describe(
    'Max bookmarks to return (default 20)'
  ),
});

export async function listBookmarks(
  input: z.infer<typeof listBookmarksSchema>,
  userId: string
) {
  const { filter, limit } = input;

  let query = dbAdmin
    .from('items')
    .select('id, title, source_url, source_type, tags, is_read, bookmarked_at, created_at')
    .eq('user_id', userId)
    .eq('is_bookmark', true)
    .eq('is_archived', false)
    .order('bookmarked_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (filter === 'unread') query = query.eq('is_read', false);
  if (filter === 'read')   query = query.eq('is_read', true);

  const { data, error } = await query;

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `list_bookmarks failed: ${error.message}` }],
      structuredContent: { bookmarks: [] } as unknown as Record<string, unknown>
    };
  }

  const bookmarks = (data ?? []).map(row => ({
    id:           row.id,
    title:        row.title ?? 'Untitled',
    source_url:   row.source_url ?? null,
    source_type:  (row as any).source_type ?? null,
    tags:         (row as any).tags ?? [],
    is_read:      (row as any).is_read ?? false,
    bookmarked_at: (row as any).bookmarked_at ?? row.created_at,
  }));

  const filterLabel = filter === 'all' ? '' : ` (${filter})`;
  const text = bookmarks.length === 0
    ? `No ${filter === 'all' ? '' : filter + ' '}bookmarks found.`
    : `Bookmarks${filterLabel} (${bookmarks.length}):\n\n` +
      bookmarks.map((b, i) =>
        `${i + 1}. ${b.title}${b.source_url ? `\n   ${b.source_url}` : ''}${b.tags?.length ? `\n   Tags: ${b.tags.join(', ')}` : ''}${b.is_read ? ' ✓' : ''}`
      ).join('\n\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { bookmarks } as unknown as Record<string, unknown>
  };
}

// ─── toggle_bookmark ──────────────────────────────────────────────────────────

export const toggleBookmarkSchema = z.object({
  item_id: z.string().uuid().describe('UUID of the item to act on'),
  action: z.enum(['bookmark', 'unbookmark', 'mark_read', 'mark_unread']).default('bookmark').describe(
    'bookmark: flag item + set bookmarked_at | unbookmark: clear flag | mark_read/mark_unread: toggle read state'
  ),
});

export async function toggleBookmark(
  input: z.infer<typeof toggleBookmarkSchema>,
  userId: string
) {
  const { item_id, action } = input;

  // Build update payload based on action
  const updates: Record<string, unknown> = {};
  if (action === 'bookmark') {
    updates.is_bookmark   = true;
    updates.bookmarked_at = new Date().toISOString();
  } else if (action === 'unbookmark') {
    updates.is_bookmark   = false;
    updates.bookmarked_at = null;
  } else if (action === 'mark_read') {
    updates.is_read = true;
  } else if (action === 'mark_unread') {
    updates.is_read = false;
  }

  const { data, error } = await dbAdmin
    .from('items')
    .update(updates)
    .eq('id', item_id)
    .eq('user_id', userId)
    .select('id, is_bookmark, is_read, bookmarked_at')
    .single();

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `toggle_bookmark failed: ${error.message}` }],
      structuredContent: { success: false, error: error.message } as unknown as Record<string, unknown>
    };
  }

  if (!data) {
    return {
      content: [{ type: 'text' as const, text: `Item ${item_id} not found or access denied.` }],
      structuredContent: { success: false, error: 'not_found' } as unknown as Record<string, unknown>
    };
  }

  const row = data as any;
  const result = {
    success:      true,
    item_id:      row.id,
    is_bookmark:  row.is_bookmark,
    is_read:      row.is_read,
    bookmarked_at: row.bookmarked_at,
  };

  const msg =
    action === 'bookmark'    ? `Bookmarked item ${item_id}` :
    action === 'unbookmark'  ? `Removed bookmark from ${item_id}` :
    action === 'mark_read'   ? `Marked ${item_id} as read` :
                               `Marked ${item_id} as unread`;

  return {
    content: [{ type: 'text' as const, text: msg }],
    structuredContent: result as unknown as Record<string, unknown>
  };
}

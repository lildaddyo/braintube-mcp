import { z } from 'zod';
import { actingUserHeaders } from '../lib/edge-auth.js';

/**
 * YouTube channel → pick videos → import, for agents (2026-11-20).
 *
 * list_channel_videos is free and read-only: it pages the channel's uploads through the
 * user's own YouTube connection (youtube-fetch-channel-videos, 200 videos per call) and
 * filters titles locally, returning at most 50 matches (Spuck 2026-11-20: listing free, max 50,
 * user's YouTube login only — no server API key).
 * import_youtube_videos runs the same import as the app (youtube-bulk-import): full
 * transcripts, the user's plan, credits and Free's monthly import rule apply unchanged.
 */

const FN_BASE = 'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1';
const MAX_MATCHES = 50;
const MAX_EDGE_CALLS = 15;           // 15 × 200 = up to 3,000 newest uploads scanned per call
const IMPORT_MAX = 50;

export const listChannelVideosSchema = z.object({
  channel_url: z.string().min(1).max(500).describe(
    'YouTube channel or playlist URL: https://www.youtube.com/@handle, /channel/UC…, /c/Name, /user/Name or /playlist?list=…',
  ),
  query: z.string().max(200).optional().describe(
    'Optional filter on the video title, case-insensitive. Separate alternatives with "|" (e.g. "Theo Von|Theo"). All words of one alternative must appear.',
  ),
  limit: z.number().int().min(1).max(MAX_MATCHES).default(MAX_MATCHES).describe(`Max videos returned (1-${MAX_MATCHES}).`),
  page_token: z.string().max(200).optional().describe('next_page_token from a previous call, to scan older uploads.'),
});

export const listChannelVideosOutputSchema = z.object({}).passthrough();

export const importYoutubeVideosSchema = z.object({
  video_ids: z.array(z.string().regex(/^[a-zA-Z0-9_-]{11}$/)).min(1).max(IMPORT_MAX).describe(
    `YouTube video ids to add (the "id" values from list_channel_videos), max ${IMPORT_MAX} per call.`,
  ),
});

export const importYoutubeVideosOutputSchema = z.object({}).passthrough();

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };

async function callEdge(fn: string, userId: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
  const res = await fetch(`${FN_BASE}/${fn}`, {
    method: 'POST',
    headers: actingUserHeaders(userId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 400) }; }
  return { status: res.status, data };
}

function errorResult(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message, ...extra }, isError: true };
}

/** "Theo Von|Theo" → [["theo","von"],["theo"]]; a title matches if any alternative has all its words. */
export function titleMatcher(query?: string): (title: string) => boolean {
  const alts = (query ?? '').split('|').map((a) => a.toLowerCase().split(/\s+/).filter(Boolean)).filter((a) => a.length > 0);
  if (alts.length === 0) return () => true;
  return (title) => {
    const t = title.toLowerCase();
    return alts.some((words) => words.every((w) => t.includes(w)));
  };
}

export async function listChannelVideos(input: z.infer<typeof listChannelVideosSchema>, userId: string): Promise<ToolResult> {
  const matches = titleMatcher(input.query);
  const limit = input.limit ?? MAX_MATCHES;
  const found: Array<{ id: string; title: string; published_at: string | null; url: string; already_saved: boolean }> = [];
  let pageToken: string | null = input.page_token ?? null;
  let channel: Record<string, unknown> | null = null;
  let scanned = 0;
  let total: number | null = null;

  for (let i = 0; i < MAX_EDGE_CALLS; i++) {
    const { status, data } = await callEdge('youtube-fetch-channel-videos', userId, { channelUrl: input.channel_url, ...(pageToken ? { pageToken } : {}) }, 60_000);
    if (status >= 400 || data?.error) {
      const msg = String(data?.error ?? `youtube-fetch-channel-videos returned ${status}`);
      const hint = /connect/i.test(msg)
        ? ' The user must connect YouTube once in the BrainTube app (Settings → YouTube), then retry.'
        : '';
      return errorResult(`Could not list this channel: ${msg}${hint}`, { code: data?.code ?? null });
    }
    channel ??= data.channel ?? null;
    total ??= typeof data.totalResults === 'number' ? data.totalResults : null;
    const videos: any[] = Array.isArray(data.videos) ? data.videos : [];
    scanned += videos.length;
    for (const v of videos) {
      if (found.length >= limit) break;
      const title = String(v.title ?? '');
      if (!matches(title)) continue;
      const id = String(v.videoId ?? v.id ?? '');
      if (!id) continue;
      found.push({
        id,
        title,
        published_at: v.publishedAt ?? null,
        url: `https://www.youtube.com/watch?v=${id}`,
        already_saved: Boolean(v.alreadyImported),
      });
    }
    pageToken = data.nextPageToken || null;
    if (!pageToken || found.length >= limit) break;
  }

  const structured = {
    channel,
    query: input.query ?? null,
    videos: found,
    returned: found.length,
    scanned,
    channel_total: total,
    next_page_token: pageToken,
    cost_credits: 0,
  };
  const lines = found.map((v, n) => `${n + 1}. ${v.title} (${v.published_at?.slice(0, 10) ?? '?'}) id=${v.id}${v.already_saved ? ' [already saved]' : ''}`);
  const more = pageToken ? `\nOlder uploads not scanned yet: call again with page_token="${pageToken}".` : '';
  const text = `${(channel as any)?.title ?? 'Channel'}: ${found.length} matching video(s) out of ${scanned} scanned${total ? ` (channel has ${total})` : ''}. Listing is free; nothing was saved.\n${lines.join('\n')}${more}\n\nShow this list to the user and ask which to add, then call import_youtube_videos with their ids.`;
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export async function importYoutubeVideos(input: z.infer<typeof importYoutubeVideosSchema>, userId: string): Promise<ToolResult> {
  const ids = [...new Set(input.video_ids)];
  const { status, data } = await callEdge('youtube-bulk-import', userId, { videoIds: ids, source: 'mcp' }, 120_000);
  if (status >= 400 || (data?.error && !('imported' in (data ?? {})))) {
    return errorResult(`Import failed: ${String(data?.error ?? status)}`, { code: data?.code ?? null, ...data });
  }
  const message = data?.message ? `\n${data.message}` : '';
  const text = `Imported ${data?.imported ?? 0} of ${ids.length} video(s) into BrainTube (skipped ${data?.skipped ?? 0}: already saved or excluded). Transcripts and summaries finish processing in the background.${message}`;
  return { content: [{ type: 'text', text }], structuredContent: { requested: ids.length, ...data } };
}

/**
 * search_obsidian — query the local Obsidian vault via the
 * Obsidian Local REST API plugin, exposed externally via Tailscale.
 *
 * Required Railway env vars:
 *   OBSIDIAN_BRIDGE_URL  — e.g. http://100.x.x.x:27123
 *   OBSIDIAN_API_KEY     — API key from the plugin settings
 */

import { z } from 'zod';

export const searchObsidianSchema = z.object({
  query: z.string().min(1).describe('Full-text search query to run against the Obsidian vault'),
  limit: z.number().int().min(1).max(50).default(5).describe('Max results to return (default 5, max 50)'),
});

export interface ObsidianResult {
  title:   string;
  path:    string;
  excerpt: string;
  tags:    string[];
}

interface ObsidianSearchMatch {
  match:   { start: number; end: number };
  context: string;
}

interface ObsidianSearchItem {
  filename: string;
  score:    number;
  matches:  ObsidianSearchMatch[];
}

export async function searchObsidian(
  input: z.infer<typeof searchObsidianSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const bridgeUrl = process.env.OBSIDIAN_BRIDGE_URL?.replace(/\/$/, '');
  const apiKey    = process.env.OBSIDIAN_API_KEY;

  if (!bridgeUrl || !apiKey) {
    return {
      content: [{ type: 'text' as const, text: 'Obsidian bridge not configured. Set OBSIDIAN_BRIDGE_URL and OBSIDIAN_API_KEY env vars on Railway.' }],
      structuredContent: { results: [], message: 'Obsidian bridge not configured. Set OBSIDIAN_BRIDGE_URL and OBSIDIAN_API_KEY env vars on Railway.' },
    };
  }

  const url = `${bridgeUrl}/search/simple/?query=${encodeURIComponent(input.query)}&contextLength=200`;

  let raw: ObsidianSearchItem[];
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept':        'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Obsidian bridge returned ${res.status}: ${body.slice(0, 200)}`);
    }

    raw = await res.json() as ObsidianSearchItem[];
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new Error('Obsidian bridge timed out after 8 s. Check that Tailscale is up and the vault is running.');
    }
    throw err;
  }

  const results: ObsidianResult[] = raw.slice(0, input.limit).map((item) => {
    // Derive a clean title from the filename (strip path prefix and .md)
    const parts = item.filename.split('/');
    const title = (parts[parts.length - 1] ?? item.filename).replace(/\.md$/i, '');

    // Best excerpt: the context with the highest-scoring match
    const excerpt = item.matches?.[0]?.context?.trim() ?? '';

    // Tags are not returned by the simple search endpoint — callers can use
    // get_video or a separate Obsidian API call to retrieve frontmatter.
    return { title, path: item.filename, excerpt, tags: [] };
  });

  const text = results.length === 0
    ? `No Obsidian notes found for "${input.query}".`
    : results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   Path: ${r.path}\n   ${r.excerpt}`
      ).join('\n\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { results } as unknown as Record<string, unknown>,
  };
}

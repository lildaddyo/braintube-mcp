/**
 * Tool profiles: which tools a session registers in tools/list.
 *
 *   core  — default for every non-admin session. Ten everyday tools plus two
 *           router tools (braintube_find_tools / braintube_run_tool) that reach
 *           the other READ-ONLY tools on demand. Keeps tool definitions small:
 *           selection accuracy drops past ~30 tools and large definition sets
 *           cost every chat thousands of tokens.
 *   full  — every tool the user's role allows (the pre-3.16 behaviour). Opt in
 *           with `?tools=full` on the MCP URL or the `X-BrainTube-Tools: full`
 *           header. Admins get `full` by default (`?tools=core` opts out).
 *
 * Nothing is removed: non-core write tools (bulk_ingest, toggle_bookmark,
 * ingest_notion_page, set_notion_api_key, connect_readwise, sync_readwise,
 * compile_knowledge) are not routable and need `full`.
 */

import type { UserRole } from './security/tool-access.js';

export type ToolProfile = 'core' | 'full';

/** Registered in the core profile. `search` / `fetch` are the ChatGPT connector pair. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'fetch',
  'search_knowledge',
  'deep_search',
  'get_video',
  'search_by_date_range',
  'list_recent',
  'tag_item',
  'ingest_content',
  'add_note',
]);

export const ROUTER_TOOLS: ReadonlySet<string> = new Set([
  'braintube_find_tools',
  'braintube_run_tool',
]);

export const FULL_PROFILE_QUERY = 'tools=full';
export const PROFILE_HEADER = 'x-braintube-tools';

/**
 * The profile a client asked for, from `?tools=` or the X-BrainTube-Tools
 * header (query wins). Anything other than "full" / "core" is ignored.
 */
export function requestedProfile(
  query: Record<string, unknown> | undefined,
  headers: Record<string, unknown> | undefined,
): ToolProfile | undefined {
  const pick = (v: unknown): ToolProfile | undefined => {
    const s = (Array.isArray(v) ? v[0] : v);
    if (typeof s !== 'string') return undefined;
    const t = s.trim().toLowerCase();
    return t === 'full' || t === 'core' ? t : undefined;
  };
  return pick(query?.tools) ?? pick(headers?.[PROFILE_HEADER]);
}

/** Admins default to full; everyone else to core. An explicit request wins. */
export function resolveProfile(role: UserRole, requested?: ToolProfile): ToolProfile {
  if (requested) return requested;
  return role === 'admin' ? 'full' : 'core';
}

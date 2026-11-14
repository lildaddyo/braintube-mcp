/**
 * Which MCP client is calling: read from the MCP `initialize` request's clientInfo.name, with the
 * User-Agent as a fallback. Normalised to a short label so usage can be counted per client
 * (mcp_audit_log.client) without storing free text a client chose.
 */

const RULES: Array<[RegExp, string]> = [
  [/claude[-_ ]?code/i, 'claude-code'],
  [/claude/i, 'claude'],
  [/anthropic/i, 'claude'],
  [/openai|chatgpt/i, 'chatgpt'],
  [/cursor/i, 'cursor'],
  [/windsurf|codeium/i, 'windsurf'],
  [/visual studio code|vscode|vs code|copilot/i, 'vscode'],
  [/gemini/i, 'gemini'],
  [/zed/i, 'zed'],
  [/cline/i, 'cline'],
  [/continue/i, 'continue'],
  [/glama/i, 'glama'],
  [/smithery/i, 'smithery'],
  [/inspector/i, 'mcp-inspector'],
  [/obsidian/i, 'obsidian'],
  [/curl|python-requests|httpx|node-fetch|undici|axios/i, 'script'],
];

export function classifyClient(clientName?: unknown, userAgent?: unknown): string {
  for (const raw of [clientName, userAgent]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const s = raw.slice(0, 200);
    for (const [re, label] of RULES) if (re.test(s)) return label;
  }
  return typeof clientName === 'string' && clientName.trim() ? 'other' : 'unknown';
}

/** clientInfo.name from a JSON-RPC body when it is (or contains) an initialize request. */
export function initializeClientName(body: unknown): string | undefined {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize') {
      const name = (m as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo?.name;
      if (typeof name === 'string') return name;
    }
  }
  return undefined;
}

/** REST path → stable label for metering: ids (uuids, long hex, numbers) become ':id', max 3 segments. */
export function restRouteLabel(path: string): string {
  const segs = path.split('/').filter(Boolean).slice(0, 3).map((seg) =>
    /^[0-9a-f-]{16,}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg.slice(0, 40));
  return '/' + segs.join('/');
}

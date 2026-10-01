/**
 * Origin validation for the MCP endpoint (MCP Streamable HTTP transport spec:
 * servers MUST validate the Origin header to prevent DNS-rebinding attacks;
 * also a requirement of the Anthropic Connectors Directory).
 *
 * Server-to-server callers — Claude.ai / Claude Desktop connectors (which call
 * from Anthropic's cloud), Cursor, CLI clients — send no Origin header and are
 * unaffected. A request that DOES carry an Origin is accepted only when that
 * origin is on the allowlist below; everything else gets 403.
 */

const EXACT_ORIGINS = new Set([
  'https://claude.ai',
  'https://claude.com',
  'https://www.claude.com',
  'https://brain-tube.com',
  'https://www.brain-tube.com',
  'https://app.brain-tube.com',
  'https://mcp.brain-tube.com',
]);

/** Host suffixes allowed over https (subdomains only, never look-alikes). */
const HTTPS_SUFFIXES = ['.claude.ai', '.claude.com', '.brain-tube.com'];

/** Non-web schemes used by browser extensions and desktop apps (Electron, Tauri). */
const APP_SCHEMES = new Set([
  'chrome-extension:',
  'moz-extension:',
  'vscode-file:',
  'vscode-webview:',
  'app:',
  'tauri:',
  'file:',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  // No Origin header: not a browser cross-origin request.
  if (origin === undefined || origin === null || origin === '') return true;

  if (EXACT_ORIGINS.has(origin)) return true;

  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }

  if (APP_SCHEMES.has(u.protocol)) return true;

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (LOOPBACK_HOSTS.has(u.hostname) || u.hostname === '::1') return true;
  }

  if (u.protocol === 'https:' && u.port === '') {
    const host = u.hostname.toLowerCase();
    if (HTTPS_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) {
      return true;
    }
  }

  return false;
}

// Minimal structural types so this module has no runtime dependencies.
interface OriginRequest { headers: Record<string, string | string[] | undefined> }
interface OriginResponse { status(code: number): { json(body: unknown): unknown } }

/** Express middleware: reject MCP requests whose Origin is not allowlisted. */
export function validateMcpOrigin(req: OriginRequest, res: OriginResponse, next: () => void): void {
  const raw = req.headers['origin'];
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (isAllowedOrigin(origin)) {
    next();
    return;
  }
  console.warn(`[origin] rejected MCP request from Origin ${JSON.stringify(origin)}`);
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: `Forbidden: Origin ${origin} is not allowed to call this MCP server.` },
    id: null,
  });
}

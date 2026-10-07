/**
 * GET /mcp from a web browser.
 *
 * MCP clients talk to /mcp with JSON-RPC or an SSE stream and get the 401 + OAuth discovery
 * headers from requireAuth. A person pasting the URL into a tab used to see only that raw 401
 * JSON, which reads like a broken server. A navigation GET (Accept: text/html, no credentials,
 * no session) now gets a short page that says what the endpoint is and how to connect.
 * Clients never send text/html without text/event-stream, so their behaviour is unchanged.
 */

import type { NextFunction, Request, Response } from 'express';

export function isBrowserNavigation(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const accept = String(req.headers.accept ?? '');
  if (!accept.includes('text/html') || accept.includes('text/event-stream')) return false;
  if (req.headers.authorization || req.headers['x-braintube-token'] || req.headers['mcp-session-id']) return false;
  if (typeof req.query.token === 'string') return false;
  return true;
}

export const LANDING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BrainTube MCP server</title>
<style>
body{font:16px/1.55 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1a1a2e}
h1{font-size:24px;margin:0 0 4px}code,pre{background:#f1effb;border-radius:6px;padding:2px 6px;font-size:14px}
pre{padding:12px;overflow-x:auto}.muted{color:#5b5b73}a{color:#5b3fd1}
</style></head><body>
<h1>BrainTube MCP server</h1>
<p class="muted">This is the live endpoint your AI app connects to. It is not a web page, so there is nothing to sign in to here.</p>
<h2>Connect Claude</h2>
<ol>
<li>Open <b>Settings → Connectors → Add custom connector</b>.</li>
<li>Paste <code>https://mcp.brain-tube.com/mcp</code> and add it.</li>
<li>Choose <b>Connect</b> and sign in with your BrainTube account. No API key needed.</li>
</ol>
<h2>Claude Code</h2>
<pre>claude mcp add --transport http braintube https://mcp.brain-tube.com/mcp</pre>
<p>Then run <code>/mcp</code> and authenticate.</p>
<p>No account yet? <a href="https://app.brain-tube.com">app.brain-tube.com</a> · More about BrainTube: <a href="https://brain-tube.com">brain-tube.com</a> · <a href="https://brain-tube.com/guide/give-your-ai-memory-mcp">Setup guide</a></p>
<p class="muted">Status: <a href="/health">/health</a></p>
</body></html>`;

export function mcpBrowserLanding(req: Request, res: Response, next: NextFunction): void {
  if (!isBrowserNavigation(req)) { next(); return; }
  res.status(200).type('html').set('Cache-Control', 'public, max-age=300').send(LANDING_HTML);
}

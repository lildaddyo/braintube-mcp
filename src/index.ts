import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';
import { getAuthContext } from './auth/jwt.js';
import { handleObsidianSync } from './routes/obsidian-sync.js';
import { oauthRouter } from './routes/oauth.js';
import { serverCardRouter } from './routes/server-card.js';
import { glamaRouter } from './routes/glama.js';
import { restRouter } from './routes/rest.js';
import { buildOpenApiSpec } from './routes/openapi.js';
import { ingestContent } from './tools/ingest.js';
import { summariseConversation } from './tools/summarise.js';
import { backfillEmbeddings } from './tools/embedding.js';
import type { AuthContext } from './types.js';

// Resolve package.json relative to this file so /health reports the actual
// shipped version. Built file lives at dist/index.js, source at src/index.ts —
// '..' lands on the repo root in both cases.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

const app = express();
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for OAuth login form POST

// ─── CORS for browser extension and dashboard origins ─────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '';
  // Allow chrome/firefox extensions, the BrainTube web app, and local dev
  if (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin === 'https://brain-tube.com' ||
    origin === 'https://www.brain-tube.com' ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-BrainTube-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Keyed on userId so each user gets their own independent bucket.
// 60 tool calls per user per 15-minute rolling window.
// Auth middleware always runs first, so auth.userId is present when limit fires.
const mcpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  limit: 60,                   // 60 tool calls per window per user
  keyGenerator: (req) => (req as express.Request & { auth?: AuthContext }).auth?.userId ?? 'unauthenticated',
  skip: (req) => !(req as express.Request & { auth?: AuthContext }).auth,
  validate: { xForwardedForHeader: false },
  message: { error: 'Rate Limited', message: 'Rate limit: 60 tool calls per 15 minutes per user. Please wait before retrying.' },
  standardHeaders: true,   // sends RateLimit-* headers so clients can back off
  legacyHeaders: false
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const auth = await getAuthContext(req);
  if (!auth) {
    res.set(
      'WWW-Authenticate',
      'Bearer realm="BrainTube MCP", resource_metadata="https://mcp.brain-tube.com/.well-known/oauth-protected-resource"'
    );
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Provide a valid BrainTube JWT via: (1) Authorization: Bearer <token> header, (2) X-BrainTube-Token header, or (3) ?token=<jwt> query parameter'
    });
    return;
  }
  (req as express.Request & { auth: AuthContext }).auth = auth;
  next();
}

// ─── Smithery server card (public, no auth) ───────────────────────────────────
// Serves /.well-known/mcp/server-card.json so Smithery can populate the listing
// without performing a live MCP scan (which hangs on OAuth discovery).
app.use(serverCardRouter);

// ─── Glama connector ownership verification (public, no auth) ────────────────
// Serves /.well-known/glama.json per Glama's documented claim mechanism.
app.use(glamaRouter);

// ─── OAuth 2.0 Authorization Server ──────────────────────────────────────────
// Handles /.well-known/oauth-authorization-server, /oauth/register,
// /oauth/authorize (GET login form + POST submit), /oauth/token
app.use(oauthRouter);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'braintube-mcp',
    version: pkg.version,
    timestamp: new Date().toISOString()
  });
});

// ─── OpenAPI spec (public — no auth required) ────────────────────────────────
app.get('/openapi.json', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host  = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${proto}://${req.headers.host}`;
  res.json(buildOpenApiSpec(host));
});

// ─── REST API layer ───────────────────────────────────────────────────────────
// All routes require auth + rate limiting (applied here, not in the router itself).
// Existing specific /api/* routes (extension-ingest, backfill, obsidian-sync)
// are registered after and take precedence for their exact paths.
app.use('/api', requireAuth, mcpRateLimit, restRouter);

// ─── MCP session store ────────────────────────────────────────────────────────
// Maps Mcp-Session-Id → live transport so that tools/list, tools/call, etc.
// hit the same McpServer instance that handled `initialize`.
// Without this, each POST creates a fresh uninitialized server and tools/list
// returns [] because the MCP state machine rejects calls before initialize.
const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

// Prune the session store hourly to avoid unbounded memory growth on Railway.
setInterval(() => {
  const before = mcpSessions.size;
  mcpSessions.clear();
  if (before > 0) console.error(`[mcp] session store pruned (${before} sessions evicted)`);
}, 60 * 60 * 1000).unref();

// ─── MCP endpoints ────────────────────────────────────────────────────────────

app.post('/mcp', requireAuth, mcpRateLimit, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthContext }).auth;

  // Re-use an existing session if the client provides Mcp-Session-Id.
  // Express lower-cases incoming headers, so the key is 'mcp-session-id'.
  const incomingSessionId = req.headers['mcp-session-id'] as string | undefined;
  if (incomingSessionId) {
    const existing = mcpSessions.get(incomingSessionId);
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    // Unknown session — client must re-initialize (e.g. after server restart).
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session not found — please re-initialize.' },
      id: null,
    });
    return;
  }

  // New session: create transport + server, wire up session callbacks.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      mcpSessions.set(sessionId, transport);
      console.error(`[mcp] session created (${sessionId}) — ${mcpSessions.size} active`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      mcpSessions.delete(transport.sessionId);
      console.error(`[mcp] session closed (${transport.sessionId}) — ${mcpSessions.size} active`);
    }
  };

  const server = await createMcpServer(auth);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireAuth, mcpRateLimit, async (req, res) => {
  // GET is used by clients that open a persistent SSE stream for server→client pushes.
  const incomingSessionId = req.headers['mcp-session-id'] as string | undefined;
  if (incomingSessionId) {
    const existing = mcpSessions.get(incomingSessionId);
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
  }
  res.status(400).json({ error: 'Mcp-Session-Id header required for SSE stream.' });
});

// ─── Personal MCP URL info ────────────────────────────────────────────────────
// Called by BrainTube dashboard to show the user their MCP URL + setup instructions
app.get('/mcp-url', requireAuth, (req, res) => {
  const auth = (req as express.Request & { auth: AuthContext }).auth;
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  const mcpUrl = `${baseUrl}/mcp`;
  const mcpUrlWithToken = `${baseUrl}/mcp?token=<your-supabase-token>`;

  // Log auth method for debugging (never log the JWT itself or userId)
  console.error(`[mcp-url] request — method: ${auth.authMethod}, email: ${auth.email ?? 'unknown'}`);

  res.json({
    mcp_url: mcpUrl,
    auth_method: 'oauth2_or_query_param',
    instructions: {
      // Claude.ai supports native MCP OAuth — user clicks Connect, logs in once,
      // tokens refresh silently forever. No manual token pasting needed.
      claude_ai: `Add ${mcpUrl} as a custom connector. Claude.ai will show a Connect button and handle OAuth automatically.`,
      // Fallback for clients that support headers (Claude Code, Cursor, Gemini CLI)
      claude_code: `claude mcp add --transport http braintube ${mcpUrl} --header "Authorization: Bearer <your-supabase-token>"`,
      cursor: `{ "url": "${mcpUrl}", "headers": { "Authorization": "Bearer <your-supabase-token>" } }`,
      gemini_cli: `{ "mcpServers": { "braintube": { "url": "${mcpUrl}", "headers": { "Authorization": "Bearer <your-supabase-token>" } } } }`,
      // Legacy fallback — still works but requires manual refresh every hour
      claude_ai_legacy: `Add ${mcpUrlWithToken} as a connector URL (manual token, expires hourly).`,
    }
  });
});

// ─── Chrome extension ingest endpoint ────────────────────────────────────────
// Auth: Bearer <supabase-jwt>
// Body: { conversation_text, source_url, source_type, page_title? }
// Server summarises via ANTHROPIC_API_KEY, then stores the digest.
// Users need zero configuration — no API keys in the extension.
app.post('/api/extension-ingest', requireAuth, mcpRateLimit, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthContext }).auth;
  const { conversation_text, source_url, source_type, page_title } = req.body as {
    conversation_text?: string;
    source_url?: string;
    source_type?: string;
    page_title?: string;
  };

  if (!conversation_text || typeof conversation_text !== 'string' || conversation_text.trim().length < 50) {
    res.status(400).json({ error: 'conversation_text is required and must be at least 50 characters' });
    return;
  }

  const allowedTypes = [
    'note', 'manual', 'article', 'web', 'document', 'pdf', 'ebook',
    'research_paper', 'work', 'reddit', 'medium', 'substack', 'github',
    'notion', 'chatgpt', 'claude', 'gemini', 'wikipedia', 'bookmark'
  ] as const;
  type AllowedType = typeof allowedTypes[number];
  const resolvedType: AllowedType = allowedTypes.includes(source_type as AllowedType)
    ? (source_type as AllowedType)
    : 'manual';

  try {
    // Summarise server-side — ANTHROPIC_API_KEY never leaves the server
    const { title, summary } = await summariseConversation(
      conversation_text.trim(),
      resolvedType
    );

    // Use page title as a hint if the summary title extraction fails
    const finalTitle = title || (page_title?.trim().slice(0, 120)) || 'AI Conversation';

    const result = await ingestContent(
      {
        title: finalTitle,
        content: summary,
        source_url: source_url ?? undefined,
        source_type: resolvedType,
        tags: ['ai-conversation', resolvedType, 'extension-capture'],
        force_new: false,
      },
      auth.userId
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[extension-ingest] error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ─── Backfill embeddings endpoint ────────────────────────────────────────────
// POST /api/backfill — triggers backfillEmbeddings for the authenticated user.
// Returns { embedded, errors, firstError? } when done.
// Use this when backfill_embeddings is beyond the 15-tool cap in claude.ai.
app.post('/api/backfill', requireAuth, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthContext }).auth;
  const batchSize = parseInt((req.query.batch_size as string) ?? '20', 10);
  console.error(`[backfill] starting for user ${auth.userId}, batchSize=${batchSize}`);
  try {
    const result = await backfillEmbeddings(auth.userId, batchSize);
    console.error(`[backfill] done — embedded=${result.embedded}, errors=${result.errors}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[backfill] error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ─── Obsidian sync REST endpoint ─────────────────────────────────────────────
// Auth: Bearer bt_<key> (API key, not JWT)
// Body: { notes: [{ path, title, content, tags, modified_at }] }
app.post('/api/obsidian-sync', handleObsidianSync);

// ─── Stdio transport (Glama quality-test harness runs `mcp-proxy -- node dist/index.js` and
// speaks MCP over stdin/stdout, not HTTP) ──────────────────────────────────────────────────
//
// Runs ALONGSIDE the HTTP server in the same process, always on — no TTY/isatty detection,
// since Railway's stdin is equally non-interactive and simply never receives input, which is
// harmless (the underlying StdioServerTransport only reacts to data it's given).
//
// stdout is reserved exclusively for JSON-RPC frames written by StdioServerTransport.send().
// Every console.log in this codebase's runtime graph (excluding the standalone
// src/cron/rnd-daily.ts process, which never shares this process's stdout) was moved to
// console.error for this reason — a single stray stdout write mid-session would corrupt the
// stdio client's JSON-RPC stream.
//
// Auth: BRAINTUBE_API_KEY env var, validated via the same getAuthContext() used for the
// X-BrainTube-Token HTTP header (fed a minimal fake Request — no header-parsing duplicated).
// If unset or invalid, initialize/tools-list still succeed (createMcpServer() never requires
// a real user — resolveUserRole() degrades to 'authenticated' on any DB error), but tools/call
// is intercepted before it reaches the server and answered with a clean auth-required MCP
// error instead of running a handler against a fake/empty user id.

class GatedStdioTransport implements Transport {
  private inner = new StdioServerTransport();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  constructor(private authorized: boolean) {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => {
      const isToolCall =
        'method' in message && message.method === 'tools/call' && 'id' in message;
      if (isToolCall && !this.authorized) {
        void this.inner.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{
              type: 'text',
              text: 'Auth required: set BRAINTUBE_API_KEY (a BrainTube API key) in this server\'s environment to call tools over stdio.',
            }],
            isError: true,
          },
        });
        return;
      }
      this.onmessage?.(message);
    };
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    // StdioServerTransport.send() takes no options param (no resumption tokens over stdio).
    return this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

async function bootStdio(): Promise<void> {
  // Defensive no-ops: Railway's stdin is inert and these events are not expected there, but if
  // they ever fire (or fire under Glama's harness after it disconnects), never let them take
  // the process down — the HTTP server must keep running regardless.
  process.stdin.on('end', () => console.error('[stdio] stdin ended — HTTP transport unaffected'));
  process.stdin.on('close', () => console.error('[stdio] stdin closed — HTTP transport unaffected'));
  process.stdin.on('error', (err) => console.error('[stdio] stdin error (non-fatal):', err.message));

  const apiKey = process.env.BRAINTUBE_API_KEY;
  let auth: AuthContext = { userId: '', authMethod: 'apikey' };
  let authorized = false;

  if (apiKey) {
    const fakeReq = { headers: { 'x-braintube-token': apiKey } } as unknown as express.Request;
    const ctx = await getAuthContext(fakeReq);
    if (ctx) {
      auth = ctx;
      authorized = true;
    } else {
      console.error('[stdio] BRAINTUBE_API_KEY set but invalid — tool calls will return an auth-required error');
    }
  } else {
    console.error('[stdio] BRAINTUBE_API_KEY not set — initialize/tools-list available, tool calls will return an auth-required error');
  }

  const server = await createMcpServer(auth);
  const transport = new GatedStdioTransport(authorized);
  transport.onerror = (err) => console.error('[stdio] transport error (non-fatal):', err.message);
  transport.onclose = () => console.error('[stdio] transport closed — HTTP transport unaffected');

  await server.connect(transport);
  console.error(`[stdio] MCP stdio transport connected (authorized=${authorized})`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.error(`BrainTube MCP v3 running on port ${PORT}`);
  console.error(`Health:   http://localhost:${PORT}/health`);
  console.error(`MCP:      http://localhost:${PORT}/mcp`);
  console.error(`MCP URL:  http://localhost:${PORT}/mcp-url`);
  console.error(`Obsidian: http://localhost:${PORT}/api/obsidian-sync`);
});

bootStdio().catch((err) => {
  console.error('[stdio] failed to start stdio transport (HTTP transport unaffected):', err instanceof Error ? err.message : String(err));
});

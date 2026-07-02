import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { getAuthContext } from './auth/jwt.js';
import { handleObsidianSync } from './routes/obsidian-sync.js';
import { oauthRouter } from './routes/oauth.js';
import { serverCardRouter } from './routes/server-card.js';
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
  if (before > 0) console.log(`[mcp] session store pruned (${before} sessions evicted)`);
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
      console.log(`[mcp] session created (${sessionId}) — ${mcpSessions.size} active`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      mcpSessions.delete(transport.sessionId);
      console.log(`[mcp] session closed (${transport.sessionId}) — ${mcpSessions.size} active`);
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
  console.log(`[mcp-url] request — method: ${auth.authMethod}, email: ${auth.email ?? 'unknown'}`);

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
  console.log(`[backfill] starting for user ${auth.userId}, batchSize=${batchSize}`);
  try {
    const result = await backfillEmbeddings(auth.userId, batchSize);
    console.log(`[backfill] done — embedded=${result.embedded}, errors=${result.errors}`);
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BrainTube MCP v3 running on port ${PORT}`);
  console.log(`Health:   http://localhost:${PORT}/health`);
  console.log(`MCP:      http://localhost:${PORT}/mcp`);
  console.log(`MCP URL:  http://localhost:${PORT}/mcp-url`);
  console.log(`Obsidian: http://localhost:${PORT}/api/obsidian-sync`);
});

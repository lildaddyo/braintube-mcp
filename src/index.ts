import express from 'express';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { getAuthContext } from './auth/jwt.js';
import { handleObsidianSync } from './routes/obsidian-sync.js';
import { oauthRouter } from './routes/oauth.js';
import { ingestContent } from './tools/ingest.js';
import { summariseConversation } from './tools/summarise.js';
import { backfillEmbeddings } from './tools/embedding.js';
import type { AuthContext } from './types.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for OAuth login form POST

// ─── CORS for browser extension and dashboard origins ─────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '';
  // Allow chrome/firefox extensions and the BrainTube web app
  if (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin === 'https://brain-tube.com' ||
    origin === 'https://www.brain-tube.com'
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
// Keyed on userId so each user gets their own 100 req/min bucket
const mcpRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  // Auth middleware always runs first, so auth.userId is always present here
  keyGenerator: (req) => (req as express.Request & { auth?: AuthContext }).auth?.userId ?? 'unauthenticated',
  skip: (req) => !(req as express.Request & { auth?: AuthContext }).auth,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too Many Requests', message: 'Rate limit: 100 requests per minute per user' },
  standardHeaders: true,
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
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Provide a valid BrainTube JWT via: (1) Authorization: Bearer <token> header, (2) X-BrainTube-Token header, or (3) ?token=<jwt> query parameter'
    });
    return;
  }
  (req as express.Request & { auth: AuthContext }).auth = auth;
  next();
}

// ─── OAuth 2.0 Authorization Server ──────────────────────────────────────────
// Handles /.well-known/oauth-authorization-server, /oauth/register,
// /oauth/authorize (GET login form + POST submit), /oauth/token
app.use(oauthRouter);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'braintube-mcp',
    version: '3.3.0',
    timestamp: new Date().toISOString()
  });
});

// ─── MCP endpoints ────────────────────────────────────────────────────────────
app.post('/mcp', requireAuth, mcpRateLimit, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthContext }).auth;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(auth);
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireAuth, mcpRateLimit, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthContext }).auth;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(auth);
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
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
    'notion', 'chatgpt', 'claude', 'gemini', 'wikipedia'
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

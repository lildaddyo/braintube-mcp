import express from 'express';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { getAuthContext } from './auth/jwt.js';
import type { AuthContext } from './types.js';

const app = express();
app.use(express.json());

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
      message: 'Provide a valid BrainTube JWT via Authorization: Bearer <token> or X-BrainTube-Token header'
    });
    return;
  }
  (req as express.Request & { auth: AuthContext }).auth = auth;
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'braintube-mcp',
    version: '3.0.0',
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

  // Log auth method for debugging (never log the JWT itself or userId)
  console.log(`[mcp-url] request — method: ${auth.authMethod}, email: ${auth.email ?? 'unknown'}`);

  res.json({
    mcp_url: mcpUrl,
    auth_method: 'header',
    instructions: {
      claude_ai: `Add ${mcpUrl} as a custom connector. Set header: Authorization: Bearer <your-supabase-token>`,
      claude_code: `claude mcp add --transport http braintube ${mcpUrl} --header "Authorization: Bearer <your-supabase-token>"`,
      cursor: `{ "url": "${mcpUrl}", "headers": { "Authorization": "Bearer <your-supabase-token>" } }`,
      gemini_cli: `{ "mcpServers": { "braintube": { "url": "${mcpUrl}", "headers": { "Authorization": "Bearer <your-supabase-token>" } } } }`
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BrainTube MCP v3 running on port ${PORT}`);
  console.log(`Health:   http://localhost:${PORT}/health`);
  console.log(`MCP:      http://localhost:${PORT}/mcp`);
  console.log(`MCP URL:  http://localhost:${PORT}/mcp-url`);
});

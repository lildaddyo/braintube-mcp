# Connecting to BrainTube

Endpoint: `https://mcp.brain-tube.com/mcp` (MCP Streamable HTTP).

## Sign in with OAuth (recommended)

Clients with MCP OAuth support (Claude.ai, ChatGPT, Claude Code, Cursor and others) only need the
endpoint URL. Add it as a custom connector or MCP server and sign in to BrainTube when prompted.

Discovery documents:
- `https://mcp.brain-tube.com/.well-known/oauth-protected-resource`
- `https://mcp.brain-tube.com/.well-known/oauth-authorization-server`

## API key

Create a key at app.brain-tube.com → Settings → AI Integrations and send it in the
`X-BrainTube-Token` header. Keep it secret; revoke it in the same screen.

## Guides

- Setup per client: https://brain-tube.com/connect
- Long-term memory with MCP: https://brain-tube.com/guide/give-your-ai-memory-mcp
- Support: https://brain-tube.com/contact

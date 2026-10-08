# BrainTube MCP Server

**Save once. Query anywhere.** BrainTube compiles what you watch, read and listen to — YouTube videos, podcasts, articles, PDFs — into a persistent, searchable knowledge base, and this MCP server lets your AI search it and save to it over one endpoint.

- **Endpoint:** `https://mcp.brain-tube.com/mcp` (Streamable HTTP)
- **Version:** 3.12.4
- **Auth:** OAuth 2.0 (authorization code + PKCE) or a BrainTube API key via `X-BrainTube-Token` header
- **Discovery:** [`/.well-known/oauth-protected-resource`](https://mcp.brain-tube.com/.well-known/oauth-protected-resource) · [`/.well-known/oauth-authorization-server`](https://mcp.brain-tube.com/.well-known/oauth-authorization-server)

## What it does

Your AI can search and cite your own corpus instead of starting every conversation cold:

- **Semantic + keyword search** over everything you've saved, with citations back to the source
- **Save from your AI** — your AI can save what it finds into BrainTube, add notes and tag items in the same session
- **Knowledge graph & related-item traversal** across your corpus
- **Session context** — expertise profile, recent activity, and resurfacing tools
- **Per-user isolation** — JWT-scoped access; you only ever see your own corpus

## Quickstart

1. Create an account at [brain-tube.com](https://brain-tube.com) and get an API key (or use OAuth from a compatible client).
2. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "braintube": {
      "type": "http",
      "url": "https://mcp.brain-tube.com/mcp",
      "headers": { "X-BrainTube-Token": "bt_..." }
    }
  }
}
```

Tested with Claude; any client that speaks MCP streamable HTTP uses the same endpoint. In clients with OAuth support, just add the endpoint URL and sign in when prompted.

**Claude Code** — one command:

```bash
claude mcp add --transport http --scope user braintube https://mcp.brain-tube.com/mcp   --header "X-BrainTube-Token: bt_..."
```

**Claude.ai** — Customize → Connectors → + Add → Add custom connector, paste the endpoint, sign in. No API key needed.

Step-by-step setup for each client, plus how BrainTube compares with other MCP memory servers: [How to give Claude long-term memory with MCP](https://brain-tube.com/guide/give-your-ai-memory-mcp).

## Links

- Website: [brain-tube.com](https://brain-tube.com)
- MCP setup guide: [brain-tube.com/connect](https://brain-tube.com/connect)
- Official MCP registry: `io.github.lildaddyo/braintube-mcp`
- Support: [brain-tube.com/contact](https://brain-tube.com/contact)

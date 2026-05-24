const MARKDOWN = `# Connect BrainTube to Any AI

Your knowledge base becomes a universal MCP server. Set up in 60 seconds.

Works with: Claude · Cursor · Windsurf · ChatGPT · Obsidian

## What is MCP?

**Model Context Protocol (MCP)** is a standard that lets AI tools connect to external data sources. Think of it as USB-C for AI — one protocol, every tool.

When you connect BrainTube via MCP, your AI can search your saved content, chat with your brains, and retrieve knowledge — all from within the AI tool you're already using.

\`BrainTube ⟶ MCP Server ⟶ Claude / Cursor / Windsurf\`

## Setup Guides

### Claude Desktop

1. **Open Claude Desktop settings** — Settings → Developer → Edit Config
2. **Add BrainTube to your MCP config** — Add this to \`claude_desktop_config.json\`:


\`\`\`json
{
  "mcpServers": {
    "braintube": {
      "url": "https://braintube-mcp-production.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`


3. **Replace \`YOUR_API_KEY\`** — Generate at brain-tube.com/settings → API Keys
4. **Restart Claude Desktop**
5. **Try it** — Ask Claude: *"Search my BrainTube brains for information about transformers"*

Same config shape works for Cursor, Windsurf, ChatGPT (API), and Obsidian.

## Available MCP Tools

| Tool | Description |
|------|-------------|
| \`search\` | Semantic search across all brains |
| \`smart_resurface\` | Items due for spaced repetition review |
| \`get_knowledge_graph\` | Retrieve knowledge graph connections |
| \`brain_chat\` | Chat with a specific brain |
| \`list_brains\` | List all user brains with stats |
| \`get_item\` | Get full item details with enrichment data |

## Endpoint & Auth

- **MCP endpoint:** \`https://braintube-mcp-production.up.railway.app/mcp\`
- **Auth:** \`Authorization: Bearer YOUR_API_KEY\` header
- **API keys:** brain-tube.com/settings → API Keys
`;

const HEADERS = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method === "GET") {
    return new Response(MARKDOWN, { status: 200, headers: HEADERS });
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: HEADERS });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: { "Content-Type": "text/plain" },
  });
});

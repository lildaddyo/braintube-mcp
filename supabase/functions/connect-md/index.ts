const MARKDOWN = `# Connect BrainTube to your AI

The canonical, always-current MCP setup guide lives at:

**https://brain-tube.com/connect.md** (raw markdown)

Human-readable version: **https://brain-tube.com/connect**

MCP endpoint: \`https://mcp.brain-tube.com/mcp\`

Tested with Claude; any client that speaks MCP streamable HTTP uses the same endpoint.

This copy is intentionally a pointer. It is not maintained separately.
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

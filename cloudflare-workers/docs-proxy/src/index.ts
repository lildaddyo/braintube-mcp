const UPSTREAM = "https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/connect-md";

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type",
        },
      });
    }

    // Only serve /connect.md
    if (url.pathname !== "/connect.md") {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Fetch from upstream Supabase function
    const upstream = await fetch(UPSTREAM, {
      method: request.method,
      headers: { "User-Agent": "braintube-docs-proxy/1.0" },
    });

    if (!upstream.ok) {
      return new Response(`Upstream error: ${upstream.status}`, {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // For HEAD requests, return no body but correct headers
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: RESPONSE_HEADERS,
      });
    }

    const body = await upstream.text();

    // Explicitly set our own headers — do NOT trust upstream headers
    return new Response(body, {
      status: 200,
      headers: RESPONSE_HEADERS,
    });
  },
} satisfies ExportedHandler;

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
// Generous but bounded — Claude 4 has 200k context so this is fine
const MAX_TRANSCRIPT_CHARS = 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

    // ── Auth ────────────────────────────────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: { user } } = await anonClient.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    const { messages, itemId } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── RAG context from items + transcript_segments ─────────────────────────
    let contextBlock = "";
    if (itemId) {
      const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

      // Item metadata — verify ownership via user_id
      const { data: item } = await db
        .from("items")
        .select("title, channel, summary, key_takeaways")
        .eq("id", itemId)
        .eq("user_id", user.id)
        .single();

      if (item) {
        contextBlock += `## Video\nTitle: ${item.title ?? "Unknown"}\n`;
        if (item.channel) contextBlock += `Channel: ${item.channel}\n`;
        if (item.summary) contextBlock += `\nSummary:\n${item.summary}\n`;
        if (item.key_takeaways?.length) {
          contextBlock +=
            `\nKey Takeaways:\n${(item.key_takeaways as string[]).map((t) => `- ${t}`).join("\n")}\n`;
        }
      }

      // Transcript segments — ordered by time, capped by character budget
      const { data: segments } = await db
        .from("transcript_segments")
        .select("text, start_time_sec")
        .eq("item_id", itemId)
        .order("segment_index")
        .limit(500); // fetch generously, trim by chars below

      if (segments?.length) {
        let transcriptText = "";
        for (const s of segments as Array<{ text: string; start_time_sec: number }>) {
          const m = Math.floor(s.start_time_sec / 60);
          const sec = Math.floor(s.start_time_sec % 60);
          const line = `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}\n`;
          if (transcriptText.length + line.length > MAX_TRANSCRIPT_CHARS) break;
          transcriptText += line;
        }
        if (transcriptText) contextBlock += `\n## Transcript\n${transcriptText}`;
      }
    }

    const systemPrompt =
      `You are BrainTube AI, a knowledge assistant that answers questions about YouTube videos the user has saved.` +
      (contextBlock ? `\n\n${contextBlock}` : "") +
      `\n\nGuidelines:
- Be concise but thorough
- Reference specific timestamps when available (e.g. "at 2:34")
- If the context doesn't contain the answer, say so honestly
- Use markdown formatting for readability`;

    // ── Call Anthropic with streaming ────────────────────────────────────────
    const anthropicResp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        // Strip any system-role messages — Anthropic takes system separately
        messages: messages
          .filter((m: { role: string }) => m.role !== "system")
          .map((m: { role: string; content: string }) => ({
            role: m.role,
            content: m.content,
          })),
        stream: true,
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      console.error("[chat] Anthropic error:", anthropicResp.status, errText);
      const status = anthropicResp.status === 429 ? 429 : 500;
      const msg = anthropicResp.status === 429
        ? "Rate limited — please try again shortly."
        : `AI error ${anthropicResp.status}: ${errText.slice(0, 200)}`;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Translate Anthropic SSE → OpenAI-style SSE ───────────────────────────
    // Anthropic:  data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}
    // OpenAI:     data: {"choices":[{"delta":{"content":"Hi"}}]}
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = anthropicResp.body!.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw) continue;
              try {
                const ev = JSON.parse(raw);
                if (
                  ev.type === "content_block_delta" &&
                  ev.delta?.type === "text_delta" &&
                  ev.delta.text
                ) {
                  const chunk = JSON.stringify({
                    choices: [{ delta: { content: ev.delta.text } }],
                  });
                  controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
                } else if (ev.type === "message_stop") {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
              } catch { /* ignore non-JSON lines (e.g. pings) */ }
            }
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { ...CORS, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("[chat] unhandled error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});

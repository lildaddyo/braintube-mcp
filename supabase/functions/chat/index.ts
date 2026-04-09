import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const MAX_TRANSCRIPT_CHARS = 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    // ── Secrets check ────────────────────────────────────────────────────────
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      console.error("[chat] FATAL: ANTHROPIC_API_KEY secret is not set in Supabase project secrets");
      return new Response(
        JSON.stringify({ error: "AI service not configured. Contact support." }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── Auth ─────────────────────────────────────────────────────────────────
    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !user) {
      console.error("[chat] Auth failed:", authError?.message);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body: { messages?: unknown; itemId?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { messages, itemId } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── RAG context: pull item + transcript in one query ─────────────────────
    let contextBlock = "";
    if (itemId) {
      const db = createClient(supabaseUrl, serviceKey);

      const { data: item, error: itemError } = await db
        .from("items")
        .select("title, channel, summary, key_takeaways, full_transcript")
        .eq("id", itemId)
        .eq("user_id", user.id)  // ownership check
        .single();

      if (itemError) {
        console.error("[chat] items query error:", itemError.message);
        // Non-fatal: proceed without context
      } else if (item) {
        contextBlock += `## Video\nTitle: ${item.title ?? "Unknown"}\n`;
        if (item.channel) contextBlock += `Channel: ${item.channel}\n`;
        if (item.summary) contextBlock += `\nSummary:\n${item.summary}\n`;
        if (item.key_takeaways?.length) {
          contextBlock += `\nKey Takeaways:\n${
            (item.key_takeaways as string[]).map((t) => `- ${t}`).join("\n")
          }\n`;
        }

        // full_transcript is a single text column — fastest path
        if (item.full_transcript) {
          const transcript = item.full_transcript.slice(0, MAX_TRANSCRIPT_CHARS);
          contextBlock += `\n## Transcript\n${transcript}\n`;
        } else {
          // Fallback: stitch from transcript_segments
          const { data: segments, error: segErr } = await db
            .from("transcript_segments")
            .select("text, start_time_sec")
            .eq("item_id", itemId)
            .order("segment_index")
            .limit(500);

          if (segErr) {
            console.error("[chat] transcript_segments query error:", segErr.message);
          } else if (segments?.length) {
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
      }
    }

    const systemPrompt =
      `You are BrainTube AI, a knowledge assistant that answers questions about YouTube videos the user has saved.` +
      (contextBlock ? `\n\n${contextBlock}` : "") +
      `\n\nGuidelines:\n- Be concise but thorough\n- Reference specific timestamps when available (e.g. "at 2:34")\n- If the context doesn't contain the answer, say so honestly\n- Use markdown formatting for readability`;

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
        messages: (messages as Array<{ role: string; content: string }>)
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      console.error("[chat] Anthropic API error:", anthropicResp.status, errText);
      const msg = anthropicResp.status === 429
        ? "Rate limited — please try again shortly."
        : anthropicResp.status === 401
        ? "AI service authentication failed — check ANTHROPIC_API_KEY."
        : `AI error (${anthropicResp.status}): ${errText.slice(0, 200)}`;
      return new Response(JSON.stringify({ error: msg }), {
        status: anthropicResp.status === 429 ? 429 : 500,
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
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { content: ev.delta.text } }] })}\n\n`,
                    ),
                  );
                } else if (ev.type === "message_stop") {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
              } catch { /* ignore non-JSON ping lines */ }
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
    console.error("[chat] unhandled error:", e instanceof Error ? e.message : e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});

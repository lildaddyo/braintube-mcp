/**
 * handle-notion-webhook
 *
 * Receives POST requests from Notion webhooks when a page is created or updated.
 * Verifies the HMAC-SHA256 signature, fetches the updated page via the Notion API,
 * re-ingests the content into the items table, re-embeds vectors, and logs to ingest_log.
 *
 * Required Supabase secrets:
 *   NOTION_WEBHOOK_SECRET   — signing secret from Notion webhook configuration
 *   NOTION_API_KEY          — Notion integration token (secret_...)
 *   OPENAI_API_KEY          — for re-embedding
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateEmbeddings } from "../_shared/embeddings.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-notion-signature",
};

const NOTION_VERSION = "2022-06-28";
const MAX_BLOCKS = 300;

// ── Notion helpers ──────────────────────────────────────────────────────────

async function notionGet(path: string, token: string) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) throw new Error(`Notion API ${path} → ${res.status}`);
  return res.json();
}

function extractTitle(page: Record<string, unknown>): string {
  const props = page.properties as Record<string, unknown> | undefined;
  if (!props) return "Untitled";
  for (const key of ["title", "Title", "Name", "name"]) {
    const p = props[key] as Record<string, unknown> | undefined;
    const arr = (p?.title ?? p?.rich_text) as Array<{ plain_text?: string }> | undefined;
    if (arr?.length) return arr.map((t) => t.plain_text ?? "").join("") || "Untitled";
  }
  return "Untitled";
}

async function extractBlocks(pageId: string, token: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  let fetched = 0;

  while (fetched < MAX_BLOCKS) {
    const url = `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const data = await notionGet(url, token) as {
      results: Array<{ type: string; [key: string]: unknown }>;
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const block of data.results) {
      const richText = (block[block.type] as Record<string, unknown> | undefined)?.rich_text as
        Array<{ plain_text?: string }> | undefined;
      if (richText?.length) lines.push(richText.map((t) => t.plain_text ?? "").join(""));
    }

    fetched += data.results.length;
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return lines.filter(Boolean).join("\n");
}

// ── Signature verification ──────────────────────────────────────────────────

async function verifySignature(req: Request, rawBody: Uint8Array, secret: string): Promise<boolean> {
  const sig = req.headers.get("x-notion-signature") ?? req.headers.get("x-hub-signature-256") ?? "";
  if (!sig) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time comparison
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const webhookSecret = Deno.env.get("NOTION_WEBHOOK_SECRET");
  const notionKey     = Deno.env.get("NOTION_API_KEY");
  const supabaseUrl   = Deno.env.get("SUPABASE_URL")!;
  const serviceKey    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!webhookSecret || !notionKey) {
    console.error("[notion-webhook] Missing NOTION_WEBHOOK_SECRET or NOTION_API_KEY");
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Read raw body for signature verification
  const rawBody = new Uint8Array(await req.arrayBuffer());

  // Verify signature
  const valid = await verifySignature(req, rawBody, webhookSecret);
  if (!valid) {
    console.warn("[notion-webhook] Invalid signature");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Notion sends { entity: { id, type }, ... } or legacy { page: { id } }
  const pageId: string | undefined =
    (payload.entity as Record<string, unknown> | undefined)?.id as string ??
    (payload.page as Record<string, unknown> | undefined)?.id as string;

  if (!pageId) {
    console.warn("[notion-webhook] No page id in payload:", JSON.stringify(payload).slice(0, 200));
    return new Response(JSON.stringify({ error: "No page id" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const db = createClient(supabaseUrl, serviceKey);

  try {
    // 1. Fetch updated page from Notion
    const page = await notionGet(`/pages/${pageId}`, notionKey) as Record<string, unknown>;
    const title   = extractTitle(page);
    const content = await extractBlocks(pageId, notionKey);
    const url     = (page.url ?? `https://notion.so/${pageId.replace(/-/g, "")}`) as string;

    if (!content.trim()) {
      console.log(`[notion-webhook] Page ${pageId} has no extractable text — skipping`);
      return new Response(JSON.stringify({ skipped: true, reason: "empty content" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // 2. Find owning user by source_url match — the user who originally ingested this page
    const { data: existing } = await db
      .from("items")
      .select("id, user_id")
      .eq("source_url", url)
      .limit(1)
      .single();

    if (!existing) {
      console.log(`[notion-webhook] No existing item for url ${url} — cannot attribute to user`);
      return new Response(JSON.stringify({ skipped: true, reason: "no existing item" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { id: itemId, user_id: userId } = existing;
    const now = new Date().toISOString();

    // 3. Update item content
    await db.from("items").update({
      title,
      full_transcript: content,
      summary: content.slice(0, 500),
      updated_at: now,
    }).eq("id", itemId);

    // 4. Re-embed
    const [[embedding]] = await generateEmbeddings([`${title}\n\n${content.slice(0, 8000)}`]);
    if (embedding) {
      await db.from("item_embeddings").upsert({
        item_id: itemId,
        embedding,
        updated_at: now,
      }, { onConflict: "item_id" });
    }

    // 5. Log to ingest_log
    await db.from("ingest_log").insert({
      user_id:     userId,
      item_id:     itemId,
      source_type: "notion",
      action:      "updated",
      title,
    });

    console.log(`[notion-webhook] Re-ingested page "${title}" (item ${itemId})`);
    return new Response(JSON.stringify({ ok: true, item_id: itemId, title, action: "updated" }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[notion-webhook] Error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

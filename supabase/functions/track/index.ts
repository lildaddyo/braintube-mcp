/**
 * track — lightweight event ingestion for the BrainTube Chrome extension.
 *
 * Accepts: POST { event_name, event_data?, page_path? }
 * Auth:    Bearer <supabase-jwt>
 * Returns: 200 { ok: true } always (errors are logged server-side, never surfaced to client)
 *
 * Events are written to extension_events (created by migration).
 * If the insert fails for any reason the request still returns 200 so
 * trackEvent() in the extension never throws.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OK = new Response(JSON.stringify({ ok: true }), {
  headers: { ...CORS, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405, headers: { ...CORS, "Content-Type": "application/json" },
  });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!token) {
    // No auth — return 200 silently so extension doesn't error pre-login
    return OK;
  }

  const anonClient = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
  if (authError || !user) {
    // Invalid/expired token — still 200, just skip recording
    console.warn("[track] Invalid token:", authError?.message ?? "no user");
    return OK;
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { event_name?: string; event_data?: unknown; page_path?: string };
  try {
    body = await req.json();
  } catch {
    return OK; // malformed JSON — swallow silently
  }

  const { event_name, event_data, page_path } = body;
  if (!event_name || typeof event_name !== "string") {
    console.warn("[track] Missing or invalid event_name");
    return OK;
  }

  // ── Store event (best-effort) ─────────────────────────────────────────────
  try {
    const db = createClient(supabaseUrl, serviceKey);
    const { error } = await db.from("extension_events").insert({
      user_id:    user.id,
      event_name: event_name.slice(0, 100),
      event_data: event_data ?? {},
      page_path:  (page_path ?? "/extension").slice(0, 200),
    });
    if (error) console.error("[track] DB insert error:", error.message);
  } catch (err) {
    console.error("[track] Unexpected error:", err instanceof Error ? err.message : err);
  }

  return OK;
});

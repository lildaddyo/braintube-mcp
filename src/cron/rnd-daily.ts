/**
 * rnd-daily.ts — one-shot R&D enrichment cron.
 * Reads from `items`, writes ONLY to `rnd_daily`. Never touches `items`.
 * Railway schedule: "0 3 * * *" (03:00 UTC = 06:00 Sofia)
 */

import { createClient } from "@supabase/supabase-js";

// --- Config ------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY!;

const RND_USER_ID =
  process.env.RND_USER_ID ?? "160e3096-07f2-45ea-9371-2f438e2af686";
const RND_MAX_ITEMS = parseInt(process.env.RND_MAX_ITEMS ?? "25", 10);
const RND_COST_CEILING = parseFloat(process.env.RND_COST_CEILING ?? "5.00");

const RND_SOURCE_TYPES_DEFAULT = [
  "youtube", "article", "web", "medium", "substack", "devto", "hashnode",
  "github", "research_paper", "pdf", "ebook", "podcast", "audiobook",
  "claude", "chatgpt", "gemini", "notion", "obsidian", "readwise",
];
const RND_SOURCE_TYPES: string[] = process.env.RND_SOURCE_TYPES
  ? process.env.RND_SOURCE_TYPES.split(",").map((s: string) => s.trim())
  : RND_SOURCE_TYPES_DEFAULT;

// --- Cost estimates (USD) -----------------------------------------------------

const FIRECRAWL_COST_PER_PAGE = 0.002;
const PERPLEXITY_COST_PER_CALL = 0.005;

// --- DB client ----------------------------------------------------------------

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Sofia timezone window -> UTC bounds --------------------------------------

function yesterdaySofiaUtcBounds(): { start: string; end: string; runDate: string } {
  // Allow manual override for dry-run / backfill: RND_DATE_OVERRIDE=YYYY-MM-DD
  if (process.env.RND_DATE_OVERRIDE) {
    const runDate = process.env.RND_DATE_OVERRIDE;
    const refMidnightUtc = new Date(`${runDate}T00:00:00Z`);
    const sofiaMidnightStr = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Sofia",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(refMidnightUtc);
    const timePart = sofiaMidnightStr.split(", ")[1] ?? "03:00:00";
    const [h, m] = timePart.split(":").map(Number);
    const offsetMs = ((h * 60) + m) * 60 * 1000;
    const startUtc = new Date(refMidnightUtc.getTime() - offsetMs);
    const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
    return { start: startUtc.toISOString(), end: endUtc.toISOString(), runDate };
  }
  const now = new Date();
  const sofiaFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todaySofia = sofiaFormatter.format(now);
  const todayParts = todaySofia.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]));
  const yesterdayUtc = new Date(todayUtc);
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1);

  const pad = (n: number) => String(n).padStart(2, "0");
  const runDate = `${yesterdayUtc.getUTCFullYear()}-${pad(yesterdayUtc.getUTCMonth() + 1)}-${pad(yesterdayUtc.getUTCDate())}`;

  // Resolve exact UTC offset for Sofia on the run date
  const refMidnightUtc = new Date(`${runDate}T00:00:00Z`);
  const sofiaMidnightStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Sofia",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(refMidnightUtc);
  const timePart = sofiaMidnightStr.split(", ")[1] ?? "03:00:00";
  const [h, m] = timePart.split(":").map(Number);
  const offsetMs = ((h * 60) + m) * 60 * 1000;

  const startUtc = new Date(refMidnightUtc.getTime() - offsetMs);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);

  return { start: startUtc.toISOString(), end: endUtc.toISOString(), runDate };
}

// --- Firecrawl scrape ---------------------------------------------------------

async function firecrawlScrape(url: string): Promise<string | null> {
  if (!FIRECRAWL_API_KEY) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) {
      console.warn(`[firecrawl] ${res.status} for ${url}`);
      return null;
    }
    const data = await res.json() as { data?: { markdown?: string } };
    return data?.data?.markdown ?? null;
  } catch (err) {
    console.warn(`[firecrawl] error for ${url}:`, (err as Error).message);
    return null;
  }
}

// --- Perplexity deep-dive -----------------------------------------------------

interface PerplexityResult {
  synthesis: string;
  citations: Array<{ url: string; title?: string }>;
}

async function perplexityDeepDive(
  title: string,
  summary: string | null,
  transcript: string | null,
  taintLevel: number,
): Promise<PerplexityResult> {
  // TAINT GUARD: taint >= 2 -> use title + summary ONLY, never inject transcript
  const contextBody =
    taintLevel >= 2
      ? `Title: ${title}\nSummary: ${summary ?? "(none)"}`
      : `Title: ${title}\nSummary: ${summary ?? "(none)"}${
          transcript ? `\n\nExcerpt:\n${transcript.slice(0, 2000)}` : ""
        }`;

  const prompt = [
    "You are a research assistant. Given the following saved knowledge item,",
    "provide a concise deep-dive synthesis (3-5 paragraphs) covering:",
    "key concepts, current relevance, related developments, and actionable insights.",
    "Then list your sources.\n",
    contextBody,
  ].join(" ");

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      return_citations: true,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Perplexity ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: Array<string | { url: string; title?: string }>;
  };

  const synthesis = data.choices?.[0]?.message?.content ?? "";
  const rawCitations = data.citations ?? [];
  const citations = rawCitations.map((c: string | { url: string; title?: string }) =>
    typeof c === "string" ? { url: c } : { url: c.url, title: c.title },
  );

  return { synthesis, citations };
}

// --- Main --------------------------------------------------------------------

async function main() {
  console.log("[rnd-daily] starting");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[rnd-daily] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  if (!PERPLEXITY_API_KEY) {
    console.error("[rnd-daily] missing PERPLEXITY_API_KEY");
    process.exit(1);
  }

  const { start, end, runDate } = yesterdaySofiaUtcBounds();
  console.log(`[rnd-daily] window ${start} -> ${end} (run_date=${runDate})`);

  // Fetch yesterday items for this user
  const { data: candidates, error: fetchErr } = await db
    .from("items")
    .select("id, title, source_type, source_url, url, summary, full_transcript, taint_level, created_at")
    .eq("user_id", RND_USER_ID)
    .eq("is_archived", false)
    .gte("created_at", start)
    .lt("created_at", end)
    .order("created_at", { ascending: true });

  if (fetchErr) {
    console.error("[rnd-daily] fetch failed:", fetchErr.message);
    process.exit(1);
  }

  const all = candidates ?? [];
  console.log(`[rnd-daily] ${all.length} items in window`);

  // Source-type allowlist filter
  const allowed = all.filter((i: { source_type: string | null }) =>
    RND_SOURCE_TYPES.includes(i.source_type ?? ""));
  const skippedType = all.length - allowed.length;

  // Idempotency: skip already-processed items for this run_date
  const { data: existing } = await db
    .from("rnd_daily")
    .select("item_id")
    .eq("run_date", runDate)
    .eq("user_id", RND_USER_ID);

  const doneIds = new Set((existing ?? []).map((r: { item_id: string }) => r.item_id));
  const todo = allowed.filter((i: { id: string }) => !doneIds.has(i.id));
  const skippedIdempotent = allowed.length - todo.length;

  // Per-run cap
  const overflow = Math.max(0, todo.length - RND_MAX_ITEMS);
  const batch = todo.slice(0, RND_MAX_ITEMS);
  if (overflow > 0) {
    console.log(`[rnd-daily] overflow: ${overflow} items exceed cap=${RND_MAX_ITEMS}`);
  }

  let processed = 0;
  let failed = 0;
  let totalCost = 0;

  for (const item of batch) {
    if (totalCost >= RND_COST_CEILING) {
      console.warn(`[rnd-daily] cost ceiling $${RND_COST_CEILING} reached — stopping`);
      break;
    }

    console.log(`[rnd-daily] -> "${item.title}" (${item.source_type}, taint=${item.taint_level ?? 0})`);

    try {
      const sourceUrl: string | null = item.source_url ?? item.url ?? null;
      let firecrawlMd: string | null = null;
      let itemCost = PERPLEXITY_COST_PER_CALL;

      if (sourceUrl && FIRECRAWL_API_KEY) {
        firecrawlMd = await firecrawlScrape(sourceUrl);
        if (firecrawlMd) itemCost += FIRECRAWL_COST_PER_PAGE;
      }

      const { synthesis, citations } = await perplexityDeepDive(
        item.title,
        item.summary ?? null,
        item.full_transcript ?? null,
        item.taint_level ?? 0,
      );

      totalCost += itemCost;

      const { error: upsertErr } = await db
        .from("rnd_daily")
        .upsert(
          {
            item_id: item.id,
            user_id: RND_USER_ID,
            run_date: runDate,
            source_type: item.source_type,
            firecrawl_md: firecrawlMd,
            perplexity_synthesis: synthesis,
            citations,
            status: "ok",
            est_cost: itemCost,
          },
          { onConflict: "item_id,run_date" },
        );

      if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
      processed++;
    } catch (err) {
      failed++;
      console.error(`[rnd-daily] FAILED "${item.title}":`, (err as Error).message);
      await db.from("rnd_daily").upsert(
        {
          item_id: item.id,
          user_id: RND_USER_ID,
          run_date: runDate,
          source_type: item.source_type,
          firecrawl_md: null,
          perplexity_synthesis: null,
          citations: null,
          status: "failed",
          est_cost: 0,
        },
        { onConflict: "item_id,run_date" },
      );
    }
  }

  console.log("[rnd-daily] --- SUMMARY -------------------------------------------");
  console.log(`  run_date:   ${runDate}`);
  console.log(`  processed:  ${processed}`);
  console.log(`  skipped:    ${skippedType + skippedIdempotent} (${skippedType} type-filtered, ${skippedIdempotent} idempotent)`);
  console.log(`  failed:     ${failed}`);
  console.log(`  overflow:   ${overflow}`);
  console.log(`  est_cost:   $${totalCost.toFixed(4)}`);
  console.log("[rnd-daily] ---------------------------------------------------------");
}

main().catch(err => {
  console.error("[rnd-daily] fatal:", err);
  process.exit(1);
});



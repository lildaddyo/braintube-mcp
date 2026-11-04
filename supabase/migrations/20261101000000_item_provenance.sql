-- Trust boundary, part 1: provenance + a taint floor for saved content.
-- Audit 2026-11-01 (finding 1: persistent memory poisoning via agent write-back).
--
-- NOT applied by the PR that adds it. The owner applies it by hand after review.
-- braintube-mcp works before AND after it: until `provenance` exists the ingest gateway retries
-- writes without that column (src/lib/ingest-gateway.ts), and taint_level is written either way.
--
-- What it does
--   1. items.provenance: who wrote the text (user_typed | agent_written | third_party:<host> |
--      import:<source> | unrecorded). NULL on existing rows until the optional backfill runs.
--   2. item_notes, claude_sessions, session_rounds get provenance + taint_level too.
--   3. items.taint_level defaults to 1 (untrusted) instead of 0, so any writer that does not set
--      it (the readwise-sync edge function, older app code) is untrusted by default.
--   4. A trigger enforces the floor in the database: content that is not provenance =
--      'user_typed' can never be stored with taint_level 0, whoever writes it.
--
-- Action needed in the app (lildaddyo/dark-n-cozy): the code path where a person TYPES a note
-- in the BrainTube UI should insert provenance = 'user_typed', taint_level = 0. Without that,
-- those notes are stored as taint 1 (safe, but they show the "untrusted" label).

BEGIN;

-- 1. items ------------------------------------------------------------------------------------
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS provenance text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_provenance_format') THEN
    ALTER TABLE public.items
      ADD CONSTRAINT items_provenance_format
      CHECK (provenance IS NULL OR provenance ~ '^(user_typed|agent_written|unrecorded|third_party:[^\s]+|import:[a-z_]+)$')
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.items ALTER COLUMN taint_level SET DEFAULT 1;

COMMENT ON COLUMN public.items.provenance IS
  'Who wrote this text into BrainTube: user_typed (typed in the app UI, the only trusted value), agent_written (an AI client via MCP/REST), third_party:<host> (browser extension capture), import:<source> (notion/obsidian/readwise/claude_session). Set by braintube-mcp src/lib/ingest-gateway.ts, never by the caller.';

CREATE INDEX IF NOT EXISTS items_user_provenance ON public.items (user_id, provenance);

-- 2. notes and session archive ---------------------------------------------------------------
ALTER TABLE public.item_notes ADD COLUMN IF NOT EXISTS provenance text;
ALTER TABLE public.item_notes ADD COLUMN IF NOT EXISTS taint_level smallint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF to_regclass('public.claude_sessions') IS NOT NULL THEN
    ALTER TABLE public.claude_sessions ADD COLUMN IF NOT EXISTS provenance text;
    ALTER TABLE public.claude_sessions ADD COLUMN IF NOT EXISTS taint_level smallint NOT NULL DEFAULT 1;
  END IF;
  IF to_regclass('public.session_rounds') IS NOT NULL THEN
    ALTER TABLE public.session_rounds ADD COLUMN IF NOT EXISTS provenance text;
    ALTER TABLE public.session_rounds ADD COLUMN IF NOT EXISTS taint_level smallint NOT NULL DEFAULT 1;
  END IF;
END $$;

-- 3/4. Taint floor ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_taint_floor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.provenance IS DISTINCT FROM 'user_typed' THEN
    NEW.taint_level := GREATEST(COALESCE(NEW.taint_level, 1), 1);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS items_taint_floor ON public.items;
CREATE TRIGGER items_taint_floor
  BEFORE INSERT OR UPDATE OF title, summary, full_transcript, description, provenance, taint_level
  ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_taint_floor();

DROP TRIGGER IF EXISTS item_notes_taint_floor ON public.item_notes;
CREATE TRIGGER item_notes_taint_floor
  BEFORE INSERT OR UPDATE OF content, provenance, taint_level
  ON public.item_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_taint_floor();

COMMIT;

-- Follow-up for the owner (not done here, the RPCs live in the app's migrations):
--   add `provenance` (and taint_level where missing) to the columns returned by adaptive_search,
--   get_related_items and the other item RPCs, so MCP results report it directly. Until then the
--   envelope derives provenance from the `agent-written` tag and reports "unrecorded" otherwise.

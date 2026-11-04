-- Trust boundary, part 2 (OPTIONAL, review before applying): label existing rows.
-- Requires 20261101000000_item_provenance.sql. Not applied by the PR that adds it.
--
-- Before 2026-11-01, ingest_content / the extension / REST ingest stored agent-written text as
-- taint_level 0 with is_user_created = true, which is indistinguishable from text typed in the
-- app. ingest_log is the only record of which items came through those paths. bulk_ingest did NOT
-- write ingest_log, so items it created stay "unrecorded" below; they are still reported as
-- untrusted by the MCP envelope, which never trusts a row without provenance = 'user_typed'.
--
-- Run the SELECT first and check the counts look right.
--
--   SELECT l.source_type, count(DISTINCT i.id)
--   FROM public.items i JOIN public.ingest_log l ON l.item_id = i.id
--   WHERE i.provenance IS NULL GROUP BY 1 ORDER BY 2 DESC;

BEGIN;

UPDATE public.items i
SET provenance = CASE l.source_type
                   WHEN 'notion'   THEN 'import:notion'
                   WHEN 'obsidian' THEN 'import:obsidian'
                   ELSE 'agent_written'
                 END,
    taint_level = GREATEST(COALESCE(i.taint_level, 1), 1)
FROM (SELECT DISTINCT ON (item_id) item_id, source_type FROM public.ingest_log ORDER BY item_id, created_at DESC) l
WHERE l.item_id = i.id
  AND i.provenance IS NULL;

UPDATE public.items
SET provenance = 'import:readwise', taint_level = GREATEST(COALESCE(taint_level, 1), 1)
WHERE provenance IS NULL AND source_type = 'readwise';

-- Everything else stays provenance NULL ("unrecorded"). Do NOT mark it user_typed in bulk:
-- only the app knows which rows a person typed.

COMMIT;

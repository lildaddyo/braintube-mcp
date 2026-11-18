-- Content heat: which saved items are in use, and by whom (2026-11-19).
--
-- BrainTube already has salience_score (recency + richness + retrieval count) and attention_score
-- (in-app interactions). Neither says WHO touched an item. Heat does:
--   agent_heat  an AI client reached the item over MCP (search hit, fetch, agent-written note)
--   user_heat   the person did, in the app (search or chat hit, open, highlight, note, star, watch)
--   heat        both together
--
-- Unit of evidence: one DAY on which an actor touched the item, not one call. A benchmark run that
-- hits an item 500 times in a day counts once. Each day decays with a 21-day half-life.
--   S     = sum(weight * 0.5 ^ (age_days / 21))
--   heat  = 1 - exp(-S / 8)                                  -- 0..1, saturating
-- Weights: result-list hit 0.3, direct read 1.0, in-app interaction 1.0 (up to 5), note 2.0, star 1.0 (no decay).
-- Tiers are relative to the person's own library, so they stay useful for heavy and light users:
--   cold  heat < 0.03 (nobody touched it in ~3 months)
--   hot   top 15% of touched items (and heat >= 0.15); warm = next 35% (and heat >= 0.06); cool = the rest.
--
-- No LLM is involved: the score is deterministic and costs nothing to run.
-- Applied to Brain Tube (iqjnmmtvhyavgrsxpoao) on 2026-11-19. Additive only.

BEGIN;

-- 1. Who asked ---------------------------------------------------------------------------------
-- NULL on rows written by the app (treated as 'user'). braintube-mcp writes 'agent'.
ALTER TABLE public.retrieval_log ADD COLUMN IF NOT EXISTS actor text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retrieval_log_actor_check') THEN
    ALTER TABLE public.retrieval_log
      ADD CONSTRAINT retrieval_log_actor_check CHECK (actor IS NULL OR actor IN ('agent', 'user')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.retrieval_log.actor IS
  'Who ran the retrieval: agent (an AI client over MCP, set by braintube-mcp) or user (in the app). NULL = app row written before 2026-11-19 or by code that does not set it; read as user.';

-- 2. One row per item ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.item_heat (
  item_id          uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  heat             numeric(5,4) NOT NULL DEFAULT 0,
  agent_heat       numeric(5,4) NOT NULL DEFAULT 0,
  user_heat        numeric(5,4) NOT NULL DEFAULT 0,
  tier             text NOT NULL DEFAULT 'cold' CHECK (tier IN ('hot', 'warm', 'cool', 'cold')),
  touched_by       text NOT NULL DEFAULT 'none' CHECK (touched_by IN ('both', 'agent', 'user', 'none')),
  agent_days       integer NOT NULL DEFAULT 0,
  user_days        integer NOT NULL DEFAULT 0,
  last_agent_touch timestamptz,
  last_user_touch  timestamptz,
  computed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_heat_user_heat ON public.item_heat (user_id, heat DESC);
CREATE INDEX IF NOT EXISTS item_heat_user_tier ON public.item_heat (user_id, tier);

ALTER TABLE public.item_heat ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS item_heat_owner_select ON public.item_heat;
CREATE POLICY item_heat_owner_select ON public.item_heat
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.item_heat FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.item_heat FROM authenticated;

COMMENT ON TABLE public.item_heat IS
  'Per-item usage heat, split by actor (AI agent over MCP / the person in the app). Rebuilt by compute_item_heat(); never written by clients.';

-- 3. Compute -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_item_heat(for_user_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  WITH log_days AS (
    -- one row per item, actor and day
    SELECT rid AS item_id,
           CASE WHEN rl.actor = 'agent' THEN 'agent' ELSE 'user' END AS actor,
           (rl.created_at AT TIME ZONE 'UTC')::date AS d,
           -- turning up in a result list is weak evidence (0.3); a direct read of the item is a full touch
           max(CASE WHEN rl.search_method IN ('mcp_fetch', 'mcp_get_video', 'mcp_search_in_item') THEN 1.0 ELSE 0.3 END) AS w,
           max(rl.created_at) AS last_at
    FROM retrieval_log rl
    CROSS JOIN LATERAL unnest(rl.retrieved_item_ids) AS rid
    WHERE rl.created_at > now() - interval '90 days'
      AND (for_user_id IS NULL OR rl.user_id = for_user_id)
    GROUP BY 1, 2, 3
  ),
  log_agg AS (
    SELECT item_id,
           coalesce(sum(w * power(0.5, ((now() AT TIME ZONE 'UTC')::date - d) / 21.0)) FILTER (WHERE actor = 'agent'), 0) AS s_agent,
           coalesce(sum(w * power(0.5, ((now() AT TIME ZONE 'UTC')::date - d) / 21.0)) FILTER (WHERE actor = 'user'), 0)  AS s_user,
           count(*) FILTER (WHERE actor = 'agent') AS agent_days,
           count(*) FILTER (WHERE actor = 'user')  AS user_days,
           max(last_at) FILTER (WHERE actor = 'agent') AS last_agent,
           max(last_at) FILTER (WHERE actor = 'user')  AS last_user
    FROM log_days
    GROUP BY item_id
  ),
  note_agg AS (
    -- a note is a strong touch (2.0); an agent-written note belongs to the agent
    SELECT n.item_id,
           coalesce(sum(2.0 * power(0.5, extract(epoch FROM (now() - n.created_at)) / 86400.0 / 21.0))
                    FILTER (WHERE n.provenance = 'agent_written'), 0) AS s_agent,
           coalesce(sum(2.0 * power(0.5, extract(epoch FROM (now() - n.created_at)) / 86400.0 / 21.0))
                    FILTER (WHERE n.provenance IS DISTINCT FROM 'agent_written'), 0) AS s_user,
           max(n.created_at) FILTER (WHERE n.provenance = 'agent_written') AS last_agent,
           max(n.created_at) FILTER (WHERE n.provenance IS DISTINCT FROM 'agent_written') AS last_user
    FROM item_notes n
    WHERE (for_user_id IS NULL OR n.user_id = for_user_id)
    GROUP BY n.item_id
  ),
  scored AS (
    SELECT i.id AS item_id, i.user_id,
           coalesce(l.s_agent, 0) + coalesce(n.s_agent, 0) AS s_agent,
           coalesce(l.s_user, 0) + coalesce(n.s_user, 0)
             -- in-app interactions (view, highlight, share ...): the app keeps a count and the last time
             + CASE WHEN i.last_interacted_at IS NOT NULL
                    THEN least(coalesce(i.interaction_count, 1), 5)
                         * power(0.5, extract(epoch FROM (now() - i.last_interacted_at)) / 86400.0 / 21.0)
                    ELSE 0 END
             + CASE WHEN i.last_watched_at IS NOT NULL
                    THEN power(0.5, extract(epoch FROM (now() - i.last_watched_at)) / 86400.0 / 21.0) ELSE 0 END
             + CASE WHEN i.last_opened_at IS NOT NULL
                    THEN power(0.5, extract(epoch FROM (now() - i.last_opened_at)) / 86400.0 / 21.0) ELSE 0 END
             -- a star does not decay: the person marked it as theirs
             + CASE WHEN i.is_starred THEN 1.0 ELSE 0 END AS s_user,
           coalesce(l.agent_days, 0) AS agent_days,
           coalesce(l.user_days, 0)  AS user_days,
           nullif(greatest(coalesce(l.last_agent, '-infinity'), coalesce(n.last_agent, '-infinity')), '-infinity') AS last_agent,
           nullif(greatest(coalesce(l.last_user, '-infinity'), coalesce(n.last_user, '-infinity'),
                           coalesce(i.last_interacted_at, '-infinity'), coalesce(i.last_watched_at, '-infinity'),
                           coalesce(i.last_opened_at, '-infinity')), '-infinity') AS last_user
    FROM items i
    LEFT JOIN log_agg l ON l.item_id = i.id
    LEFT JOIN note_agg n ON n.item_id = i.id
    WHERE i.is_archived IS NOT TRUE
      AND (for_user_id IS NULL OR i.user_id = for_user_id)
  ),
  final AS (
    SELECT s.*,
           round((1 - exp(-(s.s_agent + s.s_user) / 8.0))::numeric, 4) AS heat,
           round((1 - exp(-s.s_agent / 8.0))::numeric, 4)              AS agent_heat,
           round((1 - exp(-s.s_user / 8.0))::numeric, 4)               AS user_heat
    FROM scored s
  ),
  ranked AS (
    -- rank inside the person's own library, among items with any heat at all
    SELECT f.*,
           CASE WHEN f.heat >= 0.03
                THEN percent_rank() OVER (PARTITION BY f.user_id, (f.heat >= 0.03) ORDER BY f.heat) END AS pr
    FROM final f
  )
  INSERT INTO item_heat AS h (item_id, user_id, heat, agent_heat, user_heat, tier, touched_by,
                              agent_days, user_days, last_agent_touch, last_user_touch, computed_at)
  SELECT f.item_id, f.user_id, f.heat, f.agent_heat, f.user_heat,
         CASE WHEN f.heat < 0.03 THEN 'cold'
              WHEN f.pr >= 0.85 AND f.heat >= 0.15 THEN 'hot'
              WHEN f.pr >= 0.50 AND f.heat >= 0.06 THEN 'warm'
              ELSE 'cool' END,
         CASE WHEN f.agent_heat >= 0.03 AND f.user_heat >= 0.03 THEN 'both'
              WHEN f.agent_heat >= 0.03 THEN 'agent'
              WHEN f.user_heat >= 0.03 THEN 'user'
              ELSE 'none' END,
         f.agent_days, f.user_days, f.last_agent, f.last_user, now()
  FROM ranked f
  ON CONFLICT (item_id) DO UPDATE SET
    user_id = EXCLUDED.user_id, heat = EXCLUDED.heat, agent_heat = EXCLUDED.agent_heat,
    user_heat = EXCLUDED.user_heat, tier = EXCLUDED.tier, touched_by = EXCLUDED.touched_by,
    agent_days = EXCLUDED.agent_days, user_days = EXCLUDED.user_days,
    last_agent_touch = EXCLUDED.last_agent_touch, last_user_touch = EXCLUDED.last_user_touch,
    computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- archived since the last run: no longer ranked
  DELETE FROM item_heat h USING items i
  WHERE i.id = h.item_id AND i.is_archived IS TRUE
    AND (for_user_id IS NULL OR h.user_id = for_user_id);

  RETURN v_n;
END;
$$;

-- 4. Read: ranked list ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.item_heat_list(
  for_user_id uuid,
  p_tier text DEFAULT NULL,
  p_touched_by text DEFAULT NULL,
  p_coldest boolean DEFAULT false,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid, title text, source_type text, url text, topic_primary text, created_at timestamptz,
  taint_level smallint, provenance text,
  heat numeric, agent_heat numeric, user_heat numeric, tier text, touched_by text,
  agent_days integer, user_days integer, last_agent_touch timestamptz, last_user_touch timestamptz
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT i.id, i.title, i.source_type::text, i.url, i.topic_primary, i.created_at,
         i.taint_level, i.provenance,
         h.heat, h.agent_heat, h.user_heat, h.tier, h.touched_by,
         h.agent_days, h.user_days, h.last_agent_touch, h.last_user_touch
  FROM item_heat h
  JOIN items i ON i.id = h.item_id
  WHERE h.user_id = for_user_id
    AND i.is_archived IS NOT TRUE
    AND coalesce(i.is_adult, false) = false AND coalesce(i.ai_excluded, false) = false
    AND (p_tier IS NULL OR h.tier = p_tier)
    AND (p_touched_by IS NULL OR h.touched_by = p_touched_by)
  ORDER BY CASE WHEN p_coldest THEN h.heat END ASC,
           CASE WHEN p_coldest THEN i.created_at END ASC,
           CASE WHEN NOT p_coldest THEN h.heat END DESC,
           i.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- 5. Read: stale stacks worth compiling ----------------------------------------------------------
-- A stack is a topic cluster (or, for items in no cluster, a primary topic) holding at least
-- p_min_items saves that are cold or cool AND are not a source of any compiled article.
CREATE OR REPLACE FUNCTION public.heat_compile_suggestions(
  for_user_id uuid,
  p_min_items integer DEFAULT 5,
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH compiled AS (
    SELECT DISTINCT s AS item_id
    FROM concept_articles ca CROSS JOIN LATERAL unnest(ca.source_item_ids) AS s
    WHERE ca.user_id = for_user_id AND ca.merged_into_id IS NULL
  ),
  best_cluster AS (
    SELECT DISTINCT ON (ic.item_id) ic.item_id, ic.cluster_id
    FROM item_clusters ic
    JOIN topic_clusters tc ON tc.id = ic.cluster_id AND tc.user_id = for_user_id
    ORDER BY ic.item_id, ic.similarity DESC NULLS LAST
  ),
  base AS (
    SELECT i.id, i.title, i.created_at, i.taint_level,
           coalesce(h.tier, 'cold') AS tier,
           (c.item_id IS NOT NULL) AS is_compiled,
           bc.cluster_id,
           CASE WHEN bc.cluster_id IS NOT NULL THEN 'cluster' ELSE 'topic' END AS kind,
           coalesce(bc.cluster_id::text, lower(i.topic_primary)) AS stack_key,
           i.topic_primary
    FROM items i
    LEFT JOIN item_heat h ON h.item_id = i.id
    LEFT JOIN compiled c ON c.item_id = i.id
    LEFT JOIN best_cluster bc ON bc.item_id = i.id
    WHERE i.user_id = for_user_id
      AND i.is_archived IS NOT TRUE
      AND coalesce(i.is_adult, false) = false AND coalesce(i.ai_excluded, false) = false
      AND (bc.cluster_id IS NOT NULL OR i.topic_primary IS NOT NULL)
  ),
  stacks AS (
    SELECT b.kind, b.stack_key, min(b.cluster_id::text) AS cluster_id,
           count(*) AS total_items,
           count(*) FILTER (WHERE NOT b.is_compiled AND b.tier IN ('cold', 'cool')) AS stale_uncompiled,
           count(*) FILTER (WHERE NOT b.is_compiled) AS uncompiled,
           count(*) FILTER (WHERE b.tier IN ('hot', 'warm')) AS active_items,
           min(b.created_at) FILTER (WHERE NOT b.is_compiled AND b.tier IN ('cold', 'cool')) AS oldest_stale,
           max(b.created_at) FILTER (WHERE NOT b.is_compiled) AS newest_uncompiled,
           max(b.taint_level) AS taint_level,
           min(b.topic_primary) AS topic_primary,
           (array_agg(b.title ORDER BY b.created_at DESC)
              FILTER (WHERE NOT b.is_compiled AND b.tier IN ('cold', 'cool') AND b.title IS NOT NULL))[1:5] AS sample_titles
    FROM base b
    GROUP BY b.kind, b.stack_key
    HAVING count(*) FILTER (WHERE NOT b.is_compiled AND b.tier IN ('cold', 'cool')) >= greatest(coalesce(p_min_items, 5), 2)
  )
  SELECT coalesce(jsonb_agg(j ORDER BY (j->>'stale_uncompiled')::int DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'kind', s.kind,
      'cluster_id', s.cluster_id,
      'name', coalesce(tc.name, s.topic_primary),
      'stale_uncompiled', s.stale_uncompiled,
      'uncompiled', s.uncompiled,
      'total_items', s.total_items,
      'active_items', s.active_items,
      'has_article', EXISTS (SELECT 1 FROM concept_articles ca
                             WHERE ca.user_id = for_user_id AND ca.merged_into_id IS NULL
                               AND s.cluster_id IS NOT NULL AND ca.cluster_id::text = s.cluster_id),
      'oldest_stale', s.oldest_stale,
      'newest_uncompiled', s.newest_uncompiled,
      'taint_level', coalesce(s.taint_level, 1),
      'sample_titles', to_jsonb(coalesce(s.sample_titles, ARRAY[]::text[]))
    ) AS j
    FROM stacks s
    LEFT JOIN topic_clusters tc ON tc.id::text = s.cluster_id
    ORDER BY s.stale_uncompiled DESC
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)
  ) x;
$$;

-- 6. Read: what was saved in a window ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saves_digest(
  for_user_id uuid,
  p_hours integer DEFAULT 24,
  p_limit integer DEFAULT 60
)
RETURNS TABLE (
  id uuid, title text, source_type text, url text, channel text, created_at timestamptz,
  topic_primary text, content_type text, summary_oneliner text, core_thesis text,
  key_takeaways text[], key_concepts text[], entities text[],
  taint_level smallint, provenance text, save_origin text, status text,
  tier text, touched_by text
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT i.id, i.title, i.source_type::text, i.url, i.channel, i.created_at,
         i.topic_primary, i.content_type,
         coalesce(i.summary_oneliner, i.tldr, left(i.summary, 400)) AS summary_oneliner,
         i.core_thesis,
         i.key_takeaways[1:6], i.key_concepts[1:10], i.entities[1:10],
         i.taint_level, i.provenance, i.save_origin, i.status::text,
         coalesce(h.tier, 'cold'), coalesce(h.touched_by, 'none')
  FROM items i
  LEFT JOIN item_heat h ON h.item_id = i.id
  WHERE i.user_id = for_user_id
    AND i.created_at > now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 24 * 14))
    AND i.is_archived IS NOT TRUE
    AND coalesce(i.is_adult, false) = false AND coalesce(i.ai_excluded, false) = false
    AND coalesce(i.save_origin, '') NOT IN ('starter', 'synthesis')
  ORDER BY i.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 60), 1), 200);
$$;

-- 7. Grants: service role only (each function takes a user id, so it must not be callable by clients)
REVOKE ALL ON FUNCTION public.compute_item_heat(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.item_heat_list(uuid, text, text, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heat_compile_suggestions(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.saves_digest(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_item_heat(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_heat_list(uuid, text, text, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heat_compile_suggestions(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.saves_digest(uuid, integer, integer) TO service_role;

COMMIT;

-- 8. Nightly rebuild for every user (run outside the transaction; pg_cron) -----------------------
SELECT cron.unschedule('compute-item-heat-nightly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'compute-item-heat-nightly');
SELECT cron.schedule('compute-item-heat-nightly', '25 3 * * *', $$SELECT public.compute_item_heat()$$);

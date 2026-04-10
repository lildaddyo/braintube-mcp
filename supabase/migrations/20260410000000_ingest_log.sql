-- Phase 5: ingest_log table
-- Tracks every ingest action (MCP, webhook, extension, obsidian sync) per user.

CREATE TABLE IF NOT EXISTS ingest_log (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id     uuid        REFERENCES items(id) ON DELETE SET NULL,
  source_type text        NOT NULL,
  action      text        NOT NULL,   -- 'inserted' | 'updated' | 'skipped' | 'error'
  title       text,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE ingest_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_logs" ON ingest_log
  FOR ALL USING (user_id = auth.uid());

-- Index for fast per-user chronological queries
CREATE INDEX IF NOT EXISTS ingest_log_user_created
  ON ingest_log (user_id, created_at DESC);

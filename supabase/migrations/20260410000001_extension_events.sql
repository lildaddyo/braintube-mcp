-- Extension analytics events table
-- Written by /functions/v1/track on every trackEvent() call from the Chrome extension.

CREATE TABLE IF NOT EXISTS extension_events (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_name  text        NOT NULL,
  event_data  jsonb       NOT NULL DEFAULT '{}',
  page_path   text        NOT NULL DEFAULT '/extension',
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE extension_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_events" ON extension_events
  FOR ALL USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS extension_events_user_created
  ON extension_events (user_id, created_at DESC);

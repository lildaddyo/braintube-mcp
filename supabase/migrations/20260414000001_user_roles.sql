-- GAP-D: Per-User Role-Based Tool Access Control
-- Stores the access tier for each user.
-- Roles: 'authenticated' (default read-only), 'premium' (write + advanced), 'admin' (full access).
-- Row is absent for users who have never been granted a role → treated as 'authenticated'.

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text        NOT NULL DEFAULT 'authenticated'
                         CHECK (role IN ('authenticated', 'premium', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Users can read their own role (e.g. for the dashboard to show their tier)
CREATE POLICY "users_read_own_role"
  ON user_roles FOR SELECT
  USING (user_id = auth.uid());

-- Only service-role / admin can insert or update roles (bypasses RLS automatically)

-- Trigger: keep updated_at fresh
CREATE OR REPLACE FUNCTION user_roles_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_roles_updated_at
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_set_updated_at();

-- Fast lookup by user_id (already the PRIMARY KEY, but explicit index aids readability)
CREATE INDEX IF NOT EXISTS user_roles_user_id_idx ON user_roles (user_id);

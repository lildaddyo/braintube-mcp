-- MCP Tool Invocation Audit Log
-- Stores one row per tool call: who called what, when, and whether it succeeded.
-- Raw input params are NEVER stored — only a SHA-256 hash (privacy-safe audit trail).

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name    text        NOT NULL,
  params_hash  text        NOT NULL,          -- SHA-256 hex of JSON.stringify(params)
  success      boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Users can query their own audit trail; service role can read all for ops.
ALTER TABLE mcp_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_audit_log" ON mcp_audit_log
  FOR SELECT USING (user_id = auth.uid());

-- High-write table: always query by user + time, or by tool + time.
CREATE INDEX IF NOT EXISTS mcp_audit_log_user_time
  ON mcp_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_audit_log_tool_time
  ON mcp_audit_log (tool_name, created_at DESC);

-- Convenience: failures-only index for security monitoring queries.
CREATE INDEX IF NOT EXISTS mcp_audit_log_failures
  ON mcp_audit_log (user_id, created_at DESC)
  WHERE success = false;

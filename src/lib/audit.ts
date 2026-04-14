/**
 * MCP Tool Invocation Audit Logger
 *
 * Every tool call is logged to mcp_audit_log asynchronously (fire-and-forget).
 * The raw input params are NEVER stored — only a SHA-256 hash, so sensitive
 * data (API keys, note content, etc.) can't be recovered from the audit table.
 *
 * Usage:
 *   auditLog(userId, 'search_knowledge', input, true);   // success
 *   auditLog(userId, 'ingest_content',   input, false);  // after error
 */

import { createHash } from 'crypto';
import { dbAdmin } from '../db/supabase.js';

/**
 * Fire-and-forget: logs one tool invocation row to mcp_audit_log.
 * Never throws, never awaited — a write failure here must not surface to the user.
 */
export function auditLog(
  userId:   string,
  toolName: string,
  params:   unknown,
  success:  boolean
): void {
  const paramsHash = createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex');

  void dbAdmin
    .from('mcp_audit_log')
    .insert({
      user_id:     userId,
      tool_name:   toolName,
      params_hash: paramsHash,
      success,
    })
    .then(({ error }) => {
      if (error) console.error('[audit] log write failed (non-fatal):', error.message);
    });
}

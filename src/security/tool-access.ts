/**
 * GAP-D: Per-User Role-Based Tool Access Control
 *
 * Three-tier model:
 *   authenticated  — default, all logged-in users; read-only search + retrieval
 *   premium        — write operations + advanced features (ingestion, notes, export…)
 *   admin          — destructive / system-level operations (bulk ingest, backfill…)
 *
 * Tier is additive: admin can do everything premium can do, premium can do everything
 * authenticated can do.
 *
 * Role is resolved ONCE per MCP session (first tool call) from the user_roles table
 * and cached for the lifetime of that session.  Absent rows default to 'authenticated'.
 */

import { dbAdmin } from '../db/supabase.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimum role required to call a tool. */
export type ToolTier = 'authenticated' | 'premium' | 'admin';

/** A user's actual role stored in user_roles table. */
export type UserRole = 'authenticated' | 'premium' | 'admin';

// ─── Tier ordering ────────────────────────────────────────────────────────────

const TIER_RANK: Record<ToolTier | UserRole, number> = {
  authenticated: 0,
  premium:       1,
  admin:         2,
};

/** Returns true if the user's role satisfies the required tier. */
export function tierGrantsAccess(userRole: UserRole, requiredTier: ToolTier): boolean {
  return TIER_RANK[userRole] >= TIER_RANK[requiredTier];
}

// ─── Tool access map ──────────────────────────────────────────────────────────
// All 42 registered tools.  Any tool NOT listed here defaults to 'authenticated'.

export const TOOL_ACCESS_MAP: Record<string, ToolTier> = {
  // ── Authenticated (safe read-only — available to every logged-in user) ─────
  search_knowledge:       'authenticated',
  get_video:              'authenticated',
  list_recent:            'authenticated',
  get_stats:              'authenticated',
  get_related:            'authenticated',
  search_by_source:       'authenticated',
  search_by_date_range:   'authenticated',
  list_bookmarks:         'authenticated',
  random_resurface:       'authenticated',
  get_recent_conversations: 'authenticated',
  get_session_brief:      'authenticated',
  search_obsidian:        'authenticated',
  chat_with_brain:        'authenticated',
  list_brains:            'authenticated',
  get_knowledge_graph:    'authenticated',
  knowledge_health:       'authenticated',
  get_knowledge_index:    'authenticated',
  get_concept_articles:   'authenticated',
  tag_cooccurrence:       'authenticated',
  entity_cooccurrence:    'authenticated',
  detect_gaps:            'authenticated',
  most_retrieved:         'authenticated',
  deep_search:            'authenticated',
  retrieval_quality:      'authenticated',
  find_path:              'authenticated',
  get_edge_history:       'authenticated',

  // ── Premium (write operations + advanced features) ────────────────────────
  tag_item:               'premium',
  toggle_bookmark:        'premium',
  add_note:               'premium',
  ingest_content:         'premium',
  ingest_notion_page:     'premium',
  compile_knowledge:      'premium',
  set_notion_api_key:     'premium',
  get_expertise_profile:  'premium',
  export_corpus:          'premium',
  export_claude_md:       'premium',

  // ── Admin (destructive / system-level operations) ─────────────────────────
  bulk_ingest:            'admin',
  ingest_notion_database: 'admin',
  backfill_embeddings:    'admin',
  recompute_salience:     'admin',
  compute_centrality:     'admin',
  generate_api_key:       'admin',
};

/** Return the required tier for a tool.  Defaults to 'authenticated' for unknown tools. */
export function getRequiredTier(toolName: string): ToolTier {
  return TOOL_ACCESS_MAP[toolName] ?? 'authenticated';
}

// ─── Role resolver ────────────────────────────────────────────────────────────

/**
 * Fetch the user's role from user_roles table.
 * Returns 'authenticated' if no row exists (i.e. free-tier user).
 *
 * This is called ONCE per MCP session and its Promise is cached, so subsequent
 * tool calls in the same session resolve instantly from the cached value.
 */
export async function resolveUserRole(userId: string): Promise<UserRole> {
  try {
    const { data, error } = await dbAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error(`[rbac] role lookup failed for ${userId}: ${error.message} — defaulting to authenticated`);
      return 'authenticated';
    }

    if (!data) return 'authenticated';

    // Validate the value is one of our known roles (guards against bad DB data)
    const raw = data.role as string;
    if (raw === 'premium' || raw === 'admin') return raw;
    return 'authenticated';
  } catch (err) {
    console.error(`[rbac] unexpected error resolving role: ${String(err)} — defaulting to authenticated`);
    return 'authenticated';
  }
}

// ─── Access denial logger ─────────────────────────────────────────────────────

/**
 * Fire-and-forget log of a denied tool call to security_events.
 * Never awaited — must not block the response path.
 */
export function logAccessDenied(
  userId:       string,
  toolName:     string,
  requiredTier: ToolTier,
  userRole:     UserRole,
): void {
  void dbAdmin
    .from('security_events')
    .insert({
      user_id:    userId,
      event_type: 'mcp_access_denied',
      severity:   'medium',
      evidence: {
        tool:          toolName,
        required_tier: requiredTier,
        user_role:     userRole,
      },
    })
    .then(({ error }) => {
      if (error) console.error(`[rbac] failed to log access denial: ${error.message}`);
    });
}

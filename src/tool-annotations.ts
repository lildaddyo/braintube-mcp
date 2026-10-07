/**
 * Directory annotations for every MCP tool: a human-readable title plus the
 * MCP behaviour hints. Claude uses these for auto-permissions — read-only tools
 * run without a per-call prompt, destructive tools always prompt — and the
 * Anthropic Connectors Directory requires a title on every tool and an explicit
 * destructiveHint on every write tool.
 *
 * Rules used here:
 *   readOnlyHint    true  — the tool never changes stored data.
 *   destructiveHint true  — the tool can overwrite or remove existing data
 *                           (upserts, tag removal, credential replacement,
 *                           score recomputes, security-config changes).
 *                   false — the tool only adds new data.
 *   idempotentHint  true  — repeating the same call has no further effect.
 *   openWorldHint   true  — the tool reaches a third-party service
 *                           (Notion, Readwise, an Obsidian bridge) or content
 *                           owned by other users (public Brains).
 *
 * server.ts applies this map inside its registerTool wrapper, and
 * tool-annotations.test.ts fails if a registered tool has no entry here.
 */

export interface ToolAnnotationEntry {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const read = (title: string, openWorldHint = false): ToolAnnotationEntry => ({
  title,
  readOnlyHint: true,
  openWorldHint,
});

const write = (
  title: string,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint = false,
): ToolAnnotationEntry => ({
  title,
  readOnlyHint: false,
  destructiveHint,
  idempotentHint,
  openWorldHint,
});

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotationEntry> = {
  // ── Read: search and retrieval ────────────────────────────────────────────
  search_knowledge:         read('Search Knowledge'),
  deep_search:              read('Deep Search'),
  search_by_source:         read('Search by Source'),
  search_by_date_range:     read('Search by Date Range'),
  get_video:                read('Get Saved Item'),
  get_related:              read('Find Related Items'),
  list_recent:              read('List Recent Saves'),
  list_bookmarks:           read('List Bookmarks'),
  random_resurface:         read('Resurface Forgotten Items'),
  most_retrieved:           read('Most Retrieved Items'),
  get_recent_conversations: read('Get Saved AI Conversations'),
  get_session_brief:        read('Get Session Brief'),
  get_stats:                read('Get Library Stats'),

  // ── Read: knowledge structure and insight ─────────────────────────────────
  get_knowledge_graph:      read('Get Knowledge Graph'),
  get_knowledge_index:      read('Get Knowledge Index'),
  get_concept_articles:     read('Get Concept Articles'),
  find_path:                read('Find Path Between Items'),
  get_edge_history:         read('Get Connection History'),
  tag_cooccurrence:         read('Tag Co-occurrence'),
  entity_cooccurrence:      read('Entity Co-occurrence'),
  detect_gaps:              read('Detect Knowledge Gaps'),
  knowledge_health:         read('Check Knowledge Health'),
  retrieval_quality:        read('Retrieval Quality Report'),
  get_expertise_profile:    read('Get Expertise Profile'),

  // ── Read: export ──────────────────────────────────────────────────────────
  export_corpus:            read('Export Library'),
  export_claude_md:         read('Export CLAUDE.md Context'),

  // ── Read: Brains (public Brains belong to other users → open world) ───────
  list_brains:              read('List My Brains'),
  chat_with_brain:          read('Ask a Public Brain', true),

  // ── Read: external sources ────────────────────────────────────────────────
  search_obsidian:          read('Search Obsidian Vault', true),

  // ── Write: organise items ─────────────────────────────────────────────────
  tag_item:                 write('Tag Item', true, true),          // can remove tags
  toggle_bookmark:          write('Bookmark Item', false, true),
  add_note:                 write('Save Note to Item', true, true), // upsert replaces the item's note

  // ── Write: ingest (dedup upserts can update an existing item) ─────────────
  ingest_content:           write('Save Content', true, true),
  bulk_ingest:              write('Bulk Save Content', true, true),
  ingest_notion_page:       write('Import Notion Page', true, true, true),
  ingest_notion_database:   write('Import Notion Database', true, true, true),
  sync_readwise:            write('Sync Readwise Highlights', true, true, true),

  // ── Write: integration credentials (replace any stored value) ─────────────
  connect_readwise:         write('Connect Readwise', true, true, true),
  set_notion_api_key:       write('Connect Notion', true, true),
  generate_api_key:         write('Create API Key', false, false),

  // ── Write: derived data (recomputes overwrite previous results) ───────────
  compile_knowledge:        write('Compile Concept Articles', true, false),
  backfill_embeddings:      write('Backfill Embeddings', false, true),
  recompute_salience:       write('Recompute Salience Scores', true, true),
  compute_centrality:       write('Recompute Graph Centrality', true, true),

  // ── Admin: security and firewall ──────────────────────────────────────────
  security_dashboard:         read('Security Dashboard'),
  firewall_status:            read('Firewall Status'),
  firewall_rule_history:      read('Firewall Rule History'),
  acknowledge_security_alert: write('Acknowledge Security Alert', false, true),
  suppress_alert_type:        write('Suppress Alert Type', true, false),
  firewall_promote_check:     write('Promote or Demote Firewall Check', true, true),
  firewall_update_threshold:  write('Update Firewall Threshold', true, true),
  firewall_rollback_rules:    write('Roll Back Firewall Rules', true, true),
};

/**
 * Title plus annotations for a tool, in the shape McpServer.registerTool takes
 * (`title` at the top level, the same title repeated as `annotations.title`).
 * Returns undefined for a tool missing from the map.
 */
export function directoryMetaFor(name: string):
  | { title: string; annotations: Omit<ToolAnnotationEntry, never> }
  | undefined {
  const entry = TOOL_ANNOTATIONS[name];
  if (!entry) return undefined;
  return { title: entry.title, annotations: { ...entry } };
}

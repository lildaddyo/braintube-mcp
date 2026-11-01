/**
 * Router tools for the core profile (see src/tool-profiles.ts):
 *   braintube_find_tools — lists the read-only tools outside the core set
 *   braintube_run_tool   — runs one of them by name after validating its args
 *
 * The handlers live in server.ts (they need the session's secureWrap and the
 * tools collected at registration); this file holds the schemas, shared with
 * the server card, and the pure helpers the tests exercise directly.
 */

import { z } from 'zod';

export const findToolsSchema = z.object({
  query: z.string().max(200).optional()
    .describe('What you want to do, e.g. "knowledge graph", "bookmarks", "ask a Brain". Omit to list every extra tool.'),
});

export const findToolsOutputSchema = z.object({
  tools: z.array(z.object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    input_schema: z.record(z.string(), z.unknown()),
  })),
  full_profile_only: z.array(z.string()),
  note: z.string(),
});

export const runToolSchema = z.object({
  name: z.string().min(1).max(64).describe('Tool name returned by braintube_find_tools.'),
  args: z.record(z.string(), z.unknown()).optional()
    .describe('Arguments for that tool, matching its input_schema. Omit or pass {} for a tool without parameters.'),
});

export const runToolOutputSchema = z.object({
  tool: z.string(),
  result: z.unknown(),
});

export const FIND_TOOLS_DESCRIPTION =
  'List the extra read-only BrainTube tools that are not in your default tool list (stats, knowledge graph, related items, bookmarks, Brains, expertise profile, analytics, exports and more), with each tool\'s input schema. Call it when none of the visible tools fits, then run the one you need with braintube_run_tool. Tools that change data outside the default set need the full tool profile (MCP URL with ?tools=full).';

export const RUN_TOOL_DESCRIPTION =
  'Run one of the extra read-only tools that braintube_find_tools lists, by name, with its arguments in `args`. The arguments are checked against that tool\'s input schema; on a mismatch the error shows the schema. Do not use it for tools already in your list: call those directly.';

export interface RoutableTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}

/** JSON Schema of a tool's input, in the same draft the server card publishes. */
export function inputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

/**
 * Tools matching a free-text query, best first: one point per query word
 * (3+ letters) found in the name, title or description. No query, or no
 * match at all, returns every tool in registration order.
 */
export function rankTools<T extends RoutableTool>(tools: T[], query?: string): { tools: T[]; matched: boolean } {
  const words = (query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (words.length === 0) return { tools, matched: true };
  const scored = tools
    .map((t, i) => {
      const hay = `${t.name.replace(/_/g, ' ')} ${t.title} ${t.description}`.toLowerCase();
      return { t, i, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  if (scored.length === 0) return { tools, matched: false };
  return { tools: scored.map((s) => s.t), matched: true };
}

/** Readable list of zod issues for the schema-mismatch error. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(args)'}: ${i.message}`)
    .join('\n');
}

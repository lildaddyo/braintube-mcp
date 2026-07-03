/**
 * Mechanical parity check: src/server.ts (runtime tool registrations) vs
 * src/routes/server-card.ts (static Smithery listing).
 *
 * Asserts, for every tool:
 *   1. The tool name set is identical between both surfaces (52 == 52).
 *   2. The `annotations` object registered at runtime deep-equals the
 *      `annotations` object shipped in the static server-card TOOLS array.
 *   3. Every property in the tool's JSON input schema has a non-empty
 *      `description` string.
 *
 * server.ts's registerTool() calls can't be executed directly here (they run
 * inside createMcpServer(), which requires a live Supabase-backed
 * AuthContext). Its `annotations` literals are extracted statically via
 * regex instead — safe because the codebase enforces a single consistent
 * call shape: `server.registerTool(\n  'name',\n  { ..., annotations: {...} },`.
 * server-card.ts has no such constraint: it's imported and executed for
 * real, so its output is the actual JSON Smithery will see.
 *
 * Exits non-zero and prints every mismatch if anything is out of sync.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from '../src/routes/server-card.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverTsPath = join(__dirname, '..', 'src', 'server.ts');
const serverTsSrc = readFileSync(serverTsPath, 'utf8');

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

function parseAnnotationsLiteral(text: string): Annotations {
  // Literal is a flat object of boolean values only — safe to evaluate in isolation.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(`"use strict"; return (${text});`)() as Annotations;
}

/** Extract { name -> annotations } from every server.registerTool('name', { ... annotations: {...} ... }, ...) call. */
function extractRuntimeAnnotations(src: string): Map<string, Annotations> {
  const out = new Map<string, Annotations>();
  const callRe = /server\.registerTool\(\s*'([a-z_]+)'/g;
  let match: RegExpExecArray | null;

  while ((match = callRe.exec(src))) {
    const name = match[1];
    const searchStart = match.index;
    // annotations object is always within a few hundred chars of the call start
    const window = src.slice(searchStart, searchStart + 2000);
    const annMatch = window.match(/annotations:\s*(\{[^}]*\})/);
    if (!annMatch) {
      throw new Error(`server.ts: tool "${name}" registerTool call has no annotations literal nearby`);
    }
    out.set(name, parseAnnotationsLiteral(annMatch[1]));
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const runtimeAnnotations = extractRuntimeAnnotations(serverTsSrc);
  const cardNames = new Set(TOOLS.map(t => t.name));
  const runtimeNames = new Set(runtimeAnnotations.keys());

  const failures: string[] = [];

  // ── 1. Name set parity ────────────────────────────────────────────────────
  for (const name of runtimeNames) {
    if (!cardNames.has(name)) failures.push(`MISSING FROM SERVER-CARD: "${name}" is registered in server.ts but absent from server-card.ts TOOLS`);
  }
  for (const name of cardNames) {
    if (!runtimeNames.has(name)) failures.push(`MISSING FROM SERVER.TS: "${name}" is in server-card.ts TOOLS but not registered in server.ts`);
  }

  if (runtimeNames.size !== 52) failures.push(`EXPECTED 52 tools registered in server.ts, found ${runtimeNames.size}`);
  if (cardNames.size !== 52) failures.push(`EXPECTED 52 tools in server-card.ts TOOLS, found ${cardNames.size}`);

  // ── 2 & 3. Per-tool checks ─────────────────────────────────────────────────
  for (const tool of TOOLS) {
    const runtimeAnn = runtimeAnnotations.get(tool.name);
    if (runtimeAnn && !deepEqual(runtimeAnn, tool.annotations)) {
      failures.push(
        `ANNOTATIONS MISMATCH: "${tool.name}"\n` +
        `  server.ts:      ${JSON.stringify(runtimeAnn)}\n` +
        `  server-card.ts: ${JSON.stringify(tool.annotations)}`
      );
    }
    if (!tool.annotations || Object.keys(tool.annotations).length === 0) {
      failures.push(`NO ANNOTATIONS: "${tool.name}" has an empty/missing annotations object in server-card.ts`);
    }

    const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
    const props = schema.properties ?? {};
    for (const [paramName, propSchema] of Object.entries(props)) {
      if (!propSchema.description || propSchema.description.trim().length === 0) {
        failures.push(`MISSING PARAM DESCRIPTION: "${tool.name}".${paramName} has no description in server-card.ts`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n✗ server-card parity check FAILED — ${failures.length} issue(s):\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }

  console.log(`✓ server-card parity check PASSED — ${TOOLS.length} tools, names match, annotations deep-equal, every param described.`);
}

main();

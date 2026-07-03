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
 *   4. `outputSchema` is declared at runtime (server.ts) AND on the static
 *      listing (server-card.ts) for every tool.
 *   5. No tool's static `outputSchema` is a top-level union (`anyOf`/`oneOf`
 *      at the root). The MCP SDK's runtime output validator —
 *      normalizeObjectSchema() in its zod-compat layer — only recognizes
 *      ZodObject/raw-shape schemas via `.shape`; a top-level z.union(...) has
 *      none, so it silently returns undefined and the next call,
 *      safeParseAsync(undefined, ...), throws "Cannot read properties of
 *      undefined (reading '_zod')" on every successful tool call. This is
 *      exactly what broke production in commit 0cbcf01 (a since-removed
 *      withEnvelope() helper unioned every outputSchema with a shared
 *      envelope). server-card.ts's zodToJsonSchema path renders unions fine
 *      (`anyOf`) — this check exists precisely because that made the static
 *      listing look correct while the live server was broken. See
 *      src/security/tool-envelope.ts and src/server-output-schema.test.ts
 *      for the full incident writeup and a live SDK-level regression test.
 *   6. src/server.ts's registerTool() proxy never wraps `outputSchema` in
 *      anything (no `z.union(` / `withEnvelope(` near an `outputSchema:`
 *      assignment inside the proxy body) — a static guard against
 *      reintroducing check #5's bug inside the proxy itself, which
 *      server-output-schema.test.ts's dynamic checks can't catch because
 *      they register schemas directly rather than through this proxy.
 *   7. secureWrap's cross-cutting short-circuits (role denial, injection
 *      reject, confirm-required preview) all go through shortCircuitResult()
 *      rather than constructing a raw `{ content: [...] }` result — that
 *      helper marks its result isError:true so the SDK skips structuredContent
 *      validation for it entirely. Catches a future 4th short-circuit path
 *      added without the helper.
 *
 * server.ts's registerTool() calls can't be executed directly here (they run
 * inside createMcpServer(), which requires a live Supabase-backed
 * AuthContext). Its `annotations`/`outputSchema` literals are extracted
 * statically via regex instead — safe because the codebase enforces a single
 * consistent call shape: `server.registerTool(\n  'name',\n  { ..., annotations: {...} },`.
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

interface RuntimeToolMeta {
  annotations: Annotations;
  hasOutputSchema: boolean;
}

function parseAnnotationsLiteral(text: string): Annotations {
  // Literal is a flat object of boolean values only — safe to evaluate in isolation.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(`"use strict"; return (${text});`)() as Annotations;
}

/** Extract { name -> { annotations, hasOutputSchema } } from every server.registerTool('name', { ... }, ...) call. */
function extractRuntimeToolMeta(src: string): Map<string, RuntimeToolMeta> {
  const out = new Map<string, RuntimeToolMeta>();
  const callRe = /server\.registerTool\(\s*'([a-z_]+)'/g;
  let match: RegExpExecArray | null;

  while ((match = callRe.exec(src))) {
    const name = match[1];
    const searchStart = match.index;
    // annotations/outputSchema are always within a few hundred chars of the call start
    const window = src.slice(searchStart, searchStart + 2000);
    const annMatch = window.match(/annotations:\s*(\{[^}]*\})/);
    if (!annMatch) {
      throw new Error(`server.ts: tool "${name}" registerTool call has no annotations literal nearby`);
    }
    // Only look for outputSchema BEFORE the annotations literal — otherwise a
    // later tool's outputSchema could be picked up by an earlier tool's window.
    const preAnnotations = window.slice(0, annMatch.index);
    out.set(name, {
      annotations: parseAnnotationsLiteral(annMatch[1]),
      hasOutputSchema: /outputSchema:\s*\S/.test(preAnnotations),
    });
  }
  return out;
}

/**
 * Asserts secureWrap's pre-handler short-circuits (role denial, injection
 * reject, confirm-required preview) all route through shortCircuitResult()
 * rather than a raw object literal. Scoped to the region between
 * `function secureWrap(` and `let success = true;` — everything after that
 * marker is post-handler response sanitization, which legitimately spreads
 * (`{ ...typedResult, content: ... }`) rather than constructing fresh.
 */
function checkSecureWrapEnvelopeGuard(src: string): string[] {
  const failures: string[] = [];
  const fnStart = src.indexOf('function secureWrap(');
  if (fnStart === -1) {
    return ['secureWrap function not found in server.ts — cannot verify short-circuit envelope guard'];
  }
  const preHandlerEnd = src.indexOf('let success = true;', fnStart);
  if (preHandlerEnd === -1) {
    return ['secureWrap: "let success = true;" marker not found — cannot bound the short-circuit region'];
  }
  const preHandlerRegion = src.slice(fnStart, preHandlerEnd);

  const shortCircuitCalls = preHandlerRegion.match(/return shortCircuitResult\(/g) ?? [];
  if (shortCircuitCalls.length < 3) {
    failures.push(
      `SHORT-CIRCUIT GUARD: expected at least 3 "return shortCircuitResult(...)" calls in secureWrap's ` +
      `pre-handler region (role denial, injection reject, confirm-required), found ${shortCircuitCalls.length}`
    );
  }

  const rawLiteralReturns = preHandlerRegion.match(/return\s*\{\s*\n?\s*content\s*:/g) ?? [];
  if (rawLiteralReturns.length > 0) {
    failures.push(
      `SHORT-CIRCUIT GUARD: found ${rawLiteralReturns.length} raw "return { content: ... }" literal(s) in ` +
      `secureWrap's pre-handler region that bypass shortCircuitResult() — these won't be marked isError:true, ` +
      `so the SDK will require them to carry a conforming structuredContent they can never have. Route them ` +
      `through shortCircuitResult() instead.`
    );
  }

  return failures;
}

/**
 * Asserts the registerTool proxy (the `(server as any).registerTool = (name, def, handler) => { ... }`
 * closure) never wraps `outputSchema` in a union or the old withEnvelope()
 * helper. Scoped to the region between the proxy's assignment and its
 * `return _origRegister(...)` call. This is a static guard for check #5's
 * bug class specifically inside the proxy — server-output-schema.test.ts's
 * dynamic checks register schemas directly and don't exercise this closure,
 * so they can't catch a regression reintroduced here.
 */
function checkRegistrationProxyDoesNotWrapOutputSchema(src: string): string[] {
  const failures: string[] = [];
  const proxyStart = src.indexOf('(server as any).registerTool = (name');
  if (proxyStart === -1) {
    return ['registerTool proxy assignment not found in server.ts — cannot verify outputSchema is unwrapped'];
  }
  const proxyEnd = src.indexOf('return _origRegister(', proxyStart);
  if (proxyEnd === -1) {
    return ['registerTool proxy: "return _origRegister(" marker not found — cannot bound the proxy body'];
  }
  const proxyBody = src.slice(proxyStart, proxyEnd);

  if (/z\.union\(|withEnvelope\(/.test(proxyBody)) {
    failures.push(
      `REGISTRATION PROXY GUARD: found z.union(/withEnvelope( inside the registerTool proxy body — ` +
      `outputSchema must pass through unmodified (see incident notes in this file's header comment). ` +
      `Wrapping outputSchema in a top-level union here will break every call to every tool that has one.`
    );
  }

  return failures;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const runtimeToolMeta = extractRuntimeToolMeta(serverTsSrc);
  const cardNames = new Set(TOOLS.map(t => t.name));
  const runtimeNames = new Set(runtimeToolMeta.keys());

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

  // ── 2, 3, 4 & 5. Per-tool checks ──────────────────────────────────────────
  for (const tool of TOOLS) {
    const runtimeMeta = runtimeToolMeta.get(tool.name);
    if (runtimeMeta && !deepEqual(runtimeMeta.annotations, tool.annotations)) {
      failures.push(
        `ANNOTATIONS MISMATCH: "${tool.name}"\n` +
        `  server.ts:      ${JSON.stringify(runtimeMeta.annotations)}\n` +
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

    // ── outputSchema presence (runtime + static) ────────────────────────────
    if (runtimeMeta && !runtimeMeta.hasOutputSchema) {
      failures.push(`NO OUTPUT SCHEMA (server.ts): "${tool.name}" registerTool call has no outputSchema`);
    }
    const cardTool = tool as { outputSchema?: { anyOf?: unknown; oneOf?: unknown } };
    if (!cardTool.outputSchema) {
      failures.push(`NO OUTPUT SCHEMA (server-card.ts): "${tool.name}" TOOLS entry has no outputSchema`);
    } else if (cardTool.outputSchema.anyOf || cardTool.outputSchema.oneOf) {
      // ── top-level union guard (the exact 0cbcf01 bug class) ──────────────
      failures.push(
        `OUTPUT SCHEMA IS A TOP-LEVEL UNION: "${tool.name}" outputSchema has anyOf/oneOf at the root — ` +
        `the MCP SDK's runtime validator can't normalize this to an object schema and will crash every ` +
        `call to this tool. See incident notes in this file's header comment.`
      );
    }
  }

  // ── 6. registerTool proxy must not wrap outputSchema ──────────────────────
  failures.push(...checkRegistrationProxyDoesNotWrapOutputSchema(serverTsSrc));

  // ── 7. secureWrap short-circuit guard ─────────────────────────────────────
  failures.push(...checkSecureWrapEnvelopeGuard(serverTsSrc));

  if (failures.length > 0) {
    console.error(`\n✗ server-card parity check FAILED — ${failures.length} issue(s):\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }

  console.log(`✓ server-card parity check PASSED — ${TOOLS.length} tools, names match, annotations deep-equal, every param described, outputSchema present on all tools with no top-level unions, registration proxy leaves outputSchema unwrapped, secureWrap short-circuits guarded.`);
}

main();

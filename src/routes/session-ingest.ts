/**
 * Session archive ingest.
 *
 *   POST /api/session-ingest         upsert one claude_sessions row plus its session_rounds
 *   GET  /api/session-ingest/cursor  where should the uploader resume?
 *
 * Auth is inherited, not re-implemented. index.ts mounts this router AFTER
 * `app.use('/api', requireAuth, mcpRateLimit, restRouter)`, so req.auth is already the
 * AuthContext that getAuthContext() produced (Bearer JWT, X-BrainTube-Token API key or
 * ?token=). user_id comes from req.auth and nowhere else - never from the body or the query
 * string - and the handlers fail closed (401) if req.auth is missing.
 *
 * Body size: the global express.json() in index.ts caps bodies at 100 kb, so this route needs
 * its own 5 MB parser registered BEFORE it, behind requireAuth (sessionIngestBodyParser; the two
 * registration lines are in index.ts, and a test pins their order).
 *
 * Logging: counts, ids and error codes only. Never a request body, message text or tool
 * payload, and never a database/OpenAI error *message* (Postgres JSON errors can quote the
 * offending text). Everything goes to console.error because stdout belongs to the MCP stdio
 * transport.
 *
 * Write order on POST: session upsert (identity + metadata) -> rounds upsert -> recount ->
 * ONE final update that moves the cursor, last_message_at and the recomputed round_count /
 * total_chars. The cursor is written last so a failed rounds upsert can never leave the stored
 * cursor pointing past rounds that were not saved.
 */

import express from 'express';
import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '../types.js';
import { dbAdmin } from '../db/supabase.js';

// -- Limits and constants (from the spec) --------------------------------------------------

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_ROUNDS_PER_CALL = 200;
export const TOOL_IO_MAX_CHARS = 8000;
export const EMBED_INPUT_MAX_CHARS = 24000;
export const EMBED_BATCH_SIZE = 100;
export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIMENSIONS = 768; // session_rounds.embedding is halfvec(768)
export const SURFACES = ['claude_ai', 'claude_code'] as const;
export type Surface = (typeof SURFACES)[number];

const MAX_ROUND_NO = 2147483647; // session_rounds.round_no is int4
const SUM_PAGE_SIZE = 1000; // PostgREST returns at most 1000 rows per request
const EMBED_WRITE_CONCURRENCY = 8;

const log = (msg: string): void => console.error('[session-ingest] ' + msg);

// -- Text hygiene ---------------------------------------------------------------------------

const NUL = String.fromCharCode(0);

/**
 * Postgres text/jsonb cannot hold NUL, and a lone surrogate is not valid UTF-8. Runs BEFORE
 * redaction so a NUL cannot be used to split a secret past the patterns.
 */
export function cleanText(s: string): string {
  const noNul = s.includes(NUL) ? s.split(NUL).join('') : s;
  const wf = noNul as unknown as { toWellFormed?: () => string };
  return typeof wf.toWellFormed === 'function' ? wf.toWellFormed() : noNul;
}

/** Cut at `max` UTF-16 units without leaving half a surrogate pair (jsonb rejects those). */
export function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

// -- Secret redaction -----------------------------------------------------------------------
//
// Bodies can be 5 MB of caller-supplied text, so these must stay linear. A pattern that needs a
// literal AFTER an unbounded character run (the JWT's dots, the "=" of NAME=value) goes
// quadratic if every position may start a match: a naive JWT pattern took about 7 s on 240 KB
// of "eyJeyJ..." when measured. Their look-behind lets a match start only at the beginning of
// a token run, so overlapping starts never rescan the same run. The remaining patterns end in
// a plain {N,} run, which is consumed on success and short on failure.
// The look-behinds also accept a start right after a literal backslash-n / -r / -t, because
// tool inputs arrive as JSON text in which a newline is the two characters backslash + n and
// would otherwise glue a secret to the preceding letter.

const mark = (kind: string): string => '[REDACTED:' + kind + ']';

const TOKEN_RULES: ReadonlyArray<readonly [kind: string, re: RegExp]> = [
  ['jwt', /(?<=^|[^A-Za-z0-9_-]|\\[nrt])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g],
  ['github_token', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['github_token', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  // sk_ / sk- are two-letter prefixes, so they need a left boundary or "task-management-..." and
  // "disk-usage-..." slugs would be rewritten in the archive.
  ['stripe_key', /(?<=^|[^A-Za-z0-9]|\\[nrt])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ['sb_secret', /sb_secret_[A-Za-z0-9_-]{10,}/g],
  ['sk_key', /(?<=^|[^A-Za-z0-9]|\\[nrt])sk-[A-Za-z0-9_-]{20,}/g],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/g],
  // "Bearer <token>". A token that is just an ordinary word ("Bearer authentication") is prose,
  // not a credential, so a lowercase or Capitalised word is left alone.
  ['bearer', /[Bb]earer\s+(?![A-Z]?[a-z]+(?![A-Za-z0-9._~+\/=-]))[A-Za-z0-9._~+\/=-]{8,}/g],
];

// NAME=value where NAME ends in KEY / SECRET / TOKEN / PASSWORD (SUPABASE_SERVICE_ROLE_KEY=...,
// OPENAI_API_KEY=...). The value is replaced, the name stays. The regexes are deliberately flat
// (no nested repeated group): they match any UPPER_CASE assignment and the callback keeps only
// the secret-looking names.
const ENV_ASSIGNMENT =
  /(?<=^|[^A-Za-z0-9_]|\\[nrt])([A-Z][A-Z0-9_]*)([ \t]*=[ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;,)}\]]+)/g;
// "NAME": "value" (JSON, or YAML written with quotes).
const ENV_JSON_ASSIGNMENT = /("([A-Z][A-Z0-9_]*)"[ \t]*:[ \t]*)"([^"\r\n]*)"/g;
const SECRET_NAME = /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)$/;
// Values that are references to a secret, not the secret itself.
const REFERENCE_VALUE =
  /^["']?(?:\$(?:\{|\(|[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_]))|process\.env|import\.meta\.env|os\.environ|os\.getenv|\[REDACTED:)/;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [kind, re] of TOKEN_RULES) out = out.replace(re, mark(kind));
  out = out.replace(ENV_ASSIGNMENT, (m: string, name: string, sep: string, value: string) =>
    SECRET_NAME.test(name) && !REFERENCE_VALUE.test(value) ? name + sep + mark('env_assignment') : m,
  );
  out = out.replace(ENV_JSON_ASSIGNMENT, (m: string, head: string, name: string, value: string) =>
    SECRET_NAME.test(name) && !value.startsWith('[REDACTED:') ? head + '"' + mark('env_assignment') + '"' : m,
  );
  return out;
}

/** Everything that gets stored as free text goes through this: hygiene first, then redaction. */
const scrub = (s: string): string => redactSecrets(cleanText(s));

// -- Tool calls and round maths -------------------------------------------------------------

export interface StoredToolCall {
  name: string;
  input: string | null;
  output: string | null;
  input_chars: number;
  output_chars: number;
  truncated: boolean;
}

/**
 * Redact, then measure, then cut. input_chars / output_chars are the lengths of the redacted
 * text BEFORE the 8000-char cut, so they stay the original size even when the text is truncated.
 */
export function storeToolCall(raw: { name: string; input?: string; output?: string }): StoredToolCall {
  const input = raw.input === undefined ? null : scrub(raw.input);
  const output = raw.output === undefined ? null : scrub(raw.output);
  const inputChars = input === null ? 0 : input.length;
  const outputChars = output === null ? 0 : output.length;
  return {
    name: cleanText(raw.name),
    input: input === null ? null : truncateChars(input, TOOL_IO_MAX_CHARS),
    output: output === null ? null : truncateChars(output, TOOL_IO_MAX_CHARS),
    input_chars: inputChars,
    output_chars: outputChars,
    truncated: inputChars > TOOL_IO_MAX_CHARS || outputChars > TOOL_IO_MAX_CHARS,
  };
}

/** est_tokens = ceil(chars/4 + tool chars/4); tool chars are the ORIGINAL (untruncated) counts. */
export function estimateTokens(chars: number, toolChars: number): number {
  return Math.ceil(chars / 4 + toolChars / 4);
}

// -- Request parsing ------------------------------------------------------------------------

export interface IngestRound {
  round_no: number;
  human: string | null;
  assistant: string | null;
  tool_calls: StoredToolCall[];
  chars: number;
  est_tokens: number;
  first_message_uuid: string | null;
  last_message_uuid: string | null;
  occurred_at: string | null;
}

export interface IngestRequest {
  surface: Surface;
  external_id: string;
  meta: Partial<Record<'url' | 'title' | 'project_label' | 'model', string>>;
  cursor: { last_message_uuid?: string; byte_offset?: number };
  rounds: IngestRound[];
}

export type ParseFailure = { ok: false; status: 400 | 413; error: string; field?: string };
export type ParseResult = { ok: true; value: IngestRequest } | ParseFailure;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const reject = (error: string, field?: string): ParseFailure =>
  field === undefined ? { ok: false, status: 400, error } : { ok: false, status: 400, error, field };

const isSurface = (v: unknown): v is Surface =>
  typeof v === 'string' && (SURFACES as readonly string[]).includes(v);

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** Returns the normalised ISO-8601 (UTC) string, or null if `v` is not an ISO date/time. */
function parseIso(v: string): string | null {
  if (!ISO_PREFIX.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Optional string field: absent or null -> null, non-string -> undefined (caller rejects). */
function optionalString(obj: Record<string, unknown>, key: string): string | null | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : undefined;
}

function parseToolCalls(raw: unknown, at: string): StoredToolCall[] | ParseFailure {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return reject('invalid_tool_calls', at);
  const out: StoredToolCall[] = [];
  for (let j = 0; j < raw.length; j++) {
    const tc: unknown = raw[j];
    const where = at + '[' + j + ']';
    if (!isPlainObject(tc)) return reject('invalid_tool_call', where);
    if (typeof tc.name !== 'string' || tc.name.length === 0) return reject('invalid_tool_call', where + '.name');
    const input = optionalString(tc, 'input');
    const output = optionalString(tc, 'output');
    if (input === undefined) return reject('invalid_tool_call', where + '.input');
    if (output === undefined) return reject('invalid_tool_call', where + '.output');
    out.push(
      storeToolCall({
        name: tc.name,
        ...(input !== null ? { input } : {}),
        ...(output !== null ? { output } : {}),
      }),
    );
  }
  return out;
}

function parseRound(raw: unknown, i: number): IngestRound | ParseFailure {
  const at = 'rounds[' + i + ']';
  if (!isPlainObject(raw)) return reject('invalid_round', at);

  const n = raw.round_no;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_ROUND_NO) {
    return reject('invalid_round_no', at + '.round_no');
  }

  const human = optionalString(raw, 'human');
  if (human === undefined) return reject('invalid_round', at + '.human');
  const assistant = optionalString(raw, 'assistant');
  if (assistant === undefined) return reject('invalid_round', at + '.assistant');
  const firstUuid = optionalString(raw, 'first_message_uuid');
  if (firstUuid === undefined) return reject('invalid_round', at + '.first_message_uuid');
  const lastUuid = optionalString(raw, 'last_message_uuid');
  if (lastUuid === undefined) return reject('invalid_round', at + '.last_message_uuid');

  const occurredRaw = optionalString(raw, 'occurred_at');
  if (occurredRaw === undefined) return reject('invalid_round', at + '.occurred_at');
  let occurredAt: string | null = null;
  if (occurredRaw !== null) {
    occurredAt = parseIso(occurredRaw);
    if (occurredAt === null) return reject('invalid_occurred_at', at + '.occurred_at');
  }

  const toolCalls = parseToolCalls(raw.tool_calls, at + '.tool_calls');
  if (!Array.isArray(toolCalls)) return toolCalls;

  const humanText = human === null ? null : scrub(human);
  const assistantText = assistant === null ? null : scrub(assistant);
  const chars = (humanText === null ? 0 : humanText.length) + (assistantText === null ? 0 : assistantText.length);
  const toolChars = toolCalls.reduce((sum, t) => sum + t.input_chars + t.output_chars, 0);

  return {
    round_no: n,
    human: humanText,
    assistant: assistantText,
    tool_calls: toolCalls,
    chars,
    est_tokens: estimateTokens(chars, toolChars),
    first_message_uuid: firstUuid === null || firstUuid === '' ? null : cleanText(firstUuid),
    last_message_uuid: lastUuid === null || lastUuid === '' ? null : cleanText(lastUuid),
    occurred_at: occurredAt,
  };
}

/**
 * Validate and normalise the POST body. Redaction and hygiene are applied here, so everything
 * in the returned value is safe to store. Errors name the offending field, never its content.
 */
export function parseIngestBody(body: unknown): ParseResult {
  if (!isPlainObject(body)) return reject('body_must_be_a_json_object');

  const rawRounds = body.rounds;
  if (!Array.isArray(rawRounds)) return reject('rounds_must_be_an_array', 'rounds');
  if (rawRounds.length > MAX_ROUNDS_PER_CALL) {
    return { ok: false, status: 413, error: 'too_many_rounds', field: 'rounds' };
  }

  if (!isSurface(body.surface)) return reject('invalid_surface', 'surface');
  const externalId = body.external_id;
  if (typeof externalId !== 'string' || externalId.length === 0) return reject('external_id_required', 'external_id');

  // Metadata is only written when provided; an empty string counts as not provided so a client
  // that has no title yet can never blank one that is already stored.
  const meta: IngestRequest['meta'] = {};
  for (const key of ['url', 'title', 'project_label', 'model'] as const) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return reject('invalid_field', key);
    if (v !== '') meta[key] = cleanText(v);
  }

  const cursor: IngestRequest['cursor'] = {};
  const rawCursor = body.cursor;
  if (rawCursor !== undefined && rawCursor !== null) {
    if (!isPlainObject(rawCursor)) return reject('invalid_cursor', 'cursor');
    const uuid = rawCursor.last_message_uuid;
    if (uuid !== undefined && uuid !== null) {
      if (typeof uuid !== 'string') return reject('invalid_cursor', 'cursor.last_message_uuid');
      if (uuid !== '') cursor.last_message_uuid = cleanText(uuid);
    }
    const offset = rawCursor.byte_offset;
    if (offset !== undefined && offset !== null) {
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        return reject('invalid_cursor', 'cursor.byte_offset');
      }
      cursor.byte_offset = offset;
    }
  }

  const seen = new Set<number>();
  const rounds: IngestRound[] = [];
  for (let i = 0; i < rawRounds.length; i++) {
    const round = parseRound(rawRounds[i], i);
    if ('ok' in round) return round;
    if (seen.has(round.round_no)) return reject('duplicate_round_no', 'rounds[' + i + '].round_no');
    seen.add(round.round_no);
    rounds.push(round);
  }

  return { ok: true, value: { surface: body.surface, external_id: externalId, meta, cursor, rounds } };
}

// -- Body parser (5 MB) ---------------------------------------------------------------------

const jsonParser = express.json({ limit: MAX_BODY_BYTES });

/**
 * 5 MB JSON parser for POST /api/session-ingest. index.ts registers it BEFORE the global
 * express.json() (100 kb), behind requireAuth, so a request is authenticated before we buffer
 * up to 5 MB of it. Once this has run, the global parser sees an already-parsed body and skips.
 */
export const sessionIngestBodyParser: express.RequestHandler = (req, res, next) => {
  jsonParser(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    const type = (err as { type?: unknown }).type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    // Some other body-parser rejection (unsupported charset/encoding, aborted upload). Only its
    // machine type is logged: parse error messages can quote a slice of the body.
    log('body rejected type=' + (typeof type === 'string' ? type : 'unknown'));
    res.status(400).json({ error: 'bad_request' });
  });
};

// -- Database -------------------------------------------------------------------------------

class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string,
  ) {
    super(stage + ':' + code);
  }
}

const codeOf = (error: { code?: string } | null | undefined): string => error?.code ?? 'unknown';

async function upsertSession(db: SupabaseClient, userId: string, req: IngestRequest): Promise<string> {
  const row: Record<string, unknown> = {
    user_id: userId,
    surface: req.surface,
    external_id: req.external_id,
    ...req.meta,
  };
  const { data, error } = await db
    .from('claude_sessions')
    .upsert(row, { onConflict: 'user_id,surface,external_id' })
    .select('id')
    .single();
  if (error || !data) throw new StageError('session_upsert', error ? codeOf(error) : 'no_row');
  return (data as { id: string }).id;
}

async function upsertRounds(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  rounds: IngestRound[],
): Promise<void> {
  // No `embedding` key on purpose: an existing embedding survives a re-upload of the round.
  const rows = rounds.map((r) => ({
    session_id: sessionId,
    user_id: userId,
    round_no: r.round_no,
    human: r.human,
    assistant: r.assistant,
    tool_calls: r.tool_calls,
    chars: r.chars,
    est_tokens: r.est_tokens,
    first_message_uuid: r.first_message_uuid,
    last_message_uuid: r.last_message_uuid,
    occurred_at: r.occurred_at,
  }));
  const { error } = await db.from('session_rounds').upsert(rows, { onConflict: 'session_id,round_no' });
  if (error) throw new StageError('rounds_upsert', codeOf(error));
}

/** count(rounds) and sum(chars) over every stored round of the session (not just this call's). */
async function sumRounds(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
): Promise<{ count: number; totalChars: number }> {
  let count = 0;
  let totalChars = 0;
  for (let from = 0; ; from += SUM_PAGE_SIZE) {
    const { data, error } = await db
      .from('session_rounds')
      .select('chars')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('round_no', { ascending: true })
      .range(from, from + SUM_PAGE_SIZE - 1);
    if (error) throw new StageError('rounds_sum', codeOf(error));
    const page = (data ?? []) as Array<{ chars: number | null }>;
    for (const row of page) {
      count += 1;
      totalChars += Number(row.chars) || 0;
    }
    if (page.length < SUM_PAGE_SIZE) break;
  }
  return { count, totalChars };
}

async function finishSession(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  req: IngestRequest,
  roundCount: number,
  totalChars: number,
): Promise<void> {
  const patch: Record<string, unknown> = { round_count: roundCount, total_chars: totalChars };
  // ISO strings from toISOString() sort chronologically, so a string max is a time max.
  const latest = req.rounds.reduce<string | null>(
    (max, r) => (r.occurred_at !== null && (max === null || r.occurred_at > max) ? r.occurred_at : max),
    null,
  );
  if (latest !== null) patch.last_message_at = latest;
  if (req.cursor.last_message_uuid !== undefined) patch.last_uploaded_message_uuid = req.cursor.last_message_uuid;
  if (req.cursor.byte_offset !== undefined) patch.last_byte_offset = req.cursor.byte_offset;
  const { error } = await db.from('claude_sessions').update(patch).eq('id', sessionId).eq('user_id', userId);
  if (error) throw new StageError('session_finish', codeOf(error));
}

// -- Embedding (runs after the response) ------------------------------------------------------

export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

/** human + blank line + assistant, cut to 24000 chars. */
export function embeddingInput(r: Pick<IngestRound, 'human' | 'assistant'>): string {
  return truncateChars((r.human ?? '') + '\n\n' + (r.assistant ?? ''), EMBED_INPUT_MAX_CHARS);
}

const hasEmbeddableText = (r: Pick<IngestRound, 'human' | 'assistant'>): boolean =>
  (r.human ?? '').trim() !== '' || (r.assistant ?? '').trim() !== '';

async function openAiEmbed(inputs: string[]): Promise<number[][]> {
  // maxRetries 0: the spec allows no retries in-request. Built per call, like src/lib/openai.ts,
  // so the server still boots without OPENAI_API_KEY.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 60_000 });
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: inputs, dimensions: EMBED_DIMENSIONS });
  return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function writeEmbeddings(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  rounds: IngestRound[],
  vectors: number[][],
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rounds.length; i += EMBED_WRITE_CONCURRENCY) {
    const slice = rounds.slice(i, i + EMBED_WRITE_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (r, k) => {
        try {
          // Bracketed text, the same form the embed-item-content edge function writes into halfvec columns.
          const { error } = await db
            .from('session_rounds')
            .update({ embedding: '[' + vectors[i + k].join(',') + ']' })
            .eq('session_id', sessionId)
            .eq('user_id', userId)
            .eq('round_no', r.round_no)
            .is('embedding', null);
          return error ? 0 : 1;
        } catch {
          return 0;
        }
      }),
    );
    written += results.reduce<number>((a, b) => a + b, 0);
  }
  return written;
}

/**
 * Embed the just-upserted rounds whose embedding is still null. Any failure (OpenAI, database,
 * bad response shape) leaves the embedding null; there are no retries. Logs counts only.
 */
async function embedMissing(
  db: SupabaseClient,
  embed: EmbedFn,
  userId: string,
  sessionId: string,
  rounds: IngestRound[],
): Promise<void> {
  let embedded = 0;
  let leftNull = 0;
  try {
    const candidates = rounds.filter(hasEmbeddableText);
    if (candidates.length === 0) return;
    const { data, error } = await db
      .from('session_rounds')
      .select('round_no')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .in('round_no', candidates.map((r) => r.round_no))
      .is('embedding', null);
    if (error) throw new StageError('embed_select', codeOf(error));
    const missing = new Set((data ?? []).map((row: { round_no: number }) => row.round_no));
    const todo = candidates.filter((r) => missing.has(r.round_no));
    leftNull = todo.length;
    for (let i = 0; i < todo.length; i += EMBED_BATCH_SIZE) {
      const batch = todo.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vectors = await embed(batch.map(embeddingInput));
        if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBED_DIMENSIONS)) {
          throw new Error('unexpected embedding response shape');
        }
        const written = await writeEmbeddings(db, userId, sessionId, batch, vectors);
        embedded += written;
        leftNull -= written;
      } catch {
        // Leave these rounds' embedding null.
      }
    }
  } catch {
    // Could not even find out which rounds need an embedding; nothing was embedded.
  } finally {
    log('embed session=' + sessionId + ' embedded=' + embedded + ' left_null=' + leftNull);
  }
}

// -- Router ---------------------------------------------------------------------------------

export interface SessionIngestDeps {
  db: SupabaseClient;
  embed: EmbedFn;
}

const userIdOf = (req: express.Request): string | null => {
  const auth = (req as express.Request & { auth?: AuthContext }).auth;
  return typeof auth?.userId === 'string' && auth.userId.length > 0 ? auth.userId : null;
};

/**
 * Express 4 does not catch a rejected async handler, and an unhandled rejection takes the
 * process down. Anything that escapes a handler becomes a 500 with no detail and a log line
 * that carries no message.
 */
const guarded =
  (name: string, handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
  (req, res) => {
    handler(req, res).catch(() => {
      log('failed stage=' + name + ' code=unhandled');
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };

/**
 * Builds the router. `idle()` resolves once every background embedding job started so far has
 * finished (used by the tests; production never awaits it).
 */
export function createSessionIngest(overrides: Partial<SessionIngestDeps> = {}) {
  const db = overrides.db ?? dbAdmin;
  const embed = overrides.embed ?? openAiEmbed;
  const pending = new Set<Promise<void>>();
  const router = express.Router();

  router.post('/', guarded('post', async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    let parsed: ParseResult;
    try {
      parsed = parseIngestBody(req.body);
    } catch {
      // Redaction is regex work on up to 5 MB of caller-supplied text; never let it escape.
      log('failed stage=parse code=exception');
      res.status(400).json({ error: 'unprocessable_body' });
      return;
    }
    if (!parsed.ok) {
      res.status(parsed.status).json({
        error: parsed.error,
        ...(parsed.field !== undefined ? { field: parsed.field } : {}),
        ...(parsed.error === 'too_many_rounds' ? { max_rounds: MAX_ROUNDS_PER_CALL } : {}),
      });
      return;
    }
    const request = parsed.value;

    let sessionId: string;
    let roundCount: number;
    try {
      sessionId = await upsertSession(db, userId, request);
      if (request.rounds.length > 0) await upsertRounds(db, userId, sessionId, request.rounds);
      const { count, totalChars } = await sumRounds(db, userId, sessionId);
      await finishSession(db, userId, sessionId, request, count, totalChars);
      roundCount = count;
    } catch (err) {
      const stage = err instanceof StageError ? err.stage : 'unexpected';
      log('failed stage=' + stage + ' code=' + (err instanceof StageError ? err.code : 'unknown'));
      res.status(500).json({ error: 'ingest_failed', stage });
      return;
    }

    res.status(200).json({
      session_id: sessionId,
      rounds_upserted: request.rounds.length,
      round_count: roundCount,
    });
    log('ok session=' + sessionId + ' rounds=' + request.rounds.length + ' round_count=' + roundCount);

    // Response is on its way; embed afterwards.
    const job = embedMissing(db, embed, userId, sessionId, request.rounds).catch(() => undefined);
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }));

  router.get('/cursor', guarded('cursor', async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { surface, external_id: externalId } = req.query;
    if (!isSurface(surface)) {
      res.status(400).json({ error: 'invalid_surface', field: 'surface' });
      return;
    }
    if (typeof externalId !== 'string' || externalId.length === 0) {
      res.status(400).json({ error: 'external_id_required', field: 'external_id' });
      return;
    }

    try {
      const { data: session, error } = await db
        .from('claude_sessions')
        .select('id, last_uploaded_message_uuid, last_byte_offset')
        .eq('user_id', userId)
        .eq('surface', surface)
        .eq('external_id', externalId)
        .maybeSingle();
      if (error) throw new StageError('cursor_session', codeOf(error));
      if (!session) {
        res.json({ session_id: null, last_uploaded_message_uuid: null, last_byte_offset: null, max_round_no: null });
        return;
      }
      const row = session as { id: string; last_uploaded_message_uuid: string | null; last_byte_offset: number | null };
      const { data: top, error: topError } = await db
        .from('session_rounds')
        .select('round_no')
        .eq('session_id', row.id)
        .eq('user_id', userId)
        .order('round_no', { ascending: false })
        .limit(1);
      if (topError) throw new StageError('cursor_rounds', codeOf(topError));
      const maxRoundNo = (top ?? [])[0] as { round_no: number } | undefined;
      res.json({
        session_id: row.id,
        last_uploaded_message_uuid: row.last_uploaded_message_uuid ?? null,
        last_byte_offset: row.last_byte_offset ?? null,
        max_round_no: maxRoundNo === undefined ? null : maxRoundNo.round_no,
      });
    } catch (err) {
      const stage = err instanceof StageError ? err.stage : 'unexpected';
      log('failed stage=' + stage + ' code=' + (err instanceof StageError ? err.code : 'unknown'));
      res.status(500).json({ error: 'cursor_failed', stage });
    }
  }));

  const idle = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  return { router, idle };
}

/** The instance index.ts mounts: real service-role client, real OpenAI embeddings. */
export const sessionIngestRouter = createSessionIngest().router;

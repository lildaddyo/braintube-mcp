import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmbedFn } from './session-ingest.js';

// src/db/supabase.ts builds its client lazily, but keep the dummy env the other tests use so a
// stray real call could never reach a real project. Nothing here touches the network except
// loopback HTTP to the throwaway servers below.
process.env.SUPABASE_URL ??= 'http://localhost:59999';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const {
  MAX_BODY_BYTES,
  MAX_ROUNDS_PER_CALL,
  TOOL_IO_MAX_CHARS,
  EMBED_INPUT_MAX_CHARS,
  EMBED_BATCH_SIZE,
  EMBED_DIMENSIONS,
  cleanText,
  truncateChars,
  redactSecrets,
  storeToolCall,
  estimateTokens,
  parseIngestBody,
  embeddingInput,
  sessionIngestBodyParser,
  createSessionIngest,
} = await import('./session-ingest.js');

// ---------------------------------------------------------------------------------------------
// Fixtures. Secret-shaped strings are assembled from pieces at runtime so that no line in this
// file looks like a real credential (GitHub push protection scans diffs for those shapes), and
// special characters come from char codes so the file stays plain ASCII.
// ---------------------------------------------------------------------------------------------

const j = (...parts: string[]): string => parts.join('');
const BS = String.fromCharCode(92);
const NUL = String.fromCharCode(0);
const EMOJI = String.fromCodePoint(0x1f600);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd83d);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

const FAKE = {
  sk: j('sk', '-', 'proj', '-', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'),
  skAnthropic: j('sk', '-', 'ant', '-', 'api03', '-', 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2'),
  stripeLive: j('sk', '_live_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  stripeRestricted: j('rk', '_live_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  stripeTest: j('sk', '_test_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  sbSecret: j('sb', '_secret_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'),
  ghp: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  gho: j('gh', 'o_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  ghPat: j('github', '_pat_', '11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
  aws: j('AKIA', 'ABCDEFGHIJKLMNOP'),
  jwt: j(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9',
    '.',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ),
  bearerToken: 'a1B2c3D4e5F6g7H8i9J0k1L2',
};

// Distinctive strings that must never show up in a log line.
const TEXT_SENTINEL = 'ZZ-MESSAGE-TEXT-SENTINEL-ZZ';
const LEAK_SENTINEL = 'ZZ-ERROR-MESSAGE-SENTINEL-ZZ';

// ---------------------------------------------------------------------------------------------
// In-memory stand-in for the slice of supabase-js the route uses. It applies the same rules the
// real tables do where they matter to this route: unique keys for upsert, NOT NULL / CHECK on the
// key columns, and Postgres refusing NUL and lone surrogates. Failures can be injected per call.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type TableName = 'claude_sessions' | 'session_rounds';
type Op = 'select' | 'upsert' | 'update';
type PgError = { code: string; message: string };
type Result = { data: unknown; error: PgError | null };

const CONFLICT_COLUMNS: Record<TableName, string[]> = {
  claude_sessions: ['user_id', 'surface', 'external_id'],
  session_rounds: ['session_id', 'round_no'],
};

function walkStrings(v: unknown, fn: (s: string) => void): void {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn));
  else if (v !== null && typeof v === 'object') Object.values(v as Row).forEach((x) => walkStrings(x, fn));
}

class FakeDb {
  tables: Record<TableName, Row[]> = { claude_sessions: [], session_rounds: [] };
  ops: string[] = [];
  /** Injected failures; `skip` lets that many matching calls through first. */
  failures: Array<{ table: TableName; op: Op; code: string; skip?: number }> = [];

  from(table: string): FakeQuery {
    return new FakeQuery(this, table as TableName);
  }

  /** What Postgres does to text it cannot store. */
  checkStorable(payload: unknown): PgError | null {
    let code: string | null = null;
    walkStrings(payload, (s) => {
      const wf = s as unknown as { isWellFormed?: () => boolean };
      if (s.includes(NUL)) code = '22P05';
      else if (typeof wf.isWellFormed === 'function' && !wf.isWellFormed()) code = '22P05';
    });
    return code === null ? null : { code, message: 'unsupported text ' + LEAK_SENTINEL };
  }
}

class FakeQuery implements PromiseLike<Result> {
  private op: Op = 'select';
  private payload: unknown = null;
  private conflict: string[] = [];
  private filters: Array<(r: Row) => boolean> = [];
  private columns: string[] | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private lo = 0;
  private hi = Number.POSITIVE_INFINITY;
  private wantsRows = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(
    private db: FakeDb,
    private table: TableName,
  ) {}

  select(cols?: string): this {
    this.wantsRows = true;
    this.columns = cols && cols !== '*' ? cols.split(',').map((c) => c.trim()) : null;
    return this;
  }
  upsert(values: unknown, opts: { onConflict?: string } = {}): this {
    this.op = 'upsert';
    this.payload = values;
    this.conflict = (opts.onConflict ?? '').split(',');
    return this;
  }
  update(values: unknown): this {
    this.op = 'update';
    this.payload = values;
    return this;
  }
  eq(col: string, v: unknown): this {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  is(col: string, v: null): this {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  in(col: string, vs: unknown[]): this {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  order(col: string, o: { ascending?: boolean } = {}): this {
    this.orderCol = col;
    this.orderAsc = o.ascending !== false;
    return this;
  }
  limit(n: number): this {
    this.lo = 0;
    this.hi = n - 1;
    return this;
  }
  range(a: number, b: number): this {
    this.lo = a;
    this.hi = b;
    return this;
  }
  single(): this {
    this.mode = 'single';
    return this;
  }
  maybeSingle(): this {
    this.mode = 'maybe';
    return this;
  }

  then<A = Result, B = never>(
    onOk?: ((v: Result) => A | PromiseLike<A>) | null,
    onErr?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onOk, onErr);
  }

  private checkConstraints(row: Row): PgError | null {
    const required =
      this.table === 'claude_sessions' ? ['user_id', 'surface', 'external_id'] : ['session_id', 'user_id', 'round_no'];
    if (required.some((c) => row[c] === undefined || row[c] === null)) return { code: '23502', message: 'not null' };
    if (this.table === 'claude_sessions' && row.surface !== 'claude_ai' && row.surface !== 'claude_code') {
      return { code: '23514', message: 'check' };
    }
    if (this.table === 'session_rounds' && (typeof row.round_no !== 'number' || row.round_no < 0)) {
      return { code: '23514', message: 'check' };
    }
    return null;
  }

  private withDefaults(row: Row): Row {
    const base: Row =
      this.table === 'claude_sessions'
        ? {
            id: randomUUID(),
            url: null,
            title: null,
            project_label: null,
            model: null,
            started_at: null,
            last_message_at: null,
            last_uploaded_message_uuid: null,
            last_byte_offset: null,
            round_count: 0,
            total_chars: 0,
          }
        : {
            id: randomUUID(),
            human: null,
            assistant: null,
            tool_calls: [],
            chars: 0,
            est_tokens: null,
            first_message_uuid: null,
            last_message_uuid: null,
            occurred_at: null,
            embedding: null,
          };
    return { ...base, ...row };
  }

  private shape(rows: Row[] | null): Result {
    if (rows === null) return { data: null, error: null };
    const cols = this.columns;
    const projected = rows.map((r) =>
      cols === null ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null] as const)),
    );
    if (this.mode === 'many') return { data: projected, error: null };
    if (projected.length === 1) return { data: projected[0], error: null };
    if (projected.length === 0 && this.mode === 'maybe') return { data: null, error: null };
    return { data: null, error: { code: 'PGRST116', message: 'expected one row' } };
  }

  private run(): Result {
    this.db.ops.push(this.op + ' ' + this.table);
    const failure = this.db.failures.findIndex((f) => f.table === this.table && f.op === this.op);
    if (failure >= 0) {
      const f = this.db.failures[failure];
      if ((f.skip ?? 0) > 0) f.skip = (f.skip ?? 0) - 1;
      else {
        this.db.failures.splice(failure, 1);
        return { data: null, error: { code: f.code, message: 'database said no ' + LEAK_SENTINEL } };
      }
    }
    const rows = this.db.tables[this.table];

    if (this.op === 'upsert') {
      const notStorable = this.db.checkStorable(this.payload);
      if (notStorable) return { data: null, error: notStorable };
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const touched: Row[] = [];
      for (const row of incoming) {
        const violation = this.checkConstraints(row);
        if (violation) return { data: null, error: violation };
        let existing = rows.find((r) => this.conflict.every((c) => r[c] === row[c]));
        if (existing) Object.assign(existing, row);
        else {
          existing = this.withDefaults(row);
          rows.push(existing);
        }
        touched.push(existing);
      }
      return this.shape(this.wantsRows ? touched : null);
    }

    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') {
      const notStorable = this.db.checkStorable(this.payload);
      if (notStorable) return { data: null, error: notStorable };
      for (const r of matched) Object.assign(r, this.payload as Row);
      return { data: null, error: null };
    }

    let out = matched;
    const col = this.orderCol;
    if (col !== null) {
      out = [...out].sort((a, b) => (Number(a[col]) - Number(b[col])) * (this.orderAsc ? 1 : -1));
    }
    return this.shape(out.slice(this.lo, this.hi + 1));
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP harness: a throwaway Express app wired in the same order as src/index.ts.
// ---------------------------------------------------------------------------------------------

const unitVector = (i: number): number[] =>
  Array.from({ length: EMBED_DIMENSIONS }, (_, k) => (k === i % EMBED_DIMENSIONS ? 1 : 0));

/** Embeddings are written as bracketed text ("[0.1,0.2,...]"), which is what a halfvec column takes. */
const vectorOf = (stored: unknown): number[] => {
  assert.equal(typeof stored, 'string');
  assert.match(stored as string, /^\[[-0-9.e,]+\]$/);
  return JSON.parse(stored as string) as number[];
};

async function serve(app: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: 'http://127.0.0.1:' + port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Harness {
  base: string;
  db: FakeDb;
  svc: ReturnType<typeof createSessionIngest>;
  embedCalls: string[][];
  /** Everything the route wrote via console.error / console.warn while this harness was up. */
  logs: string[];
  /** Everything written via console.log / console.info (must stay empty: stdout is the MCP transport). */
  stdout: string[];
}

interface HarnessOptions {
  /** Authenticated user id; null simulates a request that reached the router without req.auth. */
  userId?: string | null;
  db?: FakeDb;
  embed?: EmbedFn;
  /** Runs between the parsers and the router (used to sabotage req.body). */
  beforeRouter?: express.RequestHandler;
}

async function withServer(opts: HarnessOptions, run: (h: Harness) => Promise<void>): Promise<void> {
  const db = opts.db ?? new FakeDb();
  const embedCalls: string[][] = [];
  const embed: EmbedFn =
    opts.embed ??
    (async (inputs) => {
      embedCalls.push(inputs);
      return inputs.map((_, i) => unitVector(i));
    });
  const svc = createSessionIngest({ db: db as unknown as SupabaseClient, embed });
  const userId = opts.userId === undefined ? 'user-A' : opts.userId;

  // Stand-in for requireAuth: all that matters here is that the router only ever reads req.auth.
  const fakeAuth: express.RequestHandler = (req, _res, next) => {
    if (userId !== null) (req as express.Request & { auth?: unknown }).auth = { userId, authMethod: 'jwt' };
    next();
  };
  const app = express();
  app.post('/api/session-ingest', fakeAuth, sessionIngestBodyParser); // 5 MB parser, ahead of the global one
  app.use(express.json()); // the 100 kb global parser
  if (opts.beforeRouter) app.use(opts.beforeRouter);
  app.use('/api/session-ingest', fakeAuth, svc.router);
  const server = await serve(app);

  const logs: string[] = [];
  const stdout: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  const line = (args: unknown[]): string => args.map(String).join(' ');
  console.error = (...a: unknown[]) => void logs.push(line(a));
  console.warn = (...a: unknown[]) => void logs.push(line(a));
  console.log = (...a: unknown[]) => void stdout.push(line(a));
  console.info = (...a: unknown[]) => void stdout.push(line(a));
  try {
    await run({ base: server.base + '/api/session-ingest', db, svc, embedCalls, logs, stdout });
  } finally {
    await svc.idle();
    Object.assign(console, saved);
    await server.close();
  }
}

const post = (base: string, body: unknown): Promise<Response> =>
  fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (base: string, path: string): Promise<Response> => fetch(base + path);
const asJson = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

const round = (n: number, extra: Row = {}): Row => ({ round_no: n, human: 'q' + n, assistant: 'a' + n, ...extra });
const payload = (extra: Row = {}): Row => ({
  surface: 'claude_code',
  external_id: 'sess-1',
  cursor: {},
  rounds: [round(0)],
  ...extra,
});
const manyRounds = (count: number, extra: Row = {}): Row[] => Array.from({ length: count }, (_, i) => round(i, extra));

// ===============================================================================================
// Redaction
// ===============================================================================================

function assertRedacts(secret: string, kind: string): void {
  const out = redactSecrets('use ' + secret + ' here');
  assert.equal(out, 'use [REDACTED:' + kind + '] here');
  assert.ok(!out.includes(secret));
}

test('redacts sk- keys (OpenAI and Anthropic shaped)', () => {
  assertRedacts(FAKE.sk, 'sk_key');
  assertRedacts(FAKE.skAnthropic, 'sk_key');
});

test('redacts Stripe keys (sk_live_, rk_live_, sk_test_)', () => {
  assertRedacts(FAKE.stripeLive, 'stripe_key');
  assertRedacts(FAKE.stripeRestricted, 'stripe_key');
  assertRedacts(FAKE.stripeTest, 'stripe_key');
});

test('redacts sb_secret_ keys', () => {
  assertRedacts(FAKE.sbSecret, 'sb_secret');
});

test('redacts GitHub tokens (ghp_, gho_, github_pat_)', () => {
  assertRedacts(FAKE.ghp, 'github_token');
  assertRedacts(FAKE.gho, 'github_token');
  assertRedacts(FAKE.ghPat, 'github_token');
});

test('redacts AWS access key ids', () => {
  assertRedacts(FAKE.aws, 'aws_access_key');
});

test('redacts JWTs, including inside an Authorization header', () => {
  assertRedacts(FAKE.jwt, 'jwt');
  assert.equal(redactSecrets('Authorization: Bearer ' + FAKE.jwt), 'Authorization: Bearer [REDACTED:jwt]');
});

test('redacts Bearer tokens', () => {
  assertRedacts('Bearer ' + FAKE.bearerToken, 'bearer');
  assertRedacts('bearer ' + FAKE.bearerToken, 'bearer');
});

test('redacts the value after NAME= assignments and keeps the name', () => {
  const cases: Array<[string, string]> = [
    ['SUPABASE_SERVICE_ROLE_KEY=not-a-real-value', 'SUPABASE_SERVICE_ROLE_KEY=[REDACTED:env_assignment]'],
    ['OPENAI_API_KEY=not-a-real-value', 'OPENAI_API_KEY=[REDACTED:env_assignment]'],
    ['export DB_PASSWORD="two words"', 'export DB_PASSWORD=[REDACTED:env_assignment]'],
    ["$env:STRIPE_SECRET = 'value with spaces'", '$env:STRIPE_SECRET = [REDACTED:env_assignment]'],
    ['TOKEN=abc', 'TOKEN=[REDACTED:env_assignment]'],
    ['AWS_SECRET_ACCESS_KEY=abc/def+ghi==', 'AWS_SECRET_ACCESS_KEY=[REDACTED:env_assignment]'],
    ['{"NOTION_API_KEY": "not-a-real-value"}', '{"NOTION_API_KEY": "[REDACTED:env_assignment]"}'],
    ['first=1\nSERVICE_TOKEN=abc\nlast=2', 'first=1\nSERVICE_TOKEN=[REDACTED:env_assignment]\nlast=2'],
    // A value that is itself a recognised token keeps its more specific kind.
    ['OPENAI_API_KEY=' + FAKE.sk, 'OPENAI_API_KEY=[REDACTED:sk_key]'],
    ['SUPABASE_SERVICE_ROLE_KEY=' + FAKE.jwt, 'SUPABASE_SERVICE_ROLE_KEY=[REDACTED:jwt]'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test('leaves assignments alone that are not secrets or only reference one', () => {
  const untouched = [
    'MAX_TOKENS=4096',
    'TOKEN_LIMIT=5',
    'MONKEY=banana',
    'KEYBOARD=us',
    'API_KEY=$API_KEY',
    'API_KEY=${API_KEY}',
    'API_KEY=$(cat key.txt)',
    'const API_KEY = process.env.API_KEY',
    'API_KEY = os.environ["API_KEY"]',
    'lowercase_key=value',
  ];
  for (const s of untouched) assert.equal(redactSecrets(s), s, s);
});

test('redacts a secret that follows a JSON-escaped newline (backslash + n)', () => {
  assert.equal(redactSecrets('echo hi' + BS + 'n' + FAKE.sk), 'echo hi' + BS + 'n[REDACTED:sk_key]');
  assert.equal(redactSecrets('echo hi' + BS + 'n' + FAKE.jwt), 'echo hi' + BS + 'n[REDACTED:jwt]');
  assert.equal(
    redactSecrets('x' + BS + 'nNOTION_API_KEY=not-a-real-value'),
    'x' + BS + 'nNOTION_API_KEY=[REDACTED:env_assignment]',
  );
  assert.equal(redactSecrets('a' + BS + 'r' + BS + 'n' + FAKE.stripeLive), 'a' + BS + 'r' + BS + 'n[REDACTED:stripe_key]');
});

test('leaves ordinary prose, slugs and short lookalikes alone', () => {
  const untouched = [
    'Bearer authentication is required',
    'Bearer Authentication',
    'the Bearer scheme',
    'task-management-dashboard-with-lots-of-words',
    'disk-usage-report-for-the-quarterly-review',
    'task_live_notifications_dashboard',
    'sk-short',
    'AKIA-short and AKIAshort',
    'eyJ is the base64 of an opening brace and quote',
    'set the Authorization header',
  ];
  for (const s of untouched) assert.equal(redactSecrets(s), s, s);
});

test('redaction is idempotent and handles every pattern in one text', () => {
  const all = [FAKE.sk, FAKE.stripeLive, FAKE.sbSecret, FAKE.ghp, FAKE.aws, FAKE.jwt, 'Bearer ' + FAKE.bearerToken, 'MY_SECRET=abc'].join(' | ');
  const once = redactSecrets(all);
  assert.equal(redactSecrets(once), once);
  for (const secret of [FAKE.sk, FAKE.stripeLive, FAKE.sbSecret, FAKE.ghp, FAKE.aws, FAKE.jwt, FAKE.bearerToken]) {
    assert.ok(!once.includes(secret));
  }
});

test('redaction stays fast on adversarial input (no quadratic or stack-overflow patterns)', () => {
  const hostile: Array<[string, string]> = [
    ['eyJ repeated, no dots', 'eyJ'.repeat(800_000)],
    ['sk- repeated', 'sk-'.repeat(800_000)],
    ['one long UPPER_CASE run', 'A_'.repeat(1_200_000)],
    ['KEY= repeated', 'KEY='.repeat(600_000)],
    ['Bearer repeated', 'Bearer '.repeat(400_000)],
    ['long run then a dot', 'x'.repeat(2_000_000) + '.'],
    ['escaped newlines', (BS + 'n').repeat(800_000)],
    ['short names after escaped newlines', ('A'.repeat(60) + BS + 'n').repeat(30_000)],
  ];
  for (const [label, text] of hostile) {
    const t0 = performance.now();
    redactSecrets(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 4000, label + ' took ' + Math.round(ms) + ' ms');
  }
});

// ===============================================================================================
// Text hygiene, tool calls and round maths
// ===============================================================================================

test('cleanText strips NUL and replaces lone surrogates; well-formed text is unchanged', () => {
  assert.equal(cleanText('a' + NUL + 'b' + NUL), 'ab');
  assert.equal(cleanText('x' + LONE_HIGH_SURROGATE + 'y'), 'x' + REPLACEMENT_CHAR + 'y');
  assert.equal(cleanText('plain ' + EMOJI + ' text'), 'plain ' + EMOJI + ' text');
});

test('truncateChars never leaves half a surrogate pair', () => {
  assert.equal(truncateChars('abcdef', 3), 'abc');
  assert.equal(truncateChars('abc', 3), 'abc');
  const cut = truncateChars('a'.repeat(7) + EMOJI + 'b', 8);
  assert.equal(cut, 'a'.repeat(7));
  assert.equal(truncateChars('a'.repeat(6) + EMOJI + 'b', 8), 'a'.repeat(6) + EMOJI);
});

test('tool truncation keeps input and output at 8000 chars with the ORIGINAL counts', () => {
  const tc = storeToolCall({ name: 'Bash', input: 'a'.repeat(20000), output: 'b'.repeat(9000) });
  assert.equal(tc.input?.length, TOOL_IO_MAX_CHARS);
  assert.equal(tc.output?.length, TOOL_IO_MAX_CHARS);
  assert.equal(tc.input_chars, 20000);
  assert.equal(tc.output_chars, 9000);
  assert.equal(tc.truncated, true);
  assert.deepEqual(Object.keys(tc).sort(), ['input', 'input_chars', 'name', 'output', 'output_chars', 'truncated']);
});

test('tool truncation: exactly 8000 is kept whole, 8001 is cut, either side triggers truncated', () => {
  const exact = storeToolCall({ name: 't', input: 'a'.repeat(8000), output: 'b'.repeat(8000) });
  assert.equal(exact.truncated, false);
  assert.equal(exact.input_chars, 8000);
  const oneOver = storeToolCall({ name: 't', input: 'a'.repeat(8001), output: 'short' });
  assert.equal(oneOver.truncated, true);
  assert.equal(oneOver.input?.length, 8000);
  assert.equal(oneOver.input_chars, 8001);
  assert.equal(oneOver.output, 'short');
  assert.equal(oneOver.output_chars, 5);
  const outputOnly = storeToolCall({ name: 't', input: 'i', output: 'o'.repeat(8500) });
  assert.equal(outputOnly.truncated, true);
  assert.equal(outputOnly.input, 'i');
});

test('tool call without input or output stores null and zero counts', () => {
  const tc = storeToolCall({ name: 'Read' });
  assert.deepEqual(tc, { name: 'Read', input: null, output: null, input_chars: 0, output_chars: 0, truncated: false });
});

test('tool call text is redacted before it is stored, and cut on a surrogate boundary', () => {
  const tc = storeToolCall({ name: 'Bash', input: 'curl -H "Authorization: Bearer ' + FAKE.jwt + '"', output: 'key ' + FAKE.sk });
  assert.ok(!tc.input?.includes(FAKE.jwt) && tc.input?.includes('[REDACTED:jwt]'));
  assert.ok(!tc.output?.includes(FAKE.sk) && tc.output?.includes('[REDACTED:sk_key]'));
  const emoji = storeToolCall({ name: 'x', output: 'a'.repeat(7999) + EMOJI + 'b' });
  assert.equal(emoji.output?.length, 7999);
  assert.equal(emoji.output_chars, 7999 + 2 + 1);
  const wf = emoji.output as unknown as { isWellFormed?: () => boolean };
  assert.equal(wf.isWellFormed?.() ?? true, true);
});

test('est_tokens = ceil(chars/4 + tool chars/4), tool chars being the original counts', () => {
  assert.equal(estimateTokens(8, 21), 8); // ceil(2 + 5.25)
  assert.equal(estimateTokens(0, 0), 0);
  assert.equal(estimateTokens(1, 0), 1);
  const parsed = parseIngestBody(
    payload({
      rounds: [
        {
          round_no: 0,
          human: 'abcd',
          assistant: 'efgh',
          tool_calls: [{ name: 'Bash', input: 'x'.repeat(10), output: 'y'.repeat(11) }],
        },
      ],
    }),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.value.rounds[0].chars, 8);
  assert.equal(parsed.value.rounds[0].est_tokens, 8);

  const huge = parseIngestBody(
    payload({ rounds: [{ round_no: 0, human: 'abcd', tool_calls: [{ name: 'Bash', input: 'x'.repeat(20000) }] }] }),
  );
  assert.ok(huge.ok);
  assert.equal(huge.value.rounds[0].tool_calls[0].input?.length, TOOL_IO_MAX_CHARS);
  assert.equal(huge.value.rounds[0].est_tokens, 5001); // ceil(4/4 + 20000/4), from the original count
});

test('parseIngestBody redacts human, assistant and tool text, and a NUL cannot split a secret past the patterns', () => {
  const parsed = parseIngestBody(
    payload({
      rounds: [
        {
          round_no: 0,
          human: 'my key is ' + FAKE.ghp,
          assistant: 'sk-' + NUL + 'proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
          tool_calls: [{ name: 'Bash', input: 'export OPENAI_API_KEY=hunter2', output: FAKE.aws }],
        },
      ],
    }),
  );
  assert.ok(parsed.ok);
  const r = parsed.value.rounds[0];
  assert.equal(r.human, 'my key is [REDACTED:github_token]');
  assert.equal(r.assistant, '[REDACTED:sk_key]');
  assert.equal(r.tool_calls[0].input, 'export OPENAI_API_KEY=[REDACTED:env_assignment]');
  assert.equal(r.tool_calls[0].output, '[REDACTED:aws_access_key]');
});

test('parseIngestBody normalises occurred_at to UTC ISO and keeps optional fields null', () => {
  const parsed = parseIngestBody(
    payload({ rounds: [{ round_no: 3, human: 'h', occurred_at: '2026-09-26T10:00:00+02:00' }] }),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.value.rounds[0].occurred_at, '2026-09-26T08:00:00.000Z');
  assert.equal(parsed.value.rounds[0].assistant, null);
  assert.equal(parsed.value.rounds[0].first_message_uuid, null);
  assert.deepEqual(parsed.value.rounds[0].tool_calls, []);
});

test('embeddingInput is human + blank line + assistant, cut at 24000 chars', () => {
  assert.equal(embeddingInput({ human: 'q', assistant: 'a' }), 'q\n\na');
  assert.equal(embeddingInput({ human: null, assistant: 'a' }), '\n\na');
  assert.equal(embeddingInput({ human: 'h'.repeat(10), assistant: 'a'.repeat(30000) }).length, EMBED_INPUT_MAX_CHARS);
});

// ===============================================================================================
// POST /api/session-ingest
// ===============================================================================================

test('POST stores the session and its rounds and answers {session_id, rounds_upserted, round_count}', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, {
      surface: 'claude_code',
      external_id: 'sess-1',
      url: 'https://example.test/s/1',
      title: 'A title',
      project_label: 'proj',
      model: 'model-x',
      cursor: { last_message_uuid: 'uuid-9', byte_offset: 4096 },
      rounds: [
        {
          round_no: 0,
          human: 'hello',
          assistant: 'world',
          first_message_uuid: 'u0',
          last_message_uuid: 'u1',
          occurred_at: '2026-09-26T10:00:00Z',
          tool_calls: [{ name: 'Bash', input: 'ls', output: 'a b' }],
        },
        { round_no: 1, human: 'again', assistant: 'yes', occurred_at: '2026-09-26T10:05:00Z' },
      ],
    });
    assert.equal(res.status, 200);
    const session = h.db.tables.claude_sessions[0];
    assert.deepEqual(await asJson(res), { session_id: session.id, rounds_upserted: 2, round_count: 2 });

    assert.equal(h.db.tables.claude_sessions.length, 1);
    assert.equal(session.user_id, 'user-A');
    assert.equal(session.surface, 'claude_code');
    assert.equal(session.external_id, 'sess-1');
    assert.equal(session.url, 'https://example.test/s/1');
    assert.equal(session.title, 'A title');
    assert.equal(session.project_label, 'proj');
    assert.equal(session.model, 'model-x');
    assert.equal(session.last_message_at, '2026-09-26T10:05:00.000Z');
    assert.equal(session.last_uploaded_message_uuid, 'uuid-9');
    assert.equal(session.last_byte_offset, 4096);
    assert.equal(session.round_count, 2);
    assert.equal(session.total_chars, 10 + 8);

    const [r0, r1] = h.db.tables.session_rounds;
    assert.equal(r0.session_id, session.id);
    assert.equal(r0.user_id, 'user-A');
    assert.equal(r0.round_no, 0);
    assert.equal(r0.human, 'hello');
    assert.equal(r0.chars, 10);
    assert.equal(r0.est_tokens, 4); // ceil(10/4 + (2 + 3)/4)
    assert.equal(r0.first_message_uuid, 'u0');
    assert.equal(r0.last_message_uuid, 'u1');
    assert.equal(r0.occurred_at, '2026-09-26T10:00:00.000Z');
    assert.deepEqual(r0.tool_calls, [
      { name: 'Bash', input: 'ls', output: 'a b', input_chars: 2, output_chars: 3, truncated: false },
    ]);
    assert.equal(r1.chars, 8);
    assert.equal(r1.est_tokens, 2);
    assert.deepEqual(r1.tool_calls, []);
    assert.equal(h.stdout.length, 0);
  });
});

test('POST is an upsert: repeating a round replaces it, and round_count / total_chars are recounted over all rounds', async () => {
  await withServer({}, async (h) => {
    let res = await post(h.base, payload({ rounds: [round(0), round(1)] }));
    assert.deepEqual(await asJson(res), {
      session_id: h.db.tables.claude_sessions[0].id,
      rounds_upserted: 2,
      round_count: 2,
    });

    res = await post(h.base, payload({ rounds: [round(1, { human: 'edited human text' }), round(2)] }));
    const out = await asJson(res);
    assert.equal(out.rounds_upserted, 2);
    assert.equal(out.round_count, 3);

    assert.equal(h.db.tables.claude_sessions.length, 1);
    assert.equal(h.db.tables.session_rounds.length, 3);
    const byNo = new Map(h.db.tables.session_rounds.map((r) => [r.round_no as number, r]));
    assert.equal(byNo.get(1)?.human, 'edited human text');
    const session = h.db.tables.claude_sessions[0];
    assert.equal(session.round_count, 3);
    assert.equal(session.total_chars, 2 + 2 + ('edited human text'.length + 2) + (2 + 2)); // q0+a0, edited+a1, q2+a2
  });
});

test('POST only writes metadata that was provided; an empty string never blanks a stored value', async () => {
  await withServer({}, async (h) => {
    await post(h.base, payload({ url: 'https://example.test/s/1', title: 'Kept', project_label: 'p', model: 'm' }));
    await post(h.base, payload({ title: '', rounds: [round(1)] }));
    const session = h.db.tables.claude_sessions[0];
    assert.equal(session.url, 'https://example.test/s/1');
    assert.equal(session.title, 'Kept');
    assert.equal(session.project_label, 'p');
    assert.equal(session.model, 'm');
  });
});

test('POST moves the cursor only when it is given, and keeps last_message_at from the batch maximum', async () => {
  await withServer({}, async (h) => {
    await post(
      h.base,
      payload({
        cursor: { last_message_uuid: 'uuid-1', byte_offset: 10 },
        rounds: [round(0, { occurred_at: '2026-09-26T09:00:00Z' }), round(1, { occurred_at: '2026-09-26T11:00:00Z' }), round(2, { occurred_at: '2026-09-26T10:00:00Z' })],
      }),
    );
    let session = h.db.tables.claude_sessions[0];
    assert.equal(session.last_message_at, '2026-09-26T11:00:00.000Z');
    assert.equal(session.last_uploaded_message_uuid, 'uuid-1');
    assert.equal(session.last_byte_offset, 10);

    await post(h.base, payload({ cursor: {}, rounds: [round(3)] })); // no cursor values, no timestamps
    session = h.db.tables.claude_sessions[0];
    assert.equal(session.last_message_at, '2026-09-26T11:00:00.000Z');
    assert.equal(session.last_uploaded_message_uuid, 'uuid-1');
    assert.equal(session.last_byte_offset, 10);
    assert.equal(session.round_count, 4);
  });
});

test('POST with no rounds still records the cursor and recounts', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, payload({ rounds: [], cursor: { byte_offset: 77 } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await asJson(res), {
      session_id: h.db.tables.claude_sessions[0].id,
      rounds_upserted: 0,
      round_count: 0,
    });
    assert.equal(h.db.tables.claude_sessions[0].last_byte_offset, 77);
    assert.equal(h.db.tables.session_rounds.length, 0);
    assert.equal(h.embedCalls.length, 0);
  });
});

test('a failed rounds upsert answers 500, leaves the stored cursor where it was, and logs only stage and code', async () => {
  await withServer({}, async (h) => {
    await post(h.base, payload({ cursor: { last_message_uuid: 'old', byte_offset: 1 } }));
    await h.svc.idle(); // let the first call's background embedding finish so the count below is deterministic
    h.db.failures.push({ table: 'session_rounds', op: 'upsert', code: 'XX000' });
    const res = await post(
      h.base,
      payload({ cursor: { last_message_uuid: 'new', byte_offset: 2 }, rounds: [round(1, { human: TEXT_SENTINEL })] }),
    );
    assert.equal(res.status, 500);
    assert.deepEqual(await asJson(res), { error: 'ingest_failed', stage: 'rounds_upsert' });
    const session = h.db.tables.claude_sessions[0];
    assert.equal(session.last_uploaded_message_uuid, 'old');
    assert.equal(session.last_byte_offset, 1);
    assert.equal(h.db.tables.session_rounds.length, 1);
    const all = h.logs.join('\n');
    assert.match(all, /failed stage=rounds_upsert code=XX000/);
    assert.ok(!all.includes(LEAK_SENTINEL) && !all.includes(TEXT_SENTINEL));
    assert.equal(h.embedCalls.length, 1); // only the first, successful call embedded anything
  });
});

test('each database stage that can fail answers 500 with its stage name', async () => {
  const stages: Array<[TableName, Op, string]> = [
    ['claude_sessions', 'upsert', 'session_upsert'],
    ['session_rounds', 'select', 'rounds_sum'],
    ['claude_sessions', 'update', 'session_finish'],
  ];
  for (const [table, op, stage] of stages) {
    await withServer({}, async (h) => {
      h.db.failures.push({ table, op, code: '57014' });
      const res = await post(h.base, payload());
      assert.equal(res.status, 500, stage);
      assert.equal((await asJson(res)).stage, stage);
      assert.equal(h.embedCalls.length, 0, stage + ' must not embed');
      assert.match(h.logs.join('\n'), new RegExp('stage=' + stage + ' code=57014'));
    });
  }
});

// -- limits -------------------------------------------------------------------------------------

test('413 over 200 rounds, and nothing is written', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, payload({ rounds: manyRounds(MAX_ROUNDS_PER_CALL + 1) }));
    assert.equal(res.status, 413);
    assert.deepEqual(await asJson(res), { error: 'too_many_rounds', field: 'rounds', max_rounds: 200 });
    assert.deepEqual(h.db.ops, []);
  });
});

test('exactly 200 rounds is accepted', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, payload({ rounds: manyRounds(MAX_ROUNDS_PER_CALL) }));
    assert.equal(res.status, 200);
    assert.equal((await asJson(res)).round_count, 200);
  });
});

test('a body far over the 100 kb global limit is accepted (the 5 MB parser runs first)', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, payload({ rounds: [round(0, { human: 'x'.repeat(300_000) })] }));
    assert.equal(res.status, 200);
    assert.equal(h.db.tables.session_rounds[0].chars, 300_000 + 2);
  });
});

test('413 over 5 MB, and nothing is written', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, payload({ rounds: [round(0, { human: 'x'.repeat(MAX_BODY_BYTES + 1000) })] }));
    assert.equal(res.status, 413);
    assert.deepEqual(await asJson(res), { error: 'payload_too_large', max_bytes: MAX_BODY_BYTES });
    assert.deepEqual(h.db.ops, []);
  });
});

test('control: the global 100 kb parser alone would refuse the same 300 kb body (why index.ts registers the 5 MB parser first)', async () => {
  const svc = createSessionIngest({ db: new FakeDb() as unknown as SupabaseClient, embed: async () => [] });
  const app = express();
  app.set('env', 'test'); // keep Express from printing the error
  app.use(express.json());
  app.use('/api/session-ingest', (req, _res, next) => {
    (req as express.Request & { auth?: unknown }).auth = { userId: 'user-A', authMethod: 'jwt' };
    next();
  }, svc.router);
  const server = await serve(app);
  try {
    const res = await post(server.base + '/api/session-ingest', payload({ rounds: [round(0, { human: 'x'.repeat(300_000) })] }));
    assert.equal(res.status, 413);
  } finally {
    await server.close();
  }
});

// -- validation ---------------------------------------------------------------------------------

test('400 on a bad surface', async () => {
  for (const surface of ['claude_web', 'CLAUDE_AI', '', 5, null, undefined, ['claude_ai']]) {
    await withServer({}, async (h) => {
      const res = await post(h.base, payload({ surface }));
      assert.equal(res.status, 400, String(surface));
      assert.deepEqual(await asJson(res), { error: 'invalid_surface', field: 'surface' });
      assert.deepEqual(h.db.ops, []);
    });
  }
});

test('both surfaces are accepted', async () => {
  for (const surface of ['claude_ai', 'claude_code']) {
    await withServer({}, async (h) => {
      const res = await post(h.base, payload({ surface }));
      assert.equal(res.status, 200, surface);
      assert.equal(h.db.tables.claude_sessions[0].surface, surface);
    });
  }
});

test('400 for every other malformed body, naming the field but never echoing content', async () => {
  const cases: Array<[string, unknown, string, string | undefined]> = [
    ['external_id missing', payload({ external_id: undefined }), 'external_id_required', 'external_id'],
    ['external_id empty', payload({ external_id: '' }), 'external_id_required', 'external_id'],
    ['external_id not a string', payload({ external_id: 12345 }), 'external_id_required', 'external_id'],
    ['rounds missing', payload({ rounds: undefined }), 'rounds_must_be_an_array', 'rounds'],
    ['rounds not an array', payload({ rounds: { round_no: 0 } }), 'rounds_must_be_an_array', 'rounds'],
    ['body is an array', [], 'body_must_be_a_json_object', undefined],
    ['body is a string', '"just a string"', 'invalid_json', undefined],
    ['invalid JSON', '{"surface": ', 'invalid_json', undefined],
    ['round is not an object', payload({ rounds: ['nope'] }), 'invalid_round', 'rounds[0]'],
    ['round_no missing', payload({ rounds: [{ human: 'h' }] }), 'invalid_round_no', 'rounds[0].round_no'],
    ['round_no negative', payload({ rounds: [round(-1)] }), 'invalid_round_no', 'rounds[0].round_no'],
    ['round_no fractional', payload({ rounds: [round(1.5)] }), 'invalid_round_no', 'rounds[0].round_no'],
    ['round_no a string', payload({ rounds: [{ round_no: '3' }] }), 'invalid_round_no', 'rounds[0].round_no'],
    ['round_no over int4', payload({ rounds: [round(2147483648)] }), 'invalid_round_no', 'rounds[0].round_no'],
    ['duplicate round_no', payload({ rounds: [round(4), round(4)] }), 'duplicate_round_no', 'rounds[1].round_no'],
    ['human not a string', payload({ rounds: [{ round_no: 0, human: 12345 }] }), 'invalid_round', 'rounds[0].human'],
    ['assistant not a string', payload({ rounds: [{ round_no: 0, assistant: {} }] }), 'invalid_round', 'rounds[0].assistant'],
    ['occurred_at not a date', payload({ rounds: [round(0, { occurred_at: 'yesterday' })] }), 'invalid_occurred_at', 'rounds[0].occurred_at'],
    ['occurred_at not a string', payload({ rounds: [round(0, { occurred_at: 1790000000 })] }), 'invalid_round', 'rounds[0].occurred_at'],
    ['tool_calls not an array', payload({ rounds: [round(0, { tool_calls: 'x' })] }), 'invalid_tool_calls', 'rounds[0].tool_calls'],
    ['tool call not an object', payload({ rounds: [round(0, { tool_calls: [1] })] }), 'invalid_tool_call', 'rounds[0].tool_calls[0]'],
    ['tool call without a name', payload({ rounds: [round(0, { tool_calls: [{ input: 'i' }] })] }), 'invalid_tool_call', 'rounds[0].tool_calls[0].name'],
    ['tool input not a string', payload({ rounds: [round(0, { tool_calls: [{ name: 'n', input: { a: 1 } }] })] }), 'invalid_tool_call', 'rounds[0].tool_calls[0].input'],
    ['tool output not a string', payload({ rounds: [round(0, { tool_calls: [{ name: 'n', output: 7 }] })] }), 'invalid_tool_call', 'rounds[0].tool_calls[0].output'],
    ['cursor not an object', payload({ cursor: 'abc' }), 'invalid_cursor', 'cursor'],
    ['cursor uuid not a string', payload({ cursor: { last_message_uuid: 5 } }), 'invalid_cursor', 'cursor.last_message_uuid'],
    ['cursor offset negative', payload({ cursor: { byte_offset: -1 } }), 'invalid_cursor', 'cursor.byte_offset'],
    ['cursor offset fractional', payload({ cursor: { byte_offset: 1.5 } }), 'invalid_cursor', 'cursor.byte_offset'],
    ['cursor offset a string', payload({ cursor: { byte_offset: '10' } }), 'invalid_cursor', 'cursor.byte_offset'],
    ['url not a string', payload({ url: 7 }), 'invalid_field', 'url'],
    ['title not a string', payload({ title: {} }), 'invalid_field', 'title'],
  ];
  await withServer({}, async (h) => {
    for (const [label, body, error, field] of cases) {
      const res = await post(h.base, body);
      assert.equal(res.status, 400, label);
      const out = await asJson(res);
      assert.equal(out.error, error, label);
      assert.equal(out.field, field, label);
      assert.ok(!JSON.stringify(out).includes('12345'), label + ' echoed its input');
    }
    assert.deepEqual(h.db.ops, []);
  });
});

test('metadata and cursor are optional, and a missing cursor object is treated as empty', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, { surface: 'claude_ai', external_id: 'bare', rounds: [round(0)] });
    assert.equal(res.status, 200);
    const session = h.db.tables.claude_sessions[0];
    assert.equal(session.title, null);
    assert.equal(session.last_uploaded_message_uuid, null);
  });
});

// -- auth ---------------------------------------------------------------------------------------

test('fails closed with 401 when the request reached the router without req.auth', async () => {
  await withServer({ userId: null }, async (h) => {
    const res = await post(h.base, payload());
    assert.equal(res.status, 401);
    assert.deepEqual(await asJson(res), { error: 'unauthorized' });
    const cursor = await get(h.base, '/cursor?surface=claude_code&external_id=sess-1');
    assert.equal(cursor.status, 401);
    assert.deepEqual(h.db.ops, []);
  });
});

test('user_id in the body (or query string) is ignored: everything is stored under the authenticated user', async () => {
  await withServer({ userId: 'user-A' }, async (h) => {
    const res = await fetch(h.base + '?user_id=attacker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        payload({
          user_id: 'attacker',
          userId: 'attacker',
          auth: { userId: 'attacker' },
          cursor: { user_id: 'attacker', last_message_uuid: 'u' },
          rounds: [round(0, { user_id: 'attacker', session_id: 'attacker-session' })],
        }),
      ),
    });
    assert.equal(res.status, 200);
    for (const row of [...h.db.tables.claude_sessions, ...h.db.tables.session_rounds]) {
      assert.equal(row.user_id, 'user-A');
    }
    assert.ok(!JSON.stringify(h.db.tables).includes('attacker'));
  });
});

test('two users never share a session, even with the same surface and external_id', async () => {
  const db = new FakeDb();
  await withServer({ db, userId: 'user-A' }, async (h) => {
    assert.equal((await post(h.base, payload({ rounds: [round(0)] }))).status, 200);
  });
  await withServer({ db, userId: 'user-B' }, async (h) => {
    assert.equal((await post(h.base, payload({ rounds: [round(0, { human: 'B text' })] }))).status, 200);
  });
  assert.equal(db.tables.claude_sessions.length, 2);
  assert.deepEqual(db.tables.claude_sessions.map((s) => s.user_id).sort(), ['user-A', 'user-B']);
  assert.equal(db.tables.session_rounds.length, 2);
  assert.equal(new Set(db.tables.session_rounds.map((r) => r.session_id)).size, 2);
});

// -- redaction and hygiene through the route ----------------------------------------------------

test('secrets are redacted in human, assistant and tool input/output before anything is stored', async () => {
  await withServer({}, async (h) => {
    const res = await post(
      h.base,
      payload({
        rounds: [
          {
            round_no: 0,
            human: 'here is my token ' + FAKE.ghp,
            assistant: 'use ' + FAKE.stripeLive + ' and OPENAI_API_KEY=hunter2',
            tool_calls: [{ name: 'Bash', input: 'curl -H "Authorization: Bearer ' + FAKE.jwt + '"', output: FAKE.sbSecret + ' ' + FAKE.aws }],
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const stored = JSON.stringify(h.db.tables);
    for (const secret of [FAKE.ghp, FAKE.stripeLive, 'hunter2', FAKE.jwt, FAKE.sbSecret, FAKE.aws]) {
      assert.ok(!stored.includes(secret), 'stored a secret');
    }
    const row = h.db.tables.session_rounds[0];
    assert.equal(row.human, 'here is my token [REDACTED:github_token]');
    assert.equal(row.assistant, 'use [REDACTED:stripe_key] and OPENAI_API_KEY=[REDACTED:env_assignment]');
    // Embedding input is built from the redacted text too.
    assert.ok(h.embedCalls.flat().every((s) => !s.includes(FAKE.ghp) && !s.includes(FAKE.stripeLive)));
  });
});

test('human and assistant are stored whole (verbatim archive), not truncated', async () => {
  await withServer({}, async (h) => {
    const long = 'w'.repeat(50_000);
    await post(h.base, payload({ rounds: [{ round_no: 0, human: long, assistant: long }] }));
    const row = h.db.tables.session_rounds[0];
    assert.equal((row.human as string).length, 50_000);
    assert.equal((row.assistant as string).length, 50_000);
    assert.equal(row.chars, 100_000);
  });
});

test('NUL and lone surrogates (which Postgres would refuse) are cleaned instead of failing the batch', async () => {
  await withServer({}, async (h) => {
    const res = await post(
      h.base,
      payload({
        title: 'ti' + NUL + 'tle',
        rounds: [
          {
            round_no: 0,
            human: 'a' + NUL + 'b',
            assistant: 'x' + LONE_HIGH_SURROGATE + 'y ' + EMOJI,
            tool_calls: [{ name: 'Bash', input: 'in' + NUL + 'put', output: 'out' + LONE_HIGH_SURROGATE }],
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const row = h.db.tables.session_rounds[0];
    assert.equal(row.human, 'ab');
    assert.equal(row.assistant, 'x' + REPLACEMENT_CHAR + 'y ' + EMOJI);
    const tc = (row.tool_calls as Array<Record<string, unknown>>)[0];
    assert.equal(tc.input, 'input');
    assert.equal(tc.output, 'out' + REPLACEMENT_CHAR);
    assert.equal(h.db.tables.claude_sessions[0].title, 'title');
  });
});

test('tool call truncation through the route keeps the original counts and est_tokens', async () => {
  await withServer({}, async (h) => {
    await post(
      h.base,
      payload({
        rounds: [
          {
            round_no: 0,
            human: 'abcd',
            assistant: 'efgh',
            tool_calls: [{ name: 'Read', input: 'i'.repeat(20000), output: 'o'.repeat(9000) }],
          },
        ],
      }),
    );
    const row = h.db.tables.session_rounds[0];
    const tc = (row.tool_calls as Array<Record<string, unknown>>)[0];
    assert.equal((tc.input as string).length, 8000);
    assert.equal((tc.output as string).length, 8000);
    assert.equal(tc.input_chars, 20000);
    assert.equal(tc.output_chars, 9000);
    assert.equal(tc.truncated, true);
    assert.equal(row.est_tokens, Math.ceil(8 / 4 + 29000 / 4));
  });
});

// -- logging ------------------------------------------------------------------------------------

test('logs carry counts and ids only: no message text, no tool payloads, no secrets, no error messages, nothing on stdout', async () => {
  await withServer({}, async (h) => {
    h.db.failures.push({ table: 'session_rounds', op: 'upsert', code: 'XX000' });
    await post(h.base, payload({ title: TEXT_SENTINEL, rounds: [round(0, { human: TEXT_SENTINEL + FAKE.sk, assistant: TEXT_SENTINEL })] })); // fails
    await post(
      h.base,
      payload({
        title: TEXT_SENTINEL,
        rounds: [
          round(0, {
            human: TEXT_SENTINEL + FAKE.sk,
            assistant: TEXT_SENTINEL,
            tool_calls: [{ name: 'Bash', input: TEXT_SENTINEL + FAKE.jwt, output: TEXT_SENTINEL }],
          }),
        ],
      }),
    ); // succeeds
    await post(h.base, '{"human": "' + TEXT_SENTINEL + '"'); // invalid JSON, body-parser message would quote it
    await get(h.base, '/cursor?surface=claude_code&external_id=sess-1');
    await h.svc.idle();

    const all = h.logs.join('\n');
    assert.ok(all.length > 0, 'expected some log lines');
    for (const forbidden of [TEXT_SENTINEL, LEAK_SENTINEL, FAKE.sk, FAKE.jwt, 'Bash']) {
      assert.ok(!all.includes(forbidden), 'log leaked ' + forbidden);
    }
    assert.match(all, /\[session-ingest\] failed stage=rounds_upsert code=XX000/);
    assert.match(all, /\[session-ingest\] ok session=[0-9a-f-]{36} rounds=1 round_count=1/);
    assert.match(all, /\[session-ingest\] embed session=[0-9a-f-]{36} embedded=1 left_null=0/);
    assert.equal(h.stdout.length, 0, 'the route must not write to stdout');
  });
});

test('an exception while parsing a hostile body answers 400 and the server keeps serving', async () => {
  const hostile: express.RequestHandler = (req, _res, next) => {
    if (req.headers['x-hostile'] === '1') {
      req.body = new Proxy({}, { get: () => { throw new RangeError('regex stack overflow stand-in'); } });
    }
    next();
  };
  await withServer({ beforeRouter: hostile }, async (h) => {
    const bad = await fetch(h.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hostile': '1' },
      body: JSON.stringify(payload()),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await asJson(bad), { error: 'unprocessable_body' });
    assert.match(h.logs.join('\n'), /failed stage=parse code=exception/);
    assert.ok(!h.logs.join('\n').includes('stack overflow'));

    const ok = await post(h.base, payload());
    assert.equal(ok.status, 200);
  });
});

test('an unexpected exception from the database layer becomes a 500 without detail', async () => {
  const db = new FakeDb();
  db.from = () => {
    throw new Error('driver blew up ' + LEAK_SENTINEL);
  };
  await withServer({ db }, async (h) => {
    const res = await post(h.base, payload());
    assert.equal(res.status, 500);
    assert.deepEqual(await asJson(res), { error: 'ingest_failed', stage: 'unexpected' });
    assert.ok(!h.logs.join('\n').includes(LEAK_SENTINEL));
    assert.match(h.logs.join('\n'), /failed stage=unexpected code=unknown/);
  });
});

// ===============================================================================================
// Embedding (after the response)
// ===============================================================================================

test('the response is sent BEFORE embedding; the embedding lands afterwards', { timeout: 20000 }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let embedStarted = false;
  const embed: EmbedFn = async (inputs) => {
    embedStarted = true;
    await gate;
    return inputs.map((_, i) => unitVector(i));
  };
  await withServer({ embed }, async (h) => {
    const res = await post(h.base, payload()); // would hang here if the route awaited the embedding
    assert.equal(res.status, 200);
    assert.equal((await asJson(res)).round_count, 1);
    assert.equal(h.db.tables.session_rounds[0].embedding, null);
    release();
    await h.svc.idle();
    assert.ok(embedStarted);
    const stored = vectorOf(h.db.tables.session_rounds[0].embedding as unknown); // (narrowed to null above)
    assert.equal(stored.length, EMBED_DIMENSIONS);
    assert.equal(stored[0], 1);
  });
});

test('embeds only rounds whose embedding is null, as text-input human + blank line + assistant, in batches of at most 100', async () => {
  await withServer({}, async (h) => {
    const res = await post(h.base, payload({ rounds: manyRounds(150) }));
    assert.equal(res.status, 200);
    await h.svc.idle();
    assert.deepEqual(h.embedCalls.map((c) => c.length), [EMBED_BATCH_SIZE, 50]);
    assert.equal(h.embedCalls[0][7], 'q7\n\na7');
    assert.ok(h.db.tables.session_rounds.every((r) => vectorOf(r.embedding).length === EMBED_DIMENSIONS));

    // Same rounds again: everything already has an embedding, so nothing is sent to OpenAI.
    await post(h.base, payload({ rounds: manyRounds(150) }));
    await h.svc.idle();
    assert.equal(h.embedCalls.length, 2);
  });
});

test('200 rounds make exactly two batches of 100', async () => {
  await withServer({}, async (h) => {
    await post(h.base, payload({ rounds: manyRounds(200) }));
    await h.svc.idle();
    assert.deepEqual(h.embedCalls.map((c) => c.length), [100, 100]);
  });
});

test('embedding input is cut at 24000 chars', async () => {
  await withServer({}, async (h) => {
    await post(h.base, payload({ rounds: [{ round_no: 0, human: 'h', assistant: 'a'.repeat(30000) }] }));
    await h.svc.idle();
    assert.equal(h.embedCalls[0][0].length, EMBED_INPUT_MAX_CHARS);
    assert.ok(h.embedCalls[0][0].startsWith('h\n\naaa'));
    assert.equal((h.db.tables.session_rounds[0].assistant as string).length, 30000); // storage is not cut
  });
});

test('an embedding error leaves embedding null, is not retried, still answers 200, and logs a count only', async () => {
  let calls = 0;
  const embed: EmbedFn = async () => {
    calls += 1;
    throw new Error('429 quota exceeded ' + LEAK_SENTINEL + ' ' + TEXT_SENTINEL);
  };
  await withServer({ embed }, async (h) => {
    const res = await post(h.base, payload({ rounds: manyRounds(3, { human: TEXT_SENTINEL }) }));
    assert.equal(res.status, 200);
    await h.svc.idle();
    assert.equal(calls, 1);
    assert.ok(h.db.tables.session_rounds.every((r) => r.embedding === null));
    const all = h.logs.join('\n');
    assert.match(all, /embed session=[0-9a-f-]{36} embedded=0 left_null=3/);
    assert.ok(!all.includes(LEAK_SENTINEL) && !all.includes(TEXT_SENTINEL));
  });
});

test('a failed batch does not stop the next batch', async () => {
  let calls = 0;
  const embed: EmbedFn = async (inputs) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return inputs.map((_, i) => unitVector(i));
  };
  await withServer({ embed }, async (h) => {
    await post(h.base, payload({ rounds: manyRounds(150) }));
    await h.svc.idle();
    assert.equal(calls, 2);
    const embedded = h.db.tables.session_rounds.filter((r) => r.embedding !== null).length;
    assert.equal(embedded, 50);
    assert.match(h.logs.join('\n'), /embedded=50 left_null=100/);
  });
});

test('a response with the wrong number or size of vectors is treated as an error', async () => {
  for (const bad of [
    async () => [] as number[][],
    async (inputs: string[]) => inputs.map(() => [1, 2, 3]),
  ] as EmbedFn[]) {
    await withServer({ embed: bad }, async (h) => {
      await post(h.base, payload({ rounds: manyRounds(2) }));
      await h.svc.idle();
      assert.ok(h.db.tables.session_rounds.every((r) => r.embedding === null));
    });
  }
});

test('rounds with no text are not sent to the embedder', async () => {
  await withServer({}, async (h) => {
    await post(
      h.base,
      payload({
        rounds: [
          { round_no: 0, human: '', assistant: '   ' },
          { round_no: 1, tool_calls: [{ name: 'Bash', input: 'ls' }] },
          round(2),
        ],
      }),
    );
    await h.svc.idle();
    assert.deepEqual(h.embedCalls, [['q2\n\na2']]);
    assert.equal(h.db.tables.session_rounds.find((r) => r.round_no === 0)?.embedding, null);
    assert.notEqual(h.db.tables.session_rounds.find((r) => r.round_no === 2)?.embedding, null);
  });
});

test('a database error while looking for rounds to embed still answers 200, leaves embeddings null and never calls the embedder', async () => {
  await withServer({}, async (h) => {
    // The recount is the first session_rounds select of a call; let it through and fail the embed-time one.
    h.db.failures.push({ table: 'session_rounds', op: 'select', code: 'XX000', skip: 1 });
    const res = await post(h.base, payload());
    assert.equal(res.status, 200);
    await h.svc.idle();
    assert.equal(h.embedCalls.length, 0);
    assert.equal(h.db.tables.session_rounds[0].embedding, null);
    assert.match(h.logs.join('\n'), /embed session=[0-9a-f-]{36} embedded=0 left_null=0/);
    assert.deepEqual(h.db.failures, []);
  });
});

// ===============================================================================================
// GET /api/session-ingest/cursor
// ===============================================================================================

test('GET /cursor returns nulls for a session that does not exist', async () => {
  await withServer({}, async (h) => {
    const res = await get(h.base, '/cursor?surface=claude_code&external_id=nope');
    assert.equal(res.status, 200);
    assert.deepEqual(await asJson(res), {
      session_id: null,
      last_uploaded_message_uuid: null,
      last_byte_offset: null,
      max_round_no: null,
    });
  });
});

test('GET /cursor returns the stored cursor and the highest round_no', async () => {
  await withServer({}, async (h) => {
    await post(
      h.base,
      payload({ cursor: { last_message_uuid: 'uuid-42', byte_offset: 9001 }, rounds: [round(0), round(5), round(3)] }),
    );
    const res = await get(h.base, '/cursor?surface=claude_code&external_id=sess-1');
    assert.equal(res.status, 200);
    assert.deepEqual(await asJson(res), {
      session_id: h.db.tables.claude_sessions[0].id,
      last_uploaded_message_uuid: 'uuid-42',
      last_byte_offset: 9001,
      max_round_no: 5,
    });
  });
});

test('GET /cursor for a session with a cursor but no rounds has max_round_no null', async () => {
  await withServer({}, async (h) => {
    await post(h.base, payload({ rounds: [], cursor: { last_message_uuid: 'only-cursor' } }));
    const out = await asJson(await get(h.base, '/cursor?surface=claude_code&external_id=sess-1'));
    assert.equal(out.last_uploaded_message_uuid, 'only-cursor');
    assert.equal(out.last_byte_offset, null);
    assert.equal(out.max_round_no, null);
  });
});

test('GET /cursor is scoped to the authenticated user and to the surface', async () => {
  const db = new FakeDb();
  await withServer({ db, userId: 'user-A' }, async (h) => {
    await post(h.base, payload({ cursor: { last_message_uuid: 'A-cursor' } }));
    const same = await asJson(await get(h.base, '/cursor?surface=claude_code&external_id=sess-1'));
    assert.equal(same.last_uploaded_message_uuid, 'A-cursor');
    const otherSurface = await asJson(await get(h.base, '/cursor?surface=claude_ai&external_id=sess-1'));
    assert.equal(otherSurface.session_id, null);
  });
  await withServer({ db, userId: 'user-B' }, async (h) => {
    const out = await asJson(await get(h.base, '/cursor?surface=claude_code&external_id=sess-1&user_id=user-A'));
    assert.equal(out.session_id, null);
    assert.equal(out.last_uploaded_message_uuid, null);
  });
});

test('GET /cursor answers 400 for a bad surface or a missing / repeated external_id', async () => {
  await withServer({}, async (h) => {
    for (const query of [
      '',
      '?external_id=x',
      '?surface=claude_web&external_id=x',
      '?surface=claude_code',
      '?surface=claude_code&external_id=',
      '?surface=claude_code&external_id=a&external_id=b',
      '?surface=claude_ai&surface=claude_code&external_id=x',
    ]) {
      const res = await get(h.base, '/cursor' + query);
      assert.equal(res.status, 400, query);
    }
    assert.deepEqual(h.db.ops, []);
  });
});

test('GET /cursor answers 500 with a stage name when the database fails', async () => {
  await withServer({}, async (h) => {
    h.db.failures.push({ table: 'claude_sessions', op: 'select', code: '57014' });
    const res = await get(h.base, '/cursor?surface=claude_code&external_id=sess-1');
    assert.equal(res.status, 500);
    assert.deepEqual(await asJson(res), { error: 'cursor_failed', stage: 'cursor_session' });
    assert.match(h.logs.join('\n'), /failed stage=cursor_session code=57014/);
    assert.ok(!h.logs.join('\n').includes(LEAK_SENTINEL));
  });
});

// ===============================================================================================
// Wiring in src/index.ts
// ===============================================================================================

test('src/index.ts registers the 5 MB parser before the global parser, and the router after the /api layer', () => {
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const early = src.indexOf("app.post('/api/session-ingest', requireAuth, sessionIngestBodyParser)");
  const globalParser = src.indexOf('app.use(express.json())');
  const apiLayer = src.indexOf("app.use('/api', requireAuth, mcpRateLimit, restRouter)");
  const mount = src.indexOf("app.use('/api/session-ingest', sessionIngestRouter)");
  assert.ok(early !== -1 && globalParser !== -1 && apiLayer !== -1 && mount !== -1, 'a registration line is missing');
  assert.ok(early < globalParser, 'the 5 MB parser must come before express.json()');
  assert.ok(apiLayer < mount, 'the router must be mounted after the /api auth + rate-limit layer');
  const registrations = src.match(/app\.\w+\('\/api\/session-ingest'/g) ?? [];
  assert.equal(registrations.length, 2, 'expected exactly the parser line and the mount line');
});

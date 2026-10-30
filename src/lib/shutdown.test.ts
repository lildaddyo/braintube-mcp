import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createInFlightTracker, createGracefulShutdown } from './shutdown.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An app with a slow route (/slow?ms=N) and a never-ending stream (/stream), behind the tracker. */
async function startApp() {
  const tracker = createInFlightTracker((req) => req.path === '/stream');
  const app = express();
  app.use(tracker.middleware);
  app.get('/slow', async (req, res) => {
    await sleep(Number(req.query.ms ?? 100));
    res.json({ ok: true });
  });
  app.get('/stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\n\n');
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { tracker, server, base };
}

test('in-flight requests finish before exit; new connections are refused once shutdown starts', async () => {
  const { tracker, server, base } = await startApp();
  const exits: number[] = [];
  const logs: string[] = [];
  const shutdown = createGracefulShutdown({
    server,
    drain: () => tracker.idle(),
    onStart: () => tracker.startDraining(),
    timeoutMs: 5_000,
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
  });

  const slow = fetch(`${base}/slow?ms=300`);
  await sleep(50);
  assert.equal(tracker.count(), 1);

  const done = shutdown('SIGTERM');
  assert.equal(shutdown('SIGTERM'), done, 'a second signal reuses the same shutdown');

  const res = await slow;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  await assert.rejects(fetch(`${base}/slow?ms=1`), 'listener is closed');

  await done;
  assert.deepEqual(exits, [0]);
  assert.match(logs.at(-1) ?? '', /drained in \d+ ms/);
});

test('an open SSE stream does not hold the drain; beforeExit runs and remaining sockets are dropped', async () => {
  const { tracker, server, base } = await startApp();
  const exits: number[] = [];
  let closedTransports = false;
  const shutdown = createGracefulShutdown({
    server,
    drain: () => tracker.idle(),
    beforeExit: () => { closedTransports = true; },
    timeoutMs: 5_000,
    exit: (code) => exits.push(code),
    log: () => {},
  });

  const stream = await fetch(`${base}/stream`);
  assert.equal(stream.status, 200);
  assert.equal(tracker.count(), 0, 'streams are excluded from the in-flight count');

  const t0 = Date.now();
  await shutdown('SIGTERM');
  assert.ok(Date.now() - t0 < 1_000, 'did not wait for the stream');
  assert.equal(closedTransports, true);
  assert.deepEqual(exits, [0]);
  await stream.body?.cancel().catch(() => undefined);
});

test('a request that outlives the deadline does not block exit', async () => {
  const { tracker, server, base } = await startApp();
  const exits: number[] = [];
  const logs: string[] = [];
  const shutdown = createGracefulShutdown({
    server,
    drain: () => tracker.idle(),
    timeoutMs: 150,
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
  });

  const stuck = fetch(`${base}/slow?ms=1000`).catch((err: unknown) => err);
  await sleep(50);
  const t0 = Date.now();
  await shutdown('SIGINT');
  const took = Date.now() - t0;
  assert.ok(took >= 140 && took < 2_000, `exited at the deadline (took ${took} ms)`);
  assert.deepEqual(exits, [0]);
  assert.match(logs.at(-1) ?? '', /timed out/);
  assert.ok((await stuck) instanceof Error, 'the stuck socket was dropped');
});

test('tracker: idle() resolves immediately with nothing in flight, and Connection: close is set while draining', async () => {
  const { tracker, server, base } = await startApp();
  await tracker.idle();
  tracker.startDraining();
  const res = await fetch(`${base}/slow?ms=1`);
  assert.equal(res.headers.get('connection'), 'close');
  await res.text();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { asyncHandler, jsonErrorHandler, installProcessHandlers } from './async-handler.js';

async function withApp(build: (app: express.Express) => void, run: (base: string) => Promise<void>) {
  const app = express();
  build(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('a rejected /mcp handler answers a 500 JSON-RPC error instead of an unhandled rejection', async () => {
  const errors: unknown[] = [];
  const onUnhandled = (e: unknown) => errors.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await withApp((app) => {
      app.post('/mcp', asyncHandler('mcp', async () => { throw new Error('db down'); }, 'jsonrpc'));
      app.get('/plain', asyncHandler('plain', async () => { throw new Error('nope'); }));
      app.get('/sync-throw', asyncHandler('sync', (() => { throw new Error('sync'); }) as never));
    }, async (base) => {
      const r1 = await fetch(`${base}/mcp`, { method: 'POST' });
      assert.equal(r1.status, 500);
      assert.deepEqual(await r1.json(), { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });

      const r2 = await fetch(`${base}/plain`);
      assert.equal(r2.status, 500);
      assert.deepEqual(await r2.json(), { error: 'internal_error' });

      const r3 = await fetch(`${base}/sync-throw`);
      assert.equal(r3.status, 500);
      await r3.text();
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(errors, [], 'no unhandled rejection escaped');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a failure after headers went out ends the response instead of writing again', async () => {
  await withApp((app) => {
    app.get('/stream', asyncHandler('stream', async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      throw new Error('mid-stream');
    }, 'jsonrpc'));
  }, async (base) => {
    const r = await fetch(`${base}/stream`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'data: one\n\n');
  });
});

test('jsonErrorHandler keeps body-parser statuses and answers JSON', async () => {
  await withApp((app) => {
    app.use(express.json({ limit: '10b' }));
    app.post('/mcp', (_req, res) => { res.json({ ok: true }); });
    app.post('/api/x', (_req, res) => { res.json({ ok: true }); });
    app.get('/boom', (_req, _res, next) => next(new Error('boom')));
    app.use(jsonErrorHandler);
  }, async (base) => {
    const big = JSON.stringify({ text: 'x'.repeat(100) });
    const r1 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(r1.status, 413);
    assert.deepEqual(await r1.json(), { error: 'entity.too.large' });

    const r2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(r2.status, 400);
    const j2 = await r2.json() as { jsonrpc: string; error: { code: number } };
    assert.equal(j2.jsonrpc, '2.0');
    assert.equal(j2.error.code, -32700);

    const r3 = await fetch(`${base}/boom`);
    assert.equal(r3.status, 500);
    assert.deepEqual(await r3.json(), { error: 'internal_error' });
  });
});

test('installProcessHandlers logs unhandled rejections and does not exit', () => {
  const fake = new EventEmitter() as unknown as NodeJS.Process;
  installProcessHandlers(fake);
  assert.equal((fake as unknown as EventEmitter).listenerCount('unhandledRejection'), 1);
  const origError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    (fake as unknown as EventEmitter).emit('unhandledRejection', new Error('stray'), Promise.resolve());
  } finally {
    console.error = origError;
  }
  assert.match(logged.join('\n'), /unhandledRejection \(kept running\).*stray/s);
});

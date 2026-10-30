import type { Server } from 'node:http';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Graceful shutdown (F3). Railway sends SIGTERM on every deploy; before 3.15.5 nothing handled
 * it. Since the container runs `node dist/index.js` as PID 1, the kernel ignored the signal
 * (PID 1 gets no default handlers) and the process ran until it was SIGKILLed, mid-request.
 *
 * On SIGTERM / SIGINT:
 *   1. stop accepting connections (server.close) and mark responses `Connection: close`;
 *   2. wait until in-flight requests (not counting long-lived SSE streams) and background jobs
 *      finish, up to `timeoutMs`;
 *   3. run `beforeExit` (closes MCP transports, which ends SSE streams), drop any remaining
 *      sockets, and exit 0 (also when the deadline was hit; that case is logged).
 */

/** Counts requests in flight; `exclude` marks requests that are long-lived streams. */
export function createInFlightTracker(exclude: (req: Request) => boolean = () => false) {
  let active = 0;
  let draining = false;
  const waiters = new Set<() => void>();
  const notify = () => { if (active === 0) for (const w of [...waiters]) w(); };

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (draining) res.setHeader('Connection', 'close');
    if (exclude(req)) { next(); return; }
    active++;
    let done = false;
    res.once('close', () => {
      if (done) return;
      done = true;
      active--;
      notify();
    });
    next();
  };

  return {
    middleware,
    count: () => active,
    startDraining: () => { draining = true; },
    /** Resolves when no tracked request is in flight. */
    idle: (): Promise<void> => {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const w = () => { waiters.delete(w); resolve(); };
        waiters.add(w);
      });
    },
  };
}

export interface GracefulShutdownOptions {
  server: Server;
  /** Resolves when in-flight work is done (requests, background jobs). */
  drain: () => Promise<void>;
  /** Called once draining finished or timed out, before sockets are dropped. */
  beforeExit?: () => void | Promise<void>;
  /** Called first, synchronously, when shutdown starts. */
  onStart?: () => void;
  timeoutMs: number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

/** Returns an idempotent `shutdown(signal)`; the second signal is ignored while draining. */
export function createGracefulShutdown(opts: GracefulShutdownOptions): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((msg: string) => console.error(msg));
  let started: Promise<void> | null = null;

  return (signal: string) => {
    if (started) return started;
    started = (async () => {
      const t0 = Date.now();
      log(`[shutdown] ${signal} received — draining (up to ${Math.round(opts.timeoutMs / 1000)} s)`);
      opts.onStart?.();
      opts.server.close();
      // Keep-alive sockets with no request in flight would otherwise hold close() open.
      opts.server.closeIdleConnections?.();

      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        opts.drain().then(() => false, () => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), opts.timeoutMs); timer.unref?.(); }),
      ]);
      if (timer) clearTimeout(timer);

      try {
        await opts.beforeExit?.();
      } catch (err) {
        log(`[shutdown] beforeExit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      opts.server.closeAllConnections?.();
      log(timedOut
        ? `[shutdown] drain timed out after ${Date.now() - t0} ms — exiting with work still in flight`
        : `[shutdown] drained in ${Date.now() - t0} ms — exiting`);
      // Always 0: a SIGTERM exit is intentional, and a non-zero code could trip the ON_FAILURE restart policy.
      exit(0);
    })();
    return started;
  };
}

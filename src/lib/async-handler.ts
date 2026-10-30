import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';

/**
 * Express 4 does not catch a rejected promise from an async handler: it becomes an
 * unhandledRejection, which on Node >= 15 terminates the process (F7). Every async route that
 * has no try/catch of its own goes through this wrapper, which answers 500 instead.
 *
 * `/mcp` speaks JSON-RPC, so the error body is a JSON-RPC error object; other routes get
 * `{ error: 'internal_error' }`. If headers already went out (an SSE stream or a streamed
 * response), the response is ended rather than written to again.
 */
export function asyncHandler(
  label: string,
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  shape: 'jsonrpc' | 'json' = 'json',
): RequestHandler {
  return (req, res, next) => {
    let p: Promise<unknown>;
    try {
      p = fn(req, res, next);
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p).catch((err: unknown) => sendInternalError(label, res, err, shape));
  };
}

export function sendInternalError(label: string, res: Response, err: unknown, shape: 'jsonrpc' | 'json'): void {
  console.error(`[${label}] unhandled error:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (shape === 'jsonrpc') {
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  } else {
    res.status(500).json({ error: 'internal_error' });
  }
}

/** Last-resort Express error middleware: JSON instead of Express's HTML stack page. */
export const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // body-parser errors (413 too large, 400 bad JSON) carry their own status; keep it.
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  if (status >= 500) {
    console.error(`[express] ${req.method} ${req.path} error:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  if (res.headersSent) {
    next(err);
    return;
  }
  const body = status >= 500 ? 'internal_error' : (err as { type?: string })?.type ?? 'bad_request';
  if (req.path.startsWith('/mcp')) {
    res.status(status).json({ jsonrpc: '2.0', error: { code: status >= 500 ? -32603 : -32700, message: body }, id: null });
  } else {
    res.status(status).json({ error: body });
  }
};

/**
 * Process-level safety net. An unhandled rejection is logged and the process keeps serving:
 * a stray promise in one request must not take every user's session down (the Railway restart
 * policy is ON_FAILURE x3, so a crash loop could leave the service down). Uncaught synchronous
 * exceptions keep Node's default (crash and restart), since process state may be corrupt.
 */
export function installProcessHandlers(proc: NodeJS.Process = process): void {
  proc.on('unhandledRejection', (reason) => {
    console.error('[process] unhandledRejection (kept running):', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });
}

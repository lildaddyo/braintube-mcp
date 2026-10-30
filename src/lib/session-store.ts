/**
 * MCP session store with idle-TTL and LRU-cap eviction.
 *
 * Until 3.15.5 the store was a plain Map that an hourly timer cleared in one go, so every live
 * session (busy or not) got "Session not found" at the same moment and all clients re-initialized
 * together. Now each entry remembers when it was last used; a periodic sweep evicts only the
 * sessions idle longer than `idleMs`, and `maxSessions` caps the total by evicting the least
 * recently used. Sessions with a request in flight (a tool call or an open SSE GET stream) are
 * never treated as idle.
 *
 * Evicted values are handed to `onEvict` (index.ts closes the transport there, which also ends an
 * open SSE stream instead of leaving it held by its response).
 */

export interface SessionStoreOptions<T> {
  /** Evict sessions not used for this long. */
  idleMs: number;
  /** Hard cap on live sessions; the least recently used one is evicted to make room. */
  maxSessions: number;
  /** Called after an entry has left the store (idle sweep, cap, or closeAll). */
  onEvict?: (sessionId: string, value: T, reason: EvictReason) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export type EvictReason = 'idle' | 'cap' | 'shutdown';

interface Entry<T> {
  value: T;
  userId: string;
  lastSeen: number;
  inFlight: number;
}

export class SessionStore<T> {
  // Map iteration order is insertion order; touch() re-inserts, so the first entry is always the LRU one.
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;

  constructor(private readonly opts: SessionStoreOptions<T>) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Add a session. Evicts the least recently used idle session(s) if the cap is reached. */
  set(sessionId: string, value: T, userId: string): void {
    this.entries.delete(sessionId);
    while (this.entries.size >= this.opts.maxSessions) {
      if (!this.evictLru()) break;
    }
    this.entries.set(sessionId, { value, userId, lastSeen: this.now(), inFlight: 0 });
  }

  /**
   * The value for this session, only if `userId` is the user who created it (BTMCP-05).
   * A hit counts as use and moves the session to the most-recently-used end.
   */
  get(sessionId: string, userId: string): T | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.userId !== userId) return undefined;
    this.touch(sessionId, entry);
    return entry.value;
  }

  /** Marks a request as running on this session; the returned function ends it (idempotent). */
  begin(sessionId: string): () => void {
    const entry = this.entries.get(sessionId);
    if (!entry) return () => {};
    entry.inFlight++;
    this.touch(sessionId, entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastSeen = this.now();
    };
  }

  /** Remove without calling onEvict (the transport closed by itself). */
  delete(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  /** Evict every session idle for longer than idleMs. Returns how many were evicted. */
  sweep(): number {
    const cutoff = this.now() - this.opts.idleMs;
    let evicted = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.inFlight === 0 && entry.lastSeen <= cutoff) {
        this.evict(id, entry, 'idle');
        evicted++;
      }
    }
    return evicted;
  }

  /** Evict everything (graceful shutdown). */
  closeAll(): number {
    const all = [...this.entries];
    for (const [id, entry] of all) this.evict(id, entry, 'shutdown');
    return all.length;
  }

  private touch(sessionId: string, entry: Entry<T>): void {
    entry.lastSeen = this.now();
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  /** Evict the least recently used session, preferring one with no request in flight. */
  private evictLru(): boolean {
    let victim: [string, Entry<T>] | undefined;
    for (const pair of this.entries) {
      if (pair[1].inFlight === 0) { victim = pair; break; }
    }
    victim ??= this.entries.entries().next().value;
    if (!victim) return false;
    this.evict(victim[0], victim[1], 'cap');
    return true;
  }

  private evict(sessionId: string, entry: Entry<T>, reason: EvictReason): void {
    // Delete first: onEvict usually closes the transport, whose onclose calls delete() again.
    this.entries.delete(sessionId);
    try {
      this.opts.onEvict?.(sessionId, entry.value, reason);
    } catch (err) {
      console.error(`[mcp] session evict callback failed (${reason}):`, err instanceof Error ? err.message : String(err));
    }
  }
}

/** Reads a positive integer from the environment, falling back to `fallback`. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * In-process LRU cache with a TTL (cache scope R&D 2026-10-16).
 *
 * The Railway process is long-lived and agents repeat the same queries across sessions, so the paid calls on the
 * search path (OpenAI embeddings, gpt-4o-mini query translation, jev-rerank) are memoised here. Bounded by entry
 * count; the least recently used entry is evicted first (Map insertion order, re-inserted on every hit).
 * Only successful values are stored: `getOrCompute` never caches a thrown error, and callers skip `undefined`.
 * Hit/miss counters are reported on /health via `cacheStats()`. Kill switch: QUERY_CACHE=off.
 */
import { createHash } from 'node:crypto';

export interface CacheStats { size: number; max: number; ttl_s: number; hits: number; misses: number; hit_rate: number | null }

export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  hits = 0;
  misses = 0;

  constructor(readonly max: number, readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (e.expires <= this.now()) { this.map.delete(key); this.misses++; return undefined; }
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  /** Cached value, else compute it; a result for which `keep` is false (e.g. null = failed) is returned but not stored. */
  async getOrCompute(key: string, compute: () => Promise<V>, keep: (v: V) => boolean = v => v !== undefined && v !== null): Promise<V> {
    if (process.env.QUERY_CACHE === 'off') return compute();
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    if (keep(value)) this.set(key, value);
    return value;
  }

  clear(): void { this.map.clear(); this.hits = 0; this.misses = 0; }

  get size(): number { return this.map.size; }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return { size: this.map.size, max: this.max, ttl_s: Math.round(this.ttlMs / 1000), hits: this.hits, misses: this.misses, hit_rate: total ? Math.round((this.hits / total) * 1000) / 1000 : null };
  }
}

/** Query text as a cache key: Unicode NFC, trimmed, inner whitespace collapsed. Case is kept (it reaches the model). */
export function normaliseQuery(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Fixed-size key for long or private text. */
export function hashKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('base64url');
}

const HOUR = 3_600_000;
// Embeddings are stored as Float32Array (the OpenAI SDK decodes base64 float32, so this is lossless): ~3 KB per
// 768-dim vector, ~6 KB per 1536-dim one -> at most ~12 MB for 2000 entries.
export const embeddingCache = new TtlCache<Float32Array>(2000, 24 * HOUR);
// The `| null` in these value types is the failure result of the compute step; getOrCompute never stores it.
export const translationCache = new TtlCache<string | null>(2000, 24 * HOUR);
// Re-rank scores depend on the passage text, which can change when an item is re-summarised: shorter TTL.
export const rerankCache = new TtlCache<Map<string, number> | null>(2000, 1 * HOUR);
// Extension capture: summary of a conversation already summarised (same user + content hash + platform).
export const summaryCache = new TtlCache<{ title: string; summary: string }>(500, 24 * HOUR);

const caches = { embedding: embeddingCache, translation: translationCache, rerank: rerankCache, extension_summary: summaryCache };

export function cacheStats(): Record<keyof typeof caches, CacheStats> {
  return Object.fromEntries(Object.entries(caches).map(([k, c]) => [k, c.stats()])) as Record<keyof typeof caches, CacheStats>;
}

export function clearCaches(): void {
  for (const c of Object.values(caches)) c.clear();
}

/**
 * Server-side stage timing for search responses (2026-11-19): `timing_ms` on search_knowledge says where the time
 * went, measured on the server, so a latency number does not depend on the client's network or tool runner.
 * Stages overlap when they run in parallel, so they need not add up to `total`.
 */
export type StageTimes = Record<string, number>;

export class StageTimer {
  private readonly t0 = performance.now();
  readonly stages: StageTimes = {};

  /** Run `fn` and add its wall time to `stage` (a stage measured twice is summed). */
  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.add(stage, performance.now() - start);
    }
  }

  add(stage: string, ms: number): void {
    this.stages[stage] = Math.round((this.stages[stage] ?? 0) + ms);
  }

  /** `{ total, ...stages }` in whole milliseconds. */
  result(): StageTimes {
    return { total: Math.round(performance.now() - this.t0), ...this.stages };
  }
}

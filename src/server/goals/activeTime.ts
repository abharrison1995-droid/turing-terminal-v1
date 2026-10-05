import type { Db } from '../db.js';
import { onGoalTransition } from './stateMachine.js';

/**
 * Active-time accounting (design 12.2). Only `running` and `reviewing` time counts. The clock is injected and
 * monotonic; only the non-negative delta between two readings is ever added to `goal_runtime.active_ms`, so the
 * monotonic value itself is never persisted and downtime across a restart is never counted. Deltas are persisted at
 * least every `flushIntervalMs`, whenever a Goal leaves an active status, at checkpoints and on shutdown.
 */
export interface MonotonicClock {
  nowMs(): number;
}

export const systemMonotonicClock: MonotonicClock = {
  nowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
};

const ACTIVE = new Set(['running', 'reviewing']);
export const DEFAULT_FLUSH_INTERVAL_MS = 15_000;

export class ActiveTimeTracker {
  /** Goal id -> monotonic reading at which the not-yet-persisted interval began. */
  private readonly since = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly db: Db,
    private readonly clock: MonotonicClock = systemMonotonicClock,
    private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  ) {
    // A user pause or an amendment can end an active interval without going through the supervisor.
    this.unsubscribe = onGoalTransition((event) => {
      if (event.db === this.db) this.sync(event.goalId);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Persists the pending delta and restarts the interval. Returns the milliseconds persisted. */
  flush(goalId: string): number {
    const start = this.since.get(goalId);
    if (start === undefined) return 0;
    const now = this.clock.nowMs();
    const delta = Math.max(0, Math.floor(now - start));
    this.since.set(goalId, now);
    if (delta > 0)
      this.db
        .prepare('UPDATE goal_runtime SET active_ms = active_ms + ?, updated_at = ? WHERE goal_id = ?')
        .run(delta, new Date().toISOString(), goalId);
    return delta;
  }

  /** Persists and stops counting. */
  leave(goalId: string): void {
    this.flush(goalId);
    this.since.delete(goalId);
  }

  /** Aligns tracking with the persisted status: counting while running/reviewing, stopped otherwise. */
  sync(goalId: string): void {
    const row = this.db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
      { status: string } | undefined;
    const active = row ? ACTIVE.has(row.status) : false;
    if (active && !this.since.has(goalId)) this.since.set(goalId, this.clock.nowMs());
    else if (!active && this.since.has(goalId)) this.leave(goalId);
  }

  /** Persists when at least the flush interval has elapsed since the last persist. */
  maybeFlush(goalId: string): void {
    const start = this.since.get(goalId);
    if (start !== undefined && this.clock.nowMs() - start >= this.flushIntervalMs) this.flush(goalId);
  }

  /** Unpersisted milliseconds for the Goal, for bound checks between flushes. */
  pendingMs(goalId: string): number {
    const start = this.since.get(goalId);
    return start === undefined ? 0 : Math.max(0, Math.floor(this.clock.nowMs() - start));
  }

  isCounting(goalId: string): boolean {
    return this.since.has(goalId);
  }

  /** Persists every counting Goal and stops them (clean shutdown). */
  shutdown(): void {
    for (const goalId of [...this.since.keys()]) this.leave(goalId);
  }
}

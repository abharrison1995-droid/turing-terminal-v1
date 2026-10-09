import { GOAL_EVENT_TYPES, type GoalEventType } from '../shared/goals.js';
import type { Db } from './db.js';
import type { MasterEventHandler } from './masterEvents.js';

type PersistedGoalEvent = {
  seq: number;
  id: string;
  goal_id: string;
  type: GoalEventType;
  payload_json: string;
  created_at: string;
};

/**
 * Tails the append-only Goal event table after commit. `initialize()` deliberately starts at the current high-water
 * mark after startup reconciliation, so persisted history never becomes a burst of fresh notifications on restart.
 */
export class GoalEventPublisher {
  private cursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private readonly allowedTypes = new Set<string>(GOAL_EVENT_TYPES);

  constructor(
    private readonly db: Db,
    private readonly publish: MasterEventHandler,
    private readonly intervalMs = 250,
  ) {}

  initialize(): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS seq FROM goal_events').get() as {
      seq: number;
    };
    this.cursor = row.seq;
    this.initialized = true;
  }

  /** Deterministic seam for tests and the production timer; only committed rows are visible to this query. */
  drainOnce(): number {
    if (!this.initialized) throw new Error('GoalEventPublisher must be initialized before draining.');
    const rows = this.db
      .prepare(
        `SELECT rowid AS seq, id, goal_id, type, payload_json, created_at
         FROM goal_events WHERE rowid > ? ORDER BY rowid LIMIT 500`,
      )
      .all(this.cursor) as PersistedGoalEvent[];
    for (const row of rows) {
      // Advance first: notification failures are isolated and must not stall Goal processing or replay this row.
      this.cursor = row.seq;
      if (!this.allowedTypes.has(row.type)) continue;
      try {
        const existingPayload = JSON.parse(row.payload_json) as Record<string, unknown>;
        this.publish(row.type, {
          ...existingPayload,
          goalId: row.goal_id,
          goalEventId: row.id,
          goalEventSeq: row.seq,
          createdAt: row.created_at,
        });
      } catch {
        // Malformed historical data is skipped; a notification path cannot break Goal processing.
      }
    }
    return rows.length;
  }

  start(): void {
    if (!this.initialized) throw new Error('GoalEventPublisher must be initialized before starting.');
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.drainOnce();
      } catch {
        // Transient read failures are retried on the next bounded polling interval.
      }
    }, this.intervalMs);
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get currentCursor(): number {
    return this.cursor;
  }
}

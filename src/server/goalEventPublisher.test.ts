import { afterEach, describe, expect, it } from 'vitest';
import { writeGoalEvent } from './goals/events.js';
import { cleanupTestDatabases, freshDatabase, goalAt, seedProject } from './goals/testKit.js';
import { GoalEventPublisher } from './goalEventPublisher.js';

afterEach(cleanupTestDatabases);

describe('committed Goal event publisher', () => {
  it('starts after history, publishes committed rows once, in row order, with bounded identity', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'ready');
    const historicalCount = (
      db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId) as { n: number }
    ).n;
    const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const publisher = new GoalEventPublisher(db, (event, payload) => seen.push({ event, payload }));
    publisher.initialize();

    expect(publisher.drainOnce()).toBe(0);
    expect(seen).toEqual([]);
    const addRows = db.transaction(() => {
      writeGoalEvent(db, goalId, 'counters_reconciled', {
        cyclesExecuted: 2,
        consecutiveFailedCycles: 0,
        remediationAttempts: {},
        corrected: false,
      });
      writeGoalEvent(db, goalId, 'evidence_recorded', {
        evidenceId: 'evidence-a',
        criterionKey: 'builds',
        verifierDigest: 'a'.repeat(64),
        kind: 'build_result',
        verdict: 'satisfies',
        definitionVersion: 1,
      });
    });
    addRows();

    expect(publisher.drainOnce()).toBe(2);
    expect(publisher.drainOnce()).toBe(0);
    expect(seen.map(({ event }) => event)).toEqual(['counters_reconciled', 'evidence_recorded']);
    const persisted = db
      .prepare(
        'SELECT rowid AS seq, id, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid DESC LIMIT 2',
      )
      .all(goalId) as Array<{ seq: number; id: string; created_at: string }>;
    expect(seen[0]?.payload).toEqual({
      cyclesExecuted: 2,
      consecutiveFailedCycles: 0,
      remediationAttempts: {},
      corrected: false,
      goalId,
      goalEventId: persisted[1]?.id,
      goalEventSeq: persisted[1]?.seq,
      createdAt: persisted[1]?.created_at,
    });
    expect(seen[0]?.payload).not.toHaveProperty('definition');
    expect(seen[0]?.payload).not.toHaveProperty('prompt');
    expect(historicalCount).toBeGreaterThan(0);
  });

  it('publishes nothing when a transaction that wrote a Goal event rolls back, then publishes a commit', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'ready');
    const seen: string[] = [];
    const publisher = new GoalEventPublisher(db, (event) => seen.push(event));
    publisher.initialize();
    const failing = db.transaction(() => {
      writeGoalEvent(db, goalId, 'goal_authoring_failed', {
        cycleId: 'cycle-a',
        runId: null,
        code: 'authoring_run_failed',
      });
      throw new Error('later statement failed');
    });

    expect(() => failing()).toThrow('later statement failed');
    expect(publisher.drainOnce()).toBe(0);
    expect(seen).toEqual([]);

    writeGoalEvent(db, goalId, 'goal_authoring_failed', {
      cycleId: 'cycle-b',
      runId: null,
      code: 'authoring_run_failed',
    });
    expect(publisher.drainOnce()).toBe(1);
    expect(seen).toEqual(['goal_authoring_failed']);
  });

  it('advances its cursor when a notification consumer throws so later Goal work is not held up', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'ready');
    const publisher = new GoalEventPublisher(db, () => {
      throw new Error('subscriber or push delivery failed');
    });
    publisher.initialize();
    writeGoalEvent(db, goalId, 'goal_authoring_failed', {
      cycleId: 'cycle-a',
      runId: null,
      code: 'authoring_run_failed',
    });

    expect(publisher.drainOnce()).toBe(1);
    const committedCursor = publisher.currentCursor;
    expect(committedCursor).toBeGreaterThan(0);
    expect(publisher.drainOnce()).toBe(0);
    expect(publisher.currentCursor).toBe(committedCursor);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { ActiveTimeTracker } from './activeTime.js';
import { cleanupRepoFixtures, goalRepoFixture } from './repoKit.js';
import { transitionGoal } from './stateMachine.js';

afterEach(cleanupRepoFixtures);

function setup(status = 'running') {
  const fx = goalRepoFixture();
  fx.db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, fx.goalId);
  const clock = { ms: 1_000_000_000 };
  const make = () => new ActiveTimeTracker(fx.db, { nowMs: () => clock.ms }, 15_000);
  const persisted = () =>
    (
      fx.db.prepare('SELECT active_ms FROM goal_runtime WHERE goal_id = ?').get(fx.goalId) as {
        active_ms: number;
      }
    ).active_ms;
  return { fx, clock, make, persisted };
}

describe('active time', () => {
  it('counts only running and reviewing time and never persists the monotonic value', () => {
    const { fx, clock, make, persisted } = setup();
    const tracker = make();
    tracker.sync(fx.goalId);
    clock.ms += 20_000;
    tracker.leave(fx.goalId);
    expect(persisted()).toBe(20_000);
    fx.db.prepare("UPDATE goals SET status = 'needs_user' WHERE id = ?").run(fx.goalId);
    tracker.sync(fx.goalId);
    clock.ms += 500_000;
    tracker.sync(fx.goalId);
    expect(persisted()).toBe(20_000);
    fx.db.prepare("UPDATE goals SET status = 'reviewing' WHERE id = ?").run(fx.goalId);
    tracker.sync(fx.goalId);
    clock.ms += 5_000;
    tracker.shutdown();
    expect(persisted()).toBe(25_000);
    tracker.dispose();
  });

  it('persists at least every flush interval and not before', () => {
    const { fx, clock, make, persisted } = setup();
    const tracker = make();
    tracker.sync(fx.goalId);
    clock.ms += 14_999;
    tracker.maybeFlush(fx.goalId);
    expect(persisted()).toBe(0);
    expect(tracker.pendingMs(fx.goalId)).toBe(14_999);
    clock.ms += 1;
    tracker.maybeFlush(fx.goalId);
    expect(persisted()).toBe(15_000);
    expect(tracker.pendingMs(fx.goalId)).toBe(0);
    clock.ms += 3_000;
    tracker.maybeFlush(fx.goalId);
    expect(persisted()).toBe(15_000);
    tracker.dispose();
  });

  it('persists when a Goal leaves an active status through the state machine', () => {
    const { fx, clock, make, persisted } = setup();
    const tracker = make();
    tracker.sync(fx.goalId);
    clock.ms += 7_000;
    transitionGoal(fx.db, { goalId: fx.goalId, to: 'paused', reasonCode: 'user', actor: 'user' });
    expect(persisted()).toBe(7_000);
    expect(tracker.isCounting(fx.goalId)).toBe(false);
    tracker.dispose();
  });

  it('does not count downtime across a restart or a clock that stands still or moves backwards', () => {
    const { fx, clock, make, persisted } = setup();
    const first = make();
    first.sync(fx.goalId);
    clock.ms += 10_000;
    first.shutdown();
    first.dispose();
    clock.ms += 3_600_000; // the process was down for an hour
    const second = make();
    second.sync(fx.goalId);
    clock.ms += 2_000;
    clock.ms -= 5_000; // a backwards reading never subtracts
    second.flush(fx.goalId);
    expect(persisted()).toBe(10_000);
    second.dispose();
  });

  it('shutdown persists every counting Goal and leaves status untouched', () => {
    const { fx, clock, make, persisted } = setup();
    const tracker = make();
    tracker.sync(fx.goalId);
    clock.ms += 4_321;
    tracker.shutdown();
    expect(persisted()).toBe(4_321);
    expect(
      (fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId) as { status: string }).status,
    ).toBe('running');
    tracker.dispose();
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import { enforceBounds, evaluateBounds, goalMeteredSpendUsd } from './bounds.js';
import { createCycle, finalizeCycle, reconcileCounters, transitionCycle } from './cycles.js';
import { cleanupRepoFixtures, goalRepoFixture, milestone, simpleDefinition } from './repoKit.js';

afterEach(cleanupRepoFixtures);

function running(tune: (definition: GoalDefinition) => void = () => undefined) {
  const definition = simpleDefinition({
    milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])],
  });
  delete definition.review.periodic;
  delete definition.review.onRepeatedFailure;
  tune(definition);
  const fx = goalRepoFixture({ definition });
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  return fx;
}
type Fx = ReturnType<typeof running>;
const NOW = () => new Date().toISOString();
async function finishCycle(
  fx: Fx,
  to: 'succeeded' | 'failed' | 'rejected',
  kind: 'execution' | 'remediation' = 'execution',
  key = 'm1',
) {
  const created = createCycle(fx.db, { goalId: fx.goalId, kind, triggerCode: 't', milestoneKey: key });
  if (!created.created) throw new Error('active cycle');
  const id = created.cycle.id;
  if (to === 'rejected') transitionCycle(fx.db, { cycleId: id, to: 'proposing' });
  if (to === 'succeeded')
    for (const status of [
      'proposing',
      'proposed',
      'launching',
      'running',
      'collecting',
      'integrating',
    ] as const)
      transitionCycle(fx.db, { cycleId: id, to: status });
  finalizeCycle(fx.db, { cycleId: id, to, outcomeCode: to });
}
const goalStatus = (fx: Fx) =>
  fx.db.prepare('SELECT status, status_reason_code AS reason FROM goals WHERE id = ?').get(fx.goalId) as {
    status: string;
    reason: string | null;
  };
const check = (fx: Fx, extra: Partial<Parameters<typeof evaluateBounds>[2]> = {}) =>
  evaluateBounds(fx.db, fx.goalId, { now: NOW(), ...extra });

function seedRun(fx: Fx): { runId: string; cycleId: string } {
  const cycleId = randomUUID();
  const sequence = (
    fx.db
      .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS s FROM goal_cycles WHERE goal_id = ?')
      .get(fx.goalId) as { s: number }
  ).s;
  fx.db
    .prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, created_at)
       VALUES (?, ?, 1, ?, 'execution', 't', 'cancelled', ?, '2026-01-01T00:00:00Z')`,
    )
    .run(cycleId, fx.goalId, sequence, fx.head());
  const runId = randomUUID();
  const machine = (
    fx.db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
  ).value;
  fx.db
    .prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at,
         goal_cycle_id, goal_run_purpose, goal_base_commit)
       VALUES (?, ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 't', 'economy', 'normal', 'completed', '2026-01-01T00:00:00Z', ?, 'execution', ?)`,
    )
    .run(runId, machine, fx.projectId, cycleId, fx.head());
  return { runId, cycleId };
}
function reservation(
  fx: Fx,
  runId: string | null,
  status: 'reserved' | 'reconciled' | 'released',
  reserved: number,
  actual: number | null,
  usageEventId: string | null = null,
) {
  fx.db
    .prepare(
      `INSERT INTO metered_reservations (id, run_id, usage_event_id, billing_lane, workload_type, reserved_usd, actual_usd, status, cost_bound, created_at)
       VALUES (?, ?, ?, 'metered-api', 'goal', ?, ?, ?, 'bounded', '2026-01-01T00:00:00Z')`,
    )
    .run(randomUUID(), runId, usageEventId, reserved, actual, status);
}

describe('bounds', () => {
  it('maxExecutionCycles counts execution and remediation cycles only', async () => {
    const fx = running((d) => {
      d.limits.maxExecutionCycles = 3;
    });
    await finishCycle(fx, 'succeeded');
    await finishCycle(fx, 'succeeded', 'remediation');
    expect(check(fx)).toBeNull();
    // A finished review/verification-style cycle does not count: only execution+remediation kinds feed the counter.
    fx.db
      .prepare(
        `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at)
         VALUES ('rv', ?, 1, 50, 'review', 't', 'cancelled', '2026-01-01T00:00:00Z')`,
      )
      .run(fx.goalId);
    reconcileCounters(fx.db, fx.goalId);
    expect(check(fx)).toBeNull();
    await finishCycle(fx, 'succeeded');
    expect(check(fx)).toMatchObject({ reason: 'bound_cycles', limit: 3, observed: 3 });
    expect(enforceBounds(fx.db, fx.goalId, { now: NOW() })).toMatchObject({ reason: 'bound_cycles' });
    expect(goalStatus(fx)).toEqual({ status: 'blocked', reason: 'bound_cycles' });
  });

  it('rejected proposals consume maxExecutionCycles even when the failure bound is far away', async () => {
    const fx = running((d) => {
      d.limits.maxExecutionCycles = 2;
      d.limits.maxConsecutiveFailedCycles = 10;
    });
    await finishCycle(fx, 'rejected');
    expect(check(fx)).toBeNull();
    await finishCycle(fx, 'rejected');
    expect(check(fx)).toMatchObject({ reason: 'bound_cycles', limit: 2, observed: 2 });
    expect(enforceBounds(fx.db, fx.goalId, { now: NOW() })).toMatchObject({ reason: 'bound_cycles' });
    expect(goalStatus(fx)).toEqual({ status: 'blocked', reason: 'bound_cycles' });
  });

  it('rejected remediation attempts consume maxRemediationAttempts; cancelled ones do not', async () => {
    const fx = running((d) => {
      d.limits.maxRemediationAttempts = 2;
    });
    const next = () => check(fx, { next: { kind: 'remediation', milestoneKey: 'm1' } });
    await finishCycle(fx, 'rejected', 'remediation', 'm1');
    expect(next()).toBeNull();
    const created = createCycle(fx.db, {
      goalId: fx.goalId,
      kind: 'remediation',
      triggerCode: 't',
      milestoneKey: 'm1',
    });
    if (!created.created) throw new Error('active cycle');
    finalizeCycle(fx.db, { cycleId: created.cycle.id, to: 'cancelled', outcomeCode: 'run_cancelled' });
    expect(next()).toBeNull();
    await finishCycle(fx, 'rejected', 'remediation', 'm1');
    expect(next()).toMatchObject({ reason: 'bound_remediation', limit: 2, observed: 2 });
  });

  it('counts consecutive failures (failed and rejected) and resets on a success', async () => {
    const fx = running((d) => {
      d.limits.maxConsecutiveFailedCycles = 3;
    });
    await finishCycle(fx, 'failed');
    await finishCycle(fx, 'rejected');
    expect(check(fx)).toBeNull();
    await finishCycle(fx, 'succeeded');
    await finishCycle(fx, 'failed');
    await finishCycle(fx, 'failed');
    expect(check(fx)).toBeNull();
    await finishCycle(fx, 'rejected');
    expect(check(fx)).toMatchObject({ reason: 'bound_failures', limit: 3, observed: 3 });
  });

  it('limits remediation per milestone, not across milestones', async () => {
    const fx = running((d) => {
      d.limits.maxRemediationAttempts = 2;
    });
    await finishCycle(fx, 'failed', 'remediation', 'm1');
    await finishCycle(fx, 'failed', 'remediation', 'm1');
    const next = (key: string) => check(fx, { next: { kind: 'remediation', milestoneKey: key } });
    expect(next('m1')).toMatchObject({ reason: 'bound_remediation', limit: 2, observed: 2 });
    expect(next('m2')).toBeNull();
    // Another milestone is untouched; an execution cycle for m1 is not remediation.
    expect(check(fx, { next: { kind: 'execution', milestoneKey: 'm1' } })).toBeNull();
  });

  it('adds the live (unpersisted) active time to the persisted value and compares against maxActiveMinutes', () => {
    const fx = running((d) => {
      d.limits.maxActiveMinutes = 10;
    });
    fx.db.prepare('UPDATE goal_runtime SET active_ms = ? WHERE goal_id = ?').run(9 * 60_000, fx.goalId);
    expect(check(fx)).toBeNull();
    expect(check(fx, { liveActiveMs: 59_999 })).toBeNull();
    expect(check(fx, { liveActiveMs: 60_000 })).toMatchObject({
      reason: 'bound_active_time',
      limit: 10,
      observed: 10,
    });
  });

  it('measures wall clock from the persisted approval baseline, whatever the Goal status', () => {
    const fx = running((d) => {
      d.limits.maxWallClockDays = 7;
    });
    const approved = (
      fx.db.prepare('SELECT approved_at FROM goals WHERE id = ?').get(fx.goalId) as { approved_at: string }
    ).approved_at;
    const at = (days: number) => new Date(Date.parse(approved) + days * 86_400_000).toISOString();
    expect(check(fx, { now: at(6.99) })).toBeNull();
    expect(check(fx, { now: at(7) })).toMatchObject({ reason: 'bound_wall_clock', limit: 7 });
    fx.db.prepare("UPDATE goals SET status = 'paused' WHERE id = ?").run(fx.goalId);
    expect(check(fx, { now: at(8) })).toMatchObject({ reason: 'bound_wall_clock' });
  });

  it('takes spend from canonical metering rows for the Goal runs only, counting open reservations', () => {
    const fx = running((d) => {
      d.limits.billingMode = 'subscriptions-plus-decision-budget';
      d.limits.maxMeteredUsd = 5;
    });
    const a = seedRun(fx);
    const b = seedRun(fx);
    reservation(fx, a.runId, 'reconciled', 2, 1.25);
    reservation(fx, a.runId, 'released', 1, null);
    reservation(fx, b.runId, 'reserved', 2, null);
    reservation(fx, randomUUID(), 'reserved', 100, null); // an unrelated run is not this Goal's spend
    reservation(fx, null, 'reserved', 100, null);
    expect(goalMeteredSpendUsd(fx.db, fx.goalId)).toBeCloseTo(3.25);
    expect(check(fx)).toBeNull();
    reservation(fx, b.runId, 'reconciled', 3, 2);
    expect(check(fx)).toMatchObject({ reason: 'bound_spend', limit: 5 });
  });

  it('finds spend that is attached through a usage event', () => {
    const fx = running((d) => {
      d.limits.billingMode = 'subscriptions-plus-decision-budget';
      d.limits.maxMeteredUsd = 1;
    });
    const { runId } = seedRun(fx);
    const usage = randomUUID();
    fx.db
      .prepare(
        "INSERT INTO usage_events (id, occurred_at, run_id, provenance) VALUES (?, '2026-01-01T00:00:00Z', ?, 'test')",
      )
      .run(usage, runId);
    reservation(fx, null, 'reconciled', 2, 1.5, usage);
    expect(goalMeteredSpendUsd(fx.db, fx.goalId)).toBeCloseTo(1.5);
    expect(check(fx)).toMatchObject({ reason: 'bound_spend' });
  });

  it('never grants metered permission to a subscriptions-only Goal: any metered spend breaches', () => {
    const fx = running();
    expect(check(fx)).toBeNull();
    const { runId } = seedRun(fx);
    reservation(fx, runId, 'reserved', 0.01, null);
    expect(check(fx)).toMatchObject({ reason: 'bound_spend', limit: 0 });
  });

  it('does not treat maxMeteredUsd as a grant: spend below the ceiling is fine, at the ceiling is not', () => {
    const fx = running((d) => {
      d.limits.billingMode = 'subscriptions-plus-decision-budget';
      d.limits.maxMeteredUsd = 2;
    });
    const { runId } = seedRun(fx);
    reservation(fx, runId, 'reconciled', 2, 1.99);
    expect(check(fx)).toBeNull();
    reservation(fx, runId, 'reconciled', 1, 0.01);
    expect(check(fx)).toMatchObject({ reason: 'bound_spend' });
  });

  it('enforceBounds blocks only through the state machine and leaves other statuses alone', () => {
    const fx = running((d) => {
      d.limits.maxActiveMinutes = 1;
    });
    fx.db.prepare('UPDATE goal_runtime SET active_ms = 60000 WHERE goal_id = ?').run(fx.goalId);
    fx.db.prepare("UPDATE goals SET status = 'paused' WHERE id = ?").run(fx.goalId);
    expect(enforceBounds(fx.db, fx.goalId, { now: NOW() })).toMatchObject({ reason: 'bound_active_time' });
    expect(goalStatus(fx).status).toBe('paused');
    fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
    enforceBounds(fx.db, fx.goalId, { now: NOW() });
    expect(goalStatus(fx)).toEqual({ status: 'blocked', reason: 'bound_active_time' });
  });
});

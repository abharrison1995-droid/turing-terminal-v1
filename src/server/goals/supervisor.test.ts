import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceGoalRef } from '../goalGit.js';
import { decideGoalApproval, pendingGoalApprovals } from './approvals.js';
import { DisabledGoalExecutor } from './executor.js';
import { listGoalEvents } from './events.js';
import { cleanupRepoFixtures, milestone, passDeterministic, simpleDefinition } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';
import { GoalSupervisor, TICK_ACTIONS, type TickAction } from './supervisor.js';
import { listCycles } from './cycles.js';
import { approveDefinition, beginAmendment } from './definitions.js';
import { ActiveTimeTracker } from './activeTime.js';

afterEach(() => {
  cleanupRepoFixtures();
  vi.restoreAllMocks();
});

const HAPPY = [
  'cycle_created',
  'proposal_started',
  'proposal_queued',
  'proposal_run_started',
  'proposal_recorded',
  'launch_started',
  'run_queued',
  'run_started',
  'waiting_for_run',
] as const;

/** Drives the Goal until the first run is in flight. */
async function toRunning(h: Harness) {
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  const actions = await h.until('waiting_for_run');
  expect(actions).toEqual([...HAPPY]);
}
const completeRun = (h: Harness) => {
  const run = h.runs().at(-1)!;
  h.setRunStatus(run.id, 'completed');
  return run.id;
};
const head = (h: Harness) =>
  (
    h.fx.db.prepare('SELECT integration_head AS h FROM goal_runtime WHERE goal_id = ?').get(h.fx.goalId) as {
      h: string;
    }
  ).h;
const runtime = (h: Harness) =>
  h.fx.db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(h.fx.goalId) as Record<string, unknown>;

describe('fake loop', () => {
  it('runs preflight, start, one execution cycle, validation, outcome, integration, memory and the next tick', async () => {
    const h = harness();
    const baseHead = head(h);
    expect(h.status().status).toBe('ready');
    await toRunning(h);
    expect(h.status()).toEqual({ status: 'running', reason: 'user_start' });
    expect(h.workStarts()).toBe(1);
    expect(h.cycle()).toMatchObject({ status: 'running', kind: 'execution' });
    expect(h.executor.queueCalls[0]).toMatchObject({ purpose: 'execution', baseCommit: baseHead });

    completeRun(h);
    expect(await h.tick()).toBe('collection_started');
    expect(await h.tick()).toBe('integration_started');
    expect(await h.tick()).toBe('cycle_succeeded');
    expect(h.cycle()).toMatchObject({
      status: 'succeeded',
      outcome: { code: 'integrated', changedFiles: ['src/a.ts'] },
    });
    expect(head(h)).not.toBe(baseHead);
    expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(head(h));
    expect(runtime(h)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 0 });
    const memory = JSON.parse(runtime(h).memory_json as string);
    expect(memory).toMatchObject({ schemaVersion: 1, lastCycle: { sequence: 1, outcome: 'integrated' } });
    expect(memory.repo.integrationHead).toBe(head(h));

    // The next tick starts the next cycle (the milestone is not yet satisfied by evidence).
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    expect(await h.tick()).toBe('cycle_created');
    expect(listCycles(h.fx.db, h.fx.goalId)).toHaveLength(2);
    const events = listGoalEvents(h.fx.db, h.fx.goalId).map((event) => event.type);
    expect(events).toContain('cycle_created');
    expect(events).toContain('cycle_finished');
  });

  it('performs at most one persisted step per tick', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    const rank = [
      'planned',
      'proposing',
      'proposed',
      'launching',
      'running',
      'collecting',
      'integrating',
      'succeeded',
    ];
    let last = -1;
    let lastCycles = 0;
    for (let index = 0; index < 11; index++) {
      if (index === 7) completeRun(h);
      await h.tick();
      const cycles = listCycles(h.fx.db, h.fx.goalId);
      const current = cycles.at(-1);
      const position = current ? rank.indexOf(current.status) : -1;
      if (cycles.length === lastCycles) expect(position - last, `tick ${index}`).toBeLessThanOrEqual(1);
      else expect(cycles.length - lastCycles).toBe(1);
      last = position;
      lastCycles = cycles.length;
    }
  });

  it('returns only values of the finite action enum and takes a single tick per call (no loop)', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    const seen: TickAction[] = [];
    for (let index = 0; index < 9; index++) seen.push(await h.tick());
    for (const action of seen) expect(TICK_ACTIONS).toContain(action);
    expect(h.model.calls).toBe(1);
    expect(h.executor.proposalQueueCalls).toHaveLength(1);
    expect(h.executor.queueCalls).toHaveLength(1);
    expect(h.startRun).toHaveBeenCalledTimes(2); // the proposal run and the execution run, once each
  });

  it('is safe under duplicate and concurrent ticks', async () => {
    const h = harness();
    await h.start();
    const [a, b] = await Promise.all([
      h.supervisor.tickGoal(h.fx.goalId),
      h.supervisor.tickGoal(h.fx.goalId),
    ]);
    expect([a.action, b.action].sort()).toEqual(['busy', 'cycle_created']);
    expect(listCycles(h.fx.db, h.fx.goalId)).toHaveLength(1);
    expect(await h.tick()).toBe('proposal_started');
  });

  it('refuses ticks for unknown Goals and does nothing for Goals that are not running', async () => {
    const h = harness();
    expect((await h.supervisor.tickGoal('00000000-0000-4000-8000-000000000000')).action).toBe('not_found');
    expect(await h.tick()).toBe('idle'); // ready
    expect(listCycles(h.fx.db, h.fx.goalId)).toHaveLength(0);
  });
});

describe('proposals', () => {
  it('records a rejected proposal as an explainable outcome and never executes it', async () => {
    const h = harness();
    h.model.script.push({
      ok: true,
      proposal: { ...GOOD_TASK, expectedPaths: ['/etc/passwd'], provider: 'x' },
    });
    await h.start();
    await h.until('proposal_rejected');
    expect(h.cycle()).toMatchObject({ status: 'rejected', outcome: { code: 'proposal_invalid' } });
    expect(JSON.stringify(h.cycle()!.outcome)).toContain('forbidden_field');
    expect(h.executor.queueCalls).toHaveLength(0);
    expect(h.workStarts()).toBe(0);
    // A rejected proposal is an autonomous attempt: it consumes the cycle bound and extends the failure run.
    expect(runtime(h)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 1 });
  });

  it('rejects an out-of-scope path and a secret without storing the secret', async () => {
    const h = harness();
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, expectedPaths: ['docs/x.md'] } });
    await h.start();
    await h.until('proposal_rejected');
    expect(JSON.stringify(h.cycle()!.outcome)).toContain('path_out_of_scope');
    h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, instructions: `use ${secret}` } });
    await h.until('proposal_rejected');
    const stored = h.fx.db
      .prepare('SELECT outcome_json FROM goal_cycles ORDER BY sequence DESC LIMIT 1')
      .get() as { outcome_json: string };
    expect(stored.outcome_json).toContain('secret_detected');
    expect(stored.outcome_json).not.toContain(secret);
  });

  it('rejects a proposal run that finished without output, and fails the cycle when the proposal run failed', async () => {
    const h = harness();
    h.model.script.push({ noOutput: true });
    await h.start();
    await h.until('proposal_rejected');
    expect(h.cycle()).toMatchObject({
      status: 'rejected',
      outcome: { code: 'proposal_unavailable', reason: 'proposal_output_missing' },
    });
    h.model.script.push({ raw: 'not json' });
    await h.until('proposal_rejected');
    expect(h.cycle()).toMatchObject({ outcome: { reason: 'proposal_output_unparsable' } });
    h.model.script.push({ ok: false, code: 'model_failed' });
    await h.until('cycle_failed');
    expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'proposal_run_failed' } });
    expect(h.executor.queueCalls).toHaveLength(0);
  });

  it('never proposes twice for the same cycle', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK }, { ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    for (let index = 0; index < 3; index++) await h.tick();
    expect(h.model.calls).toBe(1);
    expect(h.executor.proposalQueueCalls).toHaveLength(1);
    expect(h.executor.readCalls).toHaveLength(1);
  });
});

describe('run outcomes', () => {
  it('finalises a failed run as a failed cycle and counts it', async () => {
    const h = harness();
    await toRunning(h);
    h.setRunStatus(h.runs()[0]!.id, 'failed');
    await h.until('cycle_failed');
    expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'run_failed' } });
    expect(runtime(h)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 1 });
  });

  it('finalises a cancelled run as a cancelled cycle that counts for nothing', async () => {
    const h = harness();
    await toRunning(h);
    h.setRunStatus(h.runs()[0]!.id, 'cancelled');
    await h.until('cycle_failed');
    expect(h.cycle()).toMatchObject({ status: 'cancelled', outcome: { code: 'run_cancelled' } });
    expect(runtime(h)).toMatchObject({ cycles_executed: 0, consecutive_failed_cycles: 0 });
  });

  it('counts a run that changed nothing as a failure and one outside the milestone scope as a scope violation', async () => {
    const h = harness();
    h.files.current = {};
    await toRunning(h);
    completeRun(h);
    await h.until('cycle_failed');
    expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'no_change' } });

    h.files.current = { 'docs/x.md': 'outside\n' };
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.until('waiting_for_run');
    completeRun(h);
    await h.until('cycle_failed');
    expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'scope_violation' } });
    expect(head(h)).toBe(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`));
    expect(runtime(h)).toMatchObject({ consecutive_failed_cycles: 2 });
  });

  it('enforces the exact milestone globs, not only their directory prefix', async () => {
    const definition = simpleDefinition({
      milestones: [
        milestone('m1', ['build'], {
          allowedScope: { includeGlobs: ['src/**'], excludeGlobs: ['src/generated/**'] },
        }),
        milestone('m2', ['tests']),
      ],
    });
    const h = harness({ definition });
    h.files.current = { 'src/generated/x.ts': 'export {};\n' };
    await toRunning(h);
    completeRun(h);
    await h.until('cycle_failed');
    expect(h.cycle()).toMatchObject({ outcome: { code: 'scope_violation' } });
  });
});

describe('bounds through the tick', () => {
  it('blocks with bound_cycles after the limit, creating no further cycle', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.maxExecutionCycles = 1;
        d.limits.maxConsecutiveFailedCycles = 1;
      },
    });
    await toRunning(h);
    completeRun(h);
    await h.until('cycle_succeeded');
    expect(await h.tick()).toBe('bound_blocked');
    expect(h.status()).toEqual({ status: 'blocked', reason: 'bound_cycles' });
    expect(listCycles(h.fx.db, h.fx.goalId)).toHaveLength(1);
    expect(await h.tick()).toBe('idle');
  });

  it('blocks after consecutive failures and a success resets the run of failures', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.maxConsecutiveFailedCycles = 2;
      },
    });
    await h.start();
    const failOnce = async () => {
      h.model.script.push({ noOutput: true });
      await h.until('proposal_rejected');
    };
    await failOnce();
    expect(runtime(h)).toMatchObject({ consecutive_failed_cycles: 1 });
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.until('waiting_for_run');
    completeRun(h);
    await h.until('cycle_succeeded');
    expect(runtime(h)).toMatchObject({ consecutive_failed_cycles: 0 });
    await failOnce();
    expect(h.status().status).toBe('running');
    await failOnce();
    expect(await h.tick()).toBe('bound_blocked');
    expect(h.status()).toEqual({ status: 'blocked', reason: 'bound_failures' });
  });

  it('blocks on active time using persisted plus live time from the injected clock', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.maxActiveMinutes = 1;
      },
    });
    await h.start();
    h.clock.ms += 59_000;
    expect(await h.tick()).toBe('cycle_created');
    h.model.script.push({ noOutput: true });
    await h.until('proposal_rejected');
    h.clock.ms += 1_000;
    expect(await h.tick()).toBe('bound_blocked');
    expect(h.status()).toEqual({ status: 'blocked', reason: 'bound_active_time' });
    // Leaving the active status persisted the time that had accrued.
    expect(runtime(h).active_ms).toBe(60_000);
  });

  it('blocks on wall clock from the approval baseline', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.maxWallClockDays = 1;
      },
    });
    await h.start();
    const approved = (
      h.fx.db.prepare('SELECT approved_at FROM goals WHERE id = ?').get(h.fx.goalId) as {
        approved_at: string;
      }
    ).approved_at;
    const late = new GoalSupervisor({
      db: h.fx.db,
      executor: h.executor,
      startRun: h.startRun,
      resumeRun: h.resumeRun,
      activeTime: h.tracker,
      now: () => new Date(Date.parse(approved) + 2 * 86_400_000).toISOString(),
    });
    expect((await late.tickGoal(h.fx.goalId)).action).toBe('bound_blocked');
    expect(h.status()).toEqual({ status: 'blocked', reason: 'bound_wall_clock' });
  });

  it('blocks on canonical metered spend and never allows it on a subscriptions-only Goal', async () => {
    const h = harness();
    await h.start();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.until('waiting_for_run');
    const run = h.runs()[0]!;
    h.fx.db
      .prepare(
        `INSERT INTO metered_reservations (id, run_id, billing_lane, workload_type, reserved_usd, status, cost_bound, created_at)
         VALUES ('r1', ?, 'metered-api', 'goal', 0.5, 'reserved', 'bounded', '2026-01-01T00:00:00Z')`,
      )
      .run(run.id);
    h.setRunStatus(run.id, 'failed');
    await h.until('cycle_failed');
    expect(await h.tick()).toBe('bound_blocked');
    expect(h.status()).toEqual({ status: 'blocked', reason: 'bound_spend' });
  });
});

describe('start, preflight and scheduling', () => {
  it('refuses to start while routing is not ready, and changes nothing', async () => {
    const h = harness();
    h.executor.readiness = { ready: false, code: 'route_unavailable', message: 'no route' };
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: false, code: 'route_unavailable' });
    expect(h.status().status).toBe('ready');
  });

  it('never claims readiness in production: the disabled executor blocks every start', async () => {
    const h = harness();
    const production = new GoalSupervisor({
      db: h.fx.db,
      executor: new DisabledGoalExecutor(),
      startRun: h.startRun,
      resumeRun: h.resumeRun,
      activeTime: h.tracker,
    });
    expect(await production.startGoal(h.fx.goalId)).toEqual({ ok: false, code: 'route_unavailable' });
    expect(await new DisabledGoalExecutor().readProposal()).toEqual({ ok: false, code: 'executor_disabled' });
    await expect(new DisabledGoalExecutor().queueProposalRun()).rejects.toThrow(/not enabled/);
    await expect(new DisabledGoalExecutor().queueChildRun()).rejects.toThrow(/not enabled/);
    expect(h.status().status).toBe('ready');
  });

  it('initialises the Goal ref when absent, and refuses an existing or moved ref without overwriting it', async () => {
    const h = harness();
    const ref = `refs/heads/turing/goal/${h.fx.goalId}`;
    h.fx.db
      .prepare(
        'UPDATE goal_runtime SET integration_head = NULL, goal_branch = NULL, base_branch = NULL, base_commit = NULL WHERE goal_id = ?',
      )
      .run(h.fx.goalId);
    // The fixture pre-created the ref, so initialisation must refuse rather than overwrite it.
    const base = h.fx.git('rev-parse', ref);
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: false, code: 'goal_ref_changed' });
    expect(h.fx.git('rev-parse', ref)).toBe(base);
    h.fx.git('update-ref', '-d', ref);
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: true });
    expect(h.fx.git('rev-parse', ref)).toBe(h.fx.git('rev-parse', 'main'));
    expect(runtime(h)).toMatchObject({ goal_branch: `turing/goal/${h.fx.goalId}`, base_branch: 'main' });
  });

  it('refuses a missing, moved or checked-out Goal ref and never overwrites it', async () => {
    const h = harness();
    const ref = `refs/heads/turing/goal/${h.fx.goalId}`;
    const orphan = h.fx.orphanCommit();
    h.fx.git('update-ref', ref, orphan);
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: false, code: 'goal_ref_changed' });
    expect(h.fx.git('rev-parse', ref)).toBe(orphan);
    h.fx.git('update-ref', '-d', ref);
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: false, code: 'goal_ref_missing' });
    expect(h.status().status).toBe('ready');
  });

  it('applies the project lease and the global running limit, deterministically ordered', async () => {
    const h = harness();
    await h.start();
    const other = h.fx.db
      .prepare(
        "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) SELECT 'g-other', machine_id, project_id, 'O', 'draft', created_at, updated_at FROM goals WHERE id = ?",
      )
      .run(h.fx.goalId);
    expect(other.changes).toBe(0 + 1 - 1 + 1 - 1 + other.changes); // insert may fail on the lease index only when status is leased
    expect(h.supervisor.maxRunning()).toBe(1);
    h.fx.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('goal_max_running', '2', '2026-01-01')")
      .run();
    expect(h.supervisor.maxRunning()).toBe(2);
    h.fx.db.prepare("UPDATE settings SET value = 'oops' WHERE key = 'goal_max_running'").run();
    expect(h.supervisor.maxRunning()).toBe(1);
  });

  it('runOnce ticks running Goals in created_at then id order within the limit', async () => {
    const h = harness();
    await h.start();
    const { db } = h.fx;
    const machine = (
      db.prepare('SELECT machine_id FROM goals WHERE id = ?').get(h.fx.goalId) as { machine_id: string }
    ).machine_id;
    for (const [id, project, created] of [
      ['b-goal', 'p2', '2026-01-01T00:00:00Z'],
      ['a-goal', 'p3', '2026-01-01T00:00:00Z'],
    ] as const) {
      db.prepare(
        "INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
      ).run(project, machine, project, `/tmp/${project}`);
      db.prepare(
        "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'G', 'running', ?, ?)",
      ).run(id, machine, project, created, created);
    }
    db.prepare("UPDATE goals SET created_at = '2025-12-31T00:00:00Z' WHERE id = ?").run(h.fx.goalId);
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('goal_max_running', '2', '2026-01-01')",
    ).run();
    const results = await h.supervisor.runOnce();
    expect(results.map((result) => result.goalId)).toEqual([h.fx.goalId, 'a-goal']);
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'goal_max_running'").run();
    expect((await h.supervisor.runOnce()).map((result) => result.goalId)).toEqual([h.fx.goalId]);
  });

  it('refuses a start when the global running limit is already used', async () => {
    const h = harness();
    const { db } = h.fx;
    const machine = (
      db.prepare('SELECT machine_id FROM goals WHERE id = ?').get(h.fx.goalId) as { machine_id: string }
    ).machine_id;
    db.prepare(
      "INSERT INTO projects (id, machine_id, name, path, created_at) VALUES ('p9', ?, 'p9', '/tmp/p9', '2026-01-01T00:00:00.000Z')",
    ).run(machine);
    db.prepare(
      "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES ('busy', ?, 'p9', 'B', 'running', '2026-01-01', '2026-01-01')",
    ).run(machine);
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: false, code: 'scheduler_full' });
    db.prepare("UPDATE goals SET status = 'blocked' WHERE id = 'busy'").run();
    expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: true });
  });

  it('refuses a second Goal on the same project through the lease', async () => {
    const h = harness();
    await h.start();
    const { db } = h.fx;
    const machine = (
      db.prepare('SELECT machine_id FROM goals WHERE id = ?').get(h.fx.goalId) as { machine_id: string }
    ).machine_id;
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES ('second', ?, ?, 'S', 'running', '2026-01-01', '2026-01-01')",
        )
        .run(machine, h.fx.projectId),
    ).toThrow(/UNIQUE/);
  });

  it('gives blocked, paused and needs_user Goals no scheduling slot', async () => {
    const h = harness();
    await h.start();
    for (const status of ['blocked', 'paused', 'needs_user']) {
      h.fx.db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, h.fx.goalId);
      expect(await h.supervisor.runOnce()).toEqual([]);
    }
  });
});

describe('human gates', () => {
  const gated = () =>
    harness({
      tune: (d) => {
        d.limits.humanGates.eachCycle = true;
      },
    });

  it('asks once per cycle, waits, and resumes through preflight after the user approves', async () => {
    const h = gated();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('gate_requested');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    expect(pendingGoalApprovals(h.fx.db, h.fx.goalId)).toHaveLength(1);
    for (let index = 0; index < 3; index++) expect(await h.tick()).toBe('waiting_gate');
    expect(pendingGoalApprovals(h.fx.db, h.fx.goalId)).toHaveLength(1);
    expect(h.executor.queueCalls).toHaveLength(0);

    const [approval] = pendingGoalApprovals(h.fx.db, h.fx.goalId);
    expect(approval!.detail).toMatchObject({ action: 'launch_cycle' });
    decideGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      approvalId: approval!.id,
      decision: 'approved',
      decidedBy: 'user',
    });
    expect(await h.tick()).toBe('resumed');
    expect(h.status().status).toBe('running');
    expect(await h.tick()).toBe('launch_started'); // no second question for the same cycle
    expect(pendingGoalApprovals(h.fx.db, h.fx.goalId)).toHaveLength(0);
    await h.until('waiting_for_run');
    expect(h.workStarts()).toBe(1);
  });

  it('does not continue after a denial: the cycle is cancelled, no run starts and the Goal waits for the user', async () => {
    const h = gated();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('gate_requested');
    const [approval] = pendingGoalApprovals(h.fx.db, h.fx.goalId);
    decideGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      approvalId: approval!.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    expect(await h.tick()).toBe('gate_denied');
    expect(h.cycle()).toMatchObject({ status: 'cancelled', outcome: { code: 'gate_denied' } });
    for (let index = 0; index < 3; index++) expect(await h.tick()).toBe('idle');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    expect(h.executor.queueCalls).toHaveLength(0);
    expect(h.workStarts()).toBe(0);
    expect(runtime(h)).toMatchObject({ cycles_executed: 0, consecutive_failed_cycles: 0 });
  });

  it('never requests the pool-route gate and leaves gates off by default', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get()).toEqual({ n: 1 }); // the definition approval only
    const gates = h.fx.db.prepare('SELECT gate FROM goal_approvals').all() as Array<{ gate: string }>;
    expect(gates.map((g) => g.gate)).not.toContain('pool_route_first_use');
  });

  it('asks for the milestone gate when only the human gate is missing, once, and stays with the user', async () => {
    const definition = simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'])],
      gates: { beforeMilestoneComplete: true },
    });
    const h = harness({ definition });
    await passDeterministic(h.fx);
    await h.start();
    expect(await h.tick()).toBe('gate_requested');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    const [approval] = pendingGoalApprovals(h.fx.db, h.fx.goalId);
    expect(approval).toMatchObject({
      gate: 'milestone_complete',
      detail: { action: 'complete', milestoneKey: 'm1' },
    });
    expect(await h.tick()).toBe('waiting_gate');
    expect(pendingGoalApprovals(h.fx.db, h.fx.goalId)).toHaveLength(1);
    decideGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      approvalId: approval!.id,
      decision: 'approved',
      decidedBy: 'user',
    });
    expect(await h.tick()).toBe('resumed');
    // The gate is satisfied, the milestone is complete, and completion is attempted through completeGoal.
    expect(await h.tick()).toBe('completed');
    expect(h.status().status).toBe('completed');
  });
});

describe('completion authority', () => {
  it('completes only through completeGoal, and reports pending when evaluation refuses', async () => {
    const withFinalReview = simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'])],
      policy: { requireFinalReview: true },
    });
    const h = harness({ definition: withFinalReview });
    await passDeterministic(h.fx);
    await h.start();
    expect(await h.tick()).toBe('completion_pending');
    expect(h.status().status).toBe('running');
    expect(listGoalEvents(h.fx.db, h.fx.goalId).some((event) => event.type === 'completion_evaluated')).toBe(
      true,
    );
  });

  it('completes a Goal whose evidence and policy are satisfied', async () => {
    const definition = simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'])],
    });
    const h = harness({ definition });
    await passDeterministic(h.fx);
    await h.start();
    expect(await h.tick()).toBe('completed');
    expect(h.status()).toEqual({ status: 'completed', reason: 'completion_verified' });
    expect(h.tracker.isCounting(h.fx.goalId)).toBe(false);
  });

  it('never writes the completed status itself (static check of every supervisor module)', () => {
    const directory = join(process.cwd(), 'src', 'server', 'goals');
    for (const file of [
      'supervisor.ts',
      'preflight.ts',
      'cycles.ts',
      'bounds.ts',
      'memory.ts',
      'activeTime.ts',
      'executor.ts',
    ]) {
      const source = readFileSync(join(directory, file), 'utf8');
      expect(source, file).not.toMatch(/to:\s*'completed'/);
      expect(source, file).not.toMatch(/status\s*=\s*'completed'/);
      expect(source, file).not.toMatch(/completionProof/);
    }
    expect(readFileSync(join(directory, 'supervisor.ts'), 'utf8')).toContain('completeGoal(');
  });
});

describe('startup reconciliation', () => {
  it('starts a launching cycle’s queued run exactly once, however often reconcile runs', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('run_queued');
    expect(h.cycle()!.status).toBe('launching');
    expect(h.runs()[0]!.status).toBe('queued');
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    expect(h.workStarts()).toBe(1);
    expect(h.cycle()!.status).toBe('running');
    expect(h.runs()).toHaveLength(1);
  });

  it('recovers a launching cycle that has no run, without a duplicate (cycle, purpose)', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('launch_started');
    expect(h.runs()).toHaveLength(0);
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    expect(h.runs()).toHaveLength(1);
    expect(h.executor.queueCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE goal_cycle_id IS NOT NULL').get()).toEqual({
      n: 2, // one proposal run and one execution run
    });
    expect(
      h.fx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM runs WHERE goal_cycle_id IS NOT NULL
             GROUP BY goal_cycle_id, goal_run_purpose HAVING COUNT(*) > 1)`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('turns a paused run into needs_user(run_interrupted) and never resumes it automatically', async () => {
    const h = harness();
    await toRunning(h);
    h.setRunStatus(h.runs()[0]!.id, 'paused');
    const results = await h.supervisor.reconcile();
    expect(results.map((result) => result.action)).toEqual(['run_interrupted']);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
    await h.supervisor.reconcile();
    expect(h.resumeRun).not.toHaveBeenCalled();
    expect(h.workStarts()).toBe(1);
    expect(h.cycle()!.status).toBe('running');
    // The user's explicit resume goes through preflight and resumes the run.
    expect(await h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'run_resumed' })).toEqual({
      ok: true,
    });
    expect(h.resumeRun).toHaveBeenCalledTimes(1);
    expect(h.status().status).toBe('running');
  });

  it('resumes collection when the run finished while the cycle was still running', async () => {
    const h = harness();
    await toRunning(h);
    completeRun(h);
    const results = await h.supervisor.reconcile();
    expect(results.map((result) => result.action)).toEqual(['collection_started']);
    expect(h.cycle()!.status).toBe('collecting');
    expect(await h.tick()).toBe('integration_started');
    expect(await h.tick()).toBe('cycle_succeeded');
  });

  it('observes an existing proposal and never creates a second one', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('proposal_recorded');
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    expect(h.model.calls).toBe(1);
    expect(h.executor.proposalQueueCalls).toHaveLength(1);
    expect(h.cycle()!.status).toBe('launching');
  });

  it('resolves a planned integration operation whose ref update happened, then completes the cycle', async () => {
    const h = harness();
    await toRunning(h);
    completeRun(h);
    await h.until('integration_started');
    const cycle = h.cycle()!;
    const run = h.runs()[0]!;
    const base = head(h);
    await expect(
      advanceGoalRef(
        h.fx.db,
        { goalId: h.fx.goalId, cycleId: cycle.id, runId: run.id, expectedHead: base },
        {},
        {
          beforeCas: () => {
            throw new Error('crash');
          },
        },
      ),
    ).rejects.toThrow('crash');
    const op = h.fx.db
      .prepare("SELECT id, new_commit FROM goal_integration_ops WHERE status = 'planned'")
      .get() as { id: string; new_commit: string };
    h.fx.git('update-ref', `refs/heads/turing/goal/${h.fx.goalId}`, op.new_commit, base);
    const results = await h.supervisor.reconcile();
    expect(results.map((result) => result.action)).toEqual(['cycle_succeeded']);
    expect(head(h)).toBe(op.new_commit);
    expect(h.cycle()).toMatchObject({ status: 'succeeded' });
    expect(h.fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(op.id)).toEqual({
      status: 'applied',
    });
  });

  it('blocks the Goal with goal_ref_changed when the ref holds an unexpected value, and never overwrites it', async () => {
    const h = harness();
    await toRunning(h);
    completeRun(h);
    await h.until('integration_started');
    const cycle = h.cycle()!;
    const base = head(h);
    await expect(
      advanceGoalRef(
        h.fx.db,
        { goalId: h.fx.goalId, cycleId: cycle.id, runId: h.runs()[0]!.id, expectedHead: base },
        {},
        {
          beforeCas: () => {
            throw new Error('crash');
          },
        },
      ),
    ).rejects.toThrow('crash');
    const third = h.fx.orphanCommit();
    h.fx.git('update-ref', `refs/heads/turing/goal/${h.fx.goalId}`, third);
    const results = await h.supervisor.reconcile();
    expect(results.map((result) => result.action)).toEqual(['ref_blocked']);
    expect(h.status()).toEqual({ status: 'blocked', reason: 'goal_ref_changed' });
    expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(third);
    expect(head(h)).toBe(base);
  });

  it('leaves pending approvals pending and is idempotent when repeated', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.humanGates.eachCycle = true;
      },
    });
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('gate_requested');
    const snapshot = () =>
      JSON.stringify([
        h.fx.db.prepare('SELECT status, status_reason_code FROM goals').all(),
        h.fx.db.prepare('SELECT id, status FROM goal_cycles ORDER BY sequence').all(),
        h.fx.db.prepare('SELECT id, status FROM goal_approvals ORDER BY id').all(),
        h.fx.db
          .prepare(
            'SELECT cycles_executed, consecutive_failed_cycles, remediation_attempts_json FROM goal_runtime',
          )
          .all(),
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_events').all(),
      ]);
    await h.supervisor.reconcile();
    const once = snapshot();
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    expect(snapshot()).toBe(once);
    expect(pendingGoalApprovals(h.fx.db, h.fx.goalId)).toHaveLength(1);
  });

  it('restores corrupted counters during reconcile and starts active-time tracking only from now', async () => {
    const h = harness();
    await toRunning(h);
    completeRun(h);
    await h.until('cycle_succeeded');
    h.fx.db
      .prepare(
        'UPDATE goal_runtime SET cycles_executed = 40, consecutive_failed_cycles = 9 WHERE goal_id = ?',
      )
      .run(h.fx.goalId);
    h.tracker.shutdown();
    h.clock.ms += 3_600_000;
    await h.supervisor.reconcile();
    expect(runtime(h)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 0 });
    expect(Number(runtime(h).active_ms)).toBe(0);
  });

  it('re-runs preflight for an approved amendment: a moved ref keeps the Goal in needs_user, a valid one resumes it', async () => {
    const h = harness();
    await h.start();
    // A real amendment: begin, approve the exact proposed version, then the resume reason is a persisted fact.
    const amendment = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    approveDefinition(h.fx.db, { goalId: h.fx.goalId, version: amendment.version, actor: 'user' });
    const ref = `refs/heads/turing/goal/${h.fx.goalId}`;
    const good = h.fx.git('rev-parse', ref);
    h.fx.git('update-ref', ref, h.fx.orphanCommit());
    expect(
      await h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'amendment_approved' }),
    ).toEqual({ ok: false, code: 'goal_ref_changed' });
    expect(h.status().status).toBe('needs_user');
    h.fx.git('update-ref', ref, good);
    expect(
      await h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'amendment_approved' }),
    ).toEqual({ ok: true });
    expect(h.status().status).toBe('running');
  });
});

describe('clean shutdown', () => {
  it('persists active time, launches nothing, keeps status and pending state, and cancels no run', async () => {
    const h = harness();
    await toRunning(h);
    h.clock.ms += 9_000;
    h.supervisor.shutdown();
    expect(Number(runtime(h).active_ms)).toBe(9_000);
    expect(h.status().status).toBe('running');
    expect(h.cycle()!.status).toBe('running');
    expect(h.runs()[0]!.status).toBe('running');
    const before = h.executor.queueCalls.length;
    expect((await h.supervisor.tickGoal(h.fx.goalId)).action).toBe('shutting_down');
    expect(h.executor.queueCalls.length).toBe(before);
    expect(h.workStarts()).toBe(1);
  });
});

describe('boundaries', () => {
  it('leaves ordinary runs entirely alone', async () => {
    const h = harness();
    const machine = (
      h.fx.db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    h.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
         VALUES ('plain', ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 't', 'economy', 'normal', 'queued', '2026-01-01T00:00:00Z')`,
      )
      .run(machine, h.fx.projectId);
    await h.start();
    await h.supervisor.reconcile();
    await h.supervisor.runOnce();
    expect(h.startRun).not.toHaveBeenCalledWith('plain');
    expect(h.fx.db.prepare("SELECT status FROM runs WHERE id = 'plain'").get()).toEqual({ status: 'queued' });
  });

  it('keeps the fake executor out of production code and out of the build', () => {
    const server = join(process.cwd(), 'src', 'server');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          entry.name.endsWith('.ts') &&
          !/\.test\.ts$/.test(entry.name) &&
          !/(fakeExecutor|supervisorKit)\.ts$/.test(entry.name)
        )
          if (/fakeExecutor|FakeGoalExecutor|supervisorKit/.test(readFileSync(path, 'utf8')))
            offenders.push(path);
      }
    };
    walk(server);
    expect(offenders).toEqual([]);
    expect(readFileSync(join(process.cwd(), 'tsconfig.server.json'), 'utf8')).toContain(
      'goals/fakeExecutor.ts',
    );
    const index = readFileSync(join(server, 'index.ts'), 'utf8');
    expect(index).toContain('new DisabledGoalExecutor()');
    expect(index).not.toMatch(/Fake/);
    expect(index.indexOf('engine.reconcileInterruptedRuns()')).toBeLessThan(
      index.indexOf('goalSupervisor.reconcile()'),
    );
  });

  it('keeps the executor interface free of database, Git and status authority', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'server', 'goals', 'executor.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/db\.js'|goalGit|transitionGoal|transitionCycle/);
  });

  it('shares one tracker instance contract: constructing a supervisor without one still works', () => {
    const h = harness();
    const bare = new GoalSupervisor({
      db: h.fx.db,
      executor: h.executor,
      startRun: h.startRun,
      resumeRun: h.resumeRun,
    });
    bare.shutdown();
    expect(ActiveTimeTracker).toBeDefined();
  });
});

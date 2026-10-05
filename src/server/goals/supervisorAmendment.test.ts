import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCycles } from './cycles.js';
import {
  approveDefinition,
  beginAmendment,
  editProposedDefinition,
  loadDefinitionVersion,
  rejectDefinition,
} from './definitions.js';
import { listGoalEvents } from './events.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(() => {
  cleanupRepoFixtures();
  vi.restoreAllMocks();
});

const goalRef = (h: Harness) => `refs/heads/turing/goal/${h.fx.goalId}`;
const head = (h: Harness) =>
  (
    h.fx.db.prepare('SELECT integration_head AS h FROM goal_runtime WHERE goal_id = ?').get(h.fx.goalId) as {
      h: string;
    }
  ).h;
const resume = (h: Harness, reasonCode: 'amendment_approved' | 'amendment_discarded') =>
  h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode });
const eventTypes = (h: Harness) => listGoalEvents(h.fx.db, h.fx.goalId).map((event) => event.type);
const cycleCount = (h: Harness) => listCycles(h.fx.db, h.fx.goalId).length;
const approve = (h: Harness, version: number) =>
  approveDefinition(h.fx.db, { goalId: h.fx.goalId, version, actor: 'user' });

/** Drives a Goal into needs_user(scope_violation): the work run changed a file outside the milestone scope. */
async function scopeViolated() {
  const h = harness();
  h.files.current = { 'docs/x.md': 'outside\n' };
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
  h.setRunStatus(h.runs()[0]!.id, 'completed');
  await h.until('cycle_failed');
  expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
  return h;
}

describe('amendment from needs_user(scope_violation)', () => {
  it('refuses an amendment reason that no persisted amendment action backs', async () => {
    const h = await scopeViolated();
    const cycles = cycleCount(h);
    const runs = h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get();
    for (const reason of ['amendment_approved', 'amendment_discarded'] as const)
      expect(await resume(h, reason)).toEqual({ ok: false, code: 'amendment_not_resolved' });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
    expect(cycleCount(h)).toBe(cycles);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual(runs);
    expect(h.resumeRun).not.toHaveBeenCalled();
    expect(h.workStarts()).toBe(1);
  });

  it('lets the user begin an amendment without disguising the scope violation', async () => {
    const h = await scopeViolated();
    const amendment = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    expect(amendment.version).toBe(2);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
    expect(eventTypes(h)).toContain('amendment_started');
    expect(loadDefinitionVersion(h.fx.db, h.fx.goalId, 2)).toMatchObject({
      status: 'proposed',
      parentVersion: 1,
    });
    // A proposal that is merely undecided does not resolve anything.
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'amendment_not_resolved' });
    expect(await resume(h, 'amendment_discarded')).toEqual({ ok: false, code: 'amendment_not_resolved' });
  });

  it('still refuses to begin an amendment from other needs_user reasons', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.humanGates.eachCycle = true;
      },
    });
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('gate_requested');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    expect(() => beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' })).toThrow(
      /cannot be amended/,
    );
  });

  it('runs the real path: begin, edit N+1, approve the exact hash, then resume through preflight', async () => {
    const h = await scopeViolated();
    const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    const base = loadDefinitionVersion(h.fx.db, h.fx.goalId, 1)!.definition;
    const edited = structuredClone(base);
    edited.milestones[0]!.allowedScope.includeGlobs = ['src/**', 'docs/**'];
    editProposedDefinition(h.fx.db, { goalId: h.fx.goalId, version, definition: edited });
    approve(h, version);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
    expect(await resume(h, 'amendment_discarded')).toEqual({ ok: false, code: 'amendment_not_resolved' });
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: true });
    expect(h.status().status).toBe('running');
  });

  it('runs the discard path: the rejected proposal was based on the current definition', async () => {
    const h = await scopeViolated();
    const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    rejectDefinition(h.fx.db, { goalId: h.fx.goalId, version, actor: 'user' });
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'amendment_not_resolved' });
    expect(await resume(h, 'amendment_discarded')).toEqual({ ok: true });
    expect(h.status().status).toBe('running');
  });

  it('does not accept an approval from an earlier episode for a later one', async () => {
    const h = harness();
    await h.start();
    const first = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    approve(h, first.version);
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: true });
    // A new quiescent episode begins; the old approval event predates it.
    const second = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    rejectDefinition(h.fx.db, { goalId: h.fx.goalId, version: second.version, actor: 'user' });
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'amendment_not_resolved' });
    expect(await resume(h, 'amendment_discarded')).toEqual({ ok: true });
  });

  it('refuses the reason outright when the Goal is not quiesced', async () => {
    const h = harness();
    await h.start();
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'amendment_not_resolved' });
    expect(h.status().status).toBe('running');
  });
});

describe('a superseded cycle never executes under the new definition', () => {
  /** Goal running with a cycle under definition 1 whose work run is `waiting_for_run`; then amend and approve v2. */
  async function amendedWhileInFlight() {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    const cycle = h.cycle()!;
    const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
    return { h, cycle, version };
  }

  it('does not resume the Goal while the old child run is still in flight, and touches nothing', async () => {
    const { h, cycle, version } = await amendedWhileInFlight();
    approve(h, version);
    const runs = h.runs();
    const startsBefore = h.startRun.mock.calls.length;
    const queuesBefore = h.executor.queueCalls.length;
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'superseded_cycle_in_flight' });
    expect(h.status().status).toBe('needs_user');
    expect(h.resumeRun).not.toHaveBeenCalled();
    expect(h.startRun.mock.calls.length).toBe(startsBefore);
    expect(h.executor.queueCalls.length).toBe(queuesBefore);
    expect(h.runs()).toEqual(runs);
    expect(h.cycle()).toMatchObject({ id: cycle.id, status: 'running' });
    expect(cycleCount(h)).toBe(1);
    expect(runs[0]!.status).toBe('running');
  });

  it.each(['paused', 'queued', 'preparing', 'waiting_for_user', 'retrying', 'cancelling'])(
    'treats a %s old run as in flight',
    async (status) => {
      const { h, version } = await amendedWhileInFlight();
      approve(h, version);
      h.setRunStatus(h.runs()[0]!.id, status);
      expect(await resume(h, 'amendment_approved')).toEqual({
        ok: false,
        code: 'superseded_cycle_in_flight',
      });
      expect(h.resumeRun).not.toHaveBeenCalled();
      expect(h.runs()[0]!.status).toBe(status);
    },
  );

  it('retires an old cycle whose child is terminal but not integrated, without moving the Goal ref', async () => {
    const { h, cycle, version } = await amendedWhileInFlight();
    approve(h, version);
    h.setRunStatus(h.runs()[0]!.id, 'completed');
    const headBefore = head(h);
    const refBefore = h.fx.git('rev-parse', goalRef(h));
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'superseded_cycle_retired' });
    expect(h.status().status).toBe('needs_user');
    expect(h.cycle()).toMatchObject({
      id: cycle.id,
      status: 'cancelled',
      outcome: { code: 'definition_superseded', fromVersion: 1, toVersion: 2 },
    });
    expect(head(h)).toBe(headBefore);
    expect(h.fx.git('rev-parse', goalRef(h))).toBe(refBefore);
    expect(
      h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance'").get(),
    ).toEqual({
      n: 0,
    });
    expect(h.runs()[0]!.status).toBe('completed'); // history retained, run untouched
    // The retirement was its own persisted action; the next explicit resume passes preflight under N+1.
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: true });
    expect(h.status().status).toBe('running');
    h.model.script.push({ ok: true, proposal: { ...GOOD_TASK } });
    expect(await h.tick()).toBe('cycle_created');
    expect(h.cycle()).toMatchObject({ status: 'planned' });
    const versions = h.fx.db
      .prepare('SELECT definition_version AS v FROM goal_cycles ORDER BY sequence')
      .all() as Array<{ v: number }>;
    expect(versions.map((row) => row.v)).toEqual([1, 2]);
  });

  it('retires an old cycle that never created a child run', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('proposal_recorded');
    expect(h.runs()).toHaveLength(0);
    const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
    approve(h, version);
    expect(await resume(h, 'amendment_approved')).toEqual({ ok: false, code: 'superseded_cycle_retired' });
    expect(h.cycle()).toMatchObject({ status: 'cancelled', outcome: { code: 'definition_superseded' } });
    expect(h.executor.queueCalls).toHaveLength(0);
  });

  it('lets a cycle continue when the amendment was discarded (same definition version)', async () => {
    const { h, cycle, version } = await amendedWhileInFlight();
    rejectDefinition(h.fx.db, { goalId: h.fx.goalId, version, actor: 'user' });
    expect(await resume(h, 'amendment_discarded')).toEqual({ ok: true });
    expect(h.status().status).toBe('running');
    expect(h.cycle()).toMatchObject({ id: cycle.id, status: 'running' });
    // Ordinary progress continues for that very cycle.
    h.setRunStatus(h.runs()[0]!.id, 'completed');
    expect(await h.tick()).toBe('collection_started');
    expect(await h.tick()).toBe('integration_started');
    expect(await h.tick()).toBe('cycle_succeeded');
  });

  describe('the tick guard (a Goal forced to running with a stale cycle)', () => {
    it('does not queue or start anything for a stale proposing cycle', async () => {
      const h = harness({ autoAnswer: false });
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await h.start();
      await h.until('proposal_queued');
      const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
      approve(h, version);
      h.fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(h.fx.goalId);
      const queues = h.executor.proposalQueueCalls.length;
      expect(await h.tick()).toBe('superseded_cycle_in_flight'); // the queued proposal run is not terminal
      expect(h.startRun).not.toHaveBeenCalled();
      expect(h.executor.proposalQueueCalls.length).toBe(queues);
      expect(h.executor.readCalls).toHaveLength(0);
      expect(h.cycle()).toMatchObject({ status: 'proposing' });
    });

    it('never validates a finished stale proposal or integrates a stale result', async () => {
      const { h, version } = await amendedWhileInFlight();
      approve(h, version);
      h.fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(h.fx.goalId);
      h.setRunStatus(h.runs()[0]!.id, 'completed');
      const refBefore = h.fx.git('rev-parse', goalRef(h));
      expect(await h.tick()).toBe('superseded_cycle_retired');
      expect(h.cycle()).toMatchObject({ status: 'cancelled', outcome: { code: 'definition_superseded' } });
      expect(h.fx.git('rev-parse', goalRef(h))).toBe(refBefore);
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance'").get(),
      ).toEqual({
        n: 0,
      });
    });
  });
});

describe('the normal tick verifies the Goal ref before new external work', () => {
  const broken = {
    moved: {
      code: 'goal_ref_changed',
      apply: (h: Harness) => h.fx.git('update-ref', goalRef(h), h.fx.orphanCommit()),
    },
    missing: { code: 'goal_ref_missing', apply: (h: Harness) => h.fx.git('update-ref', '-d', goalRef(h)) },
  } as const;
  const stages = [
    {
      name: 'proposing, no proposal run',
      reach: async (h: Harness) => void (await h.until('proposal_started')),
    },
    {
      name: 'proposing, queued proposal run',
      reach: async (h: Harness) => void (await h.until('proposal_queued')),
    },
    {
      name: 'launching, no work run',
      reach: async (h: Harness) => void (await h.until('launch_started')),
    },
    {
      name: 'launching, queued work run',
      reach: async (h: Harness) => void (await h.until('run_queued')),
    },
  ];

  describe.each(stages)('$name', (stage) => {
    it.each(Object.entries(broken))(
      'blocks with the %s ref and queues and starts nothing',
      async (_name, how) => {
        const h = harness({ autoAnswer: true });
        h.model.script.push({ ok: true, proposal: GOOD_TASK });
        await h.start();
        await stage.reach(h);
        const before = {
          starts: h.startRun.mock.calls.length,
          proposalQueues: h.executor.proposalQueueCalls.length,
          workQueues: h.executor.queueCalls.length,
          runs: h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get(),
        };
        how.apply(h);
        expect(await h.tick()).toBe('ref_blocked');
        expect(h.status()).toEqual({ status: 'blocked', reason: how.code });
        expect(h.startRun.mock.calls.length).toBe(before.starts);
        expect(h.executor.proposalQueueCalls.length).toBe(before.proposalQueues);
        expect(h.executor.queueCalls.length).toBe(before.workQueues);
        expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual(before.runs);
      },
    );
  });

  it('does not repair or overwrite the ref, and reports invalid Git state as git_state_invalid', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('proposal_started');
    const moved = h.fx.orphanCommit();
    h.fx.git('update-ref', goalRef(h), moved);
    await h.tick();
    expect(h.fx.git('rev-parse', goalRef(h))).toBe(moved);

    const second = harness();
    second.model.script.push({ ok: true, proposal: GOOD_TASK });
    await second.start();
    await second.until('proposal_started');
    second.fx.db.prepare('UPDATE projects SET git_root = NULL WHERE id = ?').run(second.fx.projectId);
    expect(await second.tick()).toBe('ref_blocked');
    expect(second.status()).toEqual({ status: 'blocked', reason: 'git_state_invalid' });
    expect(second.executor.proposalQueueCalls).toHaveLength(0);
  });

  it('does not verify on passive waiting ticks', async () => {
    const h = harness({ autoAnswer: false });
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('proposal_run_started');
    h.fx.git('update-ref', goalRef(h), h.fx.orphanCommit());
    expect(await h.tick()).toBe('waiting_for_proposal');
    expect(h.status().status).toBe('running');
  });
});

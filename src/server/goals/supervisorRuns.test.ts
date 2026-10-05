import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCycles } from './cycles.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(() => {
  cleanupRepoFixtures();
  vi.restoreAllMocks();
});

const runtime = (h: Harness) =>
  h.fx.db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(h.fx.goalId) as Record<string, unknown>;
const head = (h: Harness) => runtime(h).integration_head as string;
const goalRef = (h: Harness) => `refs/heads/turing/goal/${h.fx.goalId}`;
const duplicateRunRows = (h: Harness) =>
  h.fx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM runs WHERE goal_cycle_id IS NOT NULL
         GROUP BY goal_cycle_id, goal_run_purpose HAVING COUNT(*) > 1)`,
    )
    .get() as { n: number };
const proposalRowsFor = (h: Harness, cycleId: string) =>
  (
    h.fx.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = 'proposal'")
      .get(cycleId) as { n: number }
  ).n;

/** A Goal whose first cycle has a queued-but-unstarted proposal run. The model is never answered automatically. */
async function manual(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ ...options, autoAnswer: false });
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  return h;
}
const to = async (h: Harness, action: Parameters<Harness['until']>[0]) => {
  await h.until(action);
};

describe('proposal runs', () => {
  it('queues the proposal run once and starts it once, without validating in the same tick', async () => {
    const h = await manual();
    expect(await h.until('proposal_queued')).toEqual([
      'cycle_created',
      'proposal_started',
      'proposal_queued',
    ]);
    expect(h.proposalRuns()).toHaveLength(1);
    expect(h.proposalRuns()[0]!.status).toBe('queued');
    expect(h.startRun).not.toHaveBeenCalled();
    expect(await h.tick()).toBe('proposal_run_started');
    expect(h.proposalRuns()[0]!.status).toBe('running');
    expect(h.executor.readCalls).toHaveLength(0);
    expect(h.cycle()!.status).toBe('proposing');
    for (let index = 0; index < 3; index++) expect(await h.tick()).toBe('waiting_for_proposal');
    expect(h.proposalRuns()).toHaveLength(1);
    expect(h.proposalStarts()).toBe(1);
    expect(h.executor.proposalQueueCalls).toHaveLength(1);
    expect(h.executor.readCalls).toHaveLength(0);
    expect(h.model.calls).toBe(0);
  });

  it.each(['preparing', 'running', 'waiting_for_approval', 'waiting_for_user', 'retrying', 'cancelling'])(
    'waits while the proposal run is %s',
    async (status) => {
      const h = await manual();
      await to(h, 'proposal_run_started');
      h.setRunStatus(h.proposalRuns()[0]!.id, status);
      for (let index = 0; index < 3; index++) expect(await h.tick()).toBe('waiting_for_proposal');
      expect(h.proposalRuns()).toHaveLength(1);
      expect(h.executor.readCalls).toHaveLength(0);
      expect(h.cycle()!.status).toBe('proposing');
    },
  );

  it('reads and validates the persisted output only after the run completed, then records the proposal', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    h.answerProposal(h.proposalRuns()[0]!.id);
    expect(h.model.calls).toBe(1);
    expect(h.executor.readCalls).toHaveLength(0);
    expect(await h.tick()).toBe('proposal_recorded');
    expect(h.executor.readCalls).toEqual([h.proposalRuns()[0]!.id]);
    expect(h.cycle()).toMatchObject({ status: 'proposed' });
    // The proposal lives in ordinary stage output, not in executor memory.
    const stage = h.fx.db
      .prepare('SELECT output_json FROM stages WHERE run_id = ?')
      .get(h.proposalRuns()[0]!.id) as { output_json: string };
    expect(JSON.parse(JSON.parse(stage.output_json).text)).toMatchObject({ title: GOOD_TASK.title });
  });

  it('fails the cycle when the proposal run failed, and never creates a second proposal run for it', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    const [run] = h.proposalRuns();
    h.setRunStatus(run!.id, 'failed');
    expect(await h.tick()).toBe('cycle_failed');
    expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'proposal_run_failed' } });
    expect(proposalRowsFor(h, h.cycle()!.id)).toBe(1);
    expect(runtime(h)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 1 });
    expect(h.executor.readCalls).toHaveLength(0);
  });

  it('records a cancelled proposal run as a cancelled cycle that counts for nothing, with no replacement run', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    h.setRunStatus(h.proposalRuns()[0]!.id, 'cancelled');
    expect(await h.tick()).toBe('cycle_failed');
    expect(h.cycle()).toMatchObject({
      status: 'cancelled',
      outcome: { code: 'run_cancelled', purpose: 'proposal' },
    });
    expect(proposalRowsFor(h, h.cycle()!.id)).toBe(1);
    expect(runtime(h)).toMatchObject({ cycles_executed: 0, consecutive_failed_cycles: 0 });
  });

  it('turns a paused proposal run into needs_user(run_interrupted) with no automatic resume', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    h.setRunStatus(h.proposalRuns()[0]!.id, 'paused');
    expect(await h.tick()).toBe('run_interrupted');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
    await h.supervisor.reconcile();
    await h.supervisor.runOnce();
    expect(h.resumeRun).not.toHaveBeenCalled();
    expect(h.proposalRuns()).toHaveLength(1);
  });
});

describe('proposal restart and crash points', () => {
  /** Runs reconcile (the startup path) several times on a fresh supervisor and executor. */
  const recover = async (h: Harness) => {
    const fresh = h.restart();
    for (let index = 0; index < 3; index++) await fresh.supervisor.reconcile();
    return fresh;
  };

  it('crash after queue, before start: the new process starts the same run and queues nothing', async () => {
    const h = await manual();
    await to(h, 'proposal_queued');
    const [queued] = h.proposalRuns();
    const fresh = h.restart();
    expect(await fresh.supervisor.tickGoal(h.fx.goalId)).toMatchObject({ action: 'proposal_run_started' });
    expect(fresh.executor.proposalQueueCalls).toHaveLength(0);
    expect(h.proposalRuns().map((run) => run.id)).toEqual([queued!.id]);
    expect(h.proposalStarts()).toBe(1);
    expect(duplicateRunRows(h)).toEqual({ n: 0 });
  });

  it('crash after start: the new process waits on the same run and never starts it again', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    const fresh = await recover(h);
    expect(fresh.executor.proposalQueueCalls).toHaveLength(0);
    expect(h.proposalStarts()).toBe(1);
    expect(h.proposalRuns()).toHaveLength(1);
    expect(h.cycle()!.status).toBe('proposing');
    expect(h.model.calls).toBe(0);
  });

  it('crash after the run completed, before validation: a new supervisor and executor read the persisted proposal', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    h.answerProposal(h.proposalRuns()[0]!.id);
    expect(h.cycle()!.status).toBe('proposing');
    const fresh = h.restart();
    // The original supervisor and executor are never used again; only persisted state remains.
    expect(await fresh.supervisor.tickGoal(h.fx.goalId)).toMatchObject({ action: 'proposal_recorded' });
    expect(h.cycle()!.status).toBe('proposed');
    expect(fresh.executor.readCalls).toHaveLength(1);
    expect(fresh.executor.proposalQueueCalls).toHaveLength(0);
    expect(h.executor.readCalls).toHaveLength(0);
    expect(h.proposalRuns()).toHaveLength(1);
    expect(h.proposalStarts()).toBe(1);
    expect(h.model.calls).toBe(1);
    expect(duplicateRunRows(h)).toEqual({ n: 0 });
  });

  it('crash after validation was persisted as proposed: nothing is proposed again', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    h.answerProposal(h.proposalRuns()[0]!.id);
    await to(h, 'proposal_recorded');
    const fresh = await recover(h);
    expect(fresh.executor.readCalls).toHaveLength(0);
    expect(fresh.executor.proposalQueueCalls).toHaveLength(0);
    expect(h.proposalRuns()).toHaveLength(1);
    expect(h.proposalStarts()).toBe(1);
    expect(h.model.calls).toBe(1);
    expect(['proposed', 'launching', 'running']).toContain(h.cycle()!.status);
    expect(h.runs().length).toBeLessThanOrEqual(1);
    expect(h.workStarts()).toBeLessThanOrEqual(1);
    expect(duplicateRunRows(h)).toEqual({ n: 0 });
  });

  it('repeated recovery at every crash point never produces a second (cycle, proposal) row', async () => {
    const h = await manual();
    await to(h, 'proposal_queued');
    await recover(h);
    expect(h.proposalRuns()).toHaveLength(1);
    expect(h.proposalStarts()).toBe(1);
    h.answerProposal(h.proposalRuns()[0]!.id);
    for (let index = 0; index < 4; index++) await recover(h);
    expect(h.proposalRuns()).toHaveLength(1);
    expect(duplicateRunRows(h)).toEqual({ n: 0 });
    expect(h.model.calls).toBe(1);
  });

  it('queueing a proposal run twice returns the same run (the database unique index is authoritative)', async () => {
    const h = await manual();
    await to(h, 'proposal_queued');
    const [run] = h.proposalRuns();
    const fresh = h.restart();
    const request = h.executor.proposalQueueCalls[0]!;
    expect(await fresh.executor.queueProposalRun(request)).toEqual({ runId: run!.id });
    expect(await h.executor.queueProposalRun(request)).toEqual({ runId: run!.id });
    expect(h.proposalRuns()).toHaveLength(1);
  });
});

describe('structured start results', () => {
  type Phase = 'proposal' | 'execution';
  /** Brings the cycle to the moment just before `phase` starts its queued run. */
  const prepare = async (phase: Phase) => {
    const h = await manual();
    if (phase === 'proposal') {
      await to(h, 'proposal_queued');
    } else {
      await to(h, 'proposal_run_started');
      h.answerProposal(h.proposalRuns()[0]!.id);
      await to(h, 'run_queued');
    }
    return h;
  };
  const queuedRun = (h: Harness, phase: Phase) => (phase === 'proposal' ? h.proposalRuns() : h.runs())[0]!;
  const startsOf = (h: Harness, phase: Phase) => (phase === 'proposal' ? h.proposalStarts() : h.workStarts());

  describe.each(['proposal', 'execution'] as const)('%s run', (phase) => {
    it('does not advance the cycle when the run is not found', async () => {
      const h = await prepare(phase);
      const before = h.cycle()!.status;
      h.startRun.mockImplementationOnce(() => ({ started: false, reason: 'not-found' }));
      expect(await h.tick()).toBe('cycle_failed');
      expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'run_not_found' } });
      expect(before).toBe(phase === 'proposal' ? 'proposing' : 'launching');
    });

    it('treats already-active as in flight and never starts it again', async () => {
      const h = await prepare(phase);
      h.startRun.mockImplementationOnce(() => ({ started: false, reason: 'already-active' }));
      expect(await h.tick()).toBe(phase === 'proposal' ? 'proposal_run_started' : 'run_started');
      expect(startsOf(h, phase)).toBe(1);
    });

    it('re-reads a not-queued run: active means in flight', async () => {
      const h = await prepare(phase);
      const run = queuedRun(h, phase);
      h.startRun.mockImplementationOnce(() => {
        h.setRunStatus(run.id, 'running');
        return { started: false, reason: 'not-queued' };
      });
      expect(await h.tick()).toBe(phase === 'proposal' ? 'proposal_run_started' : 'run_started');
      expect(h.cycle()!.status).toBe(phase === 'proposal' ? 'proposing' : 'running');
    });

    it('re-reads a not-queued run: paused means run_interrupted', async () => {
      const h = await prepare(phase);
      const run = queuedRun(h, phase);
      h.startRun.mockImplementationOnce(() => {
        h.setRunStatus(run.id, 'paused');
        return { started: false, reason: 'not-queued' };
      });
      expect(await h.tick()).toBe('run_interrupted');
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
      expect(h.resumeRun).not.toHaveBeenCalled();
    });

    it('re-reads a not-queued run: terminal is observed without restarting it', async () => {
      const h = await prepare(phase);
      const run = queuedRun(h, phase);
      h.startRun.mockImplementationOnce(() => {
        if (phase === 'proposal') h.answerProposal(run.id);
        else h.setRunStatus(run.id, 'completed');
        return { started: false, reason: 'not-queued' };
      });
      const action = await h.tick();
      expect(action).toBe(phase === 'proposal' ? 'waiting_for_proposal' : 'waiting_for_run');
      expect(startsOf(h, phase)).toBe(1);
      const next = await h.tick();
      expect(next).toBe(phase === 'proposal' ? 'proposal_recorded' : 'collection_started');
      expect(startsOf(h, phase)).toBe(1);
    });

    it('re-reads a not-queued run: an impossible state fails stably', async () => {
      const h = await prepare(phase);
      h.startRun.mockImplementationOnce(() => ({ started: false, reason: 'not-queued' }));
      expect(await h.tick()).toBe('cycle_failed');
      expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'run_state_invalid' } });
    });
  });

  it('production startQueuedRun results flow through unchanged (the dependency returns them)', () => {
    const index = readFileSync(join(process.cwd(), 'src', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('startRun: (runId) => startQueuedRun(database, engine, runId)');
  });
});

describe('explicit resume ordering', () => {
  const interrupted = async (phase: 'proposal' | 'execution') => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    if (phase === 'proposal') {
      h.setRunStatus(h.proposalRuns()[0]!.id, 'paused');
    } else {
      h.answerProposal(h.proposalRuns()[0]!.id);
      await to(h, 'waiting_for_run');
      h.setRunStatus(h.runs()[0]!.id, 'paused');
    }
    expect(await h.tick()).toBe('run_interrupted');
    return h;
  };
  const resume = (h: Harness) =>
    h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'run_resumed' });

  it.each(['proposal', 'execution'] as const)(
    'a refused Goal transition resumes nothing (%s run)',
    async (phase) => {
      const h = await interrupted(phase);
      h.fx.db.exec(
        `CREATE TRIGGER zz_refuse BEFORE UPDATE OF status ON goals WHEN NEW.status = 'running'
         BEGIN SELECT RAISE(ABORT, 'refused'); END`,
      );
      expect(await resume(h)).toEqual({ ok: false, code: 'transition_refused' });
      expect(h.resumeRun).toHaveBeenCalledTimes(0);
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
      h.fx.db.exec('DROP TRIGGER zz_refuse');
    },
  );

  it.each(['proposal', 'execution'] as const)(
    'the Goal owns running before the exact paused run resumes (%s run)',
    async (phase) => {
      const h = await interrupted(phase);
      const paused = (phase === 'proposal' ? h.proposalRuns() : h.runs())[0]!;
      const seen: Array<{ goal: string; run: string }> = [];
      h.resumeRun.mockImplementation((runId) => {
        seen.push({ goal: h.status().status, run: runId });
        h.setRunStatus(runId, 'running');
      });
      expect(await resume(h)).toEqual({ ok: true });
      expect(seen).toEqual([{ goal: 'running', run: paused.id }]);
      expect(h.status().status).toBe('running');
    },
  );

  it('refuses before transitioning when there is no paused Goal run', async () => {
    const h = await interrupted('proposal');
    h.setRunStatus(h.proposalRuns()[0]!.id, 'running');
    expect(await resume(h)).toEqual({ ok: false, code: 'no_paused_run' });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
    expect(h.resumeRun).not.toHaveBeenCalled();
  });

  it('does not hide a failed resume: the Goal returns to needs_user(run_interrupted) with bounded detail', async () => {
    const h = await interrupted('execution');
    h.resumeRun.mockImplementation(() => {
      throw new Error(`engine refused ${'x'.repeat(500)}`);
    });
    const startsBefore = h.startRun.mock.calls.length;
    expect(await resume(h)).toEqual({ ok: false, code: 'resume_failed' });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
    const detail = JSON.parse(
      (
        h.fx.db.prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?').get(h.fx.goalId) as {
          d: string;
        }
      ).d,
    ) as { resumeError: string; runId: string };
    expect(detail.runId).toBe(h.runs()[0]!.id);
    expect(detail.resumeError.length).toBeLessThanOrEqual(200);
    expect(h.startRun.mock.calls.length).toBe(startsBefore);
    expect(h.runs()).toHaveLength(1);
  });
});

describe('startup Goal-ref verification', () => {
  type Stop = { name: string; stop: Parameters<Harness['until']>[0]; prepare?: (h: Harness) => void };
  const stops: Stop[] = [
    { name: 'proposing with a queued proposal run', stop: 'proposal_queued' },
    {
      name: 'launching with a queued execution run',
      stop: 'run_queued',
      prepare: (h) => h.answerProposal(h.proposalRuns()[0]!.id),
    },
  ];
  const breaks = [
    {
      name: 'missing',
      code: 'goal_ref_missing',
      apply: (h: Harness) => h.fx.git('update-ref', '-d', goalRef(h)),
    },
    {
      name: 'moved',
      code: 'goal_ref_changed',
      apply: (h: Harness) => h.fx.git('update-ref', goalRef(h), h.fx.orphanCommit()),
    },
  ];

  describe.each(stops)('$name', (scenario) => {
    it.each(breaks)(
      'blocks with $code and starts and queues nothing when the ref is $name',
      async (broken) => {
        const h = await manual();
        if (scenario.stop === 'proposal_queued') await to(h, 'proposal_queued');
        else {
          await to(h, 'proposal_run_started');
          scenario.prepare!(h);
          await to(h, 'run_queued');
        }
        broken.apply(h);
        const starts = h.startRun.mock.calls.length;
        const proposalQueues = h.executor.proposalQueueCalls.length;
        const workQueues = h.executor.queueCalls.length;
        const results = await h.supervisor.reconcile();
        expect(results.map((result) => result.action)).toEqual(['ref_blocked']);
        expect(h.status()).toEqual({ status: 'blocked', reason: broken.code });
        expect(h.startRun.mock.calls.length).toBe(starts);
        expect(h.executor.proposalQueueCalls.length).toBe(proposalQueues);
        expect(h.executor.queueCalls.length).toBe(workQueues);
        expect(h.resumeRun).not.toHaveBeenCalled();
      },
    );
  });

  it('a correct ref lets recovery continue and start the queued work exactly once', async () => {
    const h = await manual();
    await to(h, 'proposal_queued');
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    expect(h.proposalStarts()).toBe(1);
  });

  it('does not overwrite the moved ref', async () => {
    const h = await manual();
    await to(h, 'proposal_queued');
    const moved = h.fx.orphanCommit();
    h.fx.git('update-ref', goalRef(h), moved);
    await h.supervisor.reconcile();
    expect(h.fx.git('rev-parse', goalRef(h))).toBe(moved);
    expect(head(h)).not.toBe(moved);
  });
});

describe('bound consumption by rejected cycles through the tick', () => {
  it('rejected proposals hit bound_cycles before the failure bound', async () => {
    const h = harness({
      tune: (d) => {
        d.limits.maxExecutionCycles = 2;
        d.limits.maxConsecutiveFailedCycles = 10;
      },
    });
    await h.start();
    for (let index = 0; index < 2; index++) {
      h.model.script.push({ noOutput: true });
      await h.until('proposal_rejected');
    }
    expect(runtime(h)).toMatchObject({ cycles_executed: 2, consecutive_failed_cycles: 2 });
    expect(await h.tick()).toBe('bound_blocked');
    expect(h.status()).toEqual({ status: 'blocked', reason: 'bound_cycles' });
    expect(listCycles(h.fx.db, h.fx.goalId)).toHaveLength(2);
  });

  it('a cancelled cycle stays outside the counters', async () => {
    const h = await manual();
    await to(h, 'proposal_run_started');
    h.setRunStatus(h.proposalRuns()[0]!.id, 'cancelled');
    await h.tick();
    expect(runtime(h)).toMatchObject({ cycles_executed: 0, consecutive_failed_cycles: 0 });
  });
});

describe('actual milestone scope violation', () => {
  const violate = async () => {
    const h = harness();
    h.files.current = { 'docs/x.md': 'outside\n' };
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    h.setRunStatus(h.runs()[0]!.id, 'completed');
    await h.until('cycle_failed');
    return h;
  };

  it('fails the cycle, sends the Goal to the user and leaves the ref alone', async () => {
    const h = await violate();
    expect(h.cycle()).toMatchObject({ status: 'failed', outcome: { code: 'scope_violation' } });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
    expect(JSON.stringify(h.cycle()!.outcome)).toContain('docs/x.md');
    expect(h.fx.git('rev-parse', goalRef(h))).toBe(head(h));
    expect(h.fx.git('rev-parse', goalRef(h))).toBe(h.fx.head());
    expect(runtime(h)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 1 });
  });

  it('creates no further autonomous cycle on repeated scheduler passes or reconcile', async () => {
    const h = await violate();
    const count = listCycles(h.fx.db, h.fx.goalId).length;
    // The failed cycle's run is extracted once (without resuming the Goal); afterwards every pass is a no-op.
    expect((await h.supervisor.maintainEvidence()).map((result) => result.action)).toEqual([
      'evidence_collected',
    ]);
    for (let index = 0; index < 4; index++) {
      expect(await h.supervisor.runOnce()).toEqual([]);
      await h.supervisor.reconcile();
      expect(await h.tick()).toBe('idle');
    }
    expect(listCycles(h.fx.db, h.fx.goalId)).toHaveLength(count);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
  });

  it('an invalid proposal with an out-of-scope path stays a rejected proposal and the Goal keeps running', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, expectedPaths: ['docs/x.md'] } });
    await h.start();
    await h.until('proposal_rejected');
    expect(h.cycle()).toMatchObject({ status: 'rejected' });
    expect(h.status().status).toBe('running');
  });
});

describe('static boundary', () => {
  it('has no immediate model-style proposal API anywhere in production code', () => {
    const directory = join(process.cwd(), 'src', 'server', 'goals');
    for (const file of ['supervisor.ts', 'executor.ts', 'preflight.ts']) {
      const source = readFileSync(join(directory, file), 'utf8');
      expect(source, file).not.toMatch(/\bpropose\s*\(/);
      expect(source, file).not.toMatch(/executor\.propose/);
    }
    const supervisor = readFileSync(join(directory, 'supervisor.ts'), 'utf8');
    expect(supervisor).toContain('queueProposalRun');
    expect(supervisor).toContain('readProposal');
    expect(supervisor).toContain('runForPurpose');
  });

  it('keeps production wired to the disabled executor', () => {
    const index = readFileSync(join(process.cwd(), 'src', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('new DisabledGoalExecutor()');
    expect(index).not.toMatch(/Fake/);
  });
});

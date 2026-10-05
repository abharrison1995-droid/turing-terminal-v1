import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyGoalRef } from '../goalGit.js';
import { listGoalEvents } from './events.js';
import { inspectRunRetention, pruneRunWorktree, recordRunEvidenceCollected } from './retention.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';
import { recordEvidence } from './evidence.js';

afterEach(cleanupRepoFixtures);

const runRow = (h: Harness, runId: string) =>
  h.fx.db
    .prepare(
      'SELECT worktree_path AS wt, branch, starting_commit AS sc, goal_base_commit AS gb, status FROM runs WHERE id = ?',
    )
    .get(runId) as {
    wt: string | null;
    branch: string;
    sc: string | null;
    gb: string | null;
    status: string;
  };
const branchExists = (h: Harness, branch: string) => {
  try {
    h.fx.git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};
const refuses = async (h: Harness, runId: string, reason: string) => {
  const inspection = await inspectRunRetention(h.fx.db, runId);
  expect(inspection.state).toBe('refused');
  expect(inspection.reasons).toContain(reason);
  const before = runRow(h, runId).wt;
  const existed = before !== null && existsSync(before);
  expect(await pruneRunWorktree(h.fx.db, runId)).toMatchObject({ status: 'refused' });
  expect(runRow(h, runId).wt).toBe(before);
  if (existed) expect(existsSync(before!)).toBe(true);
};

/** A Goal whose proposal run exists, is completed, and has a real worktree; the cycle has NOT consumed it yet. */
async function proposalCase() {
  const h = harness({ proposalWorktrees: true });
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('proposal_run_started');
  const run = h.proposalRuns()[0]!;
  expect(run.status).toBe('completed');
  return { h, runId: run.id, cycleId: run.goal_cycle_id! };
}

/** A Goal whose first cycle ran an execution run to a succeeded (integrated) cycle. */
async function integratedCase() {
  const h = harness();
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
  const runId = h.runs()[0]!.id;
  h.setRunStatus(runId, 'completed');
  await h.until('cycle_succeeded');
  return { h, runId, cycleId: h.cycle()!.id };
}

/** A Goal whose work run finished but whose cycle has not yet been collected or finalised. */
async function runningCycleCase() {
  const h = harness();
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
  const runId = h.runs()[0]!.id;
  h.setRunStatus(runId, 'completed');
  return { h, runId, cycleId: h.cycle()!.id };
}

/** A Goal whose execution cycle failed (work outside scope). */
async function failedCase() {
  const h = harness();
  h.files.current = { 'docs/x.md': 'outside\n' };
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
  const runId = h.runs()[0]!.id;
  h.setRunStatus(runId, 'completed');
  await h.until('cycle_failed');
  return { h, runId, cycleId: h.cycle()!.id };
}

const mark = (h: Harness, runId: string) =>
  recordRunEvidenceCollected(h.fx.db, { goalId: h.fx.goalId, runId, evidenceCount: 0 });

describe('retention refusals', () => {
  it('refuses unknown and ordinary (non-Goal) runs', async () => {
    const h = harness();
    expect(await inspectRunRetention(h.fx.db, 'nope')).toEqual({
      state: 'refused',
      reasons: ['run_not_found'],
    });
    const id = randomUUID();
    const machine = (
      h.fx.db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as {
        value: string;
      }
    ).value;
    h.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, branch, worktree_path)
         VALUES (?, ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 'p', 'economy', 'normal', 'completed', ?, 'turing/x', '/tmp/x')`,
      )
      .run(id, machine, h.fx.projectId, new Date().toISOString());
    expect(await inspectRunRetention(h.fx.db, id)).toEqual({ state: 'refused', reasons: ['not_goal_run'] });
    expect(await pruneRunWorktree(h.fx.db, id)).toEqual({ status: 'refused', reasons: ['not_goal_run'] });
  });

  it('refuses a non-terminal run and a non-terminal owning cycle', async () => {
    const { h, runId } = await runningCycleCase();
    mark(h, runId);
    await refuses(h, runId, 'cycle_not_terminal');
    h.setRunStatus(runId, 'running');
    await refuses(h, runId, 'run_not_terminal');
  });

  it('refuses an execution run that has no evidence marker', async () => {
    const { h, runId } = await failedCase();
    await refuses(h, runId, 'evidence_not_collected');
  });

  it.each([
    ['the run', true],
    ['only its cycle', false],
  ])('refuses a planned integration op that references %s', async (_name, withRun) => {
    const { h, runId, cycleId } = await failedCase();
    mark(h, runId);
    h.fx.db
      .prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, run_id, op, expected_old, new_commit, status, checks_json, created_at)
         VALUES (?, ?, ?, ?, 'advance', ?, ?, 'planned', '[]', ?)`,
      )
      .run(
        randomUUID(),
        h.fx.goalId,
        cycleId,
        withRun ? runId : null,
        h.fx.head(),
        h.fx.head(),
        new Date().toISOString(),
      );
    await refuses(h, runId, 'planned_integration_op');
  });

  describe('worktree state', () => {
    it('refuses a dirty worktree and an untracked file', async () => {
      const { h, runId } = await failedCase();
      mark(h, runId);
      const wt = runRow(h, runId).wt!;
      writeFileSync(join(wt, 'docs/x.md'), 'changed\n');
      await refuses(h, runId, 'worktree_dirty');
      h.fx.git('-C', wt, 'checkout', '--', '.');
      expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
      writeFileSync(join(wt, 'untracked.txt'), 'u\n');
      await refuses(h, runId, 'worktree_dirty');
    });

    it('refuses when the worktree is on another branch, detached, or the recorded branch name is wrong', async () => {
      const { h, runId } = await failedCase();
      mark(h, runId);
      const wt = runRow(h, runId).wt!;
      const branch = runRow(h, runId).branch;
      execFileSync('git', ['-C', wt, 'switch', '-q', '-c', 'other-branch']);
      await refuses(h, runId, 'worktree_mismatch');
      execFileSync('git', ['-C', wt, 'switch', '-q', branch]);
      execFileSync('git', ['-C', wt, 'checkout', '-q', '--detach']);
      await refuses(h, runId, 'worktree_mismatch');
      execFileSync('git', ['-C', wt, 'switch', '-q', branch]);
      expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
      h.fx.db.prepare("UPDATE runs SET branch = 'turing/00000000' WHERE id = ?").run(runId);
      await refuses(h, runId, 'worktree_mismatch');
    });

    it('refuses a worktree whose branch tip moved underneath it (HEAD is symbolic, so the checkout reads dirty)', async () => {
      const { h, runId } = await failedCase();
      mark(h, runId);
      const branch = runRow(h, runId).branch;
      h.fx.git('update-ref', `refs/heads/${branch}`, h.fx.orphanCommit());
      const inspection = await inspectRunRetention(h.fx.db, runId);
      expect(inspection.state).toBe('refused');
      expect(await pruneRunWorktree(h.fx.db, runId)).toMatchObject({ status: 'refused' });
      expect(existsSync(runRow(h, runId).wt!)).toBe(true);
    });

    it('refuses a worktree that belongs to another repository', async () => {
      const { h, runId } = await failedCase();
      mark(h, runId);
      const other = harness();
      const foreign = other.fx.repo;
      h.fx.db.prepare('UPDATE runs SET worktree_path = ? WHERE id = ?').run(foreign, runId);
      await refuses(h, runId, 'worktree_mismatch');
    });

    it('refuses when the retained branch is missing, and a missing worktree directory', async () => {
      const { h, runId } = await failedCase();
      mark(h, runId);
      const { branch, wt } = runRow(h, runId) as { branch: string; wt: string };
      h.fx.db.prepare('UPDATE runs SET worktree_path = ? WHERE id = ?').run(`${wt}-gone`, runId);
      await refuses(h, runId, 'worktree_missing');
      h.fx.db.prepare('UPDATE runs SET worktree_path = ? WHERE id = ?').run(wt, runId);
      // Deleting a branch that a worktree has checked out is refused by Git, so remove the ref file directly.
      const refFile = join(h.fx.repo, '.git', 'refs', 'heads', branch);
      execFileSync('rm', ['-f', refFile]);
      const inspection = await inspectRunRetention(h.fx.db, runId);
      expect(inspection.state).toBe('refused');
      expect(inspection.reasons.length).toBe(1);
      expect(existsSync(wt)).toBe(true);
    });
  });
});

describe('proposal retention', () => {
  it('refuses an unconsumed proposal, then allows it once the validated task is persisted', async () => {
    const { h, runId, cycleId } = await proposalCase();
    await refuses(h, runId, 'proposal_not_consumed');
    h.fx.db.prepare("UPDATE goal_cycles SET validated_task_json = '{}' WHERE id = ?").run(cycleId);
    expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
  });

  it.each(['rejected', 'failed', 'cancelled'])(
    'allows a proposal of a terminally %s cycle',
    async (status) => {
      const { h, runId, cycleId } = await proposalCase();
      h.fx.db.prepare('UPDATE goal_cycles SET status = ? WHERE id = ?').run(status, cycleId);
      expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
    },
  );

  it('prunes through Git, retains the branch and base fields, and a second prune is already_pruned', async () => {
    const { h, runId, cycleId } = await proposalCase();
    h.fx.db.prepare("UPDATE goal_cycles SET validated_task_json = '{}' WHERE id = ?").run(cycleId);
    const before = runRow(h, runId);
    const result = await pruneRunWorktree(h.fx.db, runId);
    expect(result).toEqual({ status: 'pruned', reasons: [], branch: before.branch });
    const after = runRow(h, runId);
    expect(after.wt).toBeNull();
    expect(existsSync(before.wt!)).toBe(false);
    expect(h.fx.git('worktree', 'list', '--porcelain')).not.toContain(before.wt!);
    expect(branchExists(h, before.branch)).toBe(true);
    expect({ branch: after.branch, sc: after.sc, gb: after.gb }).toEqual({
      branch: before.branch,
      sc: before.sc,
      gb: before.gb,
    });
    expect(await pruneRunWorktree(h.fx.db, runId)).toEqual({ status: 'already_pruned', reasons: [] });
    expect(await inspectRunRetention(h.fx.db, runId)).toEqual({ state: 'already_pruned', reasons: [] });
  });

  it('the supervisor opportunistically prunes a consumed proposal and reports a bounded cleanup result', async () => {
    const { h, runId } = await proposalCase();
    const wt = runRow(h, runId).wt!;
    const result = await h.supervisor.tickGoal(h.fx.goalId);
    expect(result.action).toBe('proposal_recorded');
    expect(result.cleanup).toEqual({ runId, status: 'pruned', reasons: [] });
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(h, runRow(h, runId).branch)).toBe(true);
  });

  it('a cleanup failure never changes the Goal outcome', async () => {
    const { h, runId } = await proposalCase();
    const wt = runRow(h, runId).wt!;
    writeFileSync(join(wt, 'dirty.txt'), 'x\n');
    const result = await h.supervisor.tickGoal(h.fx.goalId);
    expect(result.action).toBe('proposal_recorded');
    expect(result.cleanup).toEqual({ runId, status: 'refused', reasons: ['worktree_dirty'] });
    expect(h.status().status).toBe('running');
    expect(existsSync(wt)).toBe(true);
  });

  it('does not run when the proposal worktree path is absent from disk (history only)', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('proposal_run_started');
    const result = await h.supervisor.tickGoal(h.fx.goalId);
    expect(result.action).toBe('proposal_recorded');
    expect(result.cleanup).toBeUndefined();
  });
});

describe('execution retention', () => {
  it('refuses an integrated run without a marker, accepts it with one, and retains branch and commit', async () => {
    const { h, runId, cycleId } = await integratedCase();
    await refuses(h, runId, 'evidence_not_collected');
    expect(mark(h, runId)).toEqual({ recorded: true });
    expect(mark(h, runId)).toEqual({ recorded: false });
    expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
    const before = runRow(h, runId);
    const cycle = h.fx.db
      .prepare('SELECT result_integration_commit AS c FROM goal_cycles WHERE id = ?')
      .get(cycleId) as { c: string };
    const refBefore = h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`);
    expect(await pruneRunWorktree(h.fx.db, runId)).toMatchObject({ status: 'pruned' });
    expect(existsSync(before.wt!)).toBe(false);
    expect(branchExists(h, before.branch)).toBe(true);
    expect(h.fx.git('merge-base', '--is-ancestor', cycle.c, refBefore)).toBe('');
    expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(refBefore);
    expect(runRow(h, runId)).toMatchObject({ branch: before.branch, sc: before.sc, gb: before.gb, wt: null });
  });

  it('refuses an integrated run whose result commit is not in Goal history', async () => {
    const { h, runId } = await integratedCase();
    mark(h, runId);
    // The Goal ref no longer contains the integrated result commit.
    h.fx.git('update-ref', `refs/heads/turing/goal/${h.fx.goalId}`, h.fx.orphanCommit());
    const inspection = await inspectRunRetention(h.fx.db, runId);
    expect(inspection).toEqual({ state: 'refused', reasons: ['integration_not_proven'] });
  });

  it('allows a failed or rejected historical run only with a marker', async () => {
    const { h, runId } = await failedCase();
    await refuses(h, runId, 'evidence_not_collected');
    mark(h, runId);
    expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
    expect(await pruneRunWorktree(h.fx.db, runId)).toMatchObject({ status: 'pruned' });
    expect(branchExists(h, runRow(h, runId).branch)).toBe(true);
  });

  it('keeps Goal verification, memory, history and evidence readable after a prune', async () => {
    const { h, runId } = await integratedCase();
    mark(h, runId);
    const eventsBefore = listGoalEvents(h.fx.db, h.fx.goalId).length;
    await pruneRunWorktree(h.fx.db, runId);
    expect(await verifyGoalRef(h.fx.db, h.fx.goalId)).toMatchObject({ ok: true });
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 1 });
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE id = ?').get(runId)).toEqual({ n: 1 });
    expect(listGoalEvents(h.fx.db, h.fx.goalId).length).toBe(eventsBefore);
    expect(
      h.fx.db.prepare("SELECT 1 FROM goal_runtime WHERE memory_json <> '{}' AND goal_id = ?").all(h.fx.goalId)
        .length,
    ).toBeGreaterThan(0);
    // Evidence recording against the pruned run's cycle still works.
    await recordEvidence(h.fx.db, {
      goalId: h.fx.goalId,
      definitionVersion: 1,
      criterionKey: 'build',
      verifierDigest: h.fx.digest('build'),
      kind: 'build_result',
      verdict: 'satisfies',
      subjectTree: h.fx.tree(),
    });
  });

  it('survives a restart: persisted state alone decides eligibility', async () => {
    const { h, runId } = await failedCase();
    mark(h, runId);
    h.restart();
    expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
    await pruneRunWorktree(h.fx.db, runId);
    h.restart();
    expect(await pruneRunWorktree(h.fx.db, runId)).toEqual({ status: 'already_pruned', reasons: [] });
  });

  it('does not let planned-op recovery state be pruned over', async () => {
    const { h, runId, cycleId } = await failedCase();
    mark(h, runId);
    h.fx.db
      .prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, run_id, op, expected_old, new_commit, status, checks_json, created_at)
         VALUES (?, ?, ?, ?, 'advance', ?, ?, 'planned', '[]', ?)`,
      )
      .run(randomUUID(), h.fx.goalId, cycleId, runId, h.fx.head(), h.fx.head(), new Date().toISOString());
    await refuses(h, runId, 'planned_integration_op');
  });
});

describe('evidence marker helper', () => {
  it('records the factual marker only for a terminal run with a matching stored evidence count', async () => {
    const { h, runId, cycleId } = await failedCase();
    expect(() =>
      recordRunEvidenceCollected(h.fx.db, { goalId: h.fx.goalId, runId, evidenceCount: 3 }),
    ).toThrow(/not 3/);
    expect(() => recordRunEvidenceCollected(h.fx.db, { goalId: 'other', runId, evidenceCount: 0 })).toThrow(
      /does not belong/,
    );
    h.setRunStatus(runId, 'running');
    expect(() => mark(h, runId)).toThrow(/terminal/);
    h.setRunStatus(runId, 'completed');
    mark(h, runId);
    const event = listGoalEvents(h.fx.db, h.fx.goalId).find((e) => e.type === 'run_evidence_collected')!;
    expect(event.payload).toEqual({ runId, cycleId, definitionVersion: 1, evidenceCount: 0 });
  });
});

describe('static guarantees', () => {
  const source = readFileSync(join(__dirname, 'retention.ts'), 'utf8');
  it('never forces removal, prunes globally, deletes branches or sweeps directories', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/--force|'-f'|worktree', 'prune|branch', '-[dD]|rmSync|rm\(|readdir/);
    expect(code).toMatch(/'worktree', 'remove', inspection\.worktreePath/);
  });
  it('never writes the evidence marker from inspection or pruning', () => {
    const body = source.slice(
      source.indexOf('export async function inspectRunRetention'),
      source.indexOf('export function recordRunEvidenceCollected'),
    );
    expect(body).not.toContain('writeGoalEvent');
  });
});

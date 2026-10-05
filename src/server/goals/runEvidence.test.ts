import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition, SuccessCriterion } from '../../shared/goals.js';
import { computeCounters, createCycle, finalizeCycle, transitionCycle } from './cycles.js';
import { TuringGoalExecutor } from './turingExecutor.js';
import { UnroutedGoalRunPlanProvider } from './runPlan.js';
import { collectRunEvidence, listUncollectedRunIds } from './runEvidence.js';
import { listGoalEvents } from './events.js';
import { recordEvidence } from './evidence.js';
import { inspectRunRetention } from './retention.js';
import { BUILD, TESTS, cleanupRepoFixtures, milestone, simpleDefinition } from './repoKit.js';
import { verifierDigest } from './verifierDigest.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILD_CMD = ['npm', 'run', 'build'];
const TEST_CMD = ['npm', 'run', 'test'];
const COMMIT: SuccessCriterion = {
  key: 'commit',
  statement: 'The work is committed',
  verification: [{ kind: 'commit_on_branch' }],
  required: true,
};
const FILE: SuccessCriterion = {
  key: 'file',
  statement: 'The module exists',
  verification: [{ kind: 'file_exists', path: 'src/a.ts' }],
  required: true,
};
const LINT: SuccessCriterion = {
  key: 'lint',
  statement: 'Lint is clean',
  verification: [{ kind: 'lint' }],
  required: true,
};

const definitionWith = (...extra: SuccessCriterion[]): GoalDefinition =>
  simpleDefinition({
    criteria: [structuredClone(BUILD), structuredClone(TESTS), ...extra.map((c) => structuredClone(c))],
    milestones: [milestone('m1', ['build', 'tests', ...extra.map((c) => c.key)])],
  });

interface StageSpec {
  key: string;
  kind: 'build' | 'test' | 'shellCommand';
  status: 'passed' | 'failed' | 'cancelled' | 'skipped';
  output: Record<string, unknown>;
}

const events = (h: Harness) => listGoalEvents(h.fx.db, h.fx.goalId).map((event) => event.type);
const rows = (h: Harness, runId: string) =>
  h.fx.db.prepare('SELECT * FROM goal_evidence WHERE run_id = ? ORDER BY rowid').all(runId) as Array<
    Record<string, unknown>
  >;
const markers = (h: Harness, runId: string) =>
  h.fx.db
    .prepare(
      "SELECT payload_json FROM goal_events WHERE type = 'run_evidence_collected' AND json_extract(payload_json, '$.runId') = ?",
    )
    .all(runId);

function addStages(h: Harness, runId: string, stages: StageSpec[]): string[] {
  const ids: string[] = [];
  stages.forEach((stage, sequence) => {
    const id = randomUUID();
    ids.push(id);
    h.fx.db
      .prepare(
        `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, output_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, stage.key, stage.kind, stage.key, sequence, stage.status, JSON.stringify(stage.output));
  });
  return ids;
}

/** One execution cycle that integrated: real worktree and Git, stages injected where the engine would persist them. */
async function integrated(
  options: {
    definition?: GoalDefinition;
    stages?: (ctx: { base: string; tree: string }) => StageSpec[];
  } = {},
) {
  const h = harness({ definition: options.definition ?? definitionWith() });
  h.fx.db
    .prepare('UPDATE projects SET build_command_json = ?, test_command_json = ? WHERE id = ?')
    .run(JSON.stringify(BUILD_CMD), JSON.stringify(TEST_CMD), h.fx.projectId);
  h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, targetCriteria: ['build'] } });
  await h.start();
  await h.until('waiting_for_run');
  const run = h.runs()[0]!;
  const branch = (h.fx.db.prepare('SELECT branch FROM runs WHERE id = ?').get(run.id) as { branch: string })
    .branch;
  const base = h.fx.head();
  const tree = h.fx.git('rev-parse', `${branch}^{tree}`);
  const stageIds = addStages(h, run.id, options.stages?.({ base, tree }) ?? []);
  const finish = options.finish ?? 'completed';
  h.setRunStatus(run.id, finish);
  await h.until(finish === 'completed' ? 'cycle_succeeded' : 'cycle_failed');
  return { h, runId: run.id, cycleId: run.goal_cycle_id!, base, tree, stageIds };
}

const passed = (
  key: 'goal-build' | 'goal-test',
  command: string[],
  base: string,
  tree: string,
): StageSpec => ({
  key,
  kind: key === 'goal-build' ? 'build' : 'test',
  status: 'passed',
  output: { command, subjectTree: tree, subjectCommit: base },
});

describe('run evidence collection', () => {
  it('binds exact subject evidence, writes the marker last, then prunes the worktree and keeps the branch', async () => {
    const { h, runId, cycleId, base, tree, stageIds } = await integrated({
      stages: ({ base, tree }) => [
        passed('goal-build', BUILD_CMD, base, tree),
        passed('goal-test', TEST_CMD, base, tree),
      ],
    });
    expect(listUncollectedRunIds(h.fx.db, h.fx.goalId)).toEqual([runId]);
    const result = await h.supervisor.tickGoal(h.fx.goalId);
    expect(result).toMatchObject({
      action: 'evidence_collected',
      cycleId,
      runId,
      evidenceCount: 2,
      cleanup: { runId, status: 'pruned' },
    });
    const stored = rows(h, runId);
    expect(stored.map((row) => [row.kind, row.verdict, row.criterion_key])).toEqual([
      ['build_result', 'satisfies', 'build'],
      ['test_result', 'satisfies', 'tests'],
    ]);
    expect(stored[0]).toMatchObject({
      goal_id: h.fx.goalId,
      definition_version: 1,
      cycle_id: cycleId,
      run_id: runId,
      stage_id: stageIds[0],
      subject_tree: tree,
      subject_commit: base,
      verifier_digest: h.fx.digest('build'),
    });
    // The marker is the last event of the collection and exists exactly once.
    expect(events(h).slice(-3)).toEqual(['evidence_recorded', 'evidence_recorded', 'run_evidence_collected']);
    expect(markers(h, runId)).toHaveLength(1);
    // Retention: the worktree is gone, the run branch is retained.
    const run = h.fx.db.prepare('SELECT worktree_path, branch FROM runs WHERE id = ?').get(runId) as {
      worktree_path: string | null;
      branch: string;
    };
    expect(run.worktree_path).toBeNull();
    expect(h.fx.git('rev-parse', '--verify', `refs/heads/${run.branch}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(await inspectRunRetention(h.fx.db, runId)).toEqual({ state: 'already_pruned', reasons: [] });
    expect(await h.tick()).not.toBe('evidence_collected');
  });

  it('a non-zero command exit contradicts; timeouts, cancellation, skips and unmarked failures say nothing', async () => {
    const { h, runId } = await integrated({
      finish: 'failed',
      stages: ({ base, tree }) => [
        {
          key: 'goal-build',
          kind: 'build',
          status: 'failed',
          output: {
            error: 'exit 3',
            command: BUILD_CMD,
            subjectTree: tree,
            subjectCommit: base,
            failureKind: 'command_exit',
            exitCode: 3,
          },
        },
        {
          key: 'goal-test',
          kind: 'test',
          status: 'failed',
          output: {
            error: 'timed out',
            command: TEST_CMD,
            subjectTree: tree,
            subjectCommit: base,
            failureKind: 'infrastructure',
          },
        },
      ],
    });
    const result = await collectRunEvidence(h.fx.db, runId);
    expect(result).toMatchObject({ status: 'collected', evidenceCount: 1 });
    expect(rows(h, runId).map((row) => [row.kind, row.verdict])).toEqual([['build_result', 'contradicts']]);
    expect(JSON.parse(rows(h, runId)[0]!.ref_json as string)).toMatchObject({ exitCode: 3 });
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['skipped', 'skipped'],
  ] as const)('a %s stage yields no evidence and a zero-evidence marker', async (_name, status) => {
    const { h, runId } = await integrated({
      finish: status === 'cancelled' ? 'failed' : 'completed',
      stages: ({ base, tree }) => [{ ...passed('goal-build', BUILD_CMD, base, tree), status }],
    });
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({
      status: 'collected',
      evidenceCount: 0,
      created: 0,
      markerRecorded: true,
    });
    expect(rows(h, runId)).toEqual([]);
    expect(
      h.fx.db.prepare("SELECT payload_json FROM goal_events WHERE type = 'run_evidence_collected'").get(),
    ).toMatchObject({
      payload_json: expect.stringContaining('"evidenceCount":0'),
    });
    expect((await inspectRunRetention(h.fx.db, runId)).state).toBe('eligible');
  });

  it('records nothing when the command that ran is not the verifier command, whatever the stage is called', async () => {
    const lintStageForBuild = (base: string, tree: string): StageSpec => ({
      key: 'goal-build',
      kind: 'build',
      status: 'passed',
      output: { command: ['npm', 'run', 'lint'], subjectTree: tree, subjectCommit: base },
    });
    const { h, runId } = await integrated({
      stages: ({ base, tree }) => [lintStageForBuild(base, tree)],
    });
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({ status: 'collected', evidenceCount: 0 });
  });

  it('a verification-style stage id is honoured only when digest, command and stage kind all agree', async () => {
    const buildDigest = h0digest();
    function h0digest() {
      return verifierDigest('build', { kind: 'build', command: BUILD_CMD });
    }
    const testDigest = verifierDigest('tests', { kind: 'test' });
    const { h, runId } = await integrated({
      stages: ({ base, tree }) => [
        // Right digest, right command, right (native) kind.
        {
          key: `gv-${buildDigest}`,
          kind: 'build',
          status: 'passed',
          output: { command: BUILD_CMD, subjectTree: tree, subjectCommit: base },
        },
        // A shell stage claiming the build digest: the verifier materialises natively, so the kind disagrees.
        {
          key: `gv-${buildDigest}`,
          kind: 'shellCommand',
          status: 'passed',
          output: { command: BUILD_CMD, subjectTree: tree, subjectCommit: base },
        },
        // Right digest but a different command than the verifier's.
        {
          key: `gv-${testDigest}`,
          kind: 'test',
          status: 'passed',
          output: { command: ['npm', 'run', 'lint'], subjectTree: tree, subjectCommit: base },
        },
        // A digest that is no verifier of the definition.
        {
          key: `gv-${'0'.repeat(64)}`,
          kind: 'build',
          status: 'passed',
          output: { command: BUILD_CMD, subjectTree: tree, subjectCommit: base },
        },
        // A label that merely looks like a verification stage.
        {
          key: 'gv-build',
          kind: 'build',
          status: 'passed',
          output: { command: BUILD_CMD, subjectTree: tree, subjectCommit: base },
        },
      ],
    });
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({ status: 'collected', evidenceCount: 1 });
    expect(rows(h, runId)[0]).toMatchObject({ kind: 'build_result', verifier_digest: buildDigest });
  });

  it('resumes after a crash between rows: reuses what exists, adds the rest, writes the marker once', async () => {
    const { h, runId, cycleId, base, tree, stageIds } = await integrated({
      stages: ({ base, tree }) => [
        passed('goal-build', BUILD_CMD, base, tree),
        passed('goal-test', TEST_CMD, base, tree),
      ],
    });
    // Row 1 was inserted, then the process died before row 2 and before the marker.
    const first = await recordEvidence(h.fx.db, {
      goalId: h.fx.goalId,
      definitionVersion: 1,
      criterionKey: 'build',
      verifierDigest: h.fx.digest('build'),
      kind: 'build_result',
      verdict: 'satisfies',
      subjectTree: tree,
      subjectCommit: base,
      cycleId,
      runId,
      stageId: stageIds[0],
    });
    expect(markers(h, runId)).toHaveLength(0);
    expect((await inspectRunRetention(h.fx.db, runId)).reasons).toContain('evidence_not_collected');
    const again = await collectRunEvidence(h.fx.db, runId);
    expect(again).toMatchObject({ evidenceCount: 2, created: 1, markerRecorded: true });
    expect(rows(h, runId).map((row) => row.id)[0]).toBe(first.id);
    // A repeat is a no-op: no duplicate rows, no second marker.
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({
      evidenceCount: 2,
      created: 0,
      markerRecorded: false,
    });
    expect(rows(h, runId)).toHaveLength(2);
    expect(markers(h, runId)).toHaveLength(1);
  });

  it('fails closed on an invalid subject: nothing is marked and retention keeps refusing', async () => {
    const { h, runId } = await integrated({
      stages: ({ base }) => [
        {
          key: 'goal-build',
          kind: 'build',
          status: 'passed',
          output: { command: BUILD_CMD, subjectTree: 'a'.repeat(40), subjectCommit: base },
        },
      ],
    });
    await expect(collectRunEvidence(h.fx.db, runId)).rejects.toThrow();
    expect(markers(h, runId)).toHaveLength(0);
    expect((await inspectRunRetention(h.fx.db, runId)).reasons).toContain('evidence_not_collected');
  });

  it('is eligible only for terminal repository runs of terminal cycles', async () => {
    const h = harness();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('proposal_run_started');
    const proposal = h.proposalRuns()[0]!;
    expect(await collectRunEvidence(h.fx.db, proposal.id)).toEqual({
      status: 'ineligible',
      code: 'unsupported_purpose',
    });
    // An ordinary (non-Goal) run is never collected and never receives Goal evidence.
    const ordinary = randomUUID();
    const machine = (
      h.fx.db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    h.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
         VALUES (?, ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 'p', 'economy', 'normal', 'completed', ?)`,
      )
      .run(ordinary, machine, h.fx.projectId, new Date().toISOString());
    expect(await collectRunEvidence(h.fx.db, ordinary)).toEqual({
      status: 'ineligible',
      code: 'not_goal_run',
    });
    expect(await collectRunEvidence(h.fx.db, 'missing')).toEqual({
      status: 'ineligible',
      code: 'run_not_found',
    });
    await h.until('waiting_for_run');
    const run = h.runs()[0]!;
    expect(await collectRunEvidence(h.fx.db, run.id)).toEqual({
      status: 'ineligible',
      code: 'run_not_terminal',
    });
    h.setRunStatus(run.id, 'completed');
    expect(await collectRunEvidence(h.fx.db, run.id)).toEqual({
      status: 'ineligible',
      code: 'cycle_not_terminal',
    });
    expect(events(h)).not.toContain('run_evidence_collected');
  });
});

describe('commit and artifact evidence', () => {
  const definition = () => definitionWith(COMMIT, FILE);

  it('records commit and file evidence only from an integrated cycle, bound to the exact commit', async () => {
    const { h, runId, cycleId } = await integrated({ definition: definition() });
    const result = (
      h.fx.db.prepare('SELECT result_integration_commit AS c FROM goal_cycles WHERE id = ?').get(cycleId) as {
        c: string;
      }
    ).c;
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({ evidenceCount: 2 });
    const stored = rows(h, runId);
    expect(stored.find((row) => row.kind === 'commit')).toMatchObject({
      verdict: 'satisfies',
      subject_commit: result,
      criterion_key: 'commit',
      cycle_id: cycleId,
    });
    expect(stored.find((row) => row.kind === 'artifact')).toMatchObject({
      verdict: 'satisfies',
      subject_commit: result,
      subject_path: 'src/a.ts',
    });
  });

  it('fabricates no file evidence once the Goal head has moved past the cycle result, but keeps the commit', async () => {
    const { h, runId } = await integrated({ definition: definition() });
    h.fx.advance({ 'src/other.ts': 'export const o = 1;\n' }, 'moved');
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({ evidenceCount: 1 });
    expect(rows(h, runId).map((row) => row.kind)).toEqual(['commit']);
  });

  it('records neither for a failed execution cycle', async () => {
    const h = harness({ definition: definition() });
    h.files.current = { 'docs/x.md': 'outside scope\n' };
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    const runId = h.runs()[0]!.id;
    h.setRunStatus(runId, 'completed');
    await h.until('cycle_failed');
    expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({ status: 'collected', evidenceCount: 0 });
    expect(rows(h, runId)).toEqual([]);
  });
});

describe('evidence maintenance', () => {
  it('extracts a needs_user Goal run without resuming it', async () => {
    const h = harness();
    h.files.current = { 'docs/x.md': 'outside scope\n' };
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    const runId = h.runs()[0]!.id;
    h.setRunStatus(runId, 'completed');
    await h.until('cycle_failed');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
    const results = await h.supervisor.maintainEvidence();
    expect(results).toMatchObject([{ action: 'evidence_collected', runId, evidenceCount: 0 }]);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
    expect(await h.supervisor.maintainEvidence()).toEqual([]);
  });

  it('collects one run per action before the next execution cycle', async () => {
    const { h, runId } = await integrated();
    const actions: string[] = [];
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    for (let index = 0; index < 2; index++) actions.push(await h.tick());
    expect(actions).toEqual(['evidence_collected', 'cycle_created']);
    expect(markers(h, runId)).toHaveLength(1);
    expect(existsSync(h.fx.repo)).toBe(true);
  });
});

describe('verification scheduling without a verification-capable executor', () => {
  it('never schedules a verification cycle for an executor that cannot queue one', async () => {
    const { h } = await integrated({ definition: definitionWith(LINT) });
    expect(await h.tick()).toBe('evidence_collected');
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    expect(await h.tick()).toBe('cycle_created');
    expect(
      h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_cycles WHERE kind = 'verification'").get(),
    ).toEqual({ n: 0 });
  });

  it('hands the Goal to the user, launching nothing, when a verifier cannot be materialised', async () => {
    const { h } = await integrated({ definition: definitionWith(LINT) });
    h.executor.queueVerificationRun = async () => {
      throw new Error('must not run');
    };
    expect(await h.tick()).toBe('evidence_collected');
    const result = await h.supervisor.tickGoal(h.fx.goalId);
    expect(result).toMatchObject({
      action: 'verification_unavailable',
      code: 'verification_command_missing',
    });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'verification_failed' });
    const detail = JSON.parse(
      (
        h.fx.db.prepare('SELECT status_detail_json FROM goals WHERE id = ?').get(h.fx.goalId) as {
          status_detail_json: string;
        }
      ).status_detail_json,
    ) as Record<string, unknown>;
    expect(detail).toMatchObject({
      kind: 'lint',
      criterionKey: 'lint',
      code: 'verification_command_missing',
    });
    expect(
      h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_cycles WHERE kind = 'verification'").get(),
    ).toEqual({ n: 0 });
    expect(
      h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'verification'").get(),
    ).toEqual({
      n: 0,
    });
  });
});

describe('verification run queueing authority', () => {
  async function queued(definition = definitionWith(LINT)) {
    const h = harness({ definition });
    h.fx.db
      .prepare('UPDATE projects SET build_command_json = ?, test_command_json = ? WHERE id = ?')
      .run(JSON.stringify(BUILD_CMD), JSON.stringify(TEST_CMD), h.fx.projectId);
    await h.start();
    const created = createCycle(h.fx.db, {
      goalId: h.fx.goalId,
      kind: 'verification',
      triggerCode: 'evidence_refresh',
      milestoneKey: 'm1',
    });
    if (!created.created) throw new Error('cycle not created');
    const executor = new TuringGoalExecutor(h.fx.db, new UnroutedGoalRunPlanProvider());
    const request = (digests: string[]) => ({
      goalId: h.fx.goalId,
      cycleId: created.cycle.id,
      baseCommit: created.cycle.baseIntegrationCommit!,
      verifierDigests: digests,
    });
    return { h, executor, cycle: created.cycle, request };
  }

  it('queues only the requested deterministic verifiers, with no model stage, idempotently', async () => {
    const { h, executor, cycle, request } = await queued();
    const digests = [h.fx.digest('build'), h.fx.digest('tests')];
    const { runId } = await executor.queueVerificationRun(request(digests));
    const run = h.fx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown>;
    expect(run).toMatchObject({
      status: 'queued',
      goal_cycle_id: cycle.id,
      goal_run_purpose: 'verification',
      goal_base_commit: cycle.baseIntegrationCommit,
      workflow_id: 'goal-verification-v1',
    });
    const stages = h.fx.db
      .prepare('SELECT stage_key, kind FROM stages WHERE run_id = ? ORDER BY sequence')
      .all(runId);
    expect(stages).toEqual([
      { stage_key: `gv-${digests[0]}`, kind: 'build' },
      { stage_key: `gv-${digests[1]}`, kind: 'test' },
    ]);
    expect((await executor.queueVerificationRun(request(digests))).runId).toBe(runId);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
  });

  it('refuses a digest that is not a required deterministic verifier of the cycle milestone', async () => {
    const { h, executor, request } = await queued(definitionWith(LINT, COMMIT));
    await expect(executor.queueVerificationRun(request([h.fx.digest('commit')]))).rejects.toMatchObject({
      code: 'verification_invalid',
    });
    await expect(executor.queueVerificationRun(request(['f'.repeat(64)]))).rejects.toMatchObject({
      code: 'verification_invalid',
    });
    await expect(executor.queueVerificationRun(request([]))).rejects.toMatchObject({
      code: 'verification_invalid',
    });
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });

  it('launches nothing when a verifier cannot be materialised', async () => {
    const { h, executor, request } = await queued();
    await expect(executor.queueVerificationRun(request([h.fx.digest('lint')]))).rejects.toMatchObject({
      code: 'verification_unmaterializable',
    });
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });

  it('refuses a base that is not the cycle base commit', async () => {
    const { h, executor, request } = await queued();
    await expect(
      executor.queueVerificationRun({ ...request([h.fx.digest('build')]), baseCommit: 'a'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'base_commit_mismatch' });
  });
});

describe('verification cycles', () => {
  it('capture the head, take the verification path and never count as execution or remediation', async () => {
    const h = harness({ definition: definitionWith(LINT) });
    await h.start();
    const created = createCycle(h.fx.db, {
      goalId: h.fx.goalId,
      kind: 'verification',
      triggerCode: 'evidence_refresh',
      milestoneKey: 'm1',
    });
    if (!created.created) throw new Error('not created');
    expect(created.cycle).toMatchObject({
      kind: 'verification',
      status: 'planned',
      definitionVersion: 1,
      baseIntegrationCommit: h.fx.head(),
    });
    // One active cycle per Goal still holds.
    expect(
      createCycle(h.fx.db, {
        goalId: h.fx.goalId,
        kind: 'execution',
        triggerCode: 'next_task',
        milestoneKey: 'm1',
      }),
    ).toMatchObject({ created: false, reason: 'active_cycle_exists' });
    expect(() => transitionCycle(h.fx.db, { cycleId: created.cycle.id, to: 'proposing' })).toThrow();
    for (const to of ['launching', 'running', 'collecting'] as const)
      transitionCycle(h.fx.db, { cycleId: created.cycle.id, to });
    finalizeCycle(h.fx.db, {
      cycleId: created.cycle.id,
      to: 'failed',
      outcomeCode: 'verification_run_failed',
    });
    expect(computeCounters(h.fx.db, h.fx.goalId)).toEqual({
      cyclesExecuted: 0,
      consecutiveFailedCycles: 0,
      remediationAttempts: {},
    });
  });
});

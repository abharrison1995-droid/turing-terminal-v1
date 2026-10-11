import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalDefinition, SuccessCriterion } from '../../shared/goals.js';
import { computeCounters, createCycle, finalizeCycle, listCycles, transitionCycle } from './cycles.js';
import {
  beginAmendment,
  approveDefinition,
  editProposedDefinition,
  loadDefinitionVersion,
} from './definitions.js';
import { TuringGoalExecutor } from './turingExecutor.js';
import { UnroutedGoalRunPlanProvider } from './runPlan.js';
import { collectRunEvidence, listUncollectedRunIds } from './runEvidence.js';
import { listGoalEvents } from './events.js';
import { recordEvidence } from './evidence.js';
import { inspectRunRetention } from './retention.js';
import {
  BUILD,
  TESTS,
  cleanupRepoFixtures,
  milestone,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
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
  it(
    'binds exact subject evidence, writes the marker last, then prunes the worktree and keeps the branch',
    async () => {
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
      expect(events(h).slice(-3)).toEqual([
        'evidence_recorded',
        'evidence_recorded',
        'run_evidence_collected',
      ]);
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a non-zero command exit contradicts; timeouts, cancellation, skips and unmarked failures say nothing',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['cancelled', 'cancelled'],
    ['skipped', 'skipped'],
  ] as const)(
    'a %s stage yields no evidence and a zero-evidence marker',
    async (_name, status) => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'records nothing when the command that ran is not the verifier command, whatever the stage is called',
    async () => {
      const lintStageForBuild = (base: string, tree: string): StageSpec => ({
        key: 'goal-build',
        kind: 'build',
        status: 'passed',
        output: { command: ['npm', 'run', 'lint'], subjectTree: tree, subjectCommit: base },
      });
      const { h, runId } = await integrated({
        stages: ({ base, tree }) => [lintStageForBuild(base, tree)],
      });
      expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({
        status: 'collected',
        evidenceCount: 0,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a verification-style stage id is honoured only when digest, command and stage kind all agree',
    async () => {
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
      expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({
        status: 'collected',
        evidenceCount: 1,
      });
      expect(rows(h, runId)[0]).toMatchObject({ kind: 'build_result', verifier_digest: buildDigest });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'resumes after a crash between rows: reuses what exists, adds the rest, writes the marker once',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed on an invalid subject: nothing is marked and retention keeps refusing',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is eligible only for terminal repository runs of terminal cycles',
    async () => {
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
        h.fx.db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as {
          value: string;
        }
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('commit and artifact evidence', () => {
  const definition = () => definitionWith(COMMIT, FILE);

  it(
    'records commit and file evidence only from an integrated cycle, bound to the exact commit',
    async () => {
      const { h, runId, cycleId } = await integrated({ definition: definition() });
      const result = (
        h.fx.db
          .prepare('SELECT result_integration_commit AS c FROM goal_cycles WHERE id = ?')
          .get(cycleId) as {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fabricates no file evidence once the Goal head has moved past the cycle result, but keeps the commit',
    async () => {
      const { h, runId } = await integrated({ definition: definition() });
      h.fx.advance({ 'src/other.ts': 'export const o = 1;\n' }, 'moved');
      expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({ evidenceCount: 1 });
      expect(rows(h, runId).map((row) => row.kind)).toEqual(['commit']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'records neither for a failed execution cycle',
    async () => {
      const h = harness({ definition: definition() });
      h.files.current = { 'docs/x.md': 'outside scope\n' };
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await h.start();
      await h.until('waiting_for_run');
      const runId = h.runs()[0]!.id;
      h.setRunStatus(runId, 'completed');
      await h.until('cycle_failed');
      expect(await collectRunEvidence(h.fx.db, runId)).toMatchObject({
        status: 'collected',
        evidenceCount: 0,
      });
      expect(rows(h, runId)).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('evidence maintenance', () => {
  it(
    'extracts a needs_user Goal run without resuming it',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'collects one run per action before the next execution cycle',
    async () => {
      const { h, runId } = await integrated();
      const actions: string[] = [];
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      for (let index = 0; index < 2; index++) actions.push(await h.tick());
      expect(actions).toEqual(['evidence_collected', 'cycle_created']);
      expect(markers(h, runId)).toHaveLength(1);
      expect(existsSync(h.fx.repo)).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('verification scheduling without a verification-capable executor', () => {
  it(
    'never schedules a verification cycle for an executor that cannot queue one',
    async () => {
      const { h } = await integrated({ definition: definitionWith(LINT) });
      expect(await h.tick()).toBe('evidence_collected');
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      expect(await h.tick()).toBe('cycle_created');
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_cycles WHERE kind = 'verification'").get(),
      ).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'hands the Goal to the user, launching nothing, when a verifier cannot be materialised',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
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

  it(
    'queues only the requested deterministic verifiers, with no model stage, idempotently',
    async () => {
      const { h, executor, cycle, request } = await queued();
      const digests = [h.fx.digest('build'), h.fx.digest('tests')];
      transitionCycle(h.fx.db, { cycleId: cycle.id, to: 'launching', outcome: { verifierDigests: digests } });
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a digest that is not a required deterministic verifier of the cycle milestone',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'launches nothing when a verifier cannot be materialised',
    async () => {
      const { h, executor, cycle, request } = await queued();
      transitionCycle(h.fx.db, {
        cycleId: cycle.id,
        to: 'launching',
        outcome: { verifierDigests: [h.fx.digest('lint')] },
      });
      await expect(executor.queueVerificationRun(request([h.fx.digest('lint')]))).rejects.toMatchObject({
        code: 'verification_unmaterializable',
      });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a base that is not the cycle base commit',
    async () => {
      const { h, executor, request } = await queued();
      await expect(
        executor.queueVerificationRun({ ...request([h.fx.digest('build')]), baseCommit: 'a'.repeat(40) }),
      ).rejects.toMatchObject({ code: 'base_commit_mismatch' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('verification cycles', () => {
  it(
    'capture the head, take the verification path and never count as execution or remediation',
    async () => {
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

// --- Stage 4B.3 hardening ---------------------------------------------------------------------------------------------

const BAD_SUBJECT = (base: string): StageSpec[] => [
  {
    key: 'goal-build',
    kind: 'build',
    status: 'passed',
    output: { command: BUILD_CMD, subjectTree: 'a'.repeat(40), subjectCommit: base },
  },
];
const countOf = (h: Harness, sql: string) => (h.fx.db.prepare(sql).get() as { n: number }).n;
const goalRef = (h: Harness) => `refs/heads/turing/goal/${h.fx.goalId}`;

describe('evidence collection is fail-closed after any number of failures', () => {
  it(
    'never lets a collector failure authorise the next cycle, across passes and restarts',
    async () => {
      const { h, runId, base, tree, stageIds } = await integrated({
        stages: ({ base }) => BAD_SUBJECT(base),
      });
      const verify = vi.fn(async () => ({ runId: 'never' }));
      h.executor.queueVerificationRun = verify;
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      const snapshot = () => ({
        cycles: countOf(h, 'SELECT COUNT(*) AS n FROM goal_cycles'),
        runs: countOf(h, 'SELECT COUNT(*) AS n FROM runs'),
        starts: h.startRun.mock.calls.length,
        queues: h.executor.queueCalls.length + h.executor.proposalQueueCalls.length,
        verify: verify.mock.calls.length,
        modelCalls: h.model.calls,
        ref: h.fx.git('rev-parse', goalRef(h)),
        markers: markers(h, runId).length,
      });
      const before = snapshot();
      expect(before.markers).toBe(0);
      for (let pass = 0; pass < 6; pass++) {
        // Passes 2 and 4 run on a restarted supervisor and executor: a restart grants no authority to continue.
        let supervisor = h.supervisor;
        if (pass === 2 || pass === 4) {
          const fresh = h.restart();
          fresh.executor.queueVerificationRun = verify;
          supervisor = fresh.supervisor;
        }
        const result = pass === 5 ? (await supervisor.runOnce())[0]! : await supervisor.tickGoal(h.fx.goalId);
        expect(result).toMatchObject({ action: 'evidence_collection_error', runId });
        expect(snapshot()).toEqual(before);
        expect(h.status()).toEqual({ status: 'running', reason: expect.anything() });
      }
      // Remove the failure: the next pass collects and marks, and does nothing else.
      h.fx.db
        .prepare('UPDATE stages SET output_json = ? WHERE id = ?')
        .run(JSON.stringify({ command: BUILD_CMD, subjectTree: tree, subjectCommit: base }), stageIds[0]);
      const fixed = await h.supervisor.tickGoal(h.fx.goalId);
      expect(fixed).toMatchObject({ action: 'evidence_collected', runId });
      expect(markers(h, runId)).toHaveLength(1);
      expect(countOf(h, 'SELECT COUNT(*) AS n FROM goal_cycles')).toBe(before.cycles);
      // Only a later tick may progress.
      expect(await h.tick()).toBe('cycle_created');
      expect(countOf(h, 'SELECT COUNT(*) AS n FROM goal_cycles')).toBe(before.cycles + 1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps retrying a non-running Goal in bounded passes without resuming it or changing its status',
    async () => {
      const h = harness();
      h.files.current = { 'docs/x.md': 'outside scope\n' };
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await h.start();
      await h.until('waiting_for_run');
      const runId = h.runs()[0]!.id;
      h.fx.db.exec(
        "CREATE TRIGGER inject_marker_failure BEFORE INSERT ON goal_events WHEN NEW.type = 'run_evidence_collected' BEGIN SELECT RAISE(ABORT, 'injected'); END",
      );
      h.setRunStatus(runId, 'completed');
      await h.until('cycle_failed');
      const state = h.status();
      expect(state).toEqual({ status: 'needs_user', reason: 'scope_violation' });
      for (let pass = 0; pass < 5; pass++) {
        expect(await h.supervisor.maintainEvidence()).toMatchObject([
          { action: 'evidence_collection_error', runId },
        ]);
        expect(markers(h, runId)).toHaveLength(0);
        expect(h.status()).toEqual(state);
      }
      h.fx.db.exec('DROP TRIGGER inject_marker_failure');
      expect(await h.supervisor.maintainEvidence()).toMatchObject([{ action: 'evidence_collected', runId }]);
      expect(h.status()).toEqual(state);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('verification loop guard is per definition, milestone, head and verifier digest', () => {
  const TWO = () =>
    simpleDefinition({ milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])] });

  async function ready(definition = definitionWith()) {
    const ctx = await integrated({ definition });
    ctx.h.executor.queueVerificationRun = async () => {
      throw new Error('no run in this test');
    };
    expect(await ctx.h.tick()).toBe('evidence_collected');
    return ctx;
  }
  const digestsOf = (h: Harness, cycleId: string): string[] | undefined =>
    (
      JSON.parse(
        (
          h.fx.db.prepare('SELECT outcome_json FROM goal_cycles WHERE id = ?').get(cycleId) as {
            outcome_json: string;
          }
        ).outcome_json,
      ) as { verifierDigests?: string[] }
    ).verifierDigests;
  const verifications = (h: Harness) =>
    listCycles(h.fx.db, h.fx.goalId).filter((c) => c.kind === 'verification');

  it(
    'keeps the sorted digest set through every terminal outcome and does not re-run the same verifier at the head',
    async () => {
      const { h } = await ready();
      expect(await h.tick()).toBe('cycle_created');
      const [cycle] = verifications(h);
      const expected = [h.fx.digest('build'), h.fx.digest('tests')].sort();
      expect(cycle!.status).toBe('launching');
      expect(digestsOf(h, cycle!.id)).toEqual(expected);
      // The queue throws: a launch error terminalises the cycle and must keep the set.
      expect(await h.tick()).toBe('cycle_failed');
      const failed = verifications(h)[0]!;
      expect(failed).toMatchObject({
        status: 'failed',
        definitionVersion: 1,
        baseIntegrationCommit: h.fx.head(),
      });
      expect(failed.outcome).toMatchObject({ code: 'launch_error', verifierDigests: expected });
      // Same definition, milestone, head and digests: not automatically re-run.
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      expect(await h.tick()).toBe('cycle_created');
      expect(listCycles(h.fx.db, h.fx.goalId).at(-1)!.kind).toBe('execution');
      expect(verifications(h)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'keeps the trusted digest set when the cycle ends %s, even if the terminal write supplies another',
    async (to) => {
      const { h } = await ready();
      expect(await h.tick()).toBe('cycle_created');
      const cycle = verifications(h)[0]!;
      const expected = [h.fx.digest('build'), h.fx.digest('tests')].sort();
      if (to === 'succeeded') {
        transitionCycle(h.fx.db, { cycleId: cycle.id, to: 'running' });
        transitionCycle(h.fx.db, { cycleId: cycle.id, to: 'collecting' });
      }
      finalizeCycle(h.fx.db, {
        cycleId: cycle.id,
        to,
        outcomeCode: 'whatever',
        detail: { verifierDigests: ['not-a-digest'] },
      });
      expect(digestsOf(h, cycle.id)).toEqual(expected);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'keeps the persisted set when the cycle ends %s and the terminal write supplies a valid different set',
    async (to) => {
      const { h } = await ready();
      expect(await h.tick()).toBe('cycle_created');
      const cycle = verifications(h)[0]!;
      const expected = [h.fx.digest('build'), h.fx.digest('tests')].sort();
      if (to === 'succeeded') {
        transitionCycle(h.fx.db, { cycleId: cycle.id, to: 'running' });
        transitionCycle(h.fx.db, { cycleId: cycle.id, to: 'collecting' });
      }
      finalizeCycle(h.fx.db, {
        cycleId: cycle.id,
        to,
        outcomeCode: 'whatever',
        detail: { verifierDigests: ['c'.repeat(64)] },
      });
      expect(digestsOf(h, cycle.id)).toEqual(expected);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'freezes the verifier set at its first valid write across non-terminal transitions',
    async () => {
      const h = harness({ definition: definitionWith(LINT) });
      await h.start();
      const created = createCycle(h.fx.db, {
        goalId: h.fx.goalId,
        kind: 'verification',
        triggerCode: 'evidence_refresh',
        milestoneKey: 'm1',
      });
      if (!created.created) throw new Error('not created');
      const id = created.cycle.id;
      const A = 'a'.repeat(64);
      const B = 'b'.repeat(64);
      const C = 'c'.repeat(64);
      transitionCycle(h.fx.db, { cycleId: id, to: 'launching', outcome: { verifierDigests: [B, A, A] } });
      expect(digestsOf(h, id)).toEqual([A, B]);
      transitionCycle(h.fx.db, { cycleId: id, to: 'running', outcome: { verifierDigests: [C] } });
      expect(digestsOf(h, id)).toEqual([A, B]);
      transitionCycle(h.fx.db, { cycleId: id, to: 'collecting', outcome: { verifierDigests: ['bad'] } });
      expect(digestsOf(h, id)).toEqual([A, B]);
      finalizeCycle(h.fx.db, {
        cycleId: id,
        to: 'failed',
        outcomeCode: 'x',
        detail: { verifierDigests: [B, A, A, C] },
      });
      expect(digestsOf(h, id)).toEqual([A, B]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not let a historical verification row without a trustworthy digest list suppress anything',
    async () => {
      const { h } = await ready();
      const head = h.fx.head();
      const milestoneId = h.fx.milestoneId('m1');
      const insert = (sequence: number, outcome: string | null) =>
        h.fx.db
          .prepare(
            `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status, base_integration_commit, outcome_json, created_at)
           VALUES (?, ?, 1, ?, ?, 'verification', 'evidence_refresh', 'failed', ?, ?, '2026-01-01T00:00:00.000Z')`,
          )
          .run(randomUUID(), h.fx.goalId, milestoneId, sequence, head, outcome);
      insert(100, null);
      insert(101, JSON.stringify({ code: 'verified' }));
      insert(102, JSON.stringify({ verifierDigests: ['nothex', 'f'.repeat(64)] }));
      insert(103, JSON.stringify({ verifierDigests: [] }));
      expect(await h.tick()).toBe('cycle_created');
      const newest = listCycles(h.fx.db, h.fx.goalId).at(-1)!;
      expect(newest).toMatchObject({ kind: 'verification', status: 'launching' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'suppresses only the digests actually attempted: [A,B] attempted, [A,C] needed schedules C alone',
    async () => {
      const definition = definitionWith(LINT);
      const { h } = await ready(definition);
      h.fx.db
        .prepare('UPDATE projects SET lint_command_json = ? WHERE id = ?')
        .run(JSON.stringify(['npm', 'run', 'lint']), h.fx.projectId);
      const head = h.fx.head();
      h.fx.db
        .prepare(
          `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status, base_integration_commit, outcome_json, created_at)
         VALUES (?, ?, 1, ?, 100, 'verification', 'evidence_refresh', 'failed', ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .run(
          randomUUID(),
          h.fx.goalId,
          h.fx.milestoneId('m1'),
          head,
          JSON.stringify({ verifierDigests: [h.fx.digest('build'), h.fx.digest('tests')] }),
        );
      expect(await h.tick()).toBe('cycle_created');
      const newest = listCycles(h.fx.db, h.fx.goalId).at(-1)!;
      expect(newest.kind).toBe('verification');
      expect(digestsOf(h, newest.id)).toEqual([h.fx.digest('lint')]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "does not let another milestone's attempt at the same head suppress this milestone",
    async () => {
      const { h } = await ready(TWO());
      h.fx.db
        .prepare(
          `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status, base_integration_commit, outcome_json, created_at)
         VALUES (?, ?, 1, ?, 100, 'verification', 'evidence_refresh', 'failed', ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .run(
          randomUUID(),
          h.fx.goalId,
          h.fx.milestoneId('m2'),
          h.fx.head(),
          JSON.stringify({ verifierDigests: [h.fx.digest('build')] }),
        );
      expect(await h.tick()).toBe('cycle_created');
      const newest = listCycles(h.fx.db, h.fx.goalId).at(-1)!;
      expect(newest).toMatchObject({ kind: 'verification', milestoneKey: 'm1' });
      expect(digestsOf(h, newest.id)).toEqual([h.fx.digest('build')]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'lets an approved amendment verify its new verifier at the same head',
    async () => {
      const { h } = await ready();
      const head = h.fx.head();
      expect(await h.tick()).toBe('cycle_created');
      expect(await h.tick()).toBe('cycle_failed');
      const oldDigest = h.fx.digest('tests');
      // The old attempt at this head is spent: the next work is an execution that violates scope.
      h.files.current = { 'docs/x.md': 'outside scope\n' };
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      expect(await h.tick()).toBe('cycle_created');
      await h.until('waiting_for_run');
      const workRun = h.runs().at(-1)!;
      h.setRunStatus(workRun.id, 'completed');
      await h.until('cycle_failed');
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'scope_violation' });
      expect(h.fx.head()).toBe(head);

      const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
      const edited = structuredClone(loadDefinitionVersion(h.fx.db, h.fx.goalId, 1)!.definition);
      const testCriterion = edited.contract.successCriteria.find((c) => c.key === 'tests')!;
      testCriterion.verification = [{ kind: 'test', command: ['npm', 'run', 'test'] }];
      editProposedDefinition(h.fx.db, { goalId: h.fx.goalId, version, definition: edited });
      approveDefinition(h.fx.db, { goalId: h.fx.goalId, version, actor: 'user' });
      expect(
        await h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'amendment_approved' }),
      ).toEqual({
        ok: true,
      });
      const newDigest = verifierDigest('tests', { kind: 'test', command: ['npm', 'run', 'test'] });
      expect(newDigest).not.toBe(oldDigest);
      // Drain evidence maintenance, then the amended definition must schedule a verification at the same head.
      let created: ReturnType<typeof listCycles>[number] | undefined;
      for (let index = 0; index < 6 && !created; index++) {
        await h.tick();
        created = verifications(h).find((cycle) => cycle.definitionVersion === 2);
      }
      expect(created).toBeDefined();
      expect(created).toMatchObject({ baseIntegrationCommit: head, definitionVersion: 2 });
      expect(digestsOf(h, created!.id)).toContain(newDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

async function queuedVerification() {
  const h = harness({ definition: definitionWith(LINT) });
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

describe("a verification run needs the cycle's persisted verifier set", () => {
  it(
    'refuses to queue without, with a corrupt, or with a different persisted set; queues with the exact set',
    async () => {
      const { h, executor, cycle, request } = await queuedVerification();
      const A = h.fx.digest('build');
      const B = h.fx.digest('tests');
      const runs = () => countOf(h, 'SELECT COUNT(*) AS n FROM runs');
      const setOutcome = (outcome: unknown) =>
        h.fx.db
          .prepare('UPDATE goal_cycles SET outcome_json = ? WHERE id = ?')
          .run(outcome === null ? null : JSON.stringify(outcome), cycle.id);
      // none
      await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
        code: 'verification_inputs_mismatch',
      });
      // corrupt
      for (const bad of [
        { verifierDigests: ['nothex'] },
        { verifierDigests: [] },
        { code: 'x' },
        { verifierDigests: 'ab' },
      ]) {
        setOutcome(bad);
        await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
          code: 'verification_inputs_mismatch',
        });
      }
      // different
      setOutcome({ verifierDigests: [A] });
      await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
        code: 'verification_inputs_mismatch',
      });
      expect(runs()).toBe(0);
      // exact
      setOutcome({ verifierDigests: [A, B].sort() });
      const { runId } = await executor.queueVerificationRun(request([B, A]));
      expect(runs()).toBe(1);
      // the existing run is refused once the set is removed or corrupted, and no second run appears
      for (const bad of [null, { code: 'x' }, { verifierDigests: ['nothex'] }, { verifierDigests: [] }]) {
        setOutcome(bad);
        await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
          code: 'verification_inputs_mismatch',
        });
      }
      expect(runs()).toBe(1);
      setOutcome({ verifierDigests: [A, B].sort() });
      expect((await executor.queueVerificationRun(request([A, B]))).runId).toBe(runId);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('verification run fast path re-proves its inputs', () => {
  async function ctx() {
    const { h, executor, cycle, request } = await queuedVerification();
    const A = h.fx.digest('build');
    const B = h.fx.digest('tests');
    const set = [B, A];
    transitionCycle(h.fx.db, { cycleId: cycle.id, to: 'launching', outcome: { verifierDigests: set } });
    return { h, executor, cycle, request, A, B };
  }

  it(
    'returns the same run for the same set (any order, new executor) and refuses every other set',
    async () => {
      const { h, executor, request, A, B } = await ctx();
      const { runId } = await executor.queueVerificationRun(request([A, B]));
      const restarted = new TuringGoalExecutor(h.fx.db, new UnroutedGoalRunPlanProvider());
      expect((await restarted.queueVerificationRun(request([A, B]))).runId).toBe(runId);
      expect((await restarted.queueVerificationRun(request([B, A]))).runId).toBe(runId);
      expect((await restarted.queueVerificationRun(request([B, A, A]))).runId).toBe(runId);
      for (const bad of [[A], [A, h.fx.digest('lint')], [A, B, 'f'.repeat(64)], []])
        await expect(restarted.queueVerificationRun(request(bad))).rejects.toMatchObject({
          code: expect.stringMatching(/^verification_/),
        });
      await expect(restarted.queueVerificationRun(request([A]))).rejects.toMatchObject({
        code: 'verification_inputs_mismatch',
      });
      expect(countOf(h, 'SELECT COUNT(*) AS n FROM runs')).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a tampered persisted verifier set or tampered run stage keys, creating nothing',
    async () => {
      const { h, executor, cycle, request, A, B } = await ctx();
      const { runId } = await executor.queueVerificationRun(request([A, B]));
      h.fx.db
        .prepare('UPDATE goal_cycles SET outcome_json = ? WHERE id = ?')
        .run(JSON.stringify({ verifierDigests: [A] }), cycle.id);
      await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
        code: 'verification_inputs_mismatch',
      });
      h.fx.db
        .prepare('UPDATE goal_cycles SET outcome_json = ? WHERE id = ?')
        .run(JSON.stringify({ verifierDigests: [A, B].sort() }), cycle.id);
      expect((await executor.queueVerificationRun(request([A, B]))).runId).toBe(runId);
      h.fx.db
        .prepare('UPDATE stages SET stage_key = ? WHERE run_id = ? AND stage_key = ?')
        .run(`gv-${'0'.repeat(64)}`, runId, `gv-${B}`);
      await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
        code: 'verification_run_inconsistent',
      });
      h.fx.db
        .prepare("UPDATE stages SET stage_key = 'goal-build' WHERE run_id = ? AND stage_key = ?")
        .run(runId, `gv-${A}`);
      await expect(executor.queueVerificationRun(request([A, B]))).rejects.toMatchObject({
        code: 'verification_run_inconsistent',
      });
      expect(countOf(h, 'SELECT COUNT(*) AS n FROM runs')).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

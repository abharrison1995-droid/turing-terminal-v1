import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';
import type { GoalDefinition } from '../../shared/goals.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in Goal run tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider, type ProviderRunRequest } from '../providers.js';
import { evaluateCriteria } from './freshness.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';
import {
  BUILD,
  cleanupRepoFixtures,
  milestone,
  passDeterministic,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { GOOD_TASK } from './supervisorKit.js';
import { realRunHarness, type RealRunHarness } from './turingRunKit.js';
import { verifierDigest } from './verifierDigest.js';

const caps: ProviderCapabilities = {
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery: false,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: true,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
};
const claude = (): ProviderStatus => ({
  id: 'claude-code',
  name: 'Claude Code',
  cli: 'claude',
  detected: true,
  version: '2.1.300',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
});
const done = (text: string) => ({
  text,
  inputTokens: 10,
  outputTokens: 5,
  usageProvenance: 'provider_reported' as const,
  exitCode: 0,
  stdout: 'ok',
});

const TEST_CMD = ['npm', 'run', 'test'];
const LINT_CMD = ['npm', 'run', 'lint'];

let h: RealRunHarness;
let calls: ProviderRunRequest[];
let packageJson: Record<string, string>;

/** Explicit test and lint commands; the project has no default test command, so both run as shell commands. */
const definition = (): GoalDefinition =>
  simpleDefinition({
    criteria: [
      structuredClone(BUILD),
      {
        key: 'tests',
        statement: 'Tests pass',
        verification: [{ kind: 'test', command: TEST_CMD }],
        required: true,
      },
      { key: 'lint', statement: 'Lint is clean', verification: [{ kind: 'lint' }], required: true },
    ],
    milestones: [
      milestone('m1', ['build', 'tests', 'lint'], {
        allowedScope: { includeGlobs: ['src/**', 'package.json'], excludeGlobs: [] },
      }),
    ],
  });

beforeEach(() => {
  calls = [];
  packageJson = { build: `node -e "console.log('build-ok')"`, test: `node -e "0"`, lint: `node -e "0"` };
  vi.mocked(discoverProviders).mockResolvedValue([claude()]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    calls.push(request);
    if (request.role !== 'implementer')
      return done(JSON.stringify({ ...GOOD_TASK, targetCriteria: ['build'] }));
    for (const [path, content] of [
      ['src/a.ts', 'export const a = 1;\n'],
      ['package.json', JSON.stringify({ scripts: packageJson })],
    ] as const) {
      const written = await h.broker(request.toolBroker.token, 'write_file', { path, content });
      expect(written.error).toBeUndefined();
    }
    return done('Implemented.');
  });
});

afterEach(async () => {
  await h?.close();
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

const verificationCycles = () =>
  h.fx.db.prepare("SELECT * FROM goal_cycles WHERE kind = 'verification' ORDER BY sequence").all() as Array<
    Record<string, unknown>
  >;
const evidenceFor = (key: string) =>
  h.fx.db.prepare('SELECT * FROM goal_evidence WHERE criterion_key = ? ORDER BY rowid').all(key) as Array<
    Record<string, unknown>
  >;
const states = async () => {
  const resolved = await resolveGoalRepository(h.fx.db, h.fx.goalId);
  if (!resolved.ok) throw new Error('repository unavailable');
  const result = await evaluateCriteria(
    h.fx.db,
    h.fx.goalId,
    h.fx.definition,
    createRepositoryReader(resolved.state),
  );
  return Object.fromEntries(result.map((criterion) => [criterion.key, criterion.state]));
};

async function reachExecutionEvidence() {
  h = await realRunHarness({ definition: definition() });
  h.fx.db
    .prepare('UPDATE projects SET test_command_json = NULL, lint_command_json = ? WHERE id = ?')
    .run(JSON.stringify(LINT_CMD), h.fx.projectId);
  h.fx.advance({ 'package.json': JSON.stringify({ scripts: packageJson }) }, 'scripts');
  await passDeterministic(h.fx); // evidence at tree A (the base)
  const treeA = h.fx.tree();
  expect(await states()).toMatchObject({ build: 'satisfied', tests: 'satisfied' });
  const started = await h.supervisor.startGoal(h.fx.goalId);
  expect(started.ok).toBe(true);
  await h.until('cycle_succeeded'); // execution integrated tree B
  const treeB = h.fx.tree();
  expect(treeB).not.toBe(treeA);
  await h.until('evidence_collected');
  return { treeA, treeB };
}

describe('Goal verification on the real RunEngine', () => {
  it(
    'repairs staleness after an integration: tree A evidence goes stale, verification at B makes it current',
    async () => {
      const { treeA, treeB } = await reachExecutionEvidence();
      // Execution evidence covers the native build at B; the explicit test command and lint have none at B.
      expect(await states()).toMatchObject({ build: 'satisfied', tests: 'stale', lint: 'missing' });
      expect(evidenceFor('tests').map((row) => row.subject_tree)).toEqual([treeA]);
      const providerCallsBefore = calls.length;

      expect(await h.tick()).toBe('cycle_created');
      const [cycle] = verificationCycles();
      expect(cycle).toMatchObject({
        kind: 'verification',
        trigger_code: 'evidence_refresh',
        definition_version: 1,
        milestone_id: h.fx.milestoneId('m1'),
        base_integration_commit: h.fx.head(),
        status: 'launching',
      });
      await h.until('cycle_succeeded');
      const finished = verificationCycles()[0]!;
      expect(finished).toMatchObject({ status: 'succeeded', result_integration_commit: null });

      const run = h.fx.db
        .prepare("SELECT * FROM runs WHERE goal_run_purpose = 'verification'")
        .get() as Record<string, unknown>;
      expect(run).toMatchObject({
        goal_cycle_id: cycle!.id,
        goal_base_commit: h.fx.head(),
        workflow_id: 'goal-verification-v1',
        status: 'completed',
      });
      const testDigest = verifierDigest('tests', { kind: 'test', command: TEST_CMD });
      const lintDigest = verifierDigest('lint', { kind: 'lint' });
      const stages = h.fx.db
        .prepare('SELECT stage_key, kind, status FROM stages WHERE run_id = ? ORDER BY sequence')
        .all(run.id) as Array<{ stage_key: string; kind: string; status: string }>;
      expect(stages).toEqual([
        { stage_key: `gv-${testDigest}`, kind: 'shellCommand', status: 'passed' },
        { stage_key: `gv-${lintDigest}`, kind: 'shellCommand', status: 'passed' },
      ]);
      // No model, no route, no provider call, no usage: a deterministic workflow only.
      expect(calls).toHaveLength(providerCallsBefore);
      const usage = h.fx.db
        .prepare(
          'SELECT workload_type, provider_id, model_id, billing_lane FROM usage_events WHERE run_id = ?',
        )
        .all(run.id);
      expect(usage).toEqual([
        { workload_type: 'deterministic', provider_id: null, model_id: null, billing_lane: null },
        { workload_type: 'deterministic', provider_id: null, model_id: null, billing_lane: null },
      ]);
      // It never counts against the execution bound.
      expect(
        h.fx.db.prepare('SELECT cycles_executed FROM goal_runtime WHERE goal_id = ?').get(h.fx.goalId),
      ).toEqual({
        cycles_executed: 1,
      });

      // Evidence maintenance records the results bound to tree B, marks the run, and prunes its worktree.
      const collected = await h.supervisor.tickGoal(h.fx.goalId);
      expect(collected).toMatchObject({ action: 'evidence_collected', runId: run.id, evidenceCount: 2 });
      const tests = evidenceFor('tests');
      expect(tests.at(-1)).toMatchObject({
        kind: 'test_result',
        verdict: 'satisfies',
        subject_tree: treeB,
        subject_commit: h.fx.head(),
        run_id: run.id,
        cycle_id: cycle!.id,
      });
      expect(evidenceFor('lint')[0]).toMatchObject({
        kind: 'lint_result',
        verdict: 'satisfies',
        subject_tree: treeB,
      });
      expect(await states()).toMatchObject({ build: 'satisfied', tests: 'satisfied', lint: 'satisfied' });
      expect(h.runRow(run.id as string).worktree_path).toBeNull();
      expect(h.fx.git('rev-parse', '--verify', `refs/heads/${run.branch as string}`)).toMatch(
        /^[0-9a-f]{40}$/,
      );
      expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).toEqual({
        status: 'running',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a failing verifier records a current contradiction and does not trigger another verification cycle',
    async () => {
      packageJson.test = `node -e "process.exit(1)"`;
      const { treeB } = await reachExecutionEvidence();
      expect(await h.tick()).toBe('cycle_created');
      await h.until('cycle_succeeded');
      const run = h.fx.db.prepare("SELECT id FROM runs WHERE goal_run_purpose = 'verification'").get() as {
        id: string;
      };
      const failed = h.fx.db
        .prepare(
          "SELECT status, output_json FROM stages WHERE run_id = ? AND stage_key LIKE 'gv-%' ORDER BY sequence",
        )
        .all(run.id) as Array<{ status: string; output_json: string }>;
      expect(failed[0]!.status).toBe('failed');
      expect(JSON.parse(failed[0]!.output_json)).toMatchObject({
        command: TEST_CMD,
        subjectTree: treeB,
        subjectCommit: h.fx.head(),
        failureKind: 'command_exit',
        exitCode: 1,
      });
      // The next verifier still ran and passed.
      expect(failed[1]!.status).toBe('passed');

      expect(await h.tick()).toBe('evidence_collected');
      expect(evidenceFor('tests').at(-1)).toMatchObject({
        verdict: 'contradicts',
        subject_tree: treeB,
        run_id: run.id,
      });
      expect(await states()).toMatchObject({ tests: 'contradicted', lint: 'satisfied' });
      // The contradiction is fresh: no second verification cycle, the Goal is not handed to the user.
      const next = await h.supervisor.tickGoal(h.fx.goalId);
      expect(next.action).toBe('cycle_created');
      expect(h.fx.db.prepare('SELECT kind FROM goal_cycles ORDER BY sequence DESC LIMIT 1').get()).toEqual({
        kind: 'execution',
      });
      expect(verificationCycles()).toHaveLength(1);
      expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).toEqual({
        status: 'running',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('failed deterministic stages keep their command and subject', () => {
  it(
    'records command, subject tree/commit and failure kind on a failed build; the run still fails',
    async () => {
      h = await realRunHarness();
      vi.mocked(executeProvider).mockImplementation(async (request) => {
        calls.push(request);
        if (request.role !== 'implementer') return done(JSON.stringify(GOOD_TASK));
        for (const [path, content] of [
          [
            'package.json',
            JSON.stringify({ scripts: { build: 'node -e "process.exit(3)"', test: 'node -e "0"' } }),
          ],
          ['src/a.ts', 'export const a = 1;\n'],
        ] as const)
          await h.broker(request.toolBroker.token, 'write_file', { path, content });
        return done('Implemented.');
      });
      const started = await h.supervisor.startGoal(h.fx.goalId);
      expect(started.ok).toBe(true);
      await h.until('cycle_failed');
      const run = h.fx.db
        .prepare("SELECT id, status FROM runs WHERE goal_run_purpose = 'execution'")
        .get() as {
        id: string;
        status: string;
      };
      expect(run.status).toBe('failed');
      const stage = h.fx.db
        .prepare("SELECT status, output_json FROM stages WHERE run_id = ? AND stage_key = 'goal-build'")
        .get(run.id) as { status: string; output_json: string };
      expect(stage.status).toBe('failed');
      const output = JSON.parse(stage.output_json) as Record<string, string>;
      expect(output).toMatchObject({
        command: ['npm', 'run', 'build'],
        failureKind: 'command_exit',
        exitCode: 3,
      });
      expect(output.subjectTree).toMatch(/^[0-9a-f]{40}$/);
      expect(output.subjectCommit).toBe(h.baseCommit);
      expect(output.error).toEqual(expect.any(String));
      // The failed stage contradicts the build verifier at exactly that subject.
      expect(await h.tick()).toBe('evidence_collected');
      expect(evidenceFor('build')).toMatchObject([
        { kind: 'build_result', verdict: 'contradicts', subject_tree: output.subjectTree, run_id: run.id },
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

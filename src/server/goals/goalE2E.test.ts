import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalDefinition, GoalRole, RouteMember } from '../../shared/goals.js';
import type { GoalManualHandoffProjection } from '../../shared/goalApi.js';
import type { ProviderCapabilities, ProviderStatus, WorkflowDefinition } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Live provider calls are disabled in Goal acceptance tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider } from '../providers.js';
import type { ProviderRunRequest } from '../providers.js';
import { preflightFinalApply } from '../goalGit.js';
import { buildPreview, createRun } from '../runLauncher.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { approveDefinition, beginAmendment, createGoalDraft } from './definitions.js';
import {
  computeFinalApplyIntentDigest,
  prepareFinalApplyIntent,
  requestFinalApplyApproval,
  validateFinalApplyAuthority,
} from './finalApplyAuthority.js';
import { getManualHandoffProjection, validateManualHandoff } from './manualHandoff.js';
import {
  cleanupRepoFixtures,
  milestone,
  reportOf,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { passRecords } from './routingKit.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { readStoredResolutions } from './routeResolution.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import { type RealRunHarness, realRunHarness } from './turingRunKit.js';

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

const fakeClaude: ProviderStatus = {
  id: 'claude-code',
  name: 'Claude Code fixture',
  cli: 'fake-provider-test-adapter',
  detected: true,
  version: 'fixture',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test-fixture',
  note: 'Deterministic test identity; no provider process is launched.',
  checkedAt: '2026-10-09T00:00:00.000Z',
  capabilities: caps,
  models: [],
};

const fakeDone = (text: string) => ({
  text,
  inputTokens: null,
  outputTokens: null,
  usageProvenance: 'unavailable' as const,
  exitCode: 0,
  stdout: 'deterministic fixture response',
});

const member = (modelId: string): RouteMember => ({
  configuration: {
    backendId: 'claude-code',
    providerId: 'anthropic-subscription',
    billingLane: 'claude-subscription',
    modelId,
  },
  identityKind: 'pinned',
  freshnessClass: 'stable-subscription',
});

const pinned = (modelId: string) => ({
  kind: 'pinned' as const,
  member: member(modelId),
  availability: 'fresh-validation' as const,
  requireRoleValidation: true,
});

function goldenDefinition(finalReviewerModel = 'gpt-5.5'): GoalDefinition {
  const definition = simpleDefinition({
    criteria: [
      {
        key: 'build',
        statement: 'The utility parses as valid JavaScript.',
        verification: [{ kind: 'build', command: ['npm', 'run', 'build'] }],
        required: true,
      },
      {
        key: 'tests',
        statement: 'The utility test passes.',
        verification: [{ kind: 'test' }],
        required: true,
      },
    ],
    milestones: [
      milestone('m1', ['build', 'tests'], {
        allowedScope: { includeGlobs: ['src/**'], excludeGlobs: [] },
      }),
    ],
    policy: {
      requireFinalReview: true,
      requireUserAcceptance: true,
      applyToBase: 'required',
    },
    gates: { finalAcceptance: true },
  });
  definition.routing.roles.orchestrator = pinned('claude-sonnet-5-5');
  definition.routing.roles.implementer = pinned('claude-opus-5-5');
  // This explicit fake identity belongs to a different known family from the implementer.
  definition.routing.roles.final_reviewer = pinned(finalReviewerModel);
  return definition;
}

const proposal = {
  milestoneKey: 'm1',
  title: 'Add the add utility and its test',
  instructions: 'Create src/add.js exporting add(a, b), plus a node:test test in src/add.test.js.',
  targetCriteria: ['build', 'tests'],
  expectedPaths: ['src/add.js', 'src/add.test.js'],
  rationale: 'This small change is objectively checked by the registered build and test commands.',
};

const report = reportOf();

let h: RealRunHarness | undefined;
let providerCalls: ProviderRunRequest[];
let additionalImplementationFiles: Record<string, string>;

beforeEach(() => {
  providerCalls = [];
  additionalImplementationFiles = {};
  vi.mocked(discoverProviders).mockResolvedValue([fakeClaude]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    providerCalls.push(request);
    if (request.role === 'planner') return fakeDone(JSON.stringify(proposal));
    if (request.role === 'implementer') {
      const implementationFiles = {
        'src/add.js': 'export function add(a, b) { return a + b; }\n',
        'src/add.test.js':
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.js';\ntest('add sums two numbers', () => assert.equal(add(2, 3), 5));\n",
        ...additionalImplementationFiles,
      };
      for (const [path, content] of Object.entries(implementationFiles)) {
        const written = await h!.broker(request.toolBroker.token, 'write_file', { path, content });
        expect(written.error, `the fake provider must write ${path} through the real broker`).toBeUndefined();
      }
      return fakeDone('Added the utility and its test.');
    }
    if (/Reviewer slot/.test(request.prompt)) return fakeDone(JSON.stringify({ findings: [] }));
    if (request.role === 'consolidator' || /goalReviewReport/.test(request.prompt))
      return fakeDone(JSON.stringify({ findings: [], goalReviewReport: report }));
    if (request.role === 'final-gate')
      return fakeDone(JSON.stringify({ pass: true, reason: 'Review output is valid.' }));
    throw new Error(`Unexpected fake-provider stage: ${request.role}`);
  });
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
  vi.mocked(discoverProviders).mockReset();
});

async function seedFakeRouteValidations(finalReviewerModel = 'gpt-5.5'): Promise<void> {
  if (!h) throw new Error('The real Goal harness is not open.');
  const snapshot = await observeRouteSnapshot(h.fx.db);
  const testedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(testedAt) + 6 * 24 * 60 * 60 * 1_000).toISOString();
  const insert = h.fx.db.prepare(
    `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, checks_json, provenance,
       adapter_version, capability_fingerprint, tested_at, expires_at)
     VALUES (?, ?, ?, ?, 'pass', '{}', 'turing_probe_run', ?, ?, ?, ?)`,
  );
  const routes: Array<[string, GoalRole]> = [
    ['claude-sonnet-5-5', 'orchestrator'],
    ['claude-opus-5-5', 'implementer'],
    [finalReviewerModel, 'final_reviewer'],
  ];
  let index = 0;
  for (const [modelId, role] of routes)
    for (const record of passRecords(member(modelId), role, snapshot, { testedAt, expiresAt })) {
      index += 1;
      insert.run(
        `goal-e2e-validation-${index}`,
        record.identityHash,
        JSON.stringify(record.identity),
        record.profile,
        record.adapterVersion,
        record.capabilityFingerprint,
        testedAt,
        expiresAt,
      );
    }
}

const call = async (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => {
  if (!h) throw new Error('The real Goal harness is not open.');
  const response = await h.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
};

function handoffGitState(repo: string): unknown {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const gitBytes = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  const paths = new Set(
    [
      ...gitBytes('ls-files', '-z', '--cached', '--others', '--exclude-standard')
        .toString('utf8')
        .split('\0'),
      ...gitBytes('ls-files', '-z', '--others', '--ignored', '--exclude-standard')
        .toString('utf8')
        .split('\0'),
    ].filter(Boolean),
  );
  const files = [...paths].sort().map((path) => {
    const fullPath = join(repo, path);
    const stat = lstatSync(fullPath);
    return [
      path,
      stat.isSymbolicLink() ? `symlink:${readlinkSync(fullPath)}` : readFileSync(fullPath).toString('base64'),
    ];
  });
  const optionalFile = (path: string) =>
    existsSync(join(repo, path)) ? readFileSync(join(repo, path)).toString('base64') : null;
  return {
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    head: git('rev-parse', 'HEAD'),
    symbolicHead: git('symbolic-ref', '-q', 'HEAD'),
    index: optionalFile('.git/index'),
    indexEntries: git('ls-files', '--stage'),
    files,
    worktrees: git('worktree', 'list', '--porcelain'),
    reflogs: git('reflog', '--all', '--format=%H%x00%gD%x00%gs'),
    config: optionalFile('.git/config'),
    exclude: optionalFile('.git/info/exclude'),
  };
}

const runFor = (
  purpose: string,
  cycleId?: string,
): { id: string; status: string; branch: string; worktree_path: string } => {
  if (!h) throw new Error('The real Goal harness is not open.');
  const row = h.fx.db
    .prepare(
      `SELECT id, status, branch, worktree_path FROM runs WHERE goal_run_purpose = ?
       ${cycleId ? 'AND goal_cycle_id = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...(cycleId ? [purpose, cycleId] : [purpose])) as
    { id: string; status: string; branch: string; worktree_path: string } | undefined;
  if (!row) throw new Error(`No ${purpose} run was persisted.`);
  return row;
};

describe('Stage 7C.1 deterministic Goal prove-it', () => {
  it(
    'runs a proposal through final-apply readiness using real Goal, run, Git, evidence, and review authority',
    async () => {
      const definition = goldenDefinition();
      h = await realRunHarness({
        definition,
        approved: false,
        initializeGoalRef: false,
        requireResolvedRoutes: true,
        planProvider: (db) =>
          new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
        scripts: {
          build: 'node --check src/add.js',
          test: 'node --test src/add.test.js',
        },
      });
      await seedFakeRouteValidations();

      const hash = (
        h.fx.db
          .prepare(
            'SELECT definition_hash AS hash FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
          )
          .get(h.fx.goalId) as { hash: string }
      ).hash;
      const storedBeforeApproval = h.fx.db
        .prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
        .get(h.fx.goalId);
      expect(storedBeforeApproval).toEqual({ status: 'proposed' });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 0 });

      const definitionView = await call('GET', `/api/goals/${h.fx.goalId}/definitions/1`);
      expect(definitionView.status).toBe(200);
      const shownDefinition = definitionView.body.definition as Record<string, unknown>;
      expect(shownDefinition.definitionHash).toBe(hash);
      expect(shownDefinition.validation).toMatchObject({ valid: true });

      const approved = await call(
        'POST',
        `/api/goals/${h.fx.goalId}/definitions/1/approve`,
        {},
        { 'if-match': `"${hash}"` },
      );
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ goalStatus: 'ready', definitionHash: hash });
      expect(
        h.fx.db
          .prepare(
            'SELECT status, approved_by FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
          )
          .get(h.fx.goalId),
      ).toEqual({ status: 'approved', approved_by: 'user' });

      const base = h.baseCommit;
      const started = await call('POST', `/api/goals/${h.fx.goalId}/start`, {});
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ ok: true, goalStatus: 'running' });
      const ref = `refs/heads/turing/goal/${h.fx.goalId}`;
      expect(
        h.fx.db
          .prepare('SELECT base_branch, base_commit, integration_head FROM goal_runtime WHERE goal_id = ?')
          .get(h.fx.goalId),
      ).toEqual({ base_branch: 'main', base_commit: base, integration_head: base });
      expect(h.fx.git('rev-parse', ref)).toBe(base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);

      await h.until('proposal_run_started');
      const proposalRun = runFor('proposal');
      await vi.waitFor(() => expect(h!.runRow(proposalRun.id).status).toBe('completed'), { timeout: 20_000 });
      expect(providerCalls.filter((request) => request.role === 'planner')).toHaveLength(1);
      expect(
        h.fx.db
          .prepare('SELECT goal_cycle_id, goal_run_purpose, goal_base_commit FROM runs WHERE id = ?')
          .get(proposalRun.id),
      ).toEqual({
        goal_cycle_id: h.cycleId(),
        goal_run_purpose: 'proposal',
        goal_base_commit: base,
      });
      expect(providerCalls.find((request) => request.role === 'planner')).toMatchObject({
        modelId: 'claude-sonnet-5-5',
        billingLane: 'claude-subscription',
      });
      await h.until('proposal_recorded');
      expect(
        h.fx.db.prepare('SELECT status, validated_task_json FROM goal_cycles WHERE id = ?').get(h.cycleId()),
      ).toMatchObject({
        status: 'proposed',
        validated_task_json: expect.stringContaining('src/add.js'),
      });

      await h.until('run_started');
      const executionId = runFor('execution', h.cycleId()).id;
      await vi.waitFor(() => expect(h!.runRow(executionId).status).toBe('completed'), { timeout: 25_000 });
      const execution = runFor('execution', h.cycleId());
      expect(
        h.fx.db
          .prepare(
            'SELECT goal_cycle_id, goal_run_purpose, goal_base_commit, starting_commit FROM runs WHERE id = ?',
          )
          .get(execution.id),
      ).toEqual({
        goal_cycle_id: h.cycleId(),
        goal_run_purpose: 'execution',
        goal_base_commit: base,
        starting_commit: base,
      });
      expect(providerCalls.find((request) => request.role === 'implementer')).toMatchObject({
        modelId: 'claude-opus-5-5',
        billingLane: 'claude-subscription',
      });
      expect(execution.worktree_path).toBeTruthy();
      expect(execution.worktree_path).not.toBe(h.fx.repo);
      expect(existsSync(join(execution.worktree_path, 'src/add.js'))).toBe(true);
      expect(readFileSync(join(execution.worktree_path, 'src/add.js'), 'utf8')).toContain('return a + b');
      expect(h.fx.git('rev-parse', execution.branch)).not.toBe(base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(h.fx.git('status', '--porcelain')).toBe('');

      await h.until('cycle_succeeded');
      let integratedHead = h.fx.git('rev-parse', ref);
      expect(integratedHead).not.toBe(base);
      expect(h.fx.head()).toBe(integratedHead);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(
        h.fx.db
          .prepare(
            `SELECT status, expected_old, new_commit FROM goal_integration_ops
           WHERE goal_id = ? AND op = 'advance' AND run_id = ?`,
          )
          .get(h.fx.goalId, execution.id),
      ).toEqual({ status: 'applied', expected_old: base, new_commit: integratedHead });
      expect(
        h.fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'advance' AND status = 'applied'",
          )
          .get(h.fx.goalId),
      ).toEqual({ n: 1 });

      await h.until('evidence_collected');
      const evidence = h.fx.db
        .prepare(
          `SELECT kind, criterion_key, definition_version, run_id, subject_tree, verifier_digest
         FROM goal_evidence WHERE goal_id = ? AND run_id = ? ORDER BY criterion_key, kind`,
        )
        .all(h.fx.goalId, execution.id) as Array<Record<string, string | number>>;
      const integratedTree = h.fx.git('rev-parse', `${integratedHead}^{tree}`);
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'build_result',
            criterion_key: 'build',
            definition_version: 1,
            run_id: execution.id,
            subject_tree: integratedTree,
            verifier_digest: h.fx.digest('build'),
          }),
          expect.objectContaining({
            kind: 'test_result',
            criterion_key: 'tests',
            definition_version: 1,
            run_id: execution.id,
            subject_tree: integratedTree,
            verifier_digest: h.fx.digest('tests'),
          }),
        ]),
      );
      const evidenceEvaluation = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(evidenceEvaluation.milestones).toMatchObject([{ key: 'm1', state: 'satisfied' }]);

      await h.until('review_run_started');
      expect(
        h.fx.db.prepare('SELECT status FROM goal_milestones WHERE goal_id = ?').get(h.fx.goalId),
      ).toMatchObject({ status: 'satisfied' });
      const reviewCycle = h.fx.db
        .prepare(
          "SELECT id FROM goal_cycles WHERE goal_id = ? AND kind = 'review' ORDER BY sequence DESC LIMIT 1",
        )
        .get(h.fx.goalId) as { id: string };
      const reviewRun = runFor('review', reviewCycle.id);
      await vi.waitFor(
        () => {
          const status = h!.runRow(reviewRun.id).status;
          if (status === 'failed') {
            const stages = h!.fx.db
              .prepare('SELECT kind, status, error FROM stages WHERE run_id = ? ORDER BY sequence')
              .all(reviewRun.id);
            throw new Error(
              `Review run failed: ${JSON.stringify(stages)}; provider roles: ${providerCalls.map((call) => call.role).join(',')}`,
            );
          }
          expect(status).toBe('completed');
        },
        { timeout: 25_000 },
      );
      const resolutionJson = (
        h.fx.db
          .prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ?')
          .get(reviewCycle.id) as { json: string }
      ).json;
      const resolutions = readStoredResolutions(resolutionJson);
      expect(resolutions.final_reviewer?.selected.configuration.modelId).toBe('gpt-5.5');
      await h.until('review_consumed');
      const completedReview = h.fx.db
        .prepare('SELECT status, verdict, independence_json FROM goal_reviews WHERE cycle_id = ?')
        .get(reviewCycle.id) as { status: string; verdict: string; independence_json: string };
      expect(completedReview).toMatchObject({ status: 'completed', verdict: 'pass' });
      expect(JSON.parse(completedReview.independence_json)).toMatchObject({
        established: true,
        policy: 'different-family',
        detail: {
          reasonCode: 'established',
          comparedAgainst: expect.arrayContaining([expect.objectContaining({ role: 'implementer' })]),
        },
      });

      await h.until('gate_requested');
      const acceptance = h.fx.db
        .prepare("SELECT id, detail_json FROM goal_approvals WHERE goal_id = ? AND gate = 'final_acceptance'")
        .get(h.fx.goalId) as { id: string; detail_json: string };
      const surfacedApprovals = await call('GET', `/api/approvals/unified?goalId=${h.fx.goalId}`);
      expect(surfacedApprovals.status).toBe(200);
      expect(surfacedApprovals.body.approvals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: acceptance.id,
            source: 'goal',
            gate: 'final_acceptance',
            risk: 'medium',
            status: 'pending',
          }),
        ]),
      );
      expect(JSON.parse(acceptance.detail_json)).toMatchObject({
        definitionVersion: 1,
        definitionHash: hash,
        integrationHead: integratedHead,
        integrationTree: integratedTree,
      });
      await expect(prepareFinalApplyIntent(h.fx.db, h.fx.goalId)).rejects.toMatchObject({
        code: 'completion_not_ready',
      });
      const decided = await call('POST', `/api/goal-approvals/${acceptance.id}/decision`, {
        decision: 'approved',
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ status: 'approved', changed: true });
      expect(
        h.fx.db.prepare('SELECT status, decided_by FROM goal_approvals WHERE id = ?').get(acceptance.id),
      ).toEqual({ status: 'approved', decided_by: 'user' });
      expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).toEqual({
        status: 'needs_user',
      });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 3 });

      const resumed = await call('POST', `/api/goals/${h.fx.goalId}/resume`, { reason: 'gate_resolved' });
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ ok: true, goalStatus: 'running' });
      expect(await h.tick()).toBe('completion_pending');
      const evaluation = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(evaluation.criteria.every((criterion) => criterion.state === 'satisfied')).toBe(true);
      expect(evaluation.milestones.every((item) => item.state === 'satisfied')).toBe(true);
      expect(evaluation.finalReview).toMatchObject({ required: true, ok: true });
      expect(evaluation.finalAcceptance).toMatchObject({ required: true, ok: true });
      expect(evaluation.finalApply).toMatchObject({ required: true, ok: false, reason: 'not_applied' });
      expect(evaluation.failures.map((failure) => failure.code)).toEqual(['final_apply_required']);

      const beforeListCount = (
        h.fx.db
          .prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?')
          .get(h.fx.goalId) as { n: number }
      ).n;
      expect(beforeListCount).toBe(0);
      const beforeHandoffApi = handoffGitState(h.fx.repo);
      const emptyHandoffs = await call('GET', `/api/goals/${h.fx.goalId}/handoffs`);
      expect(emptyHandoffs.status).toBe(200);
      expect(emptyHandoffs.body.handoffs).toEqual([]);
      expect(
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(h.fx.goalId),
      ).toEqual({ n: 0 });

      const preparedResponse = await call('POST', `/api/goals/${h.fx.goalId}/handoffs`, {});
      expect(preparedResponse.status).toBe(201);
      expect(preparedResponse.body.reused).toBe(false);
      const handoffId = preparedResponse.body.handoffId as string;
      const projectionResponse = await call('GET', `/api/goals/${h.fx.goalId}/handoffs/${handoffId}`);
      expect(projectionResponse.status).toBe(200);
      const projection = projectionResponse.body.projection as GoalManualHandoffProjection;
      expect(projection.state).toBe('current');
      const preparedHandoff = {
        reused: preparedResponse.body.reused as boolean,
        record: projection.handoff!,
      };
      const otherGoal = createGoalDraft(h.fx.db, {
        projectId: h.fx.projectId,
        title: 'Cross-scope handoff probe',
        definition: simpleDefinition(),
      });
      expect((await call('GET', `/api/goals/${otherGoal.goalId}/handoffs/${handoffId}`)).status).toBe(404);
      expect(preparedHandoff.record).toMatchObject({
        goalId: h.fx.goalId,
        definition: { version: 1, hash },
        finalAcceptance: { approvalId: acceptance.id },
        source: { goalRef: ref, commit: integratedHead, tree: integratedTree },
        target: { baseRef: 'refs/heads/main', observedBaseCommit: base },
        review: { finalReviewId: evaluation.finalReview.reviewId },
        projection: { manualIntegrationRequired: true },
      });
      expect(
        await validateManualHandoff(h.fx.db, h.fx.goalId, preparedHandoff.record.handoffId),
      ).toMatchObject({
        state: 'current',
        reason: null,
      });
      expect(
        await getManualHandoffProjection(h.fx.db, h.fx.goalId, preparedHandoff.record.handoffId),
      ).toMatchObject({
        state: 'current',
        label: 'Ready for manual integration',
        actualApplication: 'not_performed_by_turing',
        goalCompletion: 'not_completed_by_handoff',
      });
      expect(
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(h.fx.goalId),
      ).toEqual({ n: 1 });
      const retry = await call('POST', `/api/goals/${h.fx.goalId}/handoffs`, {});
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({
        handoffId,
        handoffDigest: preparedHandoff.record.handoffDigest,
        reused: true,
      });
      const listedHandoffs = await call('GET', `/api/goals/${h.fx.goalId}/handoffs?limit=1`);
      expect(listedHandoffs.body.handoffs).toEqual([
        expect.objectContaining({ handoffId, sourceCommit: integratedHead, definitionVersion: 1 }),
      ]);
      expect(handoffGitState(h.fx.repo)).toEqual(beforeHandoffApi);
      expect(
        h.fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base'",
          )
          .get(h.fx.goalId),
      ).toEqual({ n: 0 });
      expect(
        (await evaluateCompletion(h.fx.db, h.fx.goalId)).failures.map((failure) => failure.code),
      ).toEqual(['final_apply_required']);

      const externalPath = `/api/goals/${h.fx.goalId}/handoffs/${handoffId}/external-integration`;
      const approvalsBeforeObservation = (
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(h.fx.goalId) as {
          n: number;
        }
      ).n;
      expect((await call('GET', externalPath)).body).toMatchObject({
        hasAttestation: false,
        attestations: [],
        approvals: [],
      });
      const notIntegrated = await call('GET', `${externalPath}/verification`);
      expect(notIntegrated).toMatchObject({
        status: 200,
        body: {
          verification: {
            state: 'not_integrated',
            observation: null,
            reason: { code: 'source_not_ancestor' },
          },
        },
      });
      expect(
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(h.fx.goalId),
      ).toEqual({
        n: approvalsBeforeObservation,
      });

      // Simulate the user's manual fast-forward in this disposable fixture. The HTTP workflow below must be Git-read-only.
      h.fx.git('merge', '--ff-only', ref);
      expect(h.fx.git('rev-parse', 'main')).toBe(integratedHead);
      expect(await getManualHandoffProjection(h.fx.db, h.fx.goalId, handoffId)).toMatchObject({
        state: 'stale',
        reason: { code: 'base_diverged' },
      });
      const afterManualIntegration = handoffGitState(h.fx.repo);
      const verified = await call('GET', `${externalPath}/verification`);
      expect(verified).toMatchObject({ status: 200, body: { verification: { state: 'verified' } } });
      const verifiedObservation = (
        verified.body.verification as {
          observation: {
            actionDigest: string;
            source: { commit: string };
            destination: { observedCommit: string };
          };
        }
      ).observation;
      expect(verifiedObservation).toMatchObject({
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: { commit: integratedHead },
        destination: { observedCommit: integratedHead },
      });
      expect(handoffGitState(h.fx.repo)).toEqual(afterManualIntegration);

      const confirmation = await call(
        'POST',
        `${externalPath}/attest`,
        { decision: 'confirm_external_integration' },
        { 'if-match': `"${verifiedObservation.actionDigest}"` },
      );
      expect(confirmation.status).toBe(201);
      const externalApproval = h.fx.db
        .prepare(
          'SELECT gate, risk, requested_by, status, decided_by, external_integration_action_digest, detail_json FROM goal_approvals WHERE id = ?',
        )
        .get(confirmation.body.approvalId as string) as {
        gate: string;
        risk: string;
        requested_by: string;
        status: string;
        decided_by: string;
        external_integration_action_digest: string;
        detail_json: string;
      };
      expect(externalApproval).toMatchObject({
        gate: 'final_apply',
        risk: 'high',
        requested_by: 'user',
        status: 'approved',
        decided_by: 'user',
        external_integration_action_digest: verifiedObservation.actionDigest,
      });
      expect(JSON.parse(externalApproval.detail_json)).toMatchObject({
        schemaVersion: 2,
        action: 'confirm_external_integration',
        actionDigest: verifiedObservation.actionDigest,
        handoffId,
      });
      const attestationPath = `${externalPath}/attestations/${confirmation.body.attestationId as string}`;
      expect((await call('GET', attestationPath)).body).toMatchObject({
        projection: {
          state: 'current',
          claim: 'source_history_observed_at_recorded_time',
          contentPreservation: 'not_proven',
          goalCompletion: 'not_completed_by_attestation',
        },
      });
      const repeatedConfirmation = await call(
        'POST',
        `${externalPath}/attest`,
        { decision: 'confirm_external_integration' },
        { 'if-match': `"${verifiedObservation.actionDigest}"` },
      );
      expect(repeatedConfirmation).toMatchObject({
        status: 200,
        body: {
          attestationId: confirmation.body.attestationId,
          approvalId: confirmation.body.approvalId,
          reusedApproval: true,
          reusedAttestation: true,
        },
      });
      expect(handoffGitState(h.fx.repo)).toEqual(afterManualIntegration);
      expect(
        (await evaluateCompletion(h.fx.db, h.fx.goalId)).failures.map((failure) => failure.code),
      ).toEqual(['final_apply_required']);

      h.fx.git('commit', '--allow-empty', '-m', 'user advances destination after attestation');
      const afterLaterCommit = handoffGitState(h.fx.repo);
      expect((await call('GET', attestationPath)).body).toMatchObject({
        projection: { state: 'historical', goalCompletion: 'not_completed_by_attestation' },
      });
      const staleConfirmation = await call(
        'POST',
        `${externalPath}/attest`,
        { decision: 'confirm_external_integration' },
        { 'if-match': `"${verifiedObservation.actionDigest}"` },
      );
      expect(staleConfirmation).toMatchObject({
        status: 412,
        body: { code: 'reviewed_observation_changed' },
      });
      expect(handoffGitState(h.fx.repo)).toEqual(afterLaterCommit);
      expect(
        h.fx.db
          .prepare(
            'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_integration_action_digest = ?',
          )
          .get(h.fx.goalId, verifiedObservation.actionDigest),
      ).toEqual({ n: 1 });
      expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).not.toEqual({
        status: 'completed',
      });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 3 });
      expect(
        h.fx.db
          .prepare('SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = ?')
          .get(h.fx.goalId, 'apply_to_base'),
      ).toEqual({ n: 0 });
      // Restore the fixture's base checkout so the legacy-authority regression below keeps its original setup.
      h.fx.git('reset', '--hard', base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(h.fx.git('status', '--porcelain')).toBe('');

      // Characterize a normal merge as well: the user's unrelated destination commit remains in the merge parentage.
      writeFileSync(join(h.fx.repo, 'manual-integration.txt'), 'user-owned destination change\n');
      h.fx.git('add', 'manual-integration.txt');
      h.fx.git('commit', '-m', 'user advances destination independently');
      h.fx.git('merge', '--no-ff', '--no-edit', ref);
      const ordinaryMergeHead = h.fx.git('rev-parse', 'main');
      expect(ordinaryMergeHead).not.toBe(integratedHead);
      expect(() => h!.fx.git('merge-base', '--is-ancestor', integratedHead, ordinaryMergeHead)).not.toThrow();
      expect(await getManualHandoffProjection(h.fx.db, h.fx.goalId, handoffId)).toMatchObject({
        state: 'stale',
        reason: { code: 'base_diverged' },
      });
      const afterOrdinaryMerge = handoffGitState(h.fx.repo);
      const mergeVerification = await call('GET', `${externalPath}/verification`);
      expect(mergeVerification).toMatchObject({
        status: 200,
        body: {
          verification: {
            state: 'verified',
            observation: {
              source: { commit: integratedHead },
              destination: { observedCommit: ordinaryMergeHead },
            },
          },
        },
      });
      expect(handoffGitState(h.fx.repo)).toEqual(afterOrdinaryMerge);
      h.fx.git('reset', '--hard', base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(h.fx.git('status', '--porcelain')).toBe('');

      const preflight = await preflightFinalApply(h.fx.db, h.fx.goalId);
      expect(preflight.status).toBe('ready_for_approved_apply');
      expect(preflight.integrationHead).toBe(integratedHead);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(h.fx.git('rev-parse', ref)).toBe(integratedHead);

      const providerCallsBeforeAuthority = providerCalls.length;
      const prepared = await prepareFinalApplyIntent(h.fx.db, h.fx.goalId);
      const preparedAgain = await prepareFinalApplyIntent(h.fx.db, h.fx.goalId);
      expect(preparedAgain.intent).toEqual(prepared.intent);
      expect(prepared.intent).toMatchObject({
        schemaVersion: 1,
        action: 'apply_to_base_intent',
        goalId: h.fx.goalId,
        definitionVersion: 1,
        definitionHash: hash,
        source: { goalRef: ref, integrationHead: integratedHead, integrationTree: integratedTree },
        destination: {
          baseBranch: 'main',
          baseRef: 'refs/heads/main',
          expectedBaseCommit: base,
        },
      });
      expect(prepared.intent.destination.repoIdentity).toMatch(/^[0-9a-f]{64}$/);
      expect(prepared.intent.review).toMatchObject({
        changedPathDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        diffStatDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        diffPreviewDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(prepared.reviewDisplay.diffPreview.length).toBeLessThanOrEqual(1_000);

      const { intentDigest: originalDigest, ...body } = prepared.intent;
      const digestChanges: Array<(candidate: typeof body) => void> = [
        (candidate) => (candidate.goalId = `${candidate.goalId}-other`),
        (candidate) => (candidate.definitionVersion += 1),
        (candidate) => (candidate.definitionHash = 'f'.repeat(64)),
        (candidate) => (candidate.source.integrationHead = 'e'.repeat(40)),
        (candidate) => (candidate.source.integrationTree = 'd'.repeat(40)),
        (candidate) => (candidate.destination.baseBranch = 'other'),
        (candidate) => (candidate.destination.expectedBaseCommit = 'c'.repeat(40)),
        (candidate) => (candidate.destination.repoIdentity = 'b'.repeat(64)),
        (candidate) => (candidate.review.diffPreviewDigest = 'a'.repeat(64)),
        (candidate) => (candidate.review.diffStatDigest = '9'.repeat(64)),
      ];
      for (const change of digestChanges) {
        const candidate = structuredClone(body);
        change(candidate);
        expect(computeFinalApplyIntentDigest(candidate)).not.toBe(originalDigest);
      }

      const firstIntentApproval = await requestFinalApplyApproval(h.fx.db, h.fx.goalId, {
        now: '2026-10-09T01:00:00.000Z',
      });
      expect(firstIntentApproval).toMatchObject({
        gate: 'final_apply',
        risk: 'high',
        requestedBy: 'user',
        status: 'pending',
        intentDigest: prepared.intent.intentDigest,
      });
      expect(firstIntentApproval.detail).toMatchObject({
        action: 'apply_to_base_intent',
        intentDigest: prepared.intent.intentDigest,
        intent: prepared.intent,
        reviewDisplay: prepared.reviewDisplay,
      });
      expect(() =>
        requestGoalApproval(h.fx.db, {
          goalId: h.fx.goalId,
          gate: 'final_apply',
          risk: 'high',
          reason: 'Unbound prospective apply must be refused.',
          requestedBy: 'user',
          detail: { action: 'apply_to_base_intent' },
        }),
      ).toThrow(/prospective final-apply digest/);

      const deniedFirst = decideGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        approvalId: firstIntentApproval.id,
        decision: 'denied',
        decidedBy: 'user',
        note: 'Test explicit retry behavior.',
      });
      expect(deniedFirst.approval.status).toBe('denied');
      const deniedReuse = await requestFinalApplyApproval(h.fx.db, h.fx.goalId);
      expect(deniedReuse.id).toBe(firstIntentApproval.id);
      expect(deniedReuse.status).toBe('denied');

      const [pendingA, pendingB] = await Promise.all([
        requestFinalApplyApproval(h.fx.db, h.fx.goalId, { retryDenied: true }),
        requestFinalApplyApproval(h.fx.db, h.fx.goalId, { retryDenied: true }),
      ]);
      expect(pendingA.id).toBe(pendingB.id);
      expect(pendingA.id).not.toBe(firstIntentApproval.id);
      expect(pendingA.status).toBe('pending');
      const pendingValidation = await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, pendingA.id, {
        expectedStatus: 'pending',
      });
      expect(pendingValidation.ok).toBe(true);

      const wrongId = await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, 'missing-approval');
      expect(wrongId).toMatchObject({ ok: false, code: 'approval_not_found' });
      const wrongGoal = await validateFinalApplyAuthority(h.fx.db, 'different-goal', pendingA.id, {
        expectedStatus: 'pending',
      });
      expect(wrongGoal).toMatchObject({ ok: false, code: 'approval_mismatch' });
      const acceptanceId = acceptance.id;
      const wrongGate = await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, acceptanceId);
      expect(wrongGate).toMatchObject({ ok: false, code: 'approval_mismatch' });

      const wrongRisk = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'final_apply',
        risk: 'medium',
        reason: 'Wrong-risk negative case.',
        requestedBy: 'user',
        detail: { action: 'applied_externally' },
      });
      expect(
        await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, wrongRisk.id, { expectedStatus: 'pending' }),
      ).toMatchObject({
        ok: false,
        code: 'approval_mismatch',
      });
      const malformed = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'final_apply',
        risk: 'high',
        reason: 'Malformed prospective detail negative case.',
        requestedBy: 'user',
        detail: { action: 'applied_externally' },
      });
      expect(
        await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, malformed.id, { expectedStatus: 'pending' }),
      ).toMatchObject({
        ok: false,
        code: 'final_apply_intent_invalid',
      });
      expect(() =>
        h.fx.db
          .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
          .run(JSON.stringify({ action: 'apply_to_base_intent', intentDigest: '0'.repeat(64) }), pendingA.id),
      ).toThrow(/immutable/);

      const originalGoalState = h.fx.db
        .prepare('SELECT status, status_reason_code FROM goals WHERE id = ?')
        .get(h.fx.goalId) as { status: string; status_reason_code: string | null };
      h.fx.db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").run(h.fx.goalId);
      expect(
        await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, pendingA.id, { expectedStatus: 'pending' }),
      ).toMatchObject({
        ok: false,
        code: 'goal_terminal',
      });
      h.fx.db
        .prepare('UPDATE goals SET status = ?, status_reason_code = ? WHERE id = ?')
        .run(originalGoalState.status, originalGoalState.status_reason_code, h.fx.goalId);
      h.fx.db
        .prepare("UPDATE goals SET status = 'blocked', status_reason_code = 'base_diverged' WHERE id = ?")
        .run(h.fx.goalId);
      expect(
        await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, pendingA.id, { expectedStatus: 'pending' }),
      ).toMatchObject({
        ok: false,
        code: 'manual_reconciliation_required',
      });
      h.fx.db
        .prepare('UPDATE goals SET status = ?, status_reason_code = ? WHERE id = ?')
        .run(originalGoalState.status, originalGoalState.status_reason_code, h.fx.goalId);
      expect(() =>
        decideGoalApproval(h.fx.db, {
          goalId: h.fx.goalId,
          approvalId: pendingA.id,
          decision: 'approved',
          decidedBy: 'system',
        }),
      ).toThrow(/explicit user action/);

      const decisionPath = `/api/goal-approvals/${pendingA.id}/decision`;
      const refusePendingApproval = async (code?: string) => {
        const response = await call('POST', decisionPath, { decision: 'approved' });
        expect(response.status).toBe(409);
        if (code) expect(response.body.code).toBe(code);
        expect(h!.fx.db.prepare('SELECT status FROM goal_approvals WHERE id = ?').get(pendingA.id)).toEqual({
          status: 'pending',
        });
        return response;
      };

      h.fx.db.prepare('UPDATE goals SET current_definition_version = NULL WHERE id = ?').run(h.fx.goalId);
      await refusePendingApproval('definition_not_approved');
      h.fx.db.prepare('UPDATE goals SET current_definition_version = 1 WHERE id = ?').run(h.fx.goalId);

      h.fx.db
        .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
        .run(base, h.fx.goalId);
      await refusePendingApproval('completion_not_ready');
      h.fx.db
        .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
        .run(integratedHead, h.fx.goalId);

      h.fx.db.prepare('UPDATE goal_runtime SET base_branch = ? WHERE goal_id = ?').run('other', h.fx.goalId);
      await refusePendingApproval('preflight_wrong_branch');
      h.fx.db.prepare('UPDATE goal_runtime SET base_branch = ? WHERE goal_id = ?').run('main', h.fx.goalId);

      h.fx.db
        .prepare('UPDATE goal_runtime SET base_commit = ? WHERE goal_id = ?')
        .run(integratedHead, h.fx.goalId);
      await refusePendingApproval('preflight_base_diverged');
      h.fx.db.prepare('UPDATE goal_runtime SET base_commit = ? WHERE goal_id = ?').run(base, h.fx.goalId);

      h.fx.git('checkout', '-b', 'authority-wrong-branch', base);
      await refusePendingApproval('preflight_wrong_branch');
      h.fx.git('checkout', 'main');

      const dirt = join(h.fx.repo, 'authority-untracked.txt');
      writeFileSync(dirt, 'untracked fixture state\n');
      await refusePendingApproval('preflight_dirty_checkout');
      rmSync(dirt, { force: true });

      const baseTree = h.fx.git('rev-parse', `${base}^{tree}`);
      const divergedBase = h.fx.git(
        'commit-tree',
        baseTree,
        '-p',
        base,
        '-m',
        'Authority stale base fixture',
      );
      h.fx.git('update-ref', 'refs/heads/main', divergedBase);
      await refusePendingApproval('preflight_base_diverged');
      h.fx.git('update-ref', 'refs/heads/main', base);

      h.fx.git('update-ref', ref, base);
      await refusePendingApproval('completion_not_ready');
      h.fx.git('update-ref', ref, integratedHead);

      const existingRun = h.fx.db
        .prepare('SELECT run_id FROM goal_runs WHERE goal_id = ? ORDER BY run_id LIMIT 1')
        .get(h.fx.goalId) as { run_id: string };
      h.fx.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(existingRun.run_id);
      await refusePendingApproval('active_work');
      h.fx.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(existingRun.run_id);

      h.fx.db
        .prepare(
          `INSERT INTO goal_integration_ops (id, goal_id, op, expected_old, new_commit, status, checks_json, created_at)
         VALUES ('authority-planned-test', ?, 'advance', ?, ?, 'planned', '[]', '2026-10-09T01:00:00.000Z')`,
        )
        .run(h.fx.goalId, base, integratedHead);
      expect(
        await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, pendingA.id, { expectedStatus: 'pending' }),
      ).toMatchObject({ ok: false, code: 'integration_operation_in_progress' });
      h.fx.db
        .prepare(
          "UPDATE goal_integration_ops SET status = 'aborted', error_code = 'test_cleanup', finished_at = ? WHERE id = 'authority-planned-test'",
        )
        .run('2026-10-09T01:01:00.000Z');

      const alternateHead = h.fx.git(
        'commit-tree',
        integratedTree,
        '-p',
        base,
        '-m',
        'Same tree, distinct source commit',
      );
      h.fx.git('update-ref', ref, alternateHead);
      h.fx.db
        .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
        .run(alternateHead, h.fx.goalId);
      expect(
        await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, pendingA.id, { expectedStatus: 'pending' }),
      ).toMatchObject({ ok: false, code: 'final_apply_intent_stale' });
      const currentIntentApproval = await requestFinalApplyApproval(h.fx.db, h.fx.goalId);
      expect(currentIntentApproval.id).not.toBe(pendingA.id);
      expect(currentIntentApproval.intentDigest).not.toBe(pendingA.intentDigest);
      expect(
        h.fx.db.prepare('SELECT status, decided_by FROM goal_approvals WHERE id = ?').get(pendingA.id),
      ).toEqual({ status: 'denied', decided_by: 'system' });
      integratedHead = alternateHead;

      const approvedResponse = await call(
        'POST',
        `/api/goal-approvals/${currentIntentApproval.id}/decision`,
        {
          decision: 'approved',
        },
      );
      expect(approvedResponse.status).toBe(200);
      expect(approvedResponse.body).toMatchObject({
        approvalId: currentIntentApproval.id,
        status: 'approved',
        changed: true,
      });
      const repeatedApprovalDecision = await call(
        'POST',
        `/api/goal-approvals/${currentIntentApproval.id}/decision`,
        { decision: 'approved' },
      );
      expect(repeatedApprovalDecision.status).toBe(200);
      expect(repeatedApprovalDecision.body).toMatchObject({
        approvalId: currentIntentApproval.id,
        status: 'approved',
        changed: false,
      });
      expect(await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, currentIntentApproval.id)).toMatchObject(
        {
          ok: true,
          authority: { intent: { source: { integrationHead: alternateHead } } },
        },
      );
      const originalAuthorityDetail = JSON.stringify(currentIntentApproval.detail);
      const tamperedAuthorityDetail = JSON.stringify({
        ...currentIntentApproval.detail,
        intentDigest: '0'.repeat(64),
      });
      h.fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      try {
        h.fx.db
          .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
          .run(tamperedAuthorityDetail, currentIntentApproval.id);
        expect(
          await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, currentIntentApproval.id),
        ).toMatchObject({
          ok: false,
          code: 'final_apply_intent_digest_mismatch',
        });
        h.fx.db
          .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
          .run(originalAuthorityDetail, currentIntentApproval.id);
      } finally {
        h.fx.db.exec(`
        CREATE TRIGGER trg_goal_approval_identity BEFORE UPDATE ON goal_approvals
        WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.gate IS NOT OLD.gate OR NEW.risk IS NOT OLD.risk
          OR NEW.reason IS NOT OLD.reason OR NEW.requested_by IS NOT OLD.requested_by
          OR NEW.detail_json IS NOT OLD.detail_json OR NEW.created_at IS NOT OLD.created_at
          OR NEW.intent_digest IS NOT OLD.intent_digest
        BEGIN SELECT RAISE(ABORT, 'goal approval identity is immutable'); END;
        CREATE TRIGGER trg_goal_approval_terminal BEFORE UPDATE ON goal_approvals
        WHEN OLD.status <> 'pending'
        BEGIN SELECT RAISE(ABORT, 'a decided goal approval is immutable'); END;
      `);
      }
      expect(await requestFinalApplyApproval(h.fx.db, h.fx.goalId)).toMatchObject({
        id: currentIntentApproval.id,
        status: 'approved',
      });

      const completionAfterProspectiveApproval = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(completionAfterProspectiveApproval.finalApply).toMatchObject({
        required: true,
        ok: false,
        basis: null,
        reason: 'not_applied',
      });
      expect(completionAfterProspectiveApproval.failures.map((failure) => failure.code)).toEqual([
        'final_apply_required',
      ]);
      expect(
        h.fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base' AND status = 'applied'",
          )
          .get(h.fx.goalId),
      ).toEqual({ n: 0 });
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(h.fx.git('rev-parse', ref)).toBe(alternateHead);
      expect(providerCalls.length).toBe(providerCallsBeforeAuthority);
      expect((await call('POST', `/api/goals/${h.fx.goalId}/final-apply`, {})).status).toBe(404);

      // An intent is still stale after approval if the approved definition changes; its final review and acceptance
      // remain bound to version 1 and cannot be reused for version 2.
      const oldAuthority = currentIntentApproval.id;

      expect(h.fx.git('rev-parse', ref)).toBe(integratedHead);
      expect(providerCalls.every((request) => request.billingLane === 'claude-subscription')).toBe(true);
      expect(
        h.fx.db
          .prepare(
            'SELECT COALESCE(SUM(equivalent_cost_usd), 0) AS total FROM usage_events WHERE run_id IN (SELECT id FROM runs)',
          )
          .get(),
      ).toEqual({ total: 0 });

      // Ordinary finite-run regression: the normal launcher and provider broker are still independent of Goal origin.
      const builtin = h.fx.db
        .prepare('SELECT config_json FROM workflows WHERE id = ?')
        .get('goal-execution-v1') as { config_json: string };
      const configuration = JSON.parse(builtin.config_json) as Partial<WorkflowDefinition>;
      const ordinaryId = 'ordinary-goal-boundary-regression';
      const now = new Date().toISOString();
      const ordinaryWorkflow: WorkflowDefinition = {
        ...(configuration as WorkflowDefinition),
        id: ordinaryId,
        name: 'Ordinary Goal boundary regression',
        description: 'A single bounded provider stage for the Stage 7C.1 regression.',
        template: 'ordinary-regression',
        permissionMode: 'yolo',
        billingMode: 'subscriptions-only',
        subscriptionOnly: true,
        isolatedWorktree: true,
        goalScope: undefined,
        stages: [
          {
            id: 'ordinary-implement',
            label: 'Ordinary implementation',
            kind: 'implementer',
            role: 'implementer',
            enabled: true,
            backendId: 'claude-code',
            providerId: 'anthropic-subscription',
            billingLane: 'claude-subscription',
            modelId: 'claude-sonnet-5-5',
          },
        ],
        version: 1,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
      const { id, name, description, template, version, isDefault, createdAt, updatedAt, ...ordinaryConfig } =
        ordinaryWorkflow;
      h.fx.db
        .prepare(
          `INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          description,
          template,
          JSON.stringify(ordinaryConfig),
          version,
          Number(isDefault),
          createdAt,
          updatedAt,
        );
      const cyclesBeforeOrdinary = (
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles WHERE goal_id = ?').get(h.fx.goalId) as {
          n: number;
        }
      ).n;
      const ordinaryPreview = await buildPreview(h.fx.db, {
        task: 'Ordinary finite regression: add the utility through the normal broker.',
        projectId: h.fx.projectId,
        workflowId: ordinaryId,
      });
      expect(ordinaryPreview?.canStart).toBe(true);
      const ordinaryRun = createRun(h.fx.db, h.engine, ordinaryPreview!);
      await vi.waitFor(() => expect(h!.runRow(ordinaryRun.id).status).toBe('completed'), { timeout: 20_000 });
      expect(
        h.fx.db
          .prepare('SELECT goal_cycle_id, goal_run_purpose, goal_base_commit FROM runs WHERE id = ?')
          .get(ordinaryRun.id),
      ).toEqual({ goal_cycle_id: null, goal_run_purpose: null, goal_base_commit: null });
      expect(
        h.fx.db
          .prepare('SELECT backend_id, provider_id, model_id, billing_lane FROM stages WHERE run_id = ?')
          .get(ordinaryRun.id),
      ).toEqual({
        backend_id: 'claude-code',
        provider_id: 'anthropic-subscription',
        model_id: 'claude-sonnet-5-5',
        billing_lane: 'claude-subscription',
      });
      expect(
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles WHERE goal_id = ?').get(h.fx.goalId),
      ).toEqual({
        n: cyclesBeforeOrdinary,
      });
      await h.supervisor.reconcile();
      await h.supervisor.runOnce();
      expect(
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_runs WHERE run_id = ?').get(ordinaryRun.id),
      ).toEqual({
        n: 0,
      });
      expect(h.fx.git('rev-parse', ref)).toBe(integratedHead);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(h.fx.git('status', '--porcelain')).toBe('');

      h.fx.git('checkout', '-b', 'authority-tree-source', base);
      const changedTree = h.fx.advance(
        { 'src/add.js': 'export function add(a, b) { return a + b + 0; }\n' },
        'Advance source tree after approval',
      );
      expect(changedTree.tree).not.toBe(integratedTree);
      const staleTreeEvaluation = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(staleTreeEvaluation.finalReview.ok).toBe(false);
      expect(staleTreeEvaluation.finalAcceptance).toMatchObject({ required: true, ok: false });
      expect(await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, oldAuthority)).toMatchObject({
        ok: false,
        code: 'completion_not_ready',
      });
      expect(
        await validateManualHandoff(h.fx.db, h.fx.goalId, preparedHandoff.record.handoffId),
      ).toMatchObject({
        state: 'stale',
      });
      expect(
        await call('GET', `/api/goals/${h.fx.goalId}/handoffs/${preparedHandoff.record.handoffId}`),
      ).toMatchObject({
        status: 200,
        body: { projection: { state: 'stale', reason: { code: 'source_changed' } } },
      });

      const amendment = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' });
      approveDefinition(h.fx.db, {
        goalId: h.fx.goalId,
        version: amendment.version,
        actor: 'user',
        expectedDefinitionHash: amendment.definitionHash,
      });
      const staleDefinitionEvaluation = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(staleDefinitionEvaluation.finalReview.ok).toBe(false);
      expect(staleDefinitionEvaluation.finalAcceptance).toMatchObject({ required: true, ok: false });
      expect(await validateFinalApplyAuthority(h.fx.db, h.fx.goalId, oldAuthority)).toMatchObject({
        ok: false,
        code: 'completion_not_ready',
      });
      expect(
        await validateManualHandoff(h.fx.db, h.fx.goalId, preparedHandoff.record.handoffId),
      ).toMatchObject({
        state: 'stale',
        reason: { code: 'definition_not_approved' },
      });
      expect(
        await call('GET', `/api/goals/${h.fx.goalId}/handoffs/${preparedHandoff.record.handoffId}`),
      ).toMatchObject({
        status: 200,
        body: {
          projection: {
            state: 'stale',
            reason: { code: 'definition_not_approved' },
          },
        },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps a denied each-cycle gate closed through API decision and supervisor reconciliation',
    async () => {
      h = await realRunHarness({ definition: simpleDefinition({ gates: { eachCycle: true } }) });
      const started = await call('POST', `/api/goals/${h.fx.goalId}/start`, {});
      expect(started.status).toBe(200);
      await h.until('gate_requested');
      const gate = h.fx.db
        .prepare(
          "SELECT id FROM goal_approvals WHERE goal_id = ? AND gate = 'each_cycle' AND status = 'pending'",
        )
        .get(h.fx.goalId) as { id: string };
      expect(gate.id).toBeTruthy();
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'execution'").get(),
      ).toEqual({ n: 0 });
      expect(providerCalls.some((request) => request.role === 'implementer')).toBe(false);

      const denied = await call('POST', `/api/goal-approvals/${gate.id}/decision`, { decision: 'denied' });
      expect(denied.status).toBe(200);
      expect(denied.body).toMatchObject({ status: 'denied', changed: true });
      expect(
        h.fx.db.prepare('SELECT status, decided_by FROM goal_approvals WHERE id = ?').get(gate.id),
      ).toEqual({ status: 'denied', decided_by: 'user' });
      expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).toEqual({
        status: 'needs_user',
      });
      expect(await h.tick()).toBe('gate_denied');
      const cycle = h.fx.db
        .prepare(
          'SELECT status, outcome_json FROM goal_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1',
        )
        .get(h.fx.goalId) as { status: string; outcome_json: string };
      expect(cycle.status).toBe('cancelled');
      expect(JSON.parse(cycle.outcome_json)).toMatchObject({ code: 'gate_denied', approvalId: gate.id });
      await h.supervisor.reconcile();
      expect(await h.tick()).toBe('idle');
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'execution'").get(),
      ).toEqual({ n: 0 });
      expect(
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles WHERE goal_id = ?').get(h.fx.goalId),
      ).toEqual({
        n: 1,
      });
      expect(providerCalls.some((request) => request.role === 'implementer')).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a broker-written out-of-scope file before Goal-ref integration',
    async () => {
      additionalImplementationFiles = { 'docs/out-of-scope.md': 'Harmless scope fixture.\n' };
      h = await realRunHarness({ definition: goldenDefinition() });
      const base = h.baseCommit;
      const started = await call('POST', `/api/goals/${h.fx.goalId}/start`, {});
      expect(started.status).toBe(200);

      await h.until('cycle_failed');
      const cycle = h.fx.db
        .prepare(
          'SELECT status, outcome_json FROM goal_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1',
        )
        .get(h.fx.goalId) as { status: string; outcome_json: string };
      expect(cycle.status).toBe('failed');
      expect(JSON.parse(cycle.outcome_json)).toMatchObject({ code: 'scope_violation' });
      expect(providerCalls.some((request) => request.role === 'implementer')).toBe(true);
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(
        h.fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance' AND status = 'applied'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        h.fx.db
          .prepare("SELECT COUNT(*) AS n FROM goal_milestones WHERE goal_id = ? AND status = 'satisfied'")
          .get(h.fx.goalId),
      ).toEqual({ n: 0 });
      expect(
        h.fx.db
          .prepare('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?')
          .get(h.fx.goalId),
      ).toEqual({ n: 1 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'blocks at the real execution-cycle bound after a failed deterministic verifier',
    async () => {
      const definition = goldenDefinition();
      definition.limits.maxExecutionCycles = 1;
      definition.limits.maxConsecutiveFailedCycles = 2;
      h = await realRunHarness({
        definition,
        requireResolvedRoutes: true,
        planProvider: (db) =>
          new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
        scripts: { build: 'node -e "process.exit(3)"', test: 'node --test src/add.test.js' },
      });
      await seedFakeRouteValidations();
      const base = h.baseCommit;
      const started = await call('POST', `/api/goals/${h.fx.goalId}/start`, {});
      expect(started.status).toBe(200);

      await h.until('bound_blocked');
      expect(
        h.fx.db.prepare('SELECT status, status_reason_code FROM goals WHERE id = ?').get(h.fx.goalId),
      ).toEqual({ status: 'blocked', status_reason_code: 'bound_cycles' });
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'execution'").get(),
      ).toEqual({
        n: 1,
      });
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'proposal'").get(),
      ).toEqual({
        n: 1,
      });
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'review'").get(),
      ).toEqual({
        n: 0,
      });
      expect(providerCalls.filter((request) => request.role === 'implementer')).toHaveLength(1);
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      const runCount = (h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
      await h.supervisor.reconcile();
      await h.supervisor.runOnce();
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: runCount });
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(base);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a same-family final reviewer and never treats it as independent',
    async () => {
      h = await realRunHarness({
        definition: goldenDefinition('claude-opus-5-5'),
        requireResolvedRoutes: true,
        planProvider: (db) =>
          new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
        scripts: {
          build: 'node --check src/add.js',
          test: 'node --test src/add.test.js',
        },
      });
      await seedFakeRouteValidations('claude-opus-5-5');
      const base = h.baseCommit;
      const started = await call('POST', `/api/goals/${h.fx.goalId}/start`, {});
      expect(started.status).toBe(200);

      await h.until('review_decision_needed');
      const failedCycle = h.fx.db
        .prepare(
          "SELECT status, outcome_json FROM goal_cycles WHERE goal_id = ? AND kind = 'review' ORDER BY sequence DESC LIMIT 1",
        )
        .get(h.fx.goalId) as { status: string; outcome_json: string };
      expect(failedCycle.status).toBe('failed');
      expect(JSON.parse(failedCycle.outcome_json)).toMatchObject({ code: 'review_queue_error' });
      expect(providerCalls.some((request) => request.role === 'final-reviewer')).toBe(false);
      expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).toEqual({
        status: 'needs_user',
      });
      const evaluation = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(evaluation.finalReview).toMatchObject({
        required: true,
        ok: false,
        reason: 'final_review_missing',
      });
      expect(evaluation.failures.map((failure) => failure.code)).toContain('final_review_missing');
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).not.toBe(base);
      expect(h.fx.git('rev-parse', 'main')).toBe(base);
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'review'").get(),
      ).toEqual({
        n: 0,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'recovers a persisted queued proposal after fresh service construction without duplicating it',
    async () => {
      h = await realRunHarness();
      const started = await call('POST', `/api/goals/${h.fx.goalId}/start`, {});
      expect(started.status).toBe(200);
      await h.until('proposal_queued');
      const queued = runFor('proposal');
      expect(queued.status).toBe('queued');
      const plannedRuns = h.plans.requests.length;
      expect(providerCalls).toHaveLength(0);

      const fresh = h.restart();
      const recovered = await fresh.supervisor.reconcile();
      expect(recovered.map((result) => result.action)).toContain('proposal_run_started');
      expect(h.plans.requests).toHaveLength(plannedRuns);
      await vi.waitFor(() => expect(h!.runRow(queued.id).status).toBe('completed'), { timeout: 20_000 });
      expect(providerCalls.filter((request) => request.role === 'planner')).toHaveLength(1);
      expect(
        h.fx.db
          .prepare("SELECT id FROM runs WHERE goal_run_purpose = 'proposal' AND goal_cycle_id = ?")
          .all(h.cycleId()),
      ).toEqual([{ id: queued.id }]);

      await fresh.supervisor.reconcile();
      expect(providerCalls.filter((request) => request.role === 'planner')).toHaveLength(1);
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'proposal'").get(),
      ).toEqual({ n: 1 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

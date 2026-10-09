import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalDefinition, GoalRole, RouteMember } from '../../shared/goals.js';
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
import { cleanupRepoFixtures, milestone, reportOf, simpleDefinition } from './repoKit.js';
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
  it('runs a proposal through final-apply readiness using real Goal, run, Git, evidence, and review authority', async () => {
    const definition = goldenDefinition();
    h = await realRunHarness({
      definition,
      approved: false,
      initializeGoalRef: false,
      requireResolvedRoutes: true,
      planProvider: (db) => new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
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
        .prepare('SELECT status, approved_by FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
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
    const integratedHead = h.fx.git('rev-parse', ref);
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

    const preflight = await preflightFinalApply(h.fx.db, h.fx.goalId);
    expect(preflight.status).toBe('ready_for_approved_apply');
    expect(preflight.integrationHead).toBe(integratedHead);
    expect(h.fx.git('rev-parse', 'main')).toBe(base);
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
  }, 30_000);

  it('keeps a denied each-cycle gate closed through API decision and supervisor reconciliation', async () => {
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
  });

  it('refuses a broker-written out-of-scope file before Goal-ref integration', async () => {
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
        .prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance' AND status = 'applied'")
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
  });

  it('blocks at the real execution-cycle bound after a failed deterministic verifier', async () => {
    const definition = goldenDefinition();
    definition.limits.maxExecutionCycles = 1;
    definition.limits.maxConsecutiveFailedCycles = 2;
    h = await realRunHarness({
      definition,
      requireResolvedRoutes: true,
      planProvider: (db) => new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
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
    expect(h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'review'").get()).toEqual(
      {
        n: 0,
      },
    );
    expect(providerCalls.filter((request) => request.role === 'implementer')).toHaveLength(1);
    expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(base);
    expect(h.fx.git('rev-parse', 'main')).toBe(base);
    const runCount = (h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    await h.supervisor.reconcile();
    await h.supervisor.runOnce();
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: runCount });
    expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(base);
  });

  it('refuses a same-family final reviewer and never treats it as independent', async () => {
    h = await realRunHarness({
      definition: goldenDefinition('claude-opus-5-5'),
      requireResolvedRoutes: true,
      planProvider: (db) => new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
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
    expect(h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'review'").get()).toEqual(
      {
        n: 0,
      },
    );
  });

  it('recovers a persisted queued proposal after fresh service construction without duplicating it', async () => {
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
  });
});

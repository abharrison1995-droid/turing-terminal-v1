import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { RunEngine } from '../runEngine.js';
import type { GoalDefinition, GoalRole, RouteMember } from '../../shared/goals.js';
import type { GoalManualHandoffProjection } from '../../shared/goalApi.js';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';

/**
 * Real-execution lifecycle qualification of one version-2 Goal. The fakes are the provider process boundary
 * (`providers.js`, with deterministic provider response texts) and the route-validation rows seeded by
 * `seedFakeRouteValidations`, which stand in for a live provider probe. The supervisor, the RunEngine, the broker, the
 * verifier, the review and acceptance gates, the approve/start/decision/handoff/attest HTTP routes, the correction and
 * completion services, Git and SQLite are all real. No test code calls `acceptedFixture`, `completeReview`, or writes a
 * Goal table directly. The restart drives a fresh supervisor and a fresh app on the same database.
 *
 * NOT PROVEN HERE: OS-level crash durability (no process is killed mid-write), WAL recovery after a killed process,
 * partial-fsync behaviour, Windows path/ref/common-dir semantics, physical iPhone, live Tailscale, and live provider
 * validation. The old supervisor is not explicitly stopped before the restart; the fresh one is what drives the rest.
 */
vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Live provider calls are disabled in Goal acceptance tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider } from '../providers.js';
import type { ProviderRunRequest } from '../providers.js';
import { decideGoalApproval, getGoalApproval } from './approvals.js';
import {
  appendAttestationCorrection,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import { readStoredResolutions } from './routeResolution.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { passRecords } from './routingKit.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import { databaseSnapshot, repositoryState } from './goalV2TestKit.js';
import {
  cleanupRepoFixtures,
  milestone,
  REAL_GIT_TEST_TIMEOUT_MS,
  reportOf,
  simpleDefinition,
} from './repoKit.js';
import { type RealRunHarness, realRunHarness } from './turingRunKit.js';

const FORMATS = ['sha1', 'sha256'] as const;

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

/** The golden v1 definition of goalE2E, plus the version-2 external-user-attested completion policy. */
function goldenV2Definition(finalReviewerModel = 'gpt-5.5'): GoalDefinition {
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
      completionContractVersion: 2,
      integrationMode: 'external_user_attested',
      requireFinalReview: true,
      requireUserAcceptance: true,
      applyToBase: 'required',
    },
    gates: { finalAcceptance: true },
  });
  definition.routing.roles.orchestrator = pinned('claude-sonnet-5-5');
  definition.routing.roles.implementer = pinned('claude-opus-5-5');
  // The final reviewer's family decides whether the review is independent of the implementer (`different-family`).
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
/** The HTTP app every `call` is served by: the harness app, or the app built after a restart. */
let serving: FastifyInstance | undefined;
/** The app built on the fresh supervisor after a restart; closed by `afterEach` if a test does not close it. */
let restartedApp: FastifyInstance | undefined;

beforeEach(() => {
  providerCalls = [];
  vi.mocked(discoverProviders).mockResolvedValue([fakeClaude]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    providerCalls.push(request);
    if (request.role === 'planner') return fakeDone(JSON.stringify(proposal));
    if (request.role === 'implementer') {
      const implementationFiles = {
        'src/add.js': 'export function add(a, b) { return a + b; }\n',
        'src/add.test.js':
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.js';\ntest('add sums two numbers', () => assert.equal(add(2, 3), 5));\n",
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
  await restartedApp?.close();
  restartedApp = undefined;
  serving = undefined;
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
        `goal-lifecycle-validation-${index}`,
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

/** Opens the real harness on a proposed v2 definition, with the route validations the real planner requires. */
async function openGoal(
  finalReviewerModel: string,
  objectFormat: 'sha1' | 'sha256',
): Promise<RealRunHarness> {
  h = await realRunHarness({
    definition: goldenV2Definition(finalReviewerModel),
    approved: false,
    initializeGoalRef: false,
    objectFormat,
    requireResolvedRoutes: true,
    planProvider: (db) => new ResolvedGoalRunPlanProvider(db, { observe: () => observeRouteSnapshot(db) }),
    scripts: {
      build: 'node --check src/add.js',
      test: 'node --test src/add.test.js',
    },
  });
  await seedFakeRouteValidations(finalReviewerModel);
  serving = h.app;
  return h;
}

const call = async (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => {
  if (!serving) throw new Error('The Goal HTTP app is not open.');
  const response = await serving.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
};

/** Approves version 1 through the real HTTP approve route, with its definition hash as the precondition. */
async function approveDefinition(db: Db, goalId: string) {
  const hash = (
    db
      .prepare(
        'SELECT definition_hash AS hash FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
      )
      .get(goalId) as { hash: string }
  ).hash;
  const response = await call(
    'POST',
    `/api/goals/${goalId}/definitions/1/approve`,
    {},
    { 'if-match': `"${hash}"` },
  );
  return { hash, response };
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

/** Every row of the Goal-scoped tables, plus the settings by key and value (reopening rewrites settings.updated_at). */
function wholeDatabase(db: Db): ReturnType<typeof databaseSnapshot> {
  const snapshot = databaseSnapshot(db);
  const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  snapshot.digests.settings = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  return snapshot;
}

/** Tables whose digest differs between two snapshots, sorted. */
function changedTables(
  before: ReturnType<typeof databaseSnapshot>,
  after: ReturnType<typeof databaseSnapshot>,
): string[] {
  return Object.keys(before.digests)
    .filter((table) => before.digests[table] !== after.digests[table])
    .sort();
}

interface GoalEventRow {
  seq: number;
  id: string;
  goal_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

interface Target {
  db: Db;
  goalId: string;
  repo: string;
}

interface Snapshot {
  db: ReturnType<typeof databaseSnapshot>;
  repo: unknown;
  events: GoalEventRow[];
  approval: unknown;
}

function goalEvents(db: Db, goalId: string): GoalEventRow[] {
  return db
    .prepare(
      'SELECT rowid AS seq, id, goal_id, type, payload_json, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid',
    )
    .all(goalId) as GoalEventRow[];
}

function goalRow(
  db: Db,
  goalId: string,
): { status: string; completed_at: string | null; status_reason_code: string | null } {
  return db
    .prepare('SELECT status, completed_at, status_reason_code FROM goals WHERE id = ?')
    .get(goalId) as { status: string; completed_at: string | null; status_reason_code: string | null };
}

function proofRows(db: Db, goalId: string): { id: string; proof_digest: string; payload_json: string }[] {
  return db
    .prepare('SELECT id, proof_digest, payload_json FROM goal_external_completion_proofs WHERE goal_id = ?')
    .all(goalId) as { id: string; proof_digest: string; payload_json: string }[];
}

/** The stored proof rows of a Goal, serialised: a byte comparison of what the proof table holds for it. */
function proofRowsJson(db: Db, goalId: string): string {
  return JSON.stringify(
    db.prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid').all(goalId),
  );
}

function snapshotOf(target: Target, approvalId: string | null): Snapshot {
  return {
    db: wholeDatabase(target.db),
    repo: repositoryState(target.repo),
    events: goalEvents(target.db, target.goalId),
    approval: approvalId === null ? null : getGoalApproval(target.db, approvalId),
  };
}

/** Tables whose rows a completion is allowed to change. Every other table must keep its digest. */
const TABLES_A_COMPLETION_CHANGES = new Set([
  'goals',
  'goal_events',
  'goal_external_completion_proofs',
  'goal_runtime',
]);

/** Exactly one proof and exactly two new events; the rest of the database and the repository are unchanged. */
function expectCompleted(target: Target, before: Snapshot, approvalId: string): void {
  expect(proofRows(target.db, target.goalId)).toHaveLength(1);

  const after = goalEvents(target.db, target.goalId);
  expect(after.slice(0, before.events.length)).toEqual(before.events);
  const added = after.slice(before.events.length);
  expect(added.map((event) => event.type)).toEqual(['external_completion_recorded', 'state_changed']);

  const goal = goalRow(target.db, target.goalId);
  expect(goal).toMatchObject({ status: 'completed', status_reason_code: EXTERNAL_COMPLETION_REASON });
  expect(goal.completed_at).toBe(added[1]!.created_at);
  expect(JSON.parse(added[1]!.payload_json)).toEqual({
    from: 'running',
    to: 'completed',
    reasonCode: EXTERNAL_COMPLETION_REASON,
    actor: 'user',
  });

  const afterSnapshot = wholeDatabase(target.db);
  for (const table of Object.keys(before.db.digests))
    if (!TABLES_A_COMPLETION_CHANGES.has(table))
      expect(afterSnapshot.digests[table], `table ${table} changed`).toBe(before.db.digests[table]);
  expect(getGoalApproval(target.db, approvalId)).toEqual(before.approval);
  expect(repositoryState(target.repo)).toEqual(before.repo);
  expect(target.db.inTransaction).toBe(false);
}

/** The request that produced the completion; a test repeats this exact request to observe the replay. */
interface CompletionRequest {
  goalId: string;
  attestationId: string;
  reviewedPreflightDigest: string;
  acknowledgeContentNotProven: true;
}

/** The Goal's status, completion, and stored state as the completion services read them. */
function completedState(target: Target) {
  return {
    goal: goalRow(target.db, target.goalId),
    proofs: proofRowsJson(target.db, target.goalId),
  };
}

describe('Q1 one version-2 Goal from real bounded execution to a corrected completion', () => {
  it.each(FORMATS)(
    'runs one v2 Goal from real execution through a corrected completion (%s)',
    async (objectFormat) => {
      const harness = await openGoal('gpt-5.5', objectFormat);
      const { db, repo, goalId } = harness.fx;
      const target: Target = { db, goalId, repo };

      // Step 1: the v2 policy is approved through the real HTTP approve route.
      const hash = (
        db
          .prepare(
            'SELECT definition_hash AS hash FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
          )
          .get(goalId) as { hash: string }
      ).hash;
      expect(
        db
          .prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
          .get(goalId),
      ).toEqual({ status: 'proposed' });
      const approval = await approveDefinition(db, goalId);
      expect(approval.hash).toBe(hash);
      expect(approval.response).toMatchObject({
        status: 200,
        body: { version: 1, definitionHash: hash, goalStatus: 'ready' },
      });
      const approvedRow = db
        .prepare(
          'SELECT status, approved_by, definition_hash, contract_json FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
        )
        .get(goalId) as {
        status: string;
        approved_by: string;
        definition_hash: string;
        contract_json: string;
      };
      expect(approvedRow).toMatchObject({ status: 'approved', approved_by: 'user', definition_hash: hash });
      expect(JSON.parse(approvedRow.contract_json).completionPolicy).toMatchObject({
        completionContractVersion: 2,
        integrationMode: 'external_user_attested',
      });

      // Step 2: real supervisor ticks through proposal, execution, deterministic evidence and a different-family review.
      const base = harness.baseCommit;
      const started = await call('POST', `/api/goals/${goalId}/start`, {});
      expect(started).toMatchObject({ status: 200, body: { ok: true, goalStatus: 'running' } });
      const ref = `refs/heads/turing/goal/${goalId}`;

      await harness.until('proposal_run_started');
      const proposalRun = runFor('proposal');
      await vi.waitFor(() => expect(harness.runRow(proposalRun.id).status).toBe('completed'), {
        timeout: 20_000,
      });
      await harness.until('proposal_recorded');

      await harness.until('run_started');
      const executionId = runFor('execution', harness.cycleId()).id;
      await vi.waitFor(() => expect(harness.runRow(executionId).status).toBe('completed'), {
        timeout: 25_000,
      });
      await harness.until('cycle_succeeded');
      const integratedHead = harness.fx.git('rev-parse', ref);
      expect(integratedHead).not.toBe(base);
      expect(harness.fx.git('rev-parse', 'main')).toBe(base);

      await harness.until('evidence_collected');
      const integratedTree = harness.fx.git('rev-parse', `${integratedHead}^{tree}`);
      const evidence = db
        .prepare(
          'SELECT kind, criterion_key, subject_tree FROM goal_evidence WHERE goal_id = ? AND run_id = ? ORDER BY criterion_key, kind',
        )
        .all(goalId, executionId) as Array<Record<string, string>>;
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'build_result',
            criterion_key: 'build',
            subject_tree: integratedTree,
          }),
          expect.objectContaining({
            kind: 'test_result',
            criterion_key: 'tests',
            subject_tree: integratedTree,
          }),
        ]),
      );

      await harness.until('review_run_started');
      const reviewCycle = db
        .prepare(
          "SELECT id FROM goal_cycles WHERE goal_id = ? AND kind = 'review' ORDER BY sequence DESC LIMIT 1",
        )
        .get(goalId) as { id: string };
      const reviewRun = runFor('review', reviewCycle.id);
      await vi.waitFor(
        () => {
          const status = harness.runRow(reviewRun.id).status;
          if (status === 'failed') {
            const stages = db
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
        db
          .prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ?')
          .get(reviewCycle.id) as {
          json: string;
        }
      ).json;
      expect(readStoredResolutions(resolutionJson).final_reviewer?.selected.configuration.modelId).toBe(
        'gpt-5.5',
      );
      await harness.until('review_consumed');
      const review = db
        .prepare('SELECT status, verdict, independence_json FROM goal_reviews WHERE cycle_id = ?')
        .get(reviewCycle.id) as { status: string; verdict: string; independence_json: string };
      expect(review).toMatchObject({ status: 'completed', verdict: 'pass' });
      expect(JSON.parse(review.independence_json)).toMatchObject({
        established: true,
        policy: 'different-family',
      });

      await harness.until('gate_requested');
      const acceptance = db
        .prepare("SELECT id, status FROM goal_approvals WHERE goal_id = ? AND gate = 'final_acceptance'")
        .get(goalId) as { id: string; status: string };
      expect(acceptance.status).toBe('pending');
      const atGate = await evaluateCompletion(db, goalId);
      expect(atGate.failures.map((failure) => failure.code)).toEqual([
        'final_acceptance_missing',
        'external_completion_not_activated',
      ]);
      expect(atGate.finalReview).toMatchObject({ required: true, ok: true });
      expect(atGate.finalAcceptance).toMatchObject({ required: true, ok: false });
      expect(proofRows(db, goalId)).toEqual([]);

      // Restart before the user decides: a fresh supervisor and a fresh app on the same database.
      const restarted = harness.restart();
      restartedApp = createApp({
        database: db,
        engine: restarted.engine,
        goalSupervisor: restarted.supervisor,
      });
      await restartedApp.ready();
      serving = restartedApp;
      // A pending acceptance gate holds the Goal in needs_user (gate_pending) until the user decides; it is not running.
      expect(goalRow(db, goalId)).toMatchObject({
        status: 'needs_user',
        status_reason_code: 'gate_pending',
        completed_at: null,
      });
      expect(proofRows(db, goalId)).toEqual([]);

      // Step 3: the user decides the acceptance gate through the real decision route, then resumes through the real route.
      const decided = await call('POST', `/api/goal-approvals/${acceptance.id}/decision`, {
        decision: 'approved',
      });
      expect(decided).toMatchObject({ status: 200, body: { status: 'approved', changed: true } });
      expect(
        db.prepare('SELECT status, decided_by FROM goal_approvals WHERE id = ?').get(acceptance.id),
      ).toEqual({
        status: 'approved',
        decided_by: 'user',
      });
      expect(goalRow(db, goalId)).toMatchObject({ status: 'needs_user' });
      const resumed = await call('POST', `/api/goals/${goalId}/resume`, { reason: 'gate_resolved' });
      expect(resumed).toMatchObject({ status: 200, body: { ok: true, goalStatus: 'running' } });
      const next = await restarted.supervisor.tickGoal(goalId);
      expect(next.action).toBe('completion_pending');
      const evaluation = await evaluateCompletion(db, goalId);
      expect(evaluation.failures.map((failure) => failure.code)).toEqual([
        'external_completion_not_activated',
      ]);
      expect(evaluation.finalReview).toMatchObject({ required: true, ok: true });
      expect(evaluation.finalAcceptance).toMatchObject({ required: true, ok: true });
      expect(evaluation.finalApply).toMatchObject({
        required: true,
        ok: false,
        reason: 'external_completion_not_activated',
      });
      expect(goalRow(db, goalId)).toMatchObject({ status: 'running', completed_at: null });
      expect(proofRows(db, goalId)).toEqual([]);

      // Step 4: the handoff is prepared through the real API. The fixture performs the Git integration, not the product.
      const preparedResponse = await call('POST', `/api/goals/${goalId}/handoffs`, {});
      expect(preparedResponse.status).toBe(201);
      const handoffId = preparedResponse.body.handoffId as string;
      const projection = (await call('GET', `/api/goals/${goalId}/handoffs/${handoffId}`)).body
        .projection as GoalManualHandoffProjection;
      expect(projection.state).toBe('current');

      const externalPath = `/api/goals/${goalId}/handoffs/${handoffId}/external-integration`;
      expect(await call('GET', `${externalPath}/verification`)).toMatchObject({
        status: 200,
        body: { verification: { state: 'not_integrated', reason: { code: 'source_not_ancestor' } } },
      });

      if (objectFormat === 'sha1') harness.fx.git('merge', '--ff-only', ref);
      else {
        // A destination-only commit makes the following merge a true two-parent `--no-ff` merge.
        writeFileSync(join(repo, 'unrelated.txt'), 'destination-only change\n');
        harness.fx.git('add', 'unrelated.txt');
        harness.fx.git('commit', '-m', 'user advances destination independently');
        harness.fx.git('merge', '--no-ff', '--no-edit', ref);
      }
      const destinationHead = harness.fx.git('rev-parse', 'main');
      if (objectFormat === 'sha1') expect(destinationHead).toBe(integratedHead);
      else
        expect(harness.fx.git('rev-list', '--parents', '-n', '1', 'main').split(' ')).toContain(
          integratedHead,
        );
      const afterIntegration = repositoryState(repo);

      const verified = await call('GET', `${externalPath}/verification`);
      expect(verified).toMatchObject({ status: 200, body: { verification: { state: 'verified' } } });
      const observation = (
        verified.body.verification as {
          observation: {
            actionDigest: string;
            source: { commit: string };
            destination: { observedCommit: string };
          };
        }
      ).observation;
      expect(observation).toMatchObject({
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: { commit: integratedHead },
        destination: { observedCommit: destinationHead },
      });
      expect(repositoryState(repo)).toEqual(afterIntegration);

      // Step 5: attestation through the real HTTP route, then the real preflight and decision services.
      const confirmation = await call(
        'POST',
        `${externalPath}/attest`,
        { decision: 'confirm_external_integration' },
        { 'if-match': `"${observation.actionDigest}"` },
      );
      expect(confirmation.status).toBe(201);
      const attestationId = confirmation.body.attestationId as string;
      expect(repositoryState(repo)).toEqual(afterIntegration);

      const preflight = await computeExternalCompletionPreflight(db, goalId, { attestationId });
      expect(preflight.outcome).toBe('ready');
      const decision = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId,
        reviewedPreflightDigest: preflight.digest,
        acknowledgeContentNotProven: true,
      });
      expect(decision).toMatchObject({ status: 'approved', reused: false });
      const request: CompletionRequest = {
        goalId,
        attestationId,
        reviewedPreflightDigest: preflight.digest,
        acknowledgeContentNotProven: true,
      };

      // Step 6: the completion, and its whole-state effect.
      const before = snapshotOf(target, decision.approvalId);
      const completed = await completeGoalFromExternalDecision(db, request);
      expect(completed.reused).toBe(false);
      expect(completed.completion).toMatchObject({
        state: 'completed',
        approvalId: decision.approvalId,
        preflightDigest: preflight.digest,
      });
      expectCompleted(target, before, decision.approvalId);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base'",
          )
          .get(goalId),
      ).toEqual({ n: 0 });
      expect(readStoredCompletion(db, goalId)).toMatchObject({
        state: 'completed',
        proofId: completed.completion.proofId,
      });
      const proofId = completed.completion.proofId;
      const proofBytes = proofRowsJson(db, goalId);
      const completedGoal = goalRow(db, goalId);

      // Close the database and reopen it from the same data root. Every read below is on the reopened connection.
      await harness.close();
      h = undefined;
      await restartedApp.close();
      restartedApp = undefined;
      serving = undefined;
      db.close();
      const reopened = openDatabase(dirname(repo));
      try {
        const reopenedTarget: Target = { db: reopened, goalId, repo };
        expectCompleted(reopenedTarget, before, decision.approvalId);
        expect(proofRowsJson(reopened, goalId)).toBe(proofBytes);
        expect(goalRow(reopened, goalId)).toEqual(completedGoal);

        // Step 7: the dispute through the real correction services: request, user decision, then the correction.
        const explanation = 'Disputed by the Q1 lifecycle qualification.';
        const beforeDispute = completedState(reopenedTarget);
        const beforeDisputeWhole = wholeDatabase(reopened);
        const reviewed = requestAttestationCorrectionApproval(reopened, {
          goalId,
          attestationId,
          correctionKind: 'dispute',
          reasonCode: 'observation_error',
          explanation,
          replacementAttestationId: null,
        });
        decideGoalApproval(reopened, {
          goalId,
          approvalId: reviewed.approval.id,
          decision: 'approved',
          decidedBy: 'user',
        });
        appendAttestationCorrection(reopened, {
          goalId,
          approvalId: reviewed.approval.id,
          expectedActionDigest: reviewed.actionDigest,
          explanation,
        });

        expect(completedState(reopenedTarget)).toEqual(beforeDispute);
        expect(goalRow(reopened, goalId)).toEqual(completedGoal);
        expect(proofRowsJson(reopened, goalId)).toBe(proofBytes);
        expect(changedTables(beforeDisputeWhole, wholeDatabase(reopened))).toEqual([
          'goal_approvals',
          'goal_attestation_corrections',
          'goal_events',
        ]);
        const standing = readGoalCompletionStanding(reopened, goalId);
        expect(standing).toMatchObject({ kind: 'v2', standing: 'disputed' });
        expect(repositoryState(repo)).toEqual(afterIntegration);

        // The HTTP read agrees with the standing reader on the same database.
        const readApp = createApp({ database: reopened, engine: new RunEngine(reopened, () => undefined) });
        try {
          await readApp.ready();
          const detail = await readApp.inject({ method: 'GET', url: `/api/goals/${goalId}` });
          expect(detail.statusCode).toBe(200);
          expect(
            (detail.json() as { goal: { completionStanding: unknown } }).goal.completionStanding,
          ).toEqual(standing);
        } finally {
          await readApp.close();
        }

        // An exact replay of the completion request returns the original proof, and writes nothing.
        const replayBefore = wholeDatabase(reopened);
        const replayRepo = repositoryState(repo);
        const replay = await completeGoalFromExternalDecision(reopened, request);
        expect(replay).toEqual({ reused: true, completion: completed.completion });
        expect(replay.completion.proofId).toBe(proofId);
        expect(wholeDatabase(reopened)).toEqual(replayBefore);
        expect(repositoryState(repo)).toEqual(replayRepo);
        expect(proofRowsJson(reopened, goalId)).toBe(proofBytes);
      } finally {
        if (reopened.open) reopened.close();
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a same-family final reviewer is refused as review_queue_error with queueCode plan_unavailable, attributed to the family check by contrast with the passing different-family run (sha1)',
    async () => {
      const harness = await openGoal('claude-opus-5-5', 'sha1');
      const { db, repo, goalId } = harness.fx;
      const approval = await approveDefinition(db, goalId);
      expect(approval.response).toMatchObject({ status: 200, body: { goalStatus: 'ready' } });
      const started = await call('POST', `/api/goals/${goalId}/start`, {});
      expect(started).toMatchObject({ status: 200 });

      await harness.until('review_decision_needed');
      const reviewCycle = db
        .prepare(
          "SELECT status, outcome_json FROM goal_cycles WHERE goal_id = ? AND kind = 'review' ORDER BY sequence DESC LIMIT 1",
        )
        .get(goalId) as { status: string; outcome_json: string };
      expect(reviewCycle.status).toBe('failed');
      expect(JSON.parse(reviewCycle.outcome_json)).toMatchObject({
        code: 'review_queue_error',
        queueCode: 'plan_unavailable',
      });
      expect(providerCalls.some((request) => request.role === 'final-reviewer')).toBe(false);
      expect(goalRow(db, goalId)).toMatchObject({
        status: 'needs_user',
        status_reason_code: 'review_needs_decision',
      });
      expect(proofRows(db, goalId)).toEqual([]);

      const before = wholeDatabase(db);
      const repoBefore = repositoryState(repo);
      const evaluation = await evaluateCompletion(db, goalId);
      expect(evaluation.finalReview).toMatchObject({
        required: true,
        ok: false,
        reason: 'final_review_missing',
      });
      expect(evaluation.failures.map((failure) => failure.code)).toEqual([
        'final_review_missing',
        'final_acceptance_missing',
        'external_completion_not_activated',
      ]);
      expect(wholeDatabase(db)).toEqual(before);
      expect(repositoryState(repo)).toEqual(repoBefore);
      expect(proofRows(db, goalId)).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

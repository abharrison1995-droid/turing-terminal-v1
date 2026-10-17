import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import type { GoalDefinition, GoalRole, RouteMember } from '../../shared/goals.js';
import type { GoalManualHandoffProjection } from '../../shared/goalApi.js';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';
import { decideGoalApproval, getGoalApproval } from './approvals.js';
import {
  appendAttestationCorrection,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { createGoalDraft } from './definitions.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredResolutions } from './routeResolution.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { passRecords } from './routingKit.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import { databaseSnapshot, repositoryState } from './goalV2TestKit.js';
import { cleanupRepoFixtures, milestone, reportOf, simpleDefinition } from './repoKit.js';
import { BUILT_IN_WORKFLOWS, type RealRunHarness, realRunHarness } from './turingRunKit.js';
import { discoverProviders, executeProvider, type ProviderRunRequest } from '../providers.js';

/**
 * Shared test-only helpers for the real-execution Goal lifecycle qualification files (Q1 and the correction files).
 * Test support: it registers no hooks and callers own cleanup. The provider process boundary is faked by the calling
 * test file, which mocks `../providers.js` and calls `installFakeProviders`. Everything else is real: the supervisor,
 * the RunEngine, the broker, the verifier, the review and acceptance gates, the approve/start/decision/handoff/attest
 * HTTP routes, the correction and completion services, Git and SQLite.
 *
 * Every helper that runs Git, directly or through a production service that reads Git, is listed in
 * goalRealGitTimeoutGuard.test.ts, and every test that calls one passes REAL_GIT_TEST_TIMEOUT_MS.
 */

export const FORMATS = ['sha1', 'sha256'] as const;
export type ObjectFormat = (typeof FORMATS)[number];

/** How the destination takes the Goal's source: a fast-forward, a true two-parent merge, or `merge -s ours`. */
export type IntegrationStrategy = 'fast-forward' | 'merge' | 'ours';

/** The strategy Q1 has always used for each object format. */
export const DEFAULT_INTEGRATION: Record<ObjectFormat, IntegrationStrategy> = {
  sha1: 'fast-forward',
  sha256: 'merge',
};

/** The provider roles of the review stages. The final reviewer is the `final-gate` stage, routed as `final_reviewer`. */
export const REVIEW_STAGE_ROLES: readonly string[] = ['reviewer', 'consolidator', 'final-gate'];

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
export function goldenV2Definition(finalReviewerModel = 'gpt-5.5'): GoalDefinition {
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

export const report = reportOf();

/**
 * The files the fake implementer writes. Revision 0 is the first implementation of a test and is byte-identical to the
 * one Q1 has always written. Each later revision adds a comment line, so two Goals in one repository never write the
 * same bytes: identical bytes make the second cycle fail with `no_change` once the first Goal has merged its file.
 */
export function implementationFiles(revision: number): Record<string, string> {
  const add =
    revision === 0
      ? 'export function add(a, b) { return a + b; }\n'
      : `export function add(a, b) { return a + b; }\n// goal revision ${revision}\n`;
  return {
    'src/add.js': add,
    'src/add.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.js';\ntest('add sums two numbers', () => assert.equal(add(2, 3), 5));\n",
  };
}

/** The mutable state a lifecycle test shares with its fake provider and its helpers. One object per test file. */
export interface LifecycleContext {
  harness: RealRunHarness | undefined;
  /** The HTTP app every `call` is served by: the harness app, or the app built after a restart. */
  serving: FastifyInstance | undefined;
  /** The app built on the fresh supervisor after a restart; closed by `closeLifecycle` if a test does not close it. */
  restartedApp: FastifyInstance | undefined;
  /** Every provider request of the current test. Cumulative across Goals in one test, so assertions must be Goal-scoped. */
  providerCalls: ProviderRunRequest[];
}

export const lifecycle: LifecycleContext = {
  harness: undefined,
  serving: undefined,
  restartedApp: undefined,
  providerCalls: [],
};

/** Posts a provider broker call to the app that serves the Goal now, the same route a provider CLI tool call uses. */
async function brokerThroughServing(
  token: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ error?: string; result?: string }> {
  if (!lifecycle.serving) throw new Error('The Goal HTTP app is not open.');
  const response = await lifecycle.serving.inject({
    method: 'POST',
    url: '/api/internal/provider-tools',
    headers: { authorization: `Bearer ${token}` },
    payload: { toolName, input },
  });
  return response.json() as { error?: string; result?: string };
}

/** Installs the deterministic provider fakes. Call from `beforeEach` in a file that mocks `../providers.js`. */
export function installFakeProviders(): void {
  lifecycle.providerCalls = [];
  vi.mocked(discoverProviders).mockResolvedValue([fakeClaude]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    lifecycle.providerCalls.push(request);
    if (request.role === 'planner') return fakeDone(JSON.stringify(proposal));
    if (request.role === 'implementer') {
      const revision = lifecycle.providerCalls.filter((call) => call.role === 'implementer').length - 1;
      for (const [path, content] of Object.entries(implementationFiles(revision))) {
        // Through the app that serves the Goal now: after a restart the run belongs to the restarted engine, and the
        // harness broker still posts to the pre-restart app, which does not hold this provider token.
        const written = await brokerThroughServing(request.toolBroker.token, 'write_file', { path, content });
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
}

/** Closes the apps, the harness and every fixture repository, and resets the provider mocks. Call from `afterEach`. */
export async function closeLifecycle(): Promise<void> {
  await lifecycle.restartedApp?.close();
  lifecycle.restartedApp = undefined;
  lifecycle.serving = undefined;
  await lifecycle.harness?.close();
  lifecycle.harness = undefined;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
  vi.mocked(discoverProviders).mockReset();
}

async function seedFakeRouteValidations(finalReviewerModel: string): Promise<void> {
  if (!lifecycle.harness) throw new Error('The real Goal harness is not open.');
  const db = lifecycle.harness.fx.db;
  const snapshot = await observeRouteSnapshot(db);
  const testedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(testedAt) + 6 * 24 * 60 * 60 * 1_000).toISOString();
  const insert = db.prepare(
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

/**
 * Opens the real harness on a proposed v2 definition, with the route validations the real planner requires. Git runs:
 * the fixture repository is created and the harness app is built.
 */
export async function openGoal(
  finalReviewerModel: string,
  objectFormat: ObjectFormat,
): Promise<RealRunHarness> {
  const harness = await realRunHarness({
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
  lifecycle.harness = harness;
  await seedFakeRouteValidations(finalReviewerModel);
  lifecycle.serving = harness.app;
  return harness;
}

/**
 * Adds a second Goal to the harness's database, on the same project and repository. Its definition gets the same fixes
 * as the harness's own definition: no periodic or repeated-failure review (they name workflows the approval cannot
 * resolve) and the built-in workflows. The caller approves and starts it through the same app and supervisor.
 */
export function createSecondGoal(harness: RealRunHarness, finalReviewerModel = 'gpt-5.5'): string {
  const definition = goldenV2Definition(finalReviewerModel);
  delete definition.review.periodic;
  delete definition.review.onRepeatedFailure;
  definition.routing.workflows = { ...BUILT_IN_WORKFLOWS };
  return createGoalDraft(harness.fx.db, {
    projectId: harness.fx.projectId,
    title: 'Second Goal in the same database',
    definition,
  }).goalId;
}

export const call = async (
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>,
) => {
  if (!lifecycle.serving) throw new Error('The Goal HTTP app is not open.');
  const response = await lifecycle.serving.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
};

/** Approves version 1 of one Goal through the real HTTP approve route, with its definition hash as the precondition. */
export async function approveDefinition(db: Db, goalId: string) {
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

/** The newest run of one Goal with a purpose, optionally within one cycle. Scoped by the Goal's own cycles. */
export function runFor(
  db: Db,
  goalId: string,
  purpose: string,
  cycleId?: string,
): { id: string; status: string; branch: string; worktree_path: string } {
  const row = db
    .prepare(
      `SELECT r.id, r.status, r.branch, r.worktree_path FROM runs r
       JOIN goal_cycles c ON c.id = r.goal_cycle_id
       WHERE c.goal_id = ? AND r.goal_run_purpose = ? ${cycleId ? 'AND r.goal_cycle_id = ?' : ''}
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(...(cycleId ? [goalId, purpose, cycleId] : [goalId, purpose])) as
    { id: string; status: string; branch: string; worktree_path: string } | undefined;
  if (!row) throw new Error(`No ${purpose} run was persisted for the Goal.`);
  return row;
}

/**
 * Waits until no engine-owned run is still active, the same settle the harness applies between ticks. A queued run is
 * waiting for the supervisor, not the engine, so it does not hold the wait.
 */
async function settleRuns(harness: RealRunHarness): Promise<void> {
  const db = harness.fx.db;
  await vi.waitFor(
    () => {
      const active = db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','preparing','retrying','cancelling')",
        )
        .get() as { n: number };
      const engineActive = db
        .prepare("SELECT id FROM runs WHERE status IN ('running','preparing','retrying','cancelling')")
        .all() as Array<{ id: string }>;
      if (engineActive.some((row) => harness.engine.isActive(row.id))) throw new Error('engine busy');
      return active;
    },
    { timeout: 15_000, interval: 25 },
  );
}

/**
 * Ticks one named Goal through the harness's own supervisor until the action is seen, settling between ticks. The
 * harness's `until` only ticks the fixture Goal, so a second Goal needs this form. Runs real execution through the
 * same supervisor and engine that started the Goal.
 */
export async function untilGoal(
  harness: RealRunHarness,
  goalId: string,
  action: string,
  max = 40,
): Promise<string[]> {
  const seen: string[] = [];
  for (let index = 0; index < max; index++) {
    const next = (await harness.supervisor.tickGoal(goalId)).action;
    seen.push(next);
    if (next === action) return seen;
    await settleRuns(harness);
  }
  throw new Error(`never reached ${action}: ${seen.join(', ')}`);
}

/** Every row of the Goal-scoped tables, plus the settings by key and value (reopening rewrites settings.updated_at). */
export function wholeDatabase(db: Db): ReturnType<typeof databaseSnapshot> {
  const snapshot = databaseSnapshot(db);
  const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  snapshot.digests.settings = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  return snapshot;
}

/** Tables whose digest differs between two snapshots, sorted. */
export function changedTables(
  before: ReturnType<typeof databaseSnapshot>,
  after: ReturnType<typeof databaseSnapshot>,
): string[] {
  return Object.keys(before.digests)
    .filter((table) => before.digests[table] !== after.digests[table])
    .sort();
}

/**
 * The rows that belong to one Goal, in every table that names it: its own row, rows with its `goal_id`, rows of its
 * cycles, and rows of its runs. Each table is one digest, so a changed, added or removed row of this Goal shows up.
 * Tables that name no Goal (projects, settings, route validations and the like) are not part of a Goal's rows.
 */
export function goalScopedDigests(db: Db, goalId: string): Record<string, string> {
  const digest = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const cycleIds = (
    db.prepare('SELECT id FROM goal_cycles WHERE goal_id = ? ORDER BY id').all(goalId) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
  const runIds = (
    db
      .prepare(
        'SELECT r.id FROM runs r JOIN goal_cycles c ON c.id = r.goal_cycle_id WHERE c.goal_id = ? ORDER BY r.id',
      )
      .all(goalId) as Array<{ id: string }>
  ).map((row) => row.id);
  const inList = (ids: string[]) => ids.map(() => '?').join(', ');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const digests: Record<string, string> = {};
  for (const { name } of tables) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (name === 'goals')
      digests[name] = digest(db.prepare('SELECT * FROM goals WHERE id = ? ORDER BY rowid').all(goalId));
    else if (columns.has('goal_id'))
      digests[name] = digest(
        db.prepare(`SELECT * FROM "${name}" WHERE goal_id = ? ORDER BY rowid`).all(goalId),
      );
    else if (name === 'runs' && cycleIds.length)
      digests[name] = digest(
        db
          .prepare(`SELECT * FROM runs WHERE goal_cycle_id IN (${inList(cycleIds)}) ORDER BY rowid`)
          .all(...cycleIds),
      );
    else if (columns.has('run_id') && runIds.length)
      digests[name] = digest(
        db
          .prepare(`SELECT * FROM "${name}" WHERE run_id IN (${inList(runIds)}) ORDER BY rowid`)
          .all(...runIds),
      );
  }
  return digests;
}

export interface GoalEventRow {
  seq: number;
  id: string;
  goal_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface Target {
  db: Db;
  goalId: string;
  repo: string;
}

export interface Snapshot {
  db: ReturnType<typeof databaseSnapshot>;
  repo: unknown;
  events: GoalEventRow[];
  approval: unknown;
}

export function goalEvents(db: Db, goalId: string): GoalEventRow[] {
  return db
    .prepare(
      'SELECT rowid AS seq, id, goal_id, type, payload_json, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid',
    )
    .all(goalId) as GoalEventRow[];
}

export function goalRow(
  db: Db,
  goalId: string,
): { status: string; completed_at: string | null; status_reason_code: string | null } {
  return db
    .prepare('SELECT status, completed_at, status_reason_code FROM goals WHERE id = ?')
    .get(goalId) as { status: string; completed_at: string | null; status_reason_code: string | null };
}

export function proofRows(
  db: Db,
  goalId: string,
): { id: string; proof_digest: string; payload_json: string }[] {
  return db
    .prepare('SELECT id, proof_digest, payload_json FROM goal_external_completion_proofs WHERE goal_id = ?')
    .all(goalId) as { id: string; proof_digest: string; payload_json: string }[];
}

/** The stored proof rows of a Goal, serialised: a byte comparison of what the proof table holds for it. */
export function proofRowsJson(db: Db, goalId: string): string {
  return JSON.stringify(
    db.prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid').all(goalId),
  );
}

export function snapshotOf(target: Target, approvalId: string | null): Snapshot {
  return {
    db: wholeDatabase(target.db),
    repo: repositoryState(target.repo),
    events: goalEvents(target.db, target.goalId),
    approval: approvalId === null ? null : getGoalApproval(target.db, approvalId),
  };
}

/** Tables whose rows a completion is allowed to change. Every other table must keep its digest. */
export const TABLES_A_COMPLETION_CHANGES = new Set([
  'goals',
  'goal_events',
  'goal_external_completion_proofs',
  'goal_runtime',
]);

/** Exactly one proof and exactly two new events; the rest of the database and the repository are unchanged. */
export function expectCompleted(target: Target, before: Snapshot, approvalId: string): void {
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
export interface CompletionRequest {
  goalId: string;
  attestationId: string;
  reviewedPreflightDigest: string;
  acknowledgeContentNotProven: true;
}

/** The Goal's status, completion, and stored state as the completion services read them. */
export function completedState(target: Target) {
  return {
    goal: goalRow(target.db, target.goalId),
    proofs: proofRowsJson(target.db, target.goalId),
  };
}

/**
 * Attests one observed integration through the real HTTP route. Git is read by the route's observation.
 * Returns the attestation id.
 */
export async function attestObservation(externalPath: string, actionDigest: string): Promise<string> {
  const confirmation = await call(
    'POST',
    `${externalPath}/attest`,
    { decision: 'confirm_external_integration' },
    { 'if-match': `"${actionDigest}"` },
  );
  expect(confirmation.status).toBe(201);
  return confirmation.body.attestationId as string;
}

/**
 * Records the user's decision for one attestation at its ready preflight, then completes the Goal from that decision,
 * and checks the whole-state effect of the completion. Git is read by the preflight and by the completion.
 */
export async function decideAndComplete(target: Target, attestationId: string) {
  const preflight = await computeExternalCompletionPreflight(target.db, target.goalId, { attestationId });
  expect(preflight.outcome).toBe('ready');
  const decision = await recordExternalCompletionDecision(target.db, {
    goalId: target.goalId,
    attestationId,
    reviewedPreflightDigest: preflight.digest,
    acknowledgeContentNotProven: true,
  });
  expect(decision).toMatchObject({ status: 'approved', reused: false });
  const request: CompletionRequest = {
    goalId: target.goalId,
    attestationId,
    reviewedPreflightDigest: preflight.digest,
    acknowledgeContentNotProven: true,
  };
  const before = snapshotOf(target, decision.approvalId);
  const completed = await completeGoalFromExternalDecision(target.db, request);
  expect(completed.reused).toBe(false);
  expect(completed.completion).toMatchObject({
    state: 'completed',
    approvalId: decision.approvalId,
    preflightDigest: preflight.digest,
  });
  expectCompleted(target, before, decision.approvalId);
  return { preflight, decision, request, completed };
}

/**
 * Requests, user-approves and appends one correction of an attestation through the correction services. Git is never
 * touched by a correction. Returns the approval the user decided, so a test can show it cannot be used elsewhere.
 */
export function correctAttestation(
  db: Db,
  input: {
    goalId: string;
    attestationId: string;
    correctionKind: 'dispute' | 'withdraw' | 'supersede';
    reasonCode: 'observation_error' | 'integration_not_performed' | 'superseded_by_new_observation';
    replacementAttestationId: string | null;
    explanation: string;
  },
) {
  const reviewed = requestAttestationCorrectionApproval(db, {
    goalId: input.goalId,
    attestationId: input.attestationId,
    correctionKind: input.correctionKind,
    reasonCode: input.reasonCode,
    explanation: input.explanation,
    replacementAttestationId: input.replacementAttestationId,
  });
  decideGoalApproval(db, {
    goalId: input.goalId,
    approvalId: reviewed.approval.id,
    decision: 'approved',
    decidedBy: 'user',
  });
  appendAttestationCorrection(db, {
    goalId: input.goalId,
    approvalId: reviewed.approval.id,
    expectedActionDigest: reviewed.actionDigest,
    explanation: input.explanation,
  });
  return { approval: reviewed.approval, actionDigest: reviewed.actionDigest };
}

/**
 * Steps 1 to 4 of the real lifecycle, on an already opened harness: the real approval, the bounded execution and review,
 * the restart, the prepared handoff, and the real destination integration with its verified observation. The
 * integration strategy decides how the destination takes the source. Returns what the later steps read.
 */
export async function driveToVerifiedHandoff(harness: RealRunHarness, integration: IntegrationStrategy) {
  const { db, repo, goalId } = harness.fx;
  const target: Target = { db, goalId, repo };
  // Provider requests made before this drive (a second Goal in the same test) are not this Goal's requests.
  const callsBefore = lifecycle.providerCalls.length;

  // Step 1: the v2 policy is approved through the real HTTP approve route.
  const hash = (
    db
      .prepare(
        'SELECT definition_hash AS hash FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
      )
      .get(goalId) as { hash: string }
  ).hash;
  expect(
    db.prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = 1').get(goalId),
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
  const proposalRun = runFor(db, goalId, 'proposal');
  await vi.waitFor(() => expect(harness.runRow(proposalRun.id).status).toBe('completed'), {
    timeout: 20_000,
  });
  await harness.until('proposal_recorded');

  await harness.until('run_started');
  const executionId = runFor(db, goalId, 'execution', harness.cycleId()).id;
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
  const reviewRun = runFor(db, goalId, 'review', reviewCycle.id);
  await vi.waitFor(
    () => {
      const status = harness.runRow(reviewRun.id).status;
      if (status === 'failed') {
        const stages = db
          .prepare('SELECT kind, status, error FROM stages WHERE run_id = ? ORDER BY sequence')
          .all(reviewRun.id);
        throw new Error(
          `Review run failed: ${JSON.stringify(stages)}; provider roles: ${lifecycle.providerCalls.map((call) => call.role).join(',')}`,
        );
      }
      expect(status).toBe('completed');
    },
    { timeout: 25_000 },
  );
  const resolutionJson = (
    db.prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ?').get(reviewCycle.id) as {
      json: string;
    }
  ).json;
  expect(readStoredResolutions(resolutionJson).final_reviewer?.selected.configuration.modelId).toBe(
    'gpt-5.5',
  );
  // The final-gate stage is the final reviewer: it ran once, on the routed model, not on the implementer's model.
  const thisGoalCalls = lifecycle.providerCalls.slice(callsBefore);
  expect(thisGoalCalls.filter((call) => call.role === 'final-gate').map((call) => call.modelId)).toEqual([
    'gpt-5.5',
  ]);
  expect(thisGoalCalls.filter((call) => call.role === 'implementer').map((call) => call.modelId)).toEqual([
    'claude-opus-5-5',
  ]);
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
  // The harness now ticks through the restarted supervisor and engine, the ones the restarted app uses, so a Goal that is
  // started after the restart is ticked by the supervisor that started it.
  harness.supervisor = restarted.supervisor;
  lifecycle.restartedApp = createApp({
    database: db,
    engine: restarted.engine,
    goalSupervisor: restarted.supervisor,
  });
  await lifecycle.restartedApp.ready();
  lifecycle.serving = lifecycle.restartedApp;
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
  expect(db.prepare('SELECT status, decided_by FROM goal_approvals WHERE id = ?').get(acceptance.id)).toEqual(
    {
      status: 'approved',
      decided_by: 'user',
    },
  );
  expect(goalRow(db, goalId)).toMatchObject({ status: 'needs_user' });
  const resumed = await call('POST', `/api/goals/${goalId}/resume`, { reason: 'gate_resolved' });
  expect(resumed).toMatchObject({ status: 200, body: { ok: true, goalStatus: 'running' } });
  const next = await restarted.supervisor.tickGoal(goalId);
  expect(next.action).toBe('completion_pending');
  const evaluation = await evaluateCompletion(db, goalId);
  expect(evaluation.failures.map((failure) => failure.code)).toEqual(['external_completion_not_activated']);
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

  if (integration === 'fast-forward') harness.fx.git('merge', '--ff-only', ref);
  else {
    // A destination-only commit makes the following merge a true two-parent merge: the source is not the destination's tip.
    writeFileSync(join(repo, 'unrelated.txt'), 'destination-only change\n');
    harness.fx.git('add', 'unrelated.txt');
    harness.fx.git('commit', '-m', 'user advances destination independently');
    if (integration === 'merge') harness.fx.git('merge', '--no-ff', '--no-edit', ref);
    else harness.fx.git('merge', '--no-ff', '--no-edit', '-s', 'ours', ref);
  }
  const destinationHead = harness.fx.git('rev-parse', 'main');
  if (integration === 'fast-forward') expect(destinationHead).toBe(integratedHead);
  else
    expect(harness.fx.git('rev-list', '--parents', '-n', '1', 'main').split(' ')).toContain(integratedHead);
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
  return {
    harness,
    db,
    repo,
    goalId,
    target,
    externalPath,
    handoffId,
    observation,
    afterIntegration,
    integratedHead,
  };
}

/** Opens the harness for a Goal and drives it to its verified handoff, with the integration Q1 uses for the format. */
export async function openAndDriveToVerifiedHandoff(
  objectFormat: ObjectFormat,
  integration = DEFAULT_INTEGRATION[objectFormat],
) {
  const harness = await openGoal('gpt-5.5', objectFormat);
  return driveToVerifiedHandoff(harness, integration);
}

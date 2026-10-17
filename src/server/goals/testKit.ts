import type { GoalDefinition } from '../../shared/goals.js';

/** A fully valid definition used by the Goal tests. Always returns a fresh deep copy. */
export function validDefinition(): GoalDefinition {
  const member = (modelId: string) => ({
    configuration: {
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: 'opencode-go-subscription' as const,
      modelId,
    },
    identityKind: 'pinned' as const,
    freshnessClass: 'stable-subscription' as const,
  });
  const pinned = (modelId: string) => ({
    kind: 'pinned' as const,
    member: member(modelId),
    availability: 'live-catalog-or-fresh-validation' as const,
    requireRoleValidation: true,
  });
  return structuredClone({
    contract: {
      outcome: 'Ship the parser',
      successCriteria: [
        {
          key: 'builds',
          statement: 'The project builds',
          verification: [{ kind: 'build', command: ['npm', 'run', 'build'] }],
          required: true,
        },
        {
          key: 'tests',
          statement: 'Tests pass',
          verification: [{ kind: 'test' }, { kind: 'review_verdict', reviewKind: 'final' }],
          required: true,
        },
      ],
      nonGoals: ['UI work'],
      constraints: ['No new dependencies'],
      deliverables: [
        { key: 'parser', description: 'The parser', path: 'src/parser.ts', criterionKeys: ['tests'] },
      ],
      completionPolicy: {
        requireFinalReview: true,
        requireUserAcceptance: true,
        applyToBase: 'required',
        maxOpenFindings: { critical: 0, high: 0 },
        highSeverityResolution: 'review-plus-head-bound-verifier',
      },
    },
    milestones: [
      {
        key: 'core',
        title: 'Core',
        objective: 'Build the core',
        criteria: ['builds'],
        dependsOn: [],
        allowedScope: { includeGlobs: ['src/**'], excludeGlobs: ['src/generated/**'] },
        requiredEvidence: [{ criterionKey: 'builds', kinds: ['build_result'] }],
        reviewRequirements: { milestoneReview: true },
      },
      {
        key: 'polish',
        title: 'Polish',
        objective: 'Test and polish',
        criteria: ['tests'],
        dependsOn: ['core'],
        allowedScope: { includeGlobs: ['src/**', 'docs/**'], excludeGlobs: [] },
        requiredEvidence: [{ criterionKey: 'tests', kinds: ['test_result', 'review_verdict'] }],
        reviewRequirements: { milestoneReview: false },
      },
    ],
    routing: {
      roles: {
        orchestrator: pinned('orch'),
        implementer: pinned('impl'),
        routine_reviewer: { kind: 'pool', poolId: 'reviewers' },
        milestone_reviewer: { kind: 'pool', poolId: 'reviewers' },
        final_reviewer: pinned('final'),
      },
      pools: [
        {
          id: 'reviewers',
          label: 'Reviewers',
          members: [member('rev-a'), member('rev-b')],
          admission: 'static',
          availability: 'live-catalog-or-fresh-validation',
          requireRoleValidation: true,
          selection: 'ordered',
          laneClass: 'subscription',
          autoRevalidate: false,
        },
      ],
      workflows: {
        planning: 'wf-plan',
        execution: 'wf-exec',
        review: 'wf-review',
        verification: 'wf-verify',
      },
      independence: {
        finalReview: 'different-family',
        against: ['implementer', 'remediation'],
        allowFloatingFinalReviewer: false,
      },
    },
    review: {
      periodic: { everyNExecutionCycles: 3, reviewerCount: 2, scope: 'since_last_review' },
      onMilestoneComplete: true,
      onRepeatedFailure: { afterConsecutiveFailures: 2 },
      final: true,
      blocking: { periodic: false, milestone: true, final: true },
    },
    limits: {
      maxExecutionCycles: 20,
      maxConsecutiveFailedCycles: 4,
      maxRemediationAttempts: 3,
      maxActiveMinutes: 600,
      maxWallClockDays: 7,
      maxParallelAgents: 3,
      maxMeteredUsd: null,
      billingMode: 'subscriptions-only',
      humanGates: {
        eachCycle: false,
        beforeMilestoneComplete: false,
        poolRouteFirstUse: true,
        finalAcceptance: true,
      },
    },
  } satisfies GoalDefinition);
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import type { GoalStatus } from '../../shared/goals.js';
import { approveDefinition, createGoalDraft } from './definitions.js';

const folders: string[] = [];
const databases: Db[] = [];

/** Closes every database opened by `freshDatabase`, then removes its folder. Call from `afterEach`. */
export function cleanupTestDatabases(): void {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
}

export function freshDatabase(): Db {
  const root = mkdtempSync(join(tmpdir(), 'turing-goals-'));
  folders.push(root);
  const db = openDatabase(root);
  databases.push(db);
  return db;
}

export function seedProject(db: Db, name = 'P'): string {
  const machine = (
    db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
  ).value;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
  ).run(id, machine, name, `/tmp/${id}`);
  return id;
}

/**
 * A Goal with an approved version 1, forced (by direct SQL, bypassing the state machine) into `status` so a test
 * can start from any state. 'draft' keeps the approved version, as a ready Goal reopened for revision would.
 */
export function goalAt(db: Db, projectId: string, status: GoalStatus): string {
  const { goalId } = createGoalDraft(db, { projectId, title: 'G', definition: validDefinition() });
  approveDefinition(db, { goalId, version: 1, actor: 'user' });
  db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, goalId);
  return goalId;
}

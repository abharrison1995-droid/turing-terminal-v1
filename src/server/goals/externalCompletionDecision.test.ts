import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import {
  bindExactGate,
  decideGoalApproval,
  getGoalApproval,
  GoalApprovalError,
  requestGoalApproval,
} from './approvals.js';
import {
  appendAttestationCorrection,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';
import { completeGoal } from './completion.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { buildExternalCompletionAction, parseExternalCompletionAction } from './externalCompletionProof.js';
import {
  ExternalCompletionDecisionError,
  listExternalCompletionDecisions,
  readExternalCompletionDecision,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import {
  computeExternalCompletionPreflight,
  externalCompletionPreflightReportSchema,
  type ExternalCompletionPreflightReport,
} from './externalCompletionPreflight.js';
import {
  assertFinalApplyApprovalDatabaseCurrent,
  validateFinalApplyAuthority,
} from './finalApplyAuthority.js';
import { decideGoalApprovalAsUser } from './goalCommands.js';
import {
  acceptedFixture,
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { GoalStateError, transitionGoal } from './stateMachine.js';
import { cleanupRepoFixtures, copyGoalApprovalRow, REAL_GIT_TEST_TIMEOUT_MS, testDigest } from './repoKit.js';

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;

type Attested = Awaited<ReturnType<typeof v2RunningAttestedFixture>>;

function emptyChainDigest(attestationId: string, recordDigest: string): string {
  // Written out by hand, not through the service, so the expected digest is independent of the implementation.
  const canonical = `{"attestationId":"${attestationId}","attestationRecordDigest":"${recordDigest}","kind":"turing_goal_external_integration_correction_chain","schemaVersion":1,"sequence":0,"tipCorrectionDigest":null}`;
  return createHash('sha256')
    .update('turing-goal-attestation-correction-chain-v1')
    .update('\0')
    .update(canonical)
    .digest('hex');
}

function startGoal(db: Db, goalId: string): void {
  transitionGoal(db, {
    goalId,
    to: 'running',
    reasonCode: 'user_start',
    actor: 'user',
    preconditions: [{ code: 'preflight', ok: true }],
  });
}

function rewriteStoredContract(fx: GoalFixture, mutate: (contract: Record<string, unknown>) => void): void {
  const row = fx.db
    .prepare('SELECT contract_json FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
    .get(fx.goalId) as { contract_json: string };
  const contract = JSON.parse(row.contract_json) as Record<string, unknown>;
  mutate(contract);
  fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
  fx.db
    .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = 1')
    .run(JSON.stringify(contract), fx.goalId);
}

/** Moves the destination base ref to a commit that keeps the attested tree but drops the accepted source. */
function moveTip(attested: Attested): string {
  return git(
    attested.fx.repo,
    'commit-tree',
    attested.attestation.destination.observedTree,
    '-p',
    attested.attestation.destination.observedCommit,
    '-m',
    'destination moved after observation',
  );
}

function decisionInput(
  goalId: string,
  attestationId: string,
  digest: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    goalId,
    attestationId,
    reviewedPreflightDigest: digest,
    acknowledgeContentNotProven: true,
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

async function expectDecisionRefusal(
  promise: Promise<unknown>,
  code: string,
  detail: string | null,
): Promise<void> {
  const error = await captureError(promise);
  expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
  expect(error).toMatchObject({ code, detail });
}

function goalEvents(db: Db): Record<string, unknown>[] {
  return db
    .prepare('SELECT id, goal_id, type, payload_json, created_at FROM goal_events ORDER BY rowid')
    .all() as Record<string, unknown>[];
}

function completionRows(db: Db, goalId: string): { id: string; status: string; digest: string }[] {
  return db
    .prepare(
      `SELECT id, status, external_completion_action_digest AS digest FROM goal_approvals
       WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL ORDER BY created_at, rowid`,
    )
    .all(goalId) as { id: string; status: string; digest: string }[];
}

function goalState(db: Db, goalId: string): unknown {
  return db.prepare('SELECT status, completed_at AS completedAt FROM goals WHERE id = ?').get(goalId);
}

function proofCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get() as { n: number }).n;
}

interface Captured {
  snapshot: ReturnType<typeof databaseSnapshot>;
  events: Record<string, unknown>[];
  repo: unknown;
}

function capture(attested: Attested): Captured {
  return {
    snapshot: databaseSnapshot(attested.fx.db),
    events: goalEvents(attested.fx.db),
    repo: repositoryState(attested.fx.repo),
  };
}

/** Every table is unchanged, including approvals and events. */
function expectNoChange(attested: Attested, before: Captured): void {
  expect(databaseSnapshot(attested.fx.db)).toEqual(before.snapshot);
  expect(goalEvents(attested.fx.db)).toEqual(before.events);
  expect(repositoryState(attested.fx.repo)).toEqual(before.repo);
}

/**
 * Only one approval and its two events changed. Every other table keeps its digest. The old event rows are a
 * byte-equal prefix, and the new events are exactly one request and one decision.
 */
function expectOnlyApprovalChange(attested: Attested, before: Captured): void {
  const after = databaseSnapshot(attested.fx.db);
  for (const table of Object.keys(before.snapshot.digests)) {
    if (table === 'goal_approvals' || table === 'goal_events') continue;
    expect(after.digests[table], table).toBe(before.snapshot.digests[table]);
    expect(after.counts[table], table).toBe(before.snapshot.counts[table]);
  }
  expect(after.counts.goal_approvals).toBe(before.snapshot.counts.goal_approvals + 1);
  const events = goalEvents(attested.fx.db);
  expect(events.slice(0, before.events.length)).toEqual(before.events);
  expect(events.slice(before.events.length).map((event) => event.type)).toEqual([
    'approval_requested',
    'approval_decided',
  ]);
  expect(repositoryState(attested.fx.repo)).toEqual(before.repo);
}

/** The approval detail a reviewer would rebuild independently from the ready preflight report. */
async function rebuiltAction(attested: Attested, report: ExternalCompletionPreflightReport) {
  const action = buildExternalCompletionAction({
    ...report.actionFields!,
    contentOutcomeAcknowledged: true,
    userReviewedPreflightDigest: report.digest,
  });
  expect(action).not.toBeNull();
  return action!;
}

/** Seeds one completion approval row through the request service, optionally decided as the user. */
async function seedCompletion(
  attested: Attested,
  options: { attestationId?: string; digest?: string; decide?: 'user' | 'system' | null } = {},
) {
  const db = attested.fx.db;
  const attestationId = options.attestationId ?? attested.attestationId;
  const report = await computeExternalCompletionPreflight(
    db,
    attested.fx.goalId,
    { attestationId },
    {
      allowRecordedDecision: true,
    },
  );
  const body = {
    ...report.actionFields!,
    contentOutcomeAcknowledged: true,
    userReviewedPreflightDigest: options.digest ?? report.digest,
  };
  const action = buildExternalCompletionAction(body);
  if (action === null) throw new Error('seedCompletion: action body is not valid');
  const approval = requestGoalApproval(db, {
    goalId: attested.fx.goalId,
    gate: 'user_confirmation',
    risk: 'high',
    reason: 'Seeded completion approval for a decision test.',
    requestedBy: 'user',
    detail: { ...action },
    externalCompletionActionDigest: action.actionDigest,
  });
  if (options.decide)
    decideGoalApproval(db, {
      goalId: attested.fx.goalId,
      approvalId: approval.id,
      decision: 'approved',
      decidedBy: options.decide,
    });
  return { approval, action };
}

describe('external completion decision: the accepted decision', () => {
  it.each(FORMATS)(
    'D1 records one approved user decision bound to the reviewed preflight under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const report = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attested.attestationId,
      });
      const digest = await reviewedDigest(attested);
      expect(digest).toBe(report.digest);
      expect(externalCompletionPreflightReportSchema.parse(report)).toEqual(report);
      const before = capture(attested);

      const result = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );

      expect(result).toEqual({
        approvalId: expect.any(String),
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        preflightDigest: digest,
        status: 'approved',
        reused: false,
      });
      const row = getGoalApproval(db, result.approvalId)!;
      expect(row).toMatchObject({
        gate: 'user_confirmation',
        risk: 'high',
        requestedBy: 'user',
        status: 'approved',
        decidedBy: 'user',
        externalCompletionActionDigest: result.actionDigest,
      });
      const rebuilt = await rebuiltAction(attested, report);
      expect(row.detail).toEqual(rebuilt);
      expect(rebuilt.actionDigest).toBe(result.actionDigest);
      expect(rebuilt.userReviewedPreflightDigest).toBe(report.digest);
      expect(rebuilt.correctionChain.digest).toBe(
        emptyChainDigest(attested.attestationId, attested.attestation.recordDigest),
      );
      expect(parseExternalCompletionAction(row.detail)).toMatchObject({
        valid: true,
        digest: result.actionDigest,
      });
      expect(readExternalCompletionDecision(db, goalId, result.approvalId)).toMatchObject({
        state: 'valid',
        approval: { id: result.approvalId },
        action: { actionDigest: result.actionDigest },
      });
      expectOnlyApprovalChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: input and action validation', () => {
  it(
    'D2 refuses an unknown input key, an unacknowledged decision, and a malformed completion action',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const before = capture(attested);

      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, {
          ...decisionInput(goalId, attested.attestationId, digest),
          actor: 'user',
        }),
        'decision_input_invalid',
        null,
      );
      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, {
          ...decisionInput(goalId, attested.attestationId, digest),
          repositoryRoot: '/x',
        }),
        'decision_input_invalid',
        null,
      );
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          db,
          decisionInput(goalId, attested.attestationId, digest, { acknowledgeContentNotProven: false }),
        ),
        'acknowledgement_required',
        null,
      );
      expectNoChange(attested, before);

      const report = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attested.attestationId,
      });
      const action = await rebuiltAction(attested, report);
      const missingKey: Record<string, unknown> = { ...action };
      delete missingKey.goalId;
      const missing = catchSync(() =>
        requestGoalApproval(db, {
          goalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'Malformed completion action.',
          requestedBy: 'user',
          detail: missingKey,
          externalCompletionActionDigest: action.actionDigest,
        }),
      );
      expect(missing).toBeInstanceOf(GoalApprovalError);
      expect(missing).toMatchObject({ code: 'invalid_external_completion_action_digest' });

      const wrongVersion = catchSync(() =>
        requestGoalApproval(db, {
          goalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'Malformed completion action.',
          requestedBy: 'user',
          detail: { ...action, schemaVersion: 2 },
          externalCompletionActionDigest: action.actionDigest,
        }),
      );
      expect(wrongVersion).toMatchObject({ code: 'invalid_external_completion_action_digest' });
      expect(completionRows(db, goalId)).toEqual([]);
      expectNoChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D2b rejects a raw completion row whose detail lacks one body key, and a row claiming the wrong requester',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const report = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attested.attestationId,
      });
      const action = await rebuiltAction(attested, report);
      const missingKey: Record<string, unknown> = { ...action };
      delete missingKey.goalId;
      const insert = db.prepare(
        `INSERT INTO goal_approvals (
           id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at,
           external_completion_action_digest
         ) VALUES (?, ?, 'user_confirmation', 'high', 'raw', ?, ?, 'pending', ?, ?)`,
      );
      expect(() =>
        insert.run(
          randomUUID(),
          goalId,
          'user',
          JSON.stringify(missingKey),
          new Date().toISOString(),
          action.actionDigest,
        ),
      ).toThrow('external completion approval action digest is invalid');
      expect(() =>
        insert.run(
          randomUUID(),
          goalId,
          'user',
          JSON.stringify({ ...action }),
          new Date().toISOString(),
          action.actionDigest,
        ),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_approvals (
               id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at,
               external_completion_action_digest
             ) VALUES (?, ?, 'user_confirmation', 'high', 'raw', 'supervisor', ?, 'pending', ?, ?)`,
          )
          .run(
            randomUUID(),
            goalId,
            JSON.stringify({ ...action, actionDigest: 'e'.repeat(64) }),
            new Date().toISOString(),
            'e'.repeat(64),
          ),
      ).toThrow('external completion approval action digest is invalid');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: refusals from the preflight', () => {
  it(
    'D3 refuses an unknown attestation, an unknown Goal, and another Goal digest',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const other = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const digest = await reviewedDigest(attested);
      const otherDigest = await reviewedDigest(other);
      const before = capture(attested);

      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, decisionInput(attested.fx.goalId, randomUUID(), digest)),
        'preflight_refused',
        'attestation_not_found',
      );
      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, decisionInput(randomUUID(), attested.attestationId, digest)),
        'preflight_refused',
        'goal_not_found',
      );
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          db,
          decisionInput(attested.fx.goalId, attested.attestationId, otherDigest),
        ),
        'reviewed_preflight_changed',
        null,
      );
      expectNoChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4 refuses a corrupted stored definition and a version-1 definition',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const digest = await reviewedDigest(attested);
      rewriteStoredContract(attested.fx, (contract) => {
        contract.outcome = 'A different outcome stored after approval.';
      });
      const before = capture(attested);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          attested.fx.db,
          decisionInput(attested.fx.goalId, attested.attestationId, digest),
        ),
        'preflight_refused',
        'definition_not_approved',
      );
      expectNoChange(attested, before);

      const accepted = await acceptedFixture('sha1');
      startGoal(accepted.fx.db, accepted.fx.goalId);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          accepted.fx.db,
          decisionInput(accepted.fx.goalId, randomUUID(), 'a'.repeat(64)),
        ),
        'preflight_refused',
        'definition_not_v2',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D6 refuses a tampered immutable handoff',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const digest = await reviewedDigest(attested);
      attested.fx.db.exec('DROP TRIGGER trg_goal_result_handoff_immutable;');
      const stored = attested.fx.db
        .prepare('SELECT payload_json FROM goal_result_handoffs WHERE id = ?')
        .get(attested.handoff.handoffId) as { payload_json: string };
      attested.fx.db
        .prepare('UPDATE goal_result_handoffs SET payload_json = ? WHERE id = ?')
        .run(
          JSON.stringify({ ...JSON.parse(stored.payload_json), tampered: true }),
          attested.handoff.handoffId,
        );
      const before = capture(attested);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          attested.fx.db,
          decisionInput(attested.fx.goalId, attested.attestationId, digest),
        ),
        'preflight_refused',
        'handoff_invalid',
      );
      expectNoChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D7 refuses a tampered attestation and a disputed attestation',
    async () => {
      const tampered = await v2RunningAttestedFixture('sha1');
      const tamperedDigest = await reviewedDigest(tampered);
      const payload = { ...tampered.attestation, observedAt: '2020-01-01T00:00:00.000Z' };
      tampered.fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      tampered.fx.db
        .prepare(
          'UPDATE goal_external_integration_attestations SET payload_json = ?, observed_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(payload), payload.observedAt, tampered.attestationId);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          tampered.fx.db,
          decisionInput(tampered.fx.goalId, tampered.attestationId, tamperedDigest),
        ),
        'preflight_refused',
        'attestation_invalid',
      );

      const disputed = await v2RunningAttestedFixture('sha1');
      const disputedDigest = await reviewedDigest(disputed);
      appendCorrectionForTest(disputed.fx, disputed.attestationId, 'dispute');
      const before = capture(disputed);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          disputed.fx.db,
          decisionInput(disputed.fx.goalId, disputed.attestationId, disputedDigest),
        ),
        'preflight_refused',
        'attestation_disputed',
      );
      expectNoChange(disputed, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D8 refuses a reviewed digest after the destination moved, and after a correction',
    async () => {
      const moved = await v2RunningAttestedFixture('sha1');
      const reviewed = await reviewedDigest(moved);
      git(moved.fx.repo, 'update-ref', moved.handoff.target.baseRef, moveTip(moved));
      const before = capture(moved);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          moved.fx.db,
          decisionInput(moved.fx.goalId, moved.attestationId, reviewed),
        ),
        'preflight_refused',
        'destination_advanced_after_observation',
      );
      expectNoChange(moved, before);

      const disputed = await v2RunningAttestedFixture('sha1');
      const stale = await reviewedDigest(disputed);
      appendCorrectionForTest(disputed.fx, disputed.attestationId, 'dispute');
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          disputed.fx.db,
          decisionInput(disputed.fx.goalId, disputed.attestationId, stale),
        ),
        'preflight_refused',
        'attestation_disputed',
      );
      expect(completionRows(disputed.fx.db, disputed.fx.goalId)).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: authority and copies', () => {
  it(
    'D12 keeps a pending completion row out of the generic decision routes and out of the requester list',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const { approval, action } = await seedCompletion(attested);
      const before = capture(attested);

      expect(
        catchSync(() =>
          decideGoalApproval(db, {
            goalId,
            approvalId: approval.id,
            decision: 'approved',
            decidedBy: 'system',
          }),
        ),
      ).toMatchObject({ code: 'user_decision_required' });
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'completion_decision_requires_dedicated_service' });
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'denied' }),
      ).rejects.toMatchObject({ code: 'completion_decision_requires_dedicated_service' });
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });

      for (const [requestedBy, gate, risk] of [
        ['supervisor', 'user_confirmation', 'high'],
        ['system', 'user_confirmation', 'high'],
        ['user', 'final_apply', 'high'],
        ['user', 'user_confirmation', 'medium'],
      ] as const)
        expect(
          catchSync(() =>
            requestGoalApproval(db, {
              goalId,
              gate,
              risk,
              reason: 'Refused completion request.',
              requestedBy: requestedBy as never,
              detail: { ...action },
              externalCompletionActionDigest: action.actionDigest,
            }),
          ),
        ).toMatchObject({ code: 'invalid_external_completion_action_digest' });
      expectNoChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D13 refuses a copied external integration approval as a completion and keeps the reader invalid',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const copied = catchSync(() =>
        requestGoalApproval(db, {
          goalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'Copied external integration approval.',
          requestedBy: 'user',
          detail: { ...attested.approval.detail },
          externalCompletionActionDigest: 'a'.repeat(64),
        }),
      );
      expect(copied).toMatchObject({ code: 'invalid_external_completion_action_digest' });
      expect(readExternalCompletionDecision(db, goalId, attested.approval.id)).toEqual({
        state: 'invalid',
        approvalId: attested.approval.id,
        reason: 'not_completion_approval',
      });

      const digest = await reviewedDigest(attested);
      const result = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );
      expect(result.approvalId).not.toBe(attested.approval.id);
      expect(result.reused).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D14 refuses a copied correction approval and records a decision for a fresh attestation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      appendCorrectionForTest(attested.fx, attested.attestationId, 'dispute');
      const correction = db
        .prepare(
          'SELECT id, detail_json FROM goal_approvals WHERE goal_id = ? AND attestation_correction_action_digest IS NOT NULL',
        )
        .get(goalId) as { id: string; detail_json: string };
      const copied = catchSync(() =>
        requestGoalApproval(db, {
          goalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'Copied correction approval.',
          requestedBy: 'user',
          detail: JSON.parse(correction.detail_json) as Record<string, unknown>,
          externalCompletionActionDigest: 'a'.repeat(64),
        }),
      );
      expect(copied).toMatchObject({ code: 'invalid_external_completion_action_digest' });
      expect(readExternalCompletionDecision(db, goalId, correction.id)).toMatchObject({
        state: 'invalid',
        reason: 'not_completion_approval',
      });

      git(attested.fx.repo, 'update-ref', attested.handoff.target.baseRef, moveTip(attested));
      const fresh = await reattestAtCurrentTip(attested);
      const freshDigest = await reviewedDigest({ fx: attested.fx, attestationId: fresh.attestationId });
      const result = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, fresh.attestationId, freshDigest),
      );
      expect(result).toMatchObject({ status: 'approved', reused: false });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D15 treats an applied_externally final_apply approval as no completion decision',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const legacy = requestGoalApproval(db, {
        goalId,
        gate: 'final_apply',
        risk: 'high',
        reason: 'Historical applied_externally approval.',
        requestedBy: 'user',
        detail: {
          action: 'applied_externally',
          definitionVersion: 1,
          definitionHash: 'a'.repeat(64),
          integrationHead: 'b'.repeat(40),
        },
      });
      decideGoalApproval(db, { goalId, approvalId: legacy.id, decision: 'approved', decidedBy: 'user' });
      expect(readExternalCompletionDecision(db, goalId, legacy.id)).toEqual({
        state: 'invalid',
        approvalId: legacy.id,
        reason: 'not_completion_approval',
      });
      const evaluation = await evaluateCompletion(db, goalId);
      expect(evaluation.finalApply).toMatchObject({ ok: false, reason: 'external_completion_not_activated' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D17 refuses a conflicting decision for the same attestation and ignores one for another attestation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const report = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        {
          allowRecordedDecision: true,
        },
      );

      const conflicting = buildExternalCompletionAction({
        ...report.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: 'f'.repeat(64),
      })!;
      const conflict = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Conflicting decision for the same attestation.',
        requestedBy: 'user',
        detail: { ...conflicting },
        externalCompletionActionDigest: conflicting.actionDigest,
      });
      decideGoalApproval(db, { goalId, approvalId: conflict.id, decision: 'approved', decidedBy: 'user' });
      const before = capture(attested);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest)),
        'decision_conflict',
        null,
      );
      expectNoChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D22 refuses a decision for a second attestation as a competing decision while the first is eligible, and records nothing',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const db = decided.fx.db;
      const goalId = decided.fx.goalId;
      git(decided.fx.repo, 'update-ref', decided.handoff.target.baseRef, moveTip(decided));
      const second = await reattestAtCurrentTip(decided);
      // The second attestation's preflight is refused as a competing decision, so this digest belongs to a refused
      // report. The refusal comes before any digest comparison, so the digest value is not what is being tested.
      const refusedDigest = (
        await computeExternalCompletionPreflight(
          db,
          goalId,
          { attestationId: second.attestationId },
          { allowRecordedDecision: true },
        )
      ).digest;
      const before = capture(decided);

      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, decisionInput(goalId, second.attestationId, refusedDigest)),
        'competing_decision',
        null,
      );
      expectNoChange(decided, before);
      expect(completionRows(db, goalId).map((row) => row.id)).toEqual([decided.recorded.approvalId]);
      expect(proofCount(db)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['dispute', 'withdraw', 'supersede'] as const)(
    'D23 records a decision for a second attestation once the first is corrected (%s), then reuses it',
    async (kind) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const db = fx.db;
      const goalId = fx.goalId;
      const firstRow = db
        .prepare('SELECT * FROM goal_approvals WHERE id = ?')
        .get(decided.recorded.approvalId);
      let second: Awaited<ReturnType<typeof reattestAtCurrentTip>>;
      if (kind === 'supersede') {
        // A supersede names its replacement, so the replacement is attested at the moved tip before the correction.
        git(fx.repo, 'update-ref', decided.handoff.target.baseRef, moveTip(decided));
        second = await reattestAtCurrentTip(decided);
        appendCorrectionForTest(fx, decided.attestationId, kind, second.attestationId);
      } else {
        appendCorrectionForTest(fx, decided.attestationId, kind);
        git(fx.repo, 'update-ref', decided.handoff.target.baseRef, moveTip(decided));
        second = await reattestAtCurrentTip(decided);
      }
      const digest = await reviewedDigest({ fx, attestationId: second.attestationId });

      const recorded = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, second.attestationId, digest),
      );
      expect(recorded).toMatchObject({ status: 'approved', reused: false, preflightDigest: digest });
      expect(completionRows(db, goalId).map((row) => row.id)).toEqual([
        decided.recorded.approvalId,
        recorded.approvalId,
      ]);
      // The corrected decision is untouched: the new decision is a new row, not an edit of the old one.
      expect(
        db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(decided.recorded.approvalId),
      ).toEqual(firstRow);
      expect(readExternalCompletionDecision(db, goalId, recorded.approvalId)).toMatchObject({
        state: 'valid',
        action: { attestation: { id: second.attestationId } },
      });
      // Only the new decision is eligible. The corrected one stays a valid row that cannot complete the Goal.
      const classification = classifyCompletionAuthority(db, goalId, second.attestationId);
      expect(classification).toMatchObject({ class: 2, proofIds: [] });
      expect(
        classification.entries.find((entry) => entry.decisionId === decided.recorded.approvalId),
      ).toMatchObject({ attestationId: decided.attestationId, eligible: false });
      expect(classification.entries.find((entry) => entry.decisionId === recorded.approvalId)).toMatchObject({
        attestationId: second.attestationId,
        eligible: true,
      });
      expect(proofCount(db)).toBe(0);
      expect(goalState(db, goalId)).toEqual({ status: 'running', completedAt: null });

      const repeat = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, second.attestationId, digest),
      );
      expect(repeat).toEqual({ ...recorded, reused: true });
      expect(completionRows(db, goalId)).toHaveLength(2);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: reuse, corruption and inert checks', () => {
  it.each(FORMATS)(
    'D16 reuses an exact duplicate decision serially, with zero writes after the first under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const before = capture(attested);
      const request = () =>
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest));

      const first = await request();
      expect(first.reused).toBe(false);
      expectOnlyApprovalChange(attested, before);

      const repeat = await request();
      expect(repeat).toEqual({ ...first, reused: true });
      expect(completionRows(db, goalId)).toHaveLength(1);
      expectOnlyApprovalChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D17b refuses a decision while a completion row names an attestation that does not exist',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const report = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        {
          allowRecordedDecision: true,
        },
      );
      const foreign = randomUUID();
      const fields = report.actionFields as Record<string, Record<string, unknown>>;
      const foreignAction = buildExternalCompletionAction({
        ...fields,
        attestation: { ...fields.attestation, id: foreign },
        correctionChain: { ...fields.correctionChain, attestationId: foreign },
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: 'e'.repeat(64),
      })!;
      const other = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Decision for another attestation.',
        requestedBy: 'user',
        detail: { ...foreignAction },
        externalCompletionActionDigest: foreignAction.actionDigest,
      });
      decideGoalApproval(db, { goalId, approvalId: other.id, decision: 'approved', decidedBy: 'user' });
      const before = capture(attested);

      // The fabricated attestation is class 5 history: the decision for the real attestation is refused, not ignored.
      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest)),
        'preflight_refused',
        'completion_history_invalid',
      );
      expectNoChange(attested, before);
      expect(readExternalCompletionDecision(db, goalId, other.id)).toMatchObject({
        state: 'valid',
        action: { attestation: { id: foreign } },
      });
      // Only the foreign row exists: the refused decision wrote nothing.
      expect(listExternalCompletionDecisions(db, goalId).map((entry) => entry.state)).toEqual(['valid']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D18 refuses every new decision for a Goal with a corrupt completion row',
    async () => {
      const flipped = await v2RunningAttestedFixture('sha1');
      const flippedDigest = await reviewedDigest(flipped);
      const seededFlipped = await seedCompletion(flipped, { decide: 'user' });
      flipped.fx.db.exec('DROP TRIGGER trg_goal_approval_identity;');
      flipped.fx.db.exec('DROP TRIGGER trg_goal_approval_terminal;');
      flipped.fx.db
        .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
        .run(
          JSON.stringify({ ...seededFlipped.action, userReviewedPreflightDigest: 'e'.repeat(64) }),
          seededFlipped.approval.id,
        );
      expect(
        readExternalCompletionDecision(flipped.fx.db, flipped.fx.goalId, seededFlipped.approval.id),
      ).toEqual({
        state: 'invalid',
        approvalId: seededFlipped.approval.id,
        reason: 'digest_mismatch',
      });
      let before = capture(flipped);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          flipped.fx.db,
          decisionInput(flipped.fx.goalId, flipped.attestationId, flippedDigest),
        ),
        'decision_corrupt',
        'digest_mismatch',
      );
      expectNoChange(flipped, before);

      const pending = await v2RunningAttestedFixture('sha1');
      const pendingDigest = await reviewedDigest(pending);
      await seedCompletion(pending);
      before = capture(pending);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          pending.fx.db,
          decisionInput(pending.fx.goalId, pending.attestationId, pendingDigest),
        ),
        'decision_corrupt',
        'approval_fields_invalid',
      );
      expectNoChange(pending, before);

      const denied = await v2RunningAttestedFixture('sha1');
      const deniedDigest = await reviewedDigest(denied);
      const seededDenied = await seedCompletion(denied);
      decideGoalApproval(denied.fx.db, {
        goalId: denied.fx.goalId,
        approvalId: seededDenied.approval.id,
        decision: 'denied',
        decidedBy: 'system',
      });
      before = capture(denied);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          denied.fx.db,
          decisionInput(denied.fx.goalId, denied.attestationId, deniedDigest),
        ),
        'decision_corrupt',
        'approval_fields_invalid',
      );
      expectNoChange(denied, before);

      const versioned = await v2RunningAttestedFixture('sha1');
      const versionedDigest = await reviewedDigest(versioned);
      const seededVersioned = await seedCompletion(versioned, { decide: 'user' });
      versioned.fx.db.exec('DROP TRIGGER trg_goal_approval_external_completion_action_guard;');
      versioned.fx.db
        .prepare(
          `INSERT INTO goal_approvals (
             id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at,
             external_completion_action_digest
           ) VALUES (?, ?, 'user_confirmation', 'high', 'raw', 'user', ?, 'pending', ?, ?)`,
        )
        .run(
          randomUUID(),
          versioned.fx.goalId,
          JSON.stringify({ ...seededVersioned.action, schemaVersion: 2 }),
          new Date().toISOString(),
          'd'.repeat(64),
        );
      before = capture(versioned);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(
          versioned.fx.db,
          decisionInput(versioned.fx.goalId, versioned.attestationId, versionedDigest),
        ),
        'decision_corrupt',
        'schema_invalid',
      );
      expectNoChange(versioned, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D19 keeps a recorded decision inert: completion, transitions, bindings and evidence all refuse',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const result = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );

      const completed = await completeGoal(db, goalId);
      expect(completed.completed).toBe(false);
      expect(completed.evaluation.failures.map(({ code }) => code)).toEqual([
        'external_completion_not_activated',
      ]);

      const asUser = catchSync(() =>
        transitionGoal(db, { goalId, to: 'completed', reasonCode: 'completion_verified', actor: 'user' }),
      );
      expect(asUser).toBeInstanceOf(GoalStateError);
      expect(asUser).toMatchObject({ code: 'actor_not_allowed' });
      const asSupervisor = catchSync(() =>
        transitionGoal(db, {
          goalId,
          to: 'completed',
          reasonCode: 'completion_verified',
          actor: 'supervisor',
        }),
      );
      expect(asSupervisor).toBeInstanceOf(GoalStateError);
      expect(asSupervisor).toMatchObject({ code: 'completion_proof_required' });

      expect(
        bindExactGate(db, goalId, {
          status: 'needs_user',
          reasonCode: 'gate_pending',
          detail: { approvalId: result.approvalId, gate: 'user_confirmation' },
        }),
      ).toEqual({ ok: false });

      expect(goalState(db, goalId)).toEqual({ status: 'running', completedAt: null });
      expect(proofCount(db)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D21 keeps the default preflight refusing after a decision, and allowRecordedDecision reports the same digest',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const before = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attested.attestationId,
      });
      const digest = before.digest;
      await recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest));

      const defaultReport = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attested.attestationId,
      });
      expect(defaultReport.outcome).toBe('refused');
      expect(defaultReport.reasons).toEqual([{ code: 'completion_already_recorded', detail: null }]);
      expect(defaultReport.checks.find(({ status }) => status === 'failed')).toEqual({
        name: 'prior_completion',
        status: 'failed',
      });

      const allowed = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        { allowRecordedDecision: true },
      );
      expect(allowed.outcome).toBe('ready');
      expect(allowed.digest).toBe(digest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: concurrent identical and conflicting requests', () => {
  it.each(FORMATS)(
    'E5 two simultaneous identical decisions create exactly one approval and reuse it under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const before = capture(attested);
      const request = () =>
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest));

      const results = await Promise.all([request(), request()]);

      const created = results.filter((result) => !result.reused);
      const reused = results.filter((result) => result.reused);
      expect(created).toHaveLength(1);
      expect(reused).toHaveLength(1);
      expect(reused[0]).toEqual({ ...created[0], reused: true });
      expect(created[0]).toEqual({
        approvalId: expect.any(String),
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        preflightDigest: digest,
        status: 'approved',
        reused: false,
      });
      expect(completionRows(db, goalId)).toEqual([
        { id: created[0]!.approvalId, status: 'approved', digest: created[0]!.actionDigest },
      ]);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL',
          )
          .get(goalId),
      ).toEqual({ n: 1 });
      expect(goalEvents(db).length - before.events.length).toBe(2);
      expectOnlyApprovalChange(attested, before);
      expect(proofCount(db)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'E5b a conflicting decision for the same attestation fails closed for every concurrent request under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const report = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        { allowRecordedDecision: true },
      );
      const conflicting = buildExternalCompletionAction({
        ...report.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: 'f'.repeat(64),
      })!;
      const conflict = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Conflicting decision for the same attestation.',
        requestedBy: 'user',
        detail: { ...conflicting },
        externalCompletionActionDigest: conflicting.actionDigest,
      });
      decideGoalApproval(db, { goalId, approvalId: conflict.id, decision: 'approved', decidedBy: 'user' });
      const before = capture(attested);
      const request = () =>
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest));

      const errors = await Promise.all([captureError(request()), captureError(request())]);

      for (const error of errors) expect(error).toMatchObject({ code: 'decision_conflict', detail: null });
      expect(errors.every((error) => error instanceof ExternalCompletionDecisionError)).toBe(true);
      expectNoChange(attested, before);
      expect(completionRows(db, goalId).map((row) => row.id)).toEqual([conflict.id]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: approval consumers refuse a completion decision', () => {
  it.each(FORMATS)(
    'F2c the attestation-correction gate refuses a completion digest and accepts its own digest under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const decision = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );
      const reviewed = requestAttestationCorrectionApproval(db, {
        goalId,
        attestationId: attested.attestationId,
        correctionKind: 'dispute',
        reasonCode: 'observation_error',
        explanation: 'Recorded by a consumer-isolation test.',
        replacementAttestationId: null,
      });
      decideGoalApproval(db, {
        goalId,
        approvalId: reviewed.approval.id,
        decision: 'approved',
        decidedBy: 'user',
      });
      const correctionInput = (approvalId: string) => ({
        goalId,
        approvalId,
        expectedActionDigest: reviewed.actionDigest,
        explanation: 'Recorded by a consumer-isolation test.',
      });

      // The real completion decision is not a correction authority.
      expect(
        catchSync(() =>
          appendAttestationCorrection(db, {
            goalId,
            approvalId: decision.approvalId,
            expectedActionDigest: decision.actionDigest,
            explanation: 'Recorded by a consumer-isolation test.',
          }),
        ),
      ).toMatchObject({ code: 'correction_action_mismatch' });

      // Paired copy: the correction row with its correction digest moved into the completion digest column.
      db.exec('DROP TRIGGER trg_goal_approval_external_completion_action_guard;');
      db.exec('DROP TRIGGER trg_goal_approval_attestation_correction_guard;');
      const movedCopy = copyGoalApprovalRow(db, reviewed.approval.id, {
        externalCompletion: reviewed.actionDigest,
        attestationCorrection: null,
      });
      expect(catchSync(() => appendAttestationCorrection(db, correctionInput(movedCopy)))).toMatchObject({
        code: 'correction_action_mismatch',
      });
      expect(getGoalApproval(db, movedCopy)).toMatchObject({ gate: 'user_confirmation', status: 'approved' });
      expect(getGoalApproval(db, movedCopy)).not.toHaveProperty('attestationCorrectionActionDigest');

      // Control: the untouched correction row is still accepted as the correction authority.
      expect(appendAttestationCorrection(db, correctionInput(reviewed.approval.id))).toMatchObject({
        reused: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'F2d the legacy final-apply authority refuses a completion decision and the insert guard refuses a final-apply copy under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const decision = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );

      expect(catchSync(() => assertFinalApplyApprovalDatabaseCurrent(db, decision.approvalId))).toMatchObject(
        { code: 'approval_mismatch' },
      );
      await expect(
        validateFinalApplyAuthority(db, goalId, decision.approvalId, { expectedStatus: 'approved' }),
      ).resolves.toMatchObject({ ok: false, code: 'approval_mismatch' });

      // A final-apply gate can never carry a completion digest; the insert guard refuses it outright.
      const detail = JSON.stringify(getGoalApproval(db, decision.approvalId)!.detail);
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at,
               external_completion_action_digest)
             VALUES (?, ?, 'final_apply', 'high', 'final apply copy', 'user', ?, 'pending', ?, ?)`,
          )
          .run(randomUUID(), goalId, detail, '2026-01-01T00:00:00.000Z', decision.actionDigest),
      ).toThrow('external completion approval action digest is invalid');
      expect(completionRows(db, goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: correction digests stay out of the completion decision (paired)', () => {
  it(
    'lists the real completion decision, and ignores a correction-digest copy of a plain confirmation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const control = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );
      expect(control).toMatchObject({ reused: false });
      const listedBefore = listExternalCompletionDecisions(db, goalId);
      expect(listedBefore).toMatchObject([{ state: 'valid', approval: { id: control.approvalId } }]);
      const recordedBefore = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );

      // Paired treatment: a plain user_confirmation row (no completion marker in its detail) whose copy carries ONLY a
      // correction digest. The disposable database drops the correction insert guard for that copy.
      db.exec('DROP TRIGGER trg_goal_approval_attestation_correction_guard;');
      const plain = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Plain confirmation for the correction-copy isolation test.',
        requestedBy: 'user',
        detail: { note: 'plain' },
      });
      const copyId = copyGoalApprovalRow(db, plain.id, {
        externalCompletion: null,
        attestationCorrection: testDigest('decision-correction-copy'),
      });
      expect(getGoalApproval(db, copyId)).toMatchObject({
        gate: 'user_confirmation',
        attestationCorrectionActionDigest: testDigest('decision-correction-copy'),
      });
      expect(getGoalApproval(db, copyId)).not.toHaveProperty('externalCompletionActionDigest');

      // The copy is not a completion row: it is not listed, and the direct reader reports it as not a completion.
      expect(listExternalCompletionDecisions(db, goalId)).toEqual(listedBefore);
      expect(completionRows(db, goalId).map(({ id }) => id)).toEqual([control.approvalId]);
      expect(readExternalCompletionDecision(db, goalId, copyId)).toEqual({
        state: 'invalid',
        approvalId: copyId,
        reason: 'not_completion_approval',
      });

      // Recording is unchanged: the exact duplicate is still reused with the same approval and the same result.
      await expect(
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest)),
      ).resolves.toEqual(recordedBefore);
      expect(recordedBefore).toMatchObject({ approvalId: control.approvalId, reused: true });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'lists a completion-detail copy that carries a correction digest as invalid, and refuses every new decision',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const control = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );

      // Paired treatment: the real completion decision copied with a correction digest and no completion digest. Its
      // detail still names the completion action, so the completion reader selects it.
      db.exec('DROP TRIGGER trg_goal_approval_external_completion_action_guard;');
      db.exec('DROP TRIGGER trg_goal_approval_attestation_correction_guard;');
      const copyId = copyGoalApprovalRow(db, control.approvalId, {
        externalCompletion: null,
        attestationCorrection: testDigest('completion-detail-correction-copy'),
      });
      expect(getGoalApproval(db, copyId)).toMatchObject({
        gate: 'user_confirmation',
        status: 'approved',
        attestationCorrectionActionDigest: testDigest('completion-detail-correction-copy'),
      });
      expect(getGoalApproval(db, copyId)).not.toHaveProperty('externalCompletionActionDigest');

      expect(listExternalCompletionDecisions(db, goalId)).toEqual([
        expect.objectContaining({
          state: 'valid',
          approval: expect.objectContaining({ id: control.approvalId }),
        }),
        { state: 'invalid', approvalId: copyId, reason: 'not_completion_approval' },
      ]);
      expect(readExternalCompletionDecision(db, goalId, copyId)).toEqual({
        state: 'invalid',
        approvalId: copyId,
        reason: 'not_completion_approval',
      });

      const before = capture(attested);
      await expectDecisionRefusal(
        recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest)),
        'decision_corrupt',
        'not_completion_approval',
      );
      expectNoChange(attested, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion decision: class 5 history and decision_corrupt stay distinct (C5)', () => {
  // Three stored states, each refused with its own literal code and nothing written. A row that fails the row validator is
  // decision_corrupt. A row that passes it but whose attestation the classifier cannot establish is class 5, which the
  // decision refuses as preflight_refused completion_history_invalid. The terminal refuses a stored row that is no longer a
  // valid approval as decision_corrupt. The class-5 case found inside the decision transaction is D11d in
  // externalCompletionDecisionSeams.test.ts, which needs that file's seam, so it is not repeated here.
  const C5_CASES = [
    {
      label: 'decision_corrupt: a stored row fails the row validator before any Git read (pinned by D18)',
      expected: { code: 'decision_corrupt', detail: 'digest_mismatch' },
      arrange: async () => {
        const decided = await v2DecidedFixture('sha1');
        const { fx } = decided;
        fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
        fx.db
          .prepare('UPDATE goal_approvals SET external_completion_action_digest = ? WHERE id = ?')
          .run('f'.repeat(64), decided.recorded.approvalId);
        return {
          db: fx.db,
          goalId: fx.goalId,
          attempt: () =>
            recordExternalCompletionDecision(
              fx.db,
              decisionInput(fx.goalId, decided.attestationId, decided.digest),
            ),
        };
      },
    },
    {
      label:
        'class 5: a stored row passes the row validator, but its attestation is not found (pinned by D17b)',
      expected: { code: 'preflight_refused', detail: 'completion_history_invalid' },
      arrange: async () => {
        const attested = await v2RunningAttestedFixture('sha1');
        const { db, goalId } = attested.fx;
        const digest = await reviewedDigest(attested);
        const report = await computeExternalCompletionPreflight(
          db,
          goalId,
          { attestationId: attested.attestationId },
          { allowRecordedDecision: true },
        );
        const foreign = randomUUID();
        const fields = report.actionFields as Record<string, Record<string, unknown>>;
        const foreignAction = buildExternalCompletionAction({
          ...fields,
          attestation: { ...fields.attestation, id: foreign },
          correctionChain: { ...fields.correctionChain, attestationId: foreign },
          contentOutcomeAcknowledged: true,
          userReviewedPreflightDigest: 'e'.repeat(64),
        })!;
        const row = requestGoalApproval(db, {
          goalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'Decision for a fabricated attestation.',
          requestedBy: 'user',
          detail: { ...foreignAction },
          externalCompletionActionDigest: foreignAction.actionDigest,
        });
        decideGoalApproval(db, { goalId, approvalId: row.id, decision: 'approved', decidedBy: 'user' });
        return {
          db,
          goalId,
          attempt: () =>
            recordExternalCompletionDecision(db, decisionInput(goalId, attested.attestationId, digest)),
        };
      },
    },
    {
      label:
        'decision_corrupt from the completion terminal: a stored row is no longer a valid approval (pinned by externalCompletion.test.ts)',
      expected: { code: 'decision_corrupt', detail: 'approval_fields_invalid' },
      arrange: async () => {
        const decided = await v2DecidedFixture('sha1');
        const { fx } = decided;
        fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
        fx.db
          .prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?")
          .run(decided.recorded.approvalId);
        return {
          db: fx.db,
          goalId: fx.goalId,
          attempt: () =>
            completeGoalFromExternalDecision(
              fx.db,
              decisionInput(fx.goalId, decided.attestationId, decided.digest),
            ),
        };
      },
    },
  ];

  it.each(C5_CASES.map((testCase) => [testCase.label, testCase] as const))(
    '%s',
    async (_label, testCase) => {
      const arranged = await testCase.arrange();
      const before = databaseSnapshot(arranged.db);

      const error = await captureError(arranged.attempt());

      expect(error).toMatchObject(testCase.expected);
      expect(databaseSnapshot(arranged.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

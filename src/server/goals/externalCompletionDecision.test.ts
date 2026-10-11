import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import {
  bindExactGate,
  decideGoalApproval,
  getGoalApproval,
  GoalApprovalError,
  requestGoalApproval,
} from './approvals.js';
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
import { decideGoalApprovalAsUser } from './goalCommands.js';
import {
  acceptedFixture,
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  reviewedDigest,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { GoalStateError, transitionGoal } from './stateMachine.js';
import { cleanupRepoFixtures } from './repoKit.js';

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;
const HEAVY = 60_000;
const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));

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
  const body = { ...report.actionFields!, userReviewedPreflightDigest: options.digest ?? report.digest };
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
  );
});

describe('external completion decision: authority and copies', () => {
  it(
    'D12 keeps a pending completion row out of the generic decision routes and out of the requester list',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const { approval } = await seedCompletion(attested);
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

      const action = await rebuiltAction(
        attested,
        await computeExternalCompletionPreflight(
          db,
          goalId,
          { attestationId: attested.attestationId },
          { allowRecordedDecision: true },
        ),
      );
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
  );

  it(
    'D17b ignores a valid decision that names another attestation',
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

      const result = await recordExternalCompletionDecision(
        db,
        decisionInput(goalId, attested.attestationId, digest),
      );
      expect(result).toMatchObject({ reused: false, status: 'approved' });
      expect(result.approvalId).not.toBe(other.id);
      expect(readExternalCompletionDecision(db, goalId, other.id)).toMatchObject({
        state: 'valid',
        action: { attestation: { id: foreign } },
      });
      expect(listExternalCompletionDecisions(db, goalId).map((entry) => entry.state)).toEqual([
        'valid',
        'valid',
      ]);
    },
    HEAVY,
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
    HEAVY,
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
    HEAVY,
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
    HEAVY,
  );
});

describe('external completion decision: static source guard', () => {
  const ALLOWED = new Set([
    'goals/approvals.ts',
    'goals/goalCommands.ts',
    'goals/evidence.ts',
    'goals/freshness.ts',
    'goals/externalCompletionProof.ts',
    'goals/externalCompletionPreflight.ts',
    'goals/externalCompletionDecision.ts',
  ]);

  function serverSources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return serverSources(path);
      const isProduction =
        entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'goalV2TestKit.ts';
      return isProduction ? [path] : [];
    });
  }

  it('D19b no production code inserts a completion proof, and completion digests stay in the allow-list', () => {
    const files = serverSources(SERVER_ROOT);
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SERVER_ROOT, file);
      if (/INSERT INTO goal_external_completion_proofs/.test(source)) offenders.push(`proof insert: ${rel}`);
      if (
        /externalCompletionActionDigest|external_completion_action_digest|complete_goal_external_integration_v2/.test(
          source,
        ) &&
        !ALLOWED.has(rel)
      )
        offenders.push(`completion identifier outside allow-list: ${rel}`);
    }
    expect(offenders).toEqual([]);
  });
});

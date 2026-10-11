import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import { openDatabase, type Db } from '../db.js';
import {
  CompletionStandingError,
  readGoalCompletionStanding,
  type GoalCompletionStanding,
} from './completionStanding.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import {
  buildExternalCompletionProof,
  externalCompletionProofPayloadJson,
  readExternalCompletionProof,
} from './externalCompletionProof.js';
import { computeEmptyCorrectionChainIdentity } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { cleanupRepoFixtures, goalRepoFixture, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Real-service tests of the completion-standing reader (commit 2): real Git fixtures and real SQLite with the production
 * migrations. Each tamper below is made on a disposable database, by dropping one named trigger or by lifting the CHECK
 * constraints with `ignore_check_constraints` and then editing one stored row. Every tamper is named where it is made.
 * Every refusal is asserted by its exact code.
 */

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;
type Decided = Awaited<ReturnType<typeof v2DecidedFixture>>;
const LATER = '2030-01-01T00:00:00.000Z';

const NOT_COMPLETED_CLAIM = {
  unqualifiedSuccessAllowed: false,
  trustedForDownstream: false,
  qualifier: 'not_completed',
  contentPreservation: 'not_applicable',
};
const INVALID_CLAIM = {
  unqualifiedSuccessAllowed: false,
  trustedForDownstream: false,
  qualifier: 'proof_unverified',
  contentPreservation: 'not_applicable',
};

/** The request a user would send for one reviewed decision. */
function requestFor(decided: Decided) {
  return {
    goalId: decided.fx.goalId,
    attestationId: decided.attestationId,
    reviewedPreflightDigest: decided.digest,
    acknowledgeContentNotProven: true,
  };
}

function goalRow(db: Db, goalId: string) {
  return db
    .prepare('SELECT status, status_reason_code, status_detail_json, completed_at FROM goals WHERE id = ?')
    .get(goalId) as {
    status: string;
    status_reason_code: string | null;
    status_detail_json: string | null;
    completed_at: string | null;
  };
}

function proofPayload(db: Db, proofId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT payload_json FROM goal_external_completion_proofs WHERE id = ?')
    .get(proofId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

/** The exact error a call throws. Fails the test when the call returns instead. */
function thrownBy(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error('the read was expected to throw');
}

/**
 * Disposable-DB tamper, a consistent forgery: the completion's correction-chain digest is replaced by a wrong value.
 * The proof is rebuilt with the production builder, so its digest is re-derived and never hand-set. Every stored copy of
 * that digest is rewritten to agree: the proof row, the status detail and the recorded event. The proof and event
 * immutability triggers are dropped for this disposable database only. The completion approval, which carries the same
 * chain digest inside its action body, is deliberately left as it was, so the stored completion is refused next.
 */
function forgeChainDigest(db: Db, goalId: string, proofId: string): void {
  const read = readExternalCompletionProof(db, goalId, proofId);
  if (read.state !== 'valid') throw new Error('forgeChainDigest: the proof must be valid before the forgery');
  const body: Record<string, unknown> = { ...read.proof };
  delete body.proofDigest;
  const forged = buildExternalCompletionProof({
    ...body,
    correctionChain: { ...read.proof.correctionChain, digest: 'f'.repeat(64) },
  });
  if (!forged) throw new Error('forgeChainDigest: the forged body is not a valid proof');
  db.exec(
    'DROP TRIGGER trg_goal_external_completion_proof_immutable; DROP TRIGGER trg_goal_event_immutable;',
  );
  db.prepare(
    'UPDATE goal_external_completion_proofs SET proof_digest = ?, correction_chain_digest = ?, payload_json = ? WHERE id = ?',
  ).run(
    forged.proofDigest,
    forged.correctionChain.digest,
    externalCompletionProofPayloadJson(forged),
    proofId,
  );
  const detail = JSON.parse(goalRow(db, goalId).status_detail_json ?? 'null') as Record<string, unknown>;
  db.prepare('UPDATE goals SET status_detail_json = ? WHERE id = ?').run(
    JSON.stringify({ ...detail, proofDigest: forged.proofDigest }),
    goalId,
  );
  const recorded = db
    .prepare(
      "SELECT id, payload_json FROM goal_events WHERE goal_id = ? AND type = 'external_completion_recorded'",
    )
    .get(goalId) as { id: string; payload_json: string };
  db.prepare('UPDATE goal_events SET payload_json = ? WHERE id = ?').run(
    JSON.stringify({
      ...(JSON.parse(recorded.payload_json) as Record<string, unknown>),
      proofDigest: forged.proofDigest,
    }),
    recorded.id,
  );
}

describe('completion standing reader: R1 a real version-2 completion with no correction is uncontested', () => {
  it.each(FORMATS)(
    'R1 [%s]: the reader returns the exact uncontested model, and the stored completion agrees',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      const { db, goalId } = decided.fx;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      const stored = readExternalCompletionProof(db, goalId, completion.proofId);
      if (stored.state !== 'valid') throw new Error('R1: the stored proof must read as valid');
      const row = goalRow(db, goalId);
      const recordDigest = stored.proof.attestation.recordDigest;

      expect(readGoalCompletionStanding(db, goalId)).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'v2',
        standing: 'uncontested',
        status: {
          goalStatus: 'completed',
          completedAt: row.completed_at,
          reasonCode: EXTERNAL_COMPLETION_REASON,
        },
        claim: {
          unqualifiedSuccessAllowed: true,
          trustedForDownstream: true,
          qualifier: 'none',
          contentPreservation: 'not_proven',
        },
        proof: {
          state: 'valid',
          proofId: completion.proofId,
          proofDigest: completion.proofDigest,
          attestationId: decided.attestationId,
          attestationRecordDigest: recordDigest,
          approvalId: completion.approvalId,
          actionDigest: completion.actionDigest,
          observedAt: completion.observedAt,
          chainAtProof: {
            sequence: 0,
            digest: computeEmptyCorrectionChainIdentity({
              attestationId: decided.attestationId,
              attestationRecordDigest: recordDigest,
            }).digest,
            standing: 'active_uncontested',
          },
        },
        correction: {
          attestationId: decided.attestationId,
          standing: 'active_uncontested',
          correctionCount: 0,
          tip: null,
          correctedAfterCompletion: null,
          invalidCode: null,
          replacement: null,
        },
        classification: { trust: 'trusted', reconciliation: 'none', reasons: [] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(row.completed_at).toBe(completion.completedAt);
      expect(readStoredCompletion(db, goalId)).toMatchObject({
        state: 'completed',
        proofId: completion.proofId,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: R2 a Goal that is not completed is not_completed', () => {
  it(
    'R2: a draft Goal, an attested running Goal, and a running Goal with a recorded decision are not_completed',
    async () => {
      const draft = goalRepoFixture({ approved: false });
      const draftModel = readGoalCompletionStanding(draft.db, draft.goalId);
      expect(draftModel).toEqual({
        schemaVersion: 1,
        goalId: draft.goalId,
        kind: 'not_completed',
        standing: null,
        status: { goalStatus: 'draft', completedAt: null, reasonCode: null },
        claim: NOT_COMPLETED_CLAIM,
      });

      const attested = await v2RunningAttestedFixture('sha1');
      const attestedModel = readGoalCompletionStanding(attested.fx.db, attested.fx.goalId);
      expect(attestedModel).toEqual({
        schemaVersion: 1,
        goalId: attested.fx.goalId,
        kind: 'not_completed',
        standing: null,
        status: { goalStatus: 'running', completedAt: null, reasonCode: 'user_start' },
        claim: NOT_COMPLETED_CLAIM,
      });

      // The recorded decision is inert: it is not a completion, so the Goal is still not completed.
      const decided = await v2DecidedFixture('sha1');
      const decidedModel = readGoalCompletionStanding(decided.fx.db, decided.fx.goalId);
      expect(decidedModel).toEqual({
        schemaVersion: 1,
        goalId: decided.fx.goalId,
        kind: 'not_completed',
        standing: null,
        status: { goalStatus: 'running', completedAt: null, reasonCode: 'user_start' },
        claim: NOT_COMPLETED_CLAIM,
      });
      expect(decidedModel.claim.unqualifiedSuccessAllowed).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: R3 an unknown Goal is a domain error', () => {
  it('R3: an unknown Goal id throws the local goal_not_found error, by code', () => {
    const root = mkdtempSync(join(tmpdir(), 'tt-standing-r3-'));
    const db = openDatabase(root);
    try {
      const error = thrownBy(() => readGoalCompletionStanding(db, randomUUID()));
      expect(error).toBeInstanceOf(CompletionStandingError);
      expect(error).toMatchObject({ code: 'goal_not_found' });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('completion standing reader: R5 a completed Goal without legacy lineage is never historical_legacy', () => {
  it(
    'R5a: a bare status change with no reason code is invalid, reason_code_unclassifiable',
    async () => {
      // Raw SQL on a disposable database, the same technique as manualHandoff.test.ts: no completion service ran.
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      db.prepare("UPDATE goals SET status = 'completed', completed_at = ? WHERE id = ?").run(LATER, goalId);
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: { goalStatus: 'completed', completedAt: LATER, reasonCode: 'user_start' },
        proof: { state: 'invalid', reason: 'reason_code_unclassifiable' },
        correction: null,
        claim: INVALID_CLAIM,
        classification: {
          trust: 'untrusted',
          reconciliation: 'none',
          reasons: ['reason_code_unclassifiable'],
        },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R5b: a version-2 Goal with the completion_verified reason forced by SQL is invalid, legacy_policy_unverified',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      db.prepare(
        "UPDATE goals SET status = 'completed', status_reason_code = 'completion_verified', completed_at = ? WHERE id = ?",
      ).run(LATER, goalId);
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        proof: { state: 'invalid', reason: 'legacy_policy_unverified' },
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['legacy_policy_unverified'] },
        claim: INVALID_CLAIM,
      });
      expect(model.standing).not.toBe('historical_legacy');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R5c: a real version-2 completion whose reason is forced to completion_verified is invalid, legacy_with_proof_row',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      await completeGoalFromExternalDecision(db, requestFor(decided));
      db.prepare("UPDATE goals SET status_reason_code = 'completion_verified' WHERE id = ?").run(goalId);
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        proof: { state: 'invalid', reason: 'legacy_with_proof_row' },
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['legacy_with_proof_row'] },
        claim: INVALID_CLAIM,
      });
      expect(model.standing).not.toBe('historical_legacy');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: R6 to R9 a completion that is tampered reads as invalid, never uncontested', () => {
  it(
    'R6: a tampered proof body reads as invalid with the same code readStoredCompletion returns',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      const original = goalRow(db, goalId);
      // Disposable-DB tamper: drop the proof immutability trigger, lift the CHECK constraints, and change one field of the
      // stored body. The stored digest no longer matches the body.
      db.exec('DROP TRIGGER trg_goal_external_completion_proof_immutable;');
      db.pragma('ignore_check_constraints = ON');
      const body = proofPayload(db, completion.proofId);
      body.userReviewedPreflightDigest = 'a'.repeat(64);
      db.prepare('UPDATE goal_external_completion_proofs SET payload_json = ? WHERE id = ?').run(
        JSON.stringify(body),
        completion.proofId,
      );
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'invalid', reason: 'digest_mismatch' });

      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: {
          goalStatus: 'completed',
          completedAt: original.completed_at,
          reasonCode: EXTERNAL_COMPLETION_REASON,
        },
        proof: { state: 'invalid', reason: 'digest_mismatch' },
        correction: null,
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(model.claim.unqualifiedSuccessAllowed).toBe(false);
      expect(model.claim.trustedForDownstream).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R7: a completed Goal whose proof row is deleted reads as invalid, proof_missing',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      // Disposable-DB tamper: drop the proof no-delete trigger, then delete the one proof row.
      db.exec('DROP TRIGGER trg_goal_external_completion_proof_no_delete;');
      db.prepare('DELETE FROM goal_external_completion_proofs WHERE id = ?').run(completion.proofId);
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'invalid', reason: 'proof_missing' });

      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        proof: { state: 'invalid', reason: 'proof_missing' },
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        claim: INVALID_CLAIM,
      });
      expect(model.standing).not.toBe('uncontested');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R8: a forged correction-chain digest is caught first by the completion approval comparison, invalid',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      forgeChainDigest(db, goalId, completion.proofId);
      // Pinned on the first observed run. The forged proof passes its own digest and row checks, then fails the comparison
      // with the completion approval, whose action body carries the same chain digest. The chain-identity branch is
      // therefore not reached by this tamper: reaching it needs the decision and approval re-forged as well.
      expect(readStoredCompletion(db, goalId)).toEqual({
        state: 'invalid',
        reason: 'completion_approval_mismatch',
      });

      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        proof: { state: 'invalid', reason: 'completion_approval_mismatch' },
        correction: null,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        claim: INVALID_CLAIM,
      });
      expect(model.standing).not.toBe('uncontested');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R9: an attestation that fails integrity is never a success, and the reader does not throw',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const attestationId = decided.attestationId;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      // Disposable-DB tamper: drop the attestation immutability trigger, lift the CHECK constraints, and change the
      // observation time inside the stored attestation body, so its digest no longer matches.
      db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      db.pragma('ignore_check_constraints = ON');
      const row = db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(attestationId) as { payload_json: string };
      const body = JSON.parse(row.payload_json) as Record<string, unknown>;
      body.observedAt = LATER;
      db.prepare('UPDATE goal_external_integration_attestations SET payload_json = ? WHERE id = ?').run(
        JSON.stringify(body),
        attestationId,
      );

      // Pinned on the first observed run. The proof reader re-validates the attestation body before the correction read,
      // so the completion reads invalid first. The pending branch for a failed correction read is not reached by this tamper.
      expect(readStoredCompletion(db, goalId)).toEqual({
        state: 'invalid',
        reason: 'attestation_payload_mismatch',
      });

      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        proof: { state: 'invalid', reason: 'attestation_payload_mismatch' },
        correction: null,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        claim: INVALID_CLAIM,
      });
      expect(model.status.completedAt).toBe(completion.completedAt);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: R10 the reader is deterministic and writes nothing', () => {
  it.each(FORMATS)(
    'R10 [%s]: two reads are equal, and neither the database nor the repository changes',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      const { db, goalId, repo } = decided.fx;
      await completeGoalFromExternalDecision(db, requestFor(decided));
      const databaseBefore = databaseSnapshot(db);
      const repositoryBefore = repositoryState(repo);

      const first = readGoalCompletionStanding(db, goalId);
      const second = readGoalCompletionStanding(db, goalId);
      expect(second).toEqual(first);
      expect(first.standing).toBe('uncontested');
      expect(databaseSnapshot(db)).toEqual(databaseBefore);
      expect(repositoryState(repo)).toEqual(repositoryBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: the commit 2 correction placeholder is pinned fail-closed', () => {
  it.each(['dispute', 'withdraw'] as const)(
    'a %s after completion is pending (invalid_unverified, correction_mapping_pending) until commit 3 maps it',
    async (kind) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx, attestationId } = decided;
      const { db, goalId } = fx;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      expect(readGoalCompletionStanding(db, goalId).standing).toBe('uncontested');

      appendCorrectionForTest(fx, attestationId, kind);

      const model: GoalCompletionStanding = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: {
          goalStatus: 'completed',
          completedAt: completion.completedAt,
          reasonCode: EXTERNAL_COMPLETION_REASON,
        },
        proof: expect.objectContaining({ state: 'valid', proofId: completion.proofId }),
        correction: null,
        claim: INVALID_CLAIM,
        classification: {
          trust: 'untrusted',
          reconciliation: 'none',
          reasons: ['correction_mapping_pending'],
        },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(model.claim.unqualifiedSuccessAllowed).toBe(false);
      expect(model.claim.trustedForDownstream).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: other attestations of the Goal are listed and never change the standing', () => {
  it(
    'an earlier attestation of the same Goal is listed as active_uncontested, not restoring, and the completion stays uncontested',
    async () => {
      const first = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = first.fx;
      // The destination moves, so the second attestation is at a new tip and its action digest is not a duplicate.
      const moved = git(
        first.fx.repo,
        'commit-tree',
        first.attestation.destination.observedTree,
        '-p',
        first.attestation.destination.observedCommit,
        '-m',
        'destination moved after observation',
      );
      git(first.fx.repo, 'update-ref', first.handoff.target.baseRef, moved);
      const second = await reattestAtCurrentTip(first);
      const digest = await reviewedDigest({ fx: first.fx, attestationId: second.attestationId });
      await recordExternalCompletionDecision(db, {
        goalId,
        attestationId: second.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });
      const { completion } = await completeGoalFromExternalDecision(db, {
        goalId,
        attestationId: second.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        proof: { state: 'valid', proofId: completion.proofId, attestationId: second.attestationId },
        correction: { attestationId: second.attestationId, standing: 'active_uncontested' },
        otherAttestations: [
          {
            attestationId: first.attestationId,
            recordDigest: first.attestation.recordDigest,
            standing: 'active_uncontested',
            isReplacementOfProofAttestation: false,
            restoresCompletion: false,
          },
        ],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

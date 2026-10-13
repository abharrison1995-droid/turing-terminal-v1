import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import { openDatabase, type Db } from '../db.js';
import { getAttestationCorrectionStanding } from './attestationCorrection.js';
import {
  CompletionStandingError,
  completionStandingAllowsUnqualifiedSuccess,
  completionStandingTrustedForDownstream,
  readGoalCompletionStanding,
} from './completionStanding.js';
import { completeGoalFromExternalDecision, ExternalCompletionError } from './externalCompletion.js';
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
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { cleanupRepoFixtures, goalRepoFixture, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Real-service tests of the completion-standing reader (commits 2 and 3): real Git fixtures and real SQLite with the
 * production migrations. Each tamper below is made on a disposable database, by dropping one named trigger, by dropping a
 * table, or by lifting the CHECK constraints with `ignore_check_constraints` and then editing one stored row. Every tamper
 * is named where it is made. Every refusal is asserted by its exact code and detail.
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

/** The version-2 model of a Goal, narrowed. Fails the test when the Goal is not a version-2 completion. */
function v2Of(db: Db, goalId: string) {
  const model = readGoalCompletionStanding(db, goalId);
  if (model.kind !== 'v2') throw new Error(`expected a version-2 model, got ${model.kind}`);
  return model;
}

/** The status the Goal row must show for one completion. Corrections never change it. */
function completedStatus(completion: { completedAt: string }) {
  return {
    goalStatus: 'completed',
    completedAt: completion.completedAt,
    reasonCode: EXTERNAL_COMPLETION_REASON,
  };
}

/** A decision input. The digest is a placeholder where the preflight is expected to refuse before it is compared. */
function inputFor(goalId: string, attestationId: string, digest = 'a'.repeat(64)) {
  return { goalId, attestationId, reviewedPreflightDigest: digest, acknowledgeContentNotProven: true };
}

/** The typed decision refusal of an attempt, by exact code and detail. Fails the test when the attempt succeeds. */
async function decisionRefusal(attempt: Promise<unknown>): Promise<{ code: string; detail: string | null }> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalCompletionDecisionError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('the decision succeeded but a refusal was expected');
}

/** The typed completion refusal of an attempt, by exact code and detail. Fails the test when the attempt succeeds. */
async function completionRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string; detail: string | null }> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalCompletionError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('the completion succeeded but a refusal was expected');
}

/** Lets the clock move past the completion, so a correction's decision time is strictly later than the completion time. */
function letClockAdvance(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** Moves the destination to a new commit on top of its current tip, so the next attestation is taken at a new tip (D1). */
function advanceDestination(attested: Pick<Decided, 'fx' | 'handoff'>, label: string): void {
  const { repo } = attested.fx;
  const baseRef = attested.handoff.target.baseRef;
  const current = git(repo, 'rev-parse', baseRef);
  const tree = git(repo, 'rev-parse', `${current}^{tree}`);
  git(repo, 'update-ref', baseRef, git(repo, 'commit-tree', tree, '-p', current, '-m', label));
}

/** A version-2 Goal completed on its decided attestation, through the real service. */
async function completed(format: 'sha1' | 'sha256') {
  const decided = await v2DecidedFixture(format);
  const { completion } = await completeGoalFromExternalDecision(decided.fx.db, requestFor(decided));
  return {
    decided,
    completion,
    db: decided.fx.db,
    goalId: decided.fx.goalId,
    repo: decided.fx.repo,
  };
}

/**
 * A version-2 Goal completed on proof attestation A, with `others` independent attestations made before completion. Each
 * independent attestation is observed at a moved destination tip. The tip is then reset to A's tip, so A is the one
 * decided and completed. Attesting after completion is refused (see C6), so this is the producible way to hold them.
 */
async function completedWithIndependent(format: 'sha1' | 'sha256', others: number) {
  const attested = await v2RunningAttestedFixture(format);
  const { fx } = attested;
  const proofTip = git(fx.repo, 'rev-parse', attested.handoff.target.baseRef);
  const independent: Awaited<ReturnType<typeof reattestAtCurrentTip>>[] = [];
  for (let index = 1; index <= others; index += 1) {
    advanceDestination(attested, `destination moved for independent attestation ${index}`);
    independent.push(await reattestAtCurrentTip(attested));
  }
  git(fx.repo, 'update-ref', attested.handoff.target.baseRef, proofTip);
  const digest = await reviewedDigest(attested);
  await recordExternalCompletionDecision(fx.db, inputFor(fx.goalId, attested.attestationId, digest));
  const { completion } = await completeGoalFromExternalDecision(
    fx.db,
    inputFor(fx.goalId, attested.attestationId, digest),
  );
  return { decided: attested, independent, completion, db: fx.db, goalId: fx.goalId, repo: fx.repo };
}

/**
 * A completed Goal whose proof attestation A is superseded after completion by an independent compatible replacement B,
 * which was attested before completion. Optional further independent attestations are returned in `independent`.
 */
async function supersededWithReplacement(format: 'sha1' | 'sha256', others = 1) {
  const made = await completedWithIndependent(format, others);
  const replacement = made.independent[0];
  await letClockAdvance();
  const { record } = appendCorrectionForTest(
    made.decided.fx,
    made.decided.attestationId,
    'supersede',
    replacement.attestationId,
  );
  return { ...made, replacement, supersedeRecord: record };
}

describe('completion standing reader: A a correction after completion never reads as uncontested', () => {
  it.each(FORMATS)(
    'A1 [%s]: a dispute after completion is disputed, while the Goal stays completed',
    async (format) => {
      const { decided, completion, db, goalId } = await completed(format);
      const before = v2Of(db, goalId);
      expect(before.standing).toBe('uncontested');
      expect(before.status.completedAt).toBe(completion.completedAt);

      await letClockAdvance();
      const { record } = appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'v2',
        standing: 'disputed',
        status: completedStatus(completion),
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'disputed_by_user',
          contentPreservation: 'not_proven',
        },
        proof: before.proof,
        correction: {
          attestationId: decided.attestationId,
          standing: 'disputed',
          correctionCount: 1,
          tip: {
            correctionId: record.correctionId,
            kind: 'dispute',
            sequence: 1,
            correctionDigest: record.correctionDigest,
            decidedAt: record.decision.decidedAt,
            replacementAttestationId: null,
          },
          correctedAfterCompletion: true,
          invalidCode: null,
          replacement: null,
        },
        classification: { trust: 'qualified', reconciliation: 'none', reasons: ['attestation_disputed'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(model.proof).toMatchObject({ state: 'valid', proofDigest: completion.proofDigest });
      expect(completionStandingAllowsUnqualifiedSuccess(model)).toBe(false);
      expect(completionStandingTrustedForDownstream(model)).toBe(false);
      expect(goalRow(db, goalId).completed_at).toBe(completion.completedAt);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'A2 [%s]: a withdrawal after completion is withdrawn, while the Goal stays completed',
    async (format) => {
      const { decided, completion, db, goalId } = await completed(format);
      const before = v2Of(db, goalId);
      await letClockAdvance();
      const { record } = appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'v2',
        standing: 'withdrawn',
        status: completedStatus(completion),
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'withdrawn_by_user',
          contentPreservation: 'not_proven',
        },
        proof: before.proof,
        correction: {
          attestationId: decided.attestationId,
          standing: 'withdrawn',
          correctionCount: 1,
          tip: {
            correctionId: record.correctionId,
            kind: 'withdraw',
            sequence: 1,
            correctionDigest: record.correctionDigest,
            decidedAt: record.decision.decidedAt,
            replacementAttestationId: null,
          },
          correctedAfterCompletion: true,
          invalidCode: null,
          replacement: null,
        },
        classification: { trust: 'qualified', reconciliation: 'none', reasons: ['attestation_withdrawn'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(completionStandingAllowsUnqualifiedSuccess(model)).toBe(false);
      expect(goalRow(db, goalId).completed_at).toBe(completion.completedAt);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A3: a dispute then a withdrawal is withdrawn with two corrections, and the tip is the second',
    async () => {
      const { decided, completion, db, goalId } = await completed('sha1');
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      await letClockAdvance();
      const { record } = appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');
      const model = v2Of(db, goalId);
      expect(model.standing).toBe('withdrawn');
      expect(model.correction).toEqual({
        attestationId: decided.attestationId,
        standing: 'withdrawn',
        correctionCount: 2,
        tip: {
          correctionId: record.correctionId,
          kind: 'withdraw',
          sequence: 2,
          correctionDigest: record.correctionDigest,
          decidedAt: record.decision.decidedAt,
          replacementAttestationId: null,
        },
        correctedAfterCompletion: true,
        invalidCode: null,
        replacement: null,
      });
      expect(model.status.completedAt).toBe(completion.completedAt);
      expect(model.claim.unqualifiedSuccessAllowed).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'A4 [%s]: a supersession after completion by an independent replacement is superseded, and the proof stays on A',
    async (format) => {
      const { decided, completion, db, goalId, replacement, supersedeRecord } =
        await supersededWithReplacement(format);
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'v2',
        standing: 'superseded',
        status: completedStatus(completion),
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'superseded_by_user',
          contentPreservation: 'not_proven',
        },
        proof: {
          state: 'valid',
          proofId: completion.proofId,
          proofDigest: completion.proofDigest,
          attestationId: decided.attestationId,
          attestationRecordDigest: decided.attestation.recordDigest,
          approvalId: completion.approvalId,
          actionDigest: completion.actionDigest,
          observedAt: completion.observedAt,
          chainAtProof: {
            sequence: 0,
            digest: computeEmptyCorrectionChainIdentity({
              attestationId: decided.attestationId,
              attestationRecordDigest: decided.attestation.recordDigest,
            }).digest,
            standing: 'active_uncontested',
          },
        },
        correction: {
          attestationId: decided.attestationId,
          standing: 'superseded',
          correctionCount: 1,
          tip: {
            correctionId: supersedeRecord.correctionId,
            kind: 'supersede',
            sequence: 1,
            correctionDigest: supersedeRecord.correctionDigest,
            decidedAt: supersedeRecord.decision.decidedAt,
            replacementAttestationId: replacement.attestationId,
          },
          correctedAfterCompletion: true,
          invalidCode: null,
          replacement: { attestationId: replacement.attestationId, standing: 'active_uncontested' },
        },
        classification: { trust: 'qualified', reconciliation: 'none', reasons: ['attestation_superseded'] },
        otherAttestations: [
          {
            attestationId: replacement.attestationId,
            recordDigest: replacement.recordDigest,
            standing: 'active_uncontested',
            isReplacementOfProofAttestation: true,
            restoresCompletion: false,
          },
        ],
        otherAttestationsTruncated: false,
      });
      expect(completionStandingAllowsUnqualifiedSuccess(model)).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['the replacement is disputed', 'dispute', 'disputed'],
    ['the replacement is withdrawn', 'withdraw', 'withdrawn'],
  ] as const)(
    'A5 (sha1): when %s, the Goal is reconciliation_required and the proof attestation stays superseded',
    async (_label, replacementKind, replacementStanding) => {
      const { decided, completion, db, goalId, replacement, supersedeRecord } =
        await supersededWithReplacement('sha1');
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, replacement.attestationId, replacementKind);
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'v2',
        standing: 'reconciliation_required',
        status: completedStatus(completion),
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'replacement_failed',
          contentPreservation: 'not_proven',
        },
        proof: v2Of(db, goalId).proof,
        correction: {
          attestationId: decided.attestationId,
          standing: 'superseded',
          correctionCount: 1,
          tip: {
            correctionId: supersedeRecord.correctionId,
            kind: 'supersede',
            sequence: 1,
            correctionDigest: supersedeRecord.correctionDigest,
            decidedAt: supersedeRecord.decision.decidedAt,
            replacementAttestationId: replacement.attestationId,
          },
          correctedAfterCompletion: true,
          invalidCode: null,
          replacement: { attestationId: replacement.attestationId, standing: replacementStanding },
        },
        classification: {
          trust: 'qualified',
          reconciliation: 'required',
          reasons: ['attestation_superseded', 'replacement_not_uncontested'],
        },
        otherAttestations: [
          {
            attestationId: replacement.attestationId,
            recordDigest: replacement.recordDigest,
            standing: replacementStanding,
            isReplacementOfProofAttestation: true,
            restoresCompletion: false,
          },
        ],
        otherAttestationsTruncated: false,
      });
      expect(model.claim.unqualifiedSuccessAllowed).toBe(false);
      expect(model.claim.trustedForDownstream).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A5 (sha1): when the replacement is itself superseded by a third attestation, the Goal is reconciliation_required',
    async () => {
      const { decided, completion, db, goalId, replacement, supersedeRecord, independent } =
        await supersededWithReplacement('sha1', 2);
      const third = independent[1];
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, replacement.attestationId, 'supersede', third.attestationId);
      const model = v2Of(db, goalId);
      expect(model.standing).toBe('reconciliation_required');
      expect(model.status.completedAt).toBe(completion.completedAt);
      expect(model.correction).toEqual({
        attestationId: decided.attestationId,
        standing: 'superseded',
        correctionCount: 1,
        tip: {
          correctionId: supersedeRecord.correctionId,
          kind: 'supersede',
          sequence: 1,
          correctionDigest: supersedeRecord.correctionDigest,
          decidedAt: supersedeRecord.decision.decidedAt,
          replacementAttestationId: replacement.attestationId,
        },
        correctedAfterCompletion: true,
        invalidCode: null,
        replacement: { attestationId: replacement.attestationId, standing: 'superseded' },
      });
      expect(model.otherAttestations).toEqual([
        {
          attestationId: replacement.attestationId,
          recordDigest: replacement.recordDigest,
          standing: 'superseded',
          isReplacementOfProofAttestation: true,
          restoresCompletion: false,
        },
        {
          attestationId: third.attestationId,
          recordDigest: third.recordDigest,
          standing: 'active_uncontested',
          isReplacementOfProofAttestation: false,
          restoresCompletion: false,
        },
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A5b (sha1): when the replacement fails integrity after the supersession, the Goal is invalid_unverified with the observed code',
    async () => {
      const { decided, completion, db, goalId, replacement } = await supersededWithReplacement('sha1');
      const proof = v2Of(db, goalId).proof;
      // Disposable-DB tamper: drop the attestation immutability trigger, lift the CHECK constraints, and change the
      // observation time inside the replacement's stored body, so its digest no longer matches.
      db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      db.pragma('ignore_check_constraints = ON');
      const row = db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(replacement.attestationId) as { payload_json: string };
      const body = JSON.parse(row.payload_json) as Record<string, unknown>;
      body.observedAt = LATER;
      db.prepare('UPDATE goal_external_integration_attestations SET payload_json = ? WHERE id = ?').run(
        JSON.stringify(body),
        replacement.attestationId,
      );

      // The completion itself still verifies: the proof does not depend on the replacement.
      expect(readStoredCompletion(db, goalId)).toMatchObject({
        state: 'completed',
        proofId: completion.proofId,
      });
      // Observed: loading the replacement for the proof's chain fails, so the proof attestation reads as invalid.
      const projection = getAttestationCorrectionStanding(db, goalId, decided.attestationId);
      expect(projection.standing).toBe('invalid');
      expect(projection.invalidCode).toBe('correction_chain_invalid');

      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: completedStatus(completion),
        proof,
        correction: {
          attestationId: decided.attestationId,
          standing: 'invalid',
          correctionCount: 0,
          tip: null,
          correctedAfterCompletion: null,
          invalidCode: 'correction_chain_invalid',
          replacement: null,
        },
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A6 (sha1): a forged stored correction reads as invalid with the projection code, and the proof dimension stays valid',
    async () => {
      const { decided, completion, db, goalId } = await completed('sha1');
      const proofBefore = v2Of(db, goalId).proof;
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const stored = db
        .prepare(
          'SELECT payload_json FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?',
        )
        .get(goalId, decided.attestationId) as { payload_json: string };
      const forged = {
        ...(JSON.parse(stored.payload_json) as Record<string, unknown>),
        correctionDigest: 'f'.repeat(64),
      };
      // Disposable-DB tamper, as externalCompletionPreflight.test.ts T9d does: drop the correction immutability trigger,
      // then store a forged payload and a forged correction digest.
      db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      db.prepare(
        'UPDATE goal_attestation_corrections SET payload_json = ?, correction_digest = ? WHERE goal_id = ? AND attestation_id = ?',
      ).run(JSON.stringify(forged), 'f'.repeat(64), goalId, decided.attestationId);

      const projection = getAttestationCorrectionStanding(db, goalId, decided.attestationId);
      expect(projection.standing).toBe('invalid');
      expect(projection.invalidCode).toBe('correction_chain_invalid');

      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: completedStatus(completion),
        proof: proofBefore,
        correction: {
          attestationId: decided.attestationId,
          standing: 'invalid',
          correctionCount: 0,
          tip: null,
          correctedAfterCompletion: null,
          invalidCode: projection.invalidCode,
          replacement: null,
        },
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(model.proof).toMatchObject({ state: 'valid', proofDigest: completion.proofDigest });
      expect(model.claim.unqualifiedSuccessAllowed).toBe(false);
      expect(model.claim.trustedForDownstream).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A7 (sha1): a dispute and a withdrawal after completion change only the correction, approval and event tables',
    async () => {
      const { decided, completion, db, goalId, repo } = await completed('sha1');
      const snapshotBefore = databaseSnapshot(db);
      const repoBefore = repositoryState(repo);
      const goalBefore = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
      const proofsBefore = db.prepare('SELECT * FROM goal_external_completion_proofs ORDER BY rowid').all();
      const eventsBefore = db.prepare('SELECT * FROM goal_events ORDER BY rowid').all();
      const storedBefore = readStoredCompletion(db, goalId);
      const statusBefore = readGoalCompletionStanding(db, goalId).status;

      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');

      const snapshotAfter = databaseSnapshot(db);
      const changed = Object.keys(snapshotAfter.digests)
        .filter(
          (table) =>
            snapshotAfter.digests[table] !== snapshotBefore.digests[table] ||
            snapshotAfter.counts[table] !== snapshotBefore.counts[table],
        )
        .sort();
      expect(changed).toEqual(['goal_approvals', 'goal_attestation_corrections', 'goal_events']);
      expect(
        Object.fromEntries(
          changed.map((table) => [table, snapshotAfter.counts[table]! - snapshotBefore.counts[table]!]),
        ),
      ).toEqual({ goal_approvals: 2, goal_attestation_corrections: 2, goal_events: 6 });

      expect(db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId)).toEqual(goalBefore);
      expect(db.prepare('SELECT * FROM goal_external_completion_proofs ORDER BY rowid').all()).toEqual(
        proofsBefore,
      );
      const eventsAfter = db.prepare('SELECT * FROM goal_events ORDER BY rowid').all();
      expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
      expect(eventsAfter.slice(eventsBefore.length).map((event) => (event as { type: string }).type)).toEqual(
        [
          'approval_requested',
          'approval_decided',
          'external_integration_corrected',
          'approval_requested',
          'approval_decided',
          'external_integration_corrected',
        ],
      );

      expect(readStoredCompletion(db, goalId)).toEqual(storedBefore);
      expect(readStoredCompletion(db, goalId)).toMatchObject({ state: 'completed' });
      expect(readGoalCompletionStanding(db, goalId).status).toEqual(statusBefore);
      expect(repositoryState(repo)).toEqual(repoBefore);
      expect(completion.completedAt).toBe(statusBefore.completedAt);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A8 (sha1): the uncorrected completion is uncontested, and every later correction is not',
    async () => {
      const { decided, db, goalId } = await completed('sha1');
      expect(readGoalCompletionStanding(db, goalId).standing).toBe('uncontested');

      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const disputed = readGoalCompletionStanding(db, goalId).standing;
      expect(disputed).toBe('disputed');
      expect(disputed).not.toBe('uncontested');

      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');
      const withdrawn = readGoalCompletionStanding(db, goalId).standing;
      expect(withdrawn).toBe('withdrawn');
      expect(withdrawn).not.toBe('uncontested');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'A9 (sha1): after a withdrawal the replay still reports completed, and the standing reader reports withdrawn',
    async () => {
      const { decided, completion, db, goalId } = await completed('sha1');
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');
      // Pinned current behaviour: the replay names the historical identity and carries no standing.
      const replay = await completeGoalFromExternalDecision(db, requestFor(decided));
      expect(replay).toMatchObject({
        reused: true,
        completion: { state: 'completed', proofId: completion.proofId },
      });
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({ kind: 'v2', standing: 'withdrawn' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: B a correction before completion, and independence of attestations', () => {
  it.each([
    ['dispute', 'attestation_disputed'],
    ['withdraw', 'attestation_withdrawn'],
  ] as const)(
    'B1 (sha1) %s before any decision: the decision is refused by its code, nothing is written, and the Goal is not completed',
    async (kind, code) => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      appendCorrectionForTest(fx, attested.attestationId, kind);
      const before = databaseSnapshot(fx.db);

      expect(
        await decisionRefusal(
          recordExternalCompletionDecision(fx.db, inputFor(fx.goalId, attested.attestationId)),
        ),
      ).toEqual({ code: 'preflight_refused', detail: code });
      expect(
        await completionRefusal(
          completeGoalFromExternalDecision(fx.db, inputFor(fx.goalId, attested.attestationId)),
        ),
      ).toEqual({ code: 'decision_not_found', detail: null });
      expect(databaseSnapshot(fx.db)).toEqual(before);
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toEqual({
        schemaVersion: 1,
        goalId: fx.goalId,
        kind: 'not_completed',
        standing: null,
        status: { goalStatus: 'running', completedAt: null, reasonCode: 'user_start' },
        claim: NOT_COMPLETED_CLAIM,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B1 (sha1) supersede before any decision: the decision is refused with attestation_superseded, and the Goal is not completed',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      advanceDestination(attested, 'destination moved for the replacement');
      const replacement = await reattestAtCurrentTip(attested);
      appendCorrectionForTest(fx, attested.attestationId, 'supersede', replacement.attestationId);

      expect(
        await decisionRefusal(
          recordExternalCompletionDecision(fx.db, inputFor(fx.goalId, attested.attestationId)),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_superseded' });
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        kind: 'not_completed',
        standing: null,
        claim: NOT_COMPLETED_CLAIM,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B2 (sha1): with A withdrawn before completion, an independent B completes and the Goal is uncontested',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      advanceDestination(attested, 'destination moved before the second observation');
      const second = await reattestAtCurrentTip(attested);
      appendCorrectionForTest(fx, attested.attestationId, 'withdraw');

      expect(
        await decisionRefusal(
          recordExternalCompletionDecision(fx.db, inputFor(fx.goalId, attested.attestationId)),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_withdrawn' });

      const digest = await reviewedDigest({ fx, attestationId: second.attestationId });
      await recordExternalCompletionDecision(fx.db, inputFor(fx.goalId, second.attestationId, digest));
      const { completion } = await completeGoalFromExternalDecision(
        fx.db,
        inputFor(fx.goalId, second.attestationId, digest),
      );
      const model = v2Of(fx.db, fx.goalId);
      expect(model).toMatchObject({
        standing: 'uncontested',
        proof: { state: 'valid', proofId: completion.proofId, attestationId: second.attestationId },
        correction: { attestationId: second.attestationId, standing: 'active_uncontested', tip: null },
        claim: { unqualifiedSuccessAllowed: true, trustedForDownstream: true, qualifier: 'none' },
      });
      expect(model.otherAttestations).toEqual([
        {
          attestationId: attested.attestationId,
          recordDigest: attested.attestation.recordDigest,
          standing: 'withdrawn',
          isReplacementOfProofAttestation: false,
          restoresCompletion: false,
        },
      ]);
      expect(model.otherAttestationsTruncated).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B3 (sha1): a decision recorded for A, then a dispute of A before completion, refuses the completion with attestation_disputed',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      appendCorrectionForTest(fx, decided.attestationId, 'dispute');
      const before = databaseSnapshot(fx.db);

      expect(await completionRefusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'attestation_disputed',
      });
      expect(databaseSnapshot(fx.db)).toEqual(before);
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        kind: 'not_completed',
        standing: null,
        claim: NOT_COMPLETED_CLAIM,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B4 (sha1): after completion on A, withdrawing an independent B leaves the Goal uncontested and trusted',
    async () => {
      const made = await completedWithIndependent('sha1', 1);
      const { decided, completion, db, goalId } = made;
      const independent = made.independent[0];
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, independent.attestationId, 'withdraw');
      const model = v2Of(db, goalId);
      expect(model.standing).toBe('uncontested');
      expect(model.proof).toMatchObject({
        attestationId: decided.attestationId,
        proofDigest: completion.proofDigest,
      });
      expect(model.otherAttestations).toEqual([
        {
          attestationId: independent.attestationId,
          recordDigest: independent.recordDigest,
          standing: 'withdrawn',
          isReplacementOfProofAttestation: false,
          restoresCompletion: false,
        },
      ]);
      expect(model.claim.trustedForDownstream).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B5 (sha1): after completion on A, withdrawing A leaves the Goal withdrawn, and B keeps its own standing',
    async () => {
      const made = await completedWithIndependent('sha1', 1);
      const { decided, db, goalId } = made;
      const independent = made.independent[0];
      const independentBefore = getAttestationCorrectionStanding(db, goalId, independent.attestationId);
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'v2',
        standing: 'withdrawn',
        proof: { attestationId: decided.attestationId },
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'withdrawn_by_user',
        },
      });
      expect(model.otherAttestations).toEqual([
        {
          attestationId: independent.attestationId,
          recordDigest: independent.recordDigest,
          standing: 'active_uncontested',
          isReplacementOfProofAttestation: false,
          restoresCompletion: false,
        },
      ]);
      expect(getAttestationCorrectionStanding(db, goalId, independent.attestationId)).toEqual(
        independentBefore,
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B6 (sha1): a withdrawal in one completed Goal leaves another completed Goal uncontested (two databases: the kit cannot host two Goals in one)',
    async () => {
      const first = await completed('sha1');
      const second = await completed('sha1');
      await letClockAdvance();
      appendCorrectionForTest(first.decided.fx, first.decided.attestationId, 'withdraw');
      expect(readGoalCompletionStanding(first.db, first.goalId).standing).toBe('withdrawn');
      expect(readGoalCompletionStanding(second.db, second.goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: { unqualifiedSuccessAllowed: true, trustedForDownstream: true },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion standing reader: review follow-ups for commit 2 (5a to 5c)', () => {
  it(
    'C1 (sha1): with 21 other attestations, exactly 20 are listed and the list is marked truncated',
    async () => {
      const { db, goalId, independent } = await completedWithIndependent('sha1', 21);
      const ids = independent.map((record) => record.attestationId);
      const count = (
        db
          .prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations WHERE goal_id = ?')
          .get(goalId) as { n: number }
      ).n;
      expect(count).toBe(22);
      const model = v2Of(db, goalId);
      expect(model.standing).toBe('uncontested');
      expect(model.otherAttestations.map((other) => other.attestationId)).toEqual(ids.slice(0, 20));
      expect(model.otherAttestations.every((other) => other.standing === 'active_uncontested')).toBe(true);
      expect(model.otherAttestationsTruncated).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'C2 (sha1): another attestation that fails integrity is unavailable, and the Goal standing does not change',
    async () => {
      const { db, goalId, independent } = await completedWithIndependent('sha1', 1);
      const other = independent[0];
      // Disposable-DB tamper: drop the attestation immutability trigger, lift the CHECK constraints, and change the
      // observation time inside the other attestation's stored body.
      db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      db.pragma('ignore_check_constraints = ON');
      const row = db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(other.attestationId) as { payload_json: string };
      const body = JSON.parse(row.payload_json) as Record<string, unknown>;
      body.observedAt = LATER;
      db.prepare('UPDATE goal_external_integration_attestations SET payload_json = ? WHERE id = ?').run(
        JSON.stringify(body),
        other.attestationId,
      );
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: { unqualifiedSuccessAllowed: true, trustedForDownstream: true },
      });
      expect(model.otherAttestations).toEqual([
        {
          attestationId: other.attestationId,
          recordDigest: other.recordDigest,
          standing: 'unavailable',
          isReplacementOfProofAttestation: false,
          restoresCompletion: false,
        },
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'C3 (sha1): a non-domain fault in the correction read maps to invalid_unverified with integrity_check_failed',
    async () => {
      const { completion, db, goalId } = await completed('sha1');
      // Disposable-DB technique: drop the correction table. Reading the correction chain then throws a SQLite error, which
      // is not a domain error, so the reader's catch-all must classify it instead of letting it escape.
      db.exec('DROP TABLE goal_attestation_corrections;');
      expect(readGoalCompletionStanding(db, goalId)).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: completedStatus(completion),
        proof: { state: 'invalid', reason: 'integrity_check_failed' },
        correction: null,
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['integrity_check_failed'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'C4 (sha1): a fault in the single Goal-row read propagates as an exception, and never returns a standing',
    async () => {
      const { db, goalId } = await completed('sha1');
      // Disposable-DB technique: rename the goals table. The Goal row cannot be read, so there is no status to report.
      db.exec('ALTER TABLE goals RENAME TO goals_renamed_for_fault_test;');
      const error = thrownBy(() => readGoalCompletionStanding(db, goalId));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('no such table: goals');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'C5 (sha1): an attestation whose approval no longer matches is unavailable to the correction read, not a success',
    async () => {
      const { decided, completion, db, goalId } = await completed('sha1');
      // Disposable-DB technique: drop the approval identity and terminal triggers, then change the attestation approval's
      // decision time, so the approval no longer matches the attestation record.
      db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      db.prepare('UPDATE goal_approvals SET responded_at = ? WHERE id = ?').run(LATER, decided.approval.id);
      const model = readGoalCompletionStanding(db, goalId);
      expect(model.standing).not.toBe('uncontested');
      expect(model.claim.unqualifiedSuccessAllowed).toBe(false);
      // Observed: the historical identity read still answers completed, because it does not re-check the approval. The
      // standing reader is the one that reports the mismatch, as invalid.
      expect(readStoredCompletion(db, goalId)).toMatchObject({ state: 'completed' });
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: completedStatus(completion),
      });
      // The approval mismatch is the AttestationCorrectionError branch: the correction read is unavailable, not a success.
      expect(model.correction).toMatchObject({
        attestationId: decided.attestationId,
        standing: 'unavailable',
      });
      expect(model.classification.reasons).toEqual(['attestation_unavailable']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'C6 (sha1), not producible: attesting the destination after completion is refused by its code, and nothing is written',
    async () => {
      const { decided, db } = await completed('sha1');
      advanceDestination(decided, 'destination moved after completion');
      const before = databaseSnapshot(db);
      await expect(reattestAtCurrentTip(decided)).rejects.toMatchObject({ code: 'goal_ineligible' });
      expect(databaseSnapshot(db)).toEqual(before);
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

describe('completion standing reader: G D.3F commit 3b, the remaining reason codes and the correction time rule', () => {
  it(
    'G1 correction_time_invalid: a completed_at that is not canonical ISO makes the time rule refuse, and the stored read still agrees',
    async () => {
      const { decided, completion, db, goalId } = await completed('sha1');
      const proof = v2Of(db, goalId).proof;
      await letClockAdvance();
      const { record } = appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      expect(new Date(record.decision.decidedAt).toISOString()).toBe(record.decision.decidedAt);
      // Disposable-DB tamper: the same instant without milliseconds. It parses, but its text is not its own toISOString().
      // The Goal row and the two completion events that must agree with it are rewritten together, with the event
      // immutability trigger dropped for this database only. The stored read therefore still answers completed.
      const nonCanonical = completion.completedAt.replace(/\.\d{3}Z$/, 'Z');
      expect(nonCanonical).not.toBe(completion.completedAt);
      expect(new Date(Date.parse(nonCanonical)).toISOString()).not.toBe(nonCanonical);
      db.exec('DROP TRIGGER trg_goal_event_immutable;');
      db.prepare('UPDATE goals SET completed_at = ? WHERE id = ?').run(nonCanonical, goalId);
      const events = db
        .prepare(
          "SELECT id, type, payload_json FROM goal_events WHERE goal_id = ? AND type IN ('external_completion_recorded', 'state_changed')",
        )
        .all(goalId) as { id: string; type: string; payload_json: string }[];
      for (const event of events) {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        if (event.type === 'external_completion_recorded') payload.completedAt = nonCanonical;
        else if (payload.to !== 'completed') continue;
        db.prepare('UPDATE goal_events SET created_at = ?, payload_json = ? WHERE id = ?').run(
          nonCanonical,
          JSON.stringify(payload),
          event.id,
        );
      }

      expect(readStoredCompletion(db, goalId)).toMatchObject({
        state: 'completed',
        proofId: completion.proofId,
        completedAt: nonCanonical,
      });
      expect(readGoalCompletionStanding(db, goalId)).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: {
          goalStatus: 'completed',
          completedAt: nonCanonical,
          reasonCode: EXTERNAL_COMPLETION_REASON,
        },
        proof,
        correction: {
          attestationId: decided.attestationId,
          standing: 'disputed',
          correctionCount: 1,
          tip: {
            correctionId: record.correctionId,
            kind: 'dispute',
            sequence: 1,
            correctionDigest: record.correctionDigest,
            decidedAt: record.decision.decidedAt,
            replacementAttestationId: null,
          },
          correctedAfterCompletion: null,
          invalidCode: null,
          replacement: null,
        },
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['correction_time_invalid'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'G1 decided_at tamper: a non-canonical decision time is refused by the chain verifier first, so the time rule is not reached',
    async () => {
      const { decided, completion, db, goalId } = await completed('sha1');
      const proof = v2Of(db, goalId).proof;
      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      // Disposable-DB tamper: drop the correction immutability trigger, lift the CHECK constraints, and store a
      // non-canonical decided_at column. The chain verifier compares that column with the verified payload and refuses.
      db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      db.pragma('ignore_check_constraints = ON');
      db.prepare('UPDATE goal_attestation_corrections SET decided_at = ? WHERE goal_id = ?').run(
        '2030-01-01T00:00:00Z',
        goalId,
      );
      // Observed: the projection's own code is correction_chain_invalid, so the reader never reaches the time rule.
      expect(getAttestationCorrectionStanding(db, goalId, decided.attestationId)).toMatchObject({
        standing: 'invalid',
        invalidCode: 'correction_chain_invalid',
      });
      expect(readGoalCompletionStanding(db, goalId)).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: completedStatus(completion),
        proof,
        correction: {
          attestationId: decided.attestationId,
          standing: 'invalid',
          correctionCount: 0,
          tip: null,
          correctedAfterCompletion: null,
          invalidCode: 'correction_chain_invalid',
          replacement: null,
        },
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'G2 correction_mapping_unclassifiable is not reached through the DB: a supersede with its replacement binding nulled is refused first by correction_chain_invalid',
    async () => {
      // The reader's mapping branch needs a supersede tip with no replacement. Three of its branches (no tip with a
      // non-empty chain, a projection and history tip mismatch, and a non-null tip with active_uncontested) cannot be
      // produced, because the projection and the history come from one verified chain read in one transaction.
      const { decided, completion, db, goalId } = await supersededWithReplacement('sha1');
      db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      db.pragma('ignore_check_constraints = ON');
      db.prepare(
        "UPDATE goal_attestation_corrections SET replacement_attestation_id = NULL, replacement_record_digest = NULL WHERE goal_id = ? AND correction_kind = 'supersede'",
      ).run(goalId);
      // Observed: the chain verifier refuses the row before the mapping sees a supersede without a replacement.
      expect(getAttestationCorrectionStanding(db, goalId, decided.attestationId)).toMatchObject({
        standing: 'invalid',
        invalidCode: 'correction_chain_invalid',
      });
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: completedStatus(completion),
        correction: { standing: 'invalid', invalidCode: 'correction_chain_invalid', tip: null },
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
      });
      expect(readGoalCompletionStanding(db, goalId).classification.reasons).not.toContain(
        'correction_mapping_unclassifiable',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'G3 chain_identity_mismatch is not producible through the DB: the forged chain digest is caught first by completion_approval_mismatch',
    async () => {
      // Not attempted: reaching the chain check needs the completion approval action body, its action digest, the decision
      // action digest, the status detail and the recorded event re-forged together. The approval comparison runs first.
      const { completion, db, goalId } = await completed('sha1');
      forgeChainDigest(db, goalId, completion.proofId);
      expect(readStoredCompletion(db, goalId)).toEqual({
        state: 'invalid',
        reason: 'completion_approval_mismatch',
      });
      const model = readGoalCompletionStanding(db, goalId);
      expect(model).toMatchObject({
        kind: 'invalid',
        standing: 'invalid_unverified',
        proof: { state: 'invalid', reason: 'completion_approval_mismatch' },
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_integrity_failed'] },
      });
      expect(model.classification.reasons).not.toContain('chain_identity_mismatch');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'G5 proof_without_completion: a proof row on a Goal that is not completed reads as invalid with that reason',
    async () => {
      // No goal status trigger exists in the migrations, so the status is reset with a plain update, as R5a does.
      const { completion, db, goalId } = await completed('sha1');
      db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(goalId);
      expect(readStoredCompletion(db, goalId)).toEqual({
        state: 'invalid',
        reason: 'proof_without_completion',
      });
      expect(readGoalCompletionStanding(db, goalId)).toEqual({
        schemaVersion: 1,
        goalId,
        kind: 'invalid',
        standing: 'invalid_unverified',
        status: {
          goalStatus: 'running',
          completedAt: completion.completedAt,
          reasonCode: EXTERNAL_COMPLETION_REASON,
        },
        proof: { state: 'invalid', reason: 'proof_without_completion' },
        correction: null,
        claim: INVALID_CLAIM,
        classification: { trust: 'untrusted', reconciliation: 'none', reasons: ['proof_without_completion'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

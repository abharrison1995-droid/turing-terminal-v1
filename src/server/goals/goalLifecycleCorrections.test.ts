import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendAttestationCorrection,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { reattestAtCurrentTip, repositoryState } from './goalV2TestKit.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import {
  approveDefinition,
  attestObservation,
  call,
  changedTables,
  closeLifecycle,
  correctAttestation,
  createSecondGoal,
  decideAndComplete,
  DEFAULT_INTEGRATION,
  driveToVerifiedHandoff,
  expectCompleted,
  FORMATS,
  goalRow,
  goalScopedDigests,
  installFakeProviders,
  openAndDriveToVerifiedHandoff,
  openGoal,
  proofRows,
  proofRowsJson,
  runFor,
  snapshotOf,
  type Target,
  untilGoal,
  wholeDatabase,
} from './goalLifecycleKit.js';
import type { Db } from '../db.js';

/**
 * Lifecycle qualification of the correction and merge paths the Q1 file does not cover: withdraw and supersede after a
 * real completion, the merge characterization of content that is not proven, and a second Goal in the same database.
 * The provider process is faked; the supervisor, engine, broker, verifier, review and completion services, the HTTP
 * routes, Git and SQLite are real. The shared steps are in goalLifecycleKit.ts.
 *
 * NOT PROVEN HERE: the content correctness of any merge. The merge characterization records what the system does with a
 * destination that discards the source content. It is not evidence that such a completion is correct.
 */
vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Live provider calls are disabled in Goal acceptance tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

beforeEach(() => installFakeProviders());

afterEach(async () => closeLifecycle());

const EXPLANATION = 'Recorded by the lifecycle corrections qualification.';

/** The value a synchronous call throws. Fails the test when the call returns instead. */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to throw, and it returned');
}

/** The id of a Goal's newest cycle, the cycle its latest run belongs to. */
function latestCycleId(db: Db, goalId: string): string {
  return (
    db.prepare('SELECT id FROM goal_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1').get(goalId) as {
      id: string;
    }
  ).id;
}

describe('withdraw and supersede after a real completion', () => {
  it.each(FORMATS)(
    'R1 withdraw (%s): a completed Goal whose attestation is withdrawn stays completed, is not trusted, and changes only the correction tables',
    async (objectFormat) => {
      const { db, repo, goalId, target, externalPath, observation } =
        await openAndDriveToVerifiedHandoff(objectFormat);
      const attestationId = await attestObservation(externalPath, observation.actionDigest);
      await decideAndComplete(target, attestationId);
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: { trustedForDownstream: true, qualifier: 'none' },
      });

      const goalBefore = goalRow(db, goalId);
      const proofBytes = proofRowsJson(db, goalId);
      const whole = wholeDatabase(db);
      const repoBefore = repositoryState(repo);

      correctAttestation(db, {
        goalId,
        attestationId,
        correctionKind: 'withdraw',
        reasonCode: 'integration_not_performed',
        replacementAttestationId: null,
        explanation: EXPLANATION,
      });

      expect(changedTables(whole, wholeDatabase(db))).toEqual([
        'goal_approvals',
        'goal_attestation_corrections',
        'goal_events',
      ]);
      expect(goalRow(db, goalId)).toEqual(goalBefore);
      expect(goalRow(db, goalId)).toMatchObject({ status: 'completed' });
      expect(proofRowsJson(db, goalId)).toBe(proofBytes);
      expect(repositoryState(repo)).toEqual(repoBefore);
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'v2',
        standing: 'withdrawn',
        status: { goalStatus: 'completed' },
        claim: {
          trustedForDownstream: false,
          unqualifiedSuccessAllowed: false,
          qualifier: 'withdrawn_by_user',
          contentPreservation: 'not_proven',
        },
        correction: { attestationId, standing: 'withdrawn', correctionCount: 1, tip: { kind: 'withdraw' } },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'R2 supersede (%s): a completed Goal superseded by an independent replacement is superseded, the replacement is active, and the Goal does not switch to it',
    async (objectFormat) => {
      const { harness, db, repo, goalId, target, externalPath, observation, handoffId } =
        await openAndDriveToVerifiedHandoff(objectFormat);
      const attestationA = await attestObservation(externalPath, observation.actionDigest);

      // The destination advances after A was attested. A stays uncorrected; R must observe a different tip, because
      // re-attesting the same tip yields the same action digest.
      writeFileSync(join(repo, 'after-a.txt'), 'destination advanced after A was attested\n');
      harness.fx.git('add', 'after-a.txt');
      harness.fx.git('commit', '-m', 'user advances destination after A');
      const attestationR = (await reattestAtCurrentTip({ fx: harness.fx, handoff: { handoffId } }))
        .attestationId;
      expect(attestationR).not.toBe(attestationA);

      // The completion is recorded on R, not A.
      const completed = await decideAndComplete(target, attestationR);
      expect(completed.completed.completion).toMatchObject({ state: 'completed' });
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        proof: { attestationId: attestationR },
      });

      const goalBefore = goalRow(db, goalId);
      const proofBytes = proofRowsJson(db, goalId);
      const whole = wholeDatabase(db);
      const repoBefore = repositoryState(repo);

      correctAttestation(db, {
        goalId,
        attestationId: attestationR,
        correctionKind: 'supersede',
        reasonCode: 'superseded_by_new_observation',
        replacementAttestationId: attestationA,
        explanation: EXPLANATION,
      });

      expect(changedTables(whole, wholeDatabase(db))).toEqual([
        'goal_approvals',
        'goal_attestation_corrections',
        'goal_events',
      ]);
      expect(goalRow(db, goalId)).toEqual(goalBefore);
      expect(proofRowsJson(db, goalId)).toBe(proofBytes);
      expect(repositoryState(repo)).toEqual(repoBefore);
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'v2',
        standing: 'superseded',
        status: { goalStatus: 'completed' },
        claim: { trustedForDownstream: false, qualifier: 'superseded_by_user' },
        // The proof still names R: the completion does not switch to the replacement.
        proof: { attestationId: attestationR },
        correction: {
          attestationId: attestationR,
          standing: 'superseded',
          tip: { kind: 'supersede', replacementAttestationId: attestationA },
        },
        otherAttestations: [
          expect.objectContaining({
            attestationId: attestationA,
            standing: 'active_uncontested',
            isReplacementOfProofAttestation: true,
            restoresCompletion: false,
          }),
        ],
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('merge -s ours characterization', () => {
  it.each(FORMATS)(
    'R4 CHARACTERIZATION, NOT a correctness proof (%s): a merge -s ours destination completes as trusted with content not proven, and the acknowledgement refusals write nothing',
    async (objectFormat) => {
      const { harness, db, repo, goalId, target, externalPath, observation, integratedHead } =
        await driveToVerifiedHandoff(await openGoal('gpt-5.5', objectFormat), 'ours');

      // The merge discarded the content: the Goal's source has the file, the destination does not.
      expect(() => harness.fx.git('cat-file', '-e', `${integratedHead}:src/add.js`)).not.toThrow();
      expect(() => harness.fx.git('cat-file', '-e', 'main:src/add.js')).toThrow();

      const attestationId = await attestObservation(externalPath, observation.actionDigest);
      const preflight = await computeExternalCompletionPreflight(db, goalId, { attestationId });
      expect(preflight.outcome).toBe('ready');

      // The decision refuses without the acknowledgement, before any write.
      const beforeDecisionRefusal = wholeDatabase(db);
      const repoBeforeDecisionRefusal = repositoryState(repo);
      await expect(
        recordExternalCompletionDecision(db, {
          goalId,
          attestationId,
          reviewedPreflightDigest: preflight.digest,
          acknowledgeContentNotProven: false,
        }),
      ).rejects.toMatchObject({ code: 'acknowledgement_required' });
      expect(wholeDatabase(db)).toEqual(beforeDecisionRefusal);
      expect(repositoryState(repo)).toEqual(repoBeforeDecisionRefusal);

      const decision = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId,
        reviewedPreflightDigest: preflight.digest,
        acknowledgeContentNotProven: true,
      });
      expect(decision).toMatchObject({ status: 'approved', reused: false });

      // The completion refuses without the acknowledgement too, before any write.
      const request = {
        goalId,
        attestationId,
        reviewedPreflightDigest: preflight.digest,
        acknowledgeContentNotProven: true as const,
      };
      const beforeCompletionRefusal = wholeDatabase(db);
      const repoBeforeCompletionRefusal = repositoryState(repo);
      await expect(
        completeGoalFromExternalDecision(db, { ...request, acknowledgeContentNotProven: false }),
      ).rejects.toMatchObject({ code: 'acknowledgement_required' });
      expect(wholeDatabase(db)).toEqual(beforeCompletionRefusal);
      expect(repositoryState(repo)).toEqual(repoBeforeCompletionRefusal);

      // With the acknowledgement, the Goal completes with the whole-state effect Q1 checks, and the standing is trusted
      // with content not proven.
      const before = snapshotOf(target, decision.approvalId);
      const completed = await completeGoalFromExternalDecision(db, request);
      expect(completed.completion).toMatchObject({ state: 'completed', approvalId: decision.approvalId });
      expectCompleted(target, before, decision.approvalId);
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: {
          trustedForDownstream: true,
          unqualifiedSuccessAllowed: true,
          qualifier: 'none',
          contentPreservation: 'not_proven',
        },
      });
      // The destination still lacks the file after completion: the completion did not and could not restore it.
      expect(() => harness.fx.git('cat-file', '-e', 'main:src/add.js')).toThrow();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('a second Goal in the same database', () => {
  it.each(FORMATS)(
    'R5 (%s): a second Goal keeps its rows, events and proof count through A completion and a dispute of A, and A approvals cannot be used by B',
    async (objectFormat) => {
      const harness = await openGoal('gpt-5.5', objectFormat);
      const { db, repo, goalId: goalA } = harness.fx;
      const goalB = createSecondGoal(harness);
      expect(goalB).not.toBe(goalA);

      // B is approved but not started. A started Goal holds the project lease, and a second Goal cannot start while it
      // does, so B waits in `ready` for A's completion. A completed Goal holds no lease.
      expect((await approveDefinition(db, goalB)).response).toMatchObject({
        status: 200,
        body: { goalStatus: 'ready' },
      });
      const bReady = goalScopedDigests(db, goalB);
      expect(goalRow(db, goalB)).toMatchObject({ status: 'ready' });
      expect(readGoalCompletionStanding(db, goalB)).toMatchObject({ kind: 'not_completed' });

      // A is driven through its verified handoff, attested, and completed through the real services.
      const aDrive = await driveToVerifiedHandoff(harness, DEFAULT_INTEGRATION[objectFormat]);
      const targetA: Target = { db, goalId: goalA, repo };
      const attestationA = await attestObservation(aDrive.externalPath, aDrive.observation.actionDigest);
      const aBeforeCompletion = goalScopedDigests(db, goalA);
      const completedA = await decideAndComplete(targetA, attestationA);
      expect(proofRows(db, goalA)).toHaveLength(1);
      // Positive control: the scoped digests do see A's own completion, so an unchanged B is a real result.
      expect(goalScopedDigests(db, goalA)).not.toEqual(aBeforeCompletion);
      expect(goalScopedDigests(db, goalB)).toEqual(bReady);
      expect(goalRow(db, goalB)).toMatchObject({ status: 'ready' });

      // B starts now that A is completed, and runs real proposal and execution on the supervisor that started it.
      expect(await call('POST', `/api/goals/${goalB}/start`, {})).toMatchObject({
        status: 200,
        body: { ok: true, goalStatus: 'running' },
      });
      await untilGoal(harness, goalB, 'proposal_run_started');
      const proposalB = runFor(db, goalB, 'proposal');
      await vi.waitFor(() => expect(harness.runRow(proposalB.id).status).toBe('completed'), {
        timeout: 20_000,
      });
      await untilGoal(harness, goalB, 'proposal_recorded');
      await untilGoal(harness, goalB, 'run_started');
      const executionB = runFor(db, goalB, 'execution', latestCycleId(db, goalB));
      await vi.waitFor(() => expect(harness.runRow(executionB.id).status).toBe('completed'), {
        timeout: 25_000,
      });
      await untilGoal(harness, goalB, 'cycle_succeeded');

      const bRunning = goalScopedDigests(db, goalB);
      const bRunningRow = goalRow(db, goalB);
      expect(bRunningRow).toMatchObject({ status: 'running' });
      expect(Object.keys(bRunning)).toEqual(
        expect.arrayContaining(['goals', 'goal_events', 'goal_cycles', 'runs']),
      );
      expect(proofRows(db, goalB)).toEqual([]);

      // A is disputed through the real correction services while B runs. B's rows and events do not move.
      const disputeA = correctAttestation(db, {
        goalId: goalA,
        attestationId: attestationA,
        correctionKind: 'dispute',
        reasonCode: 'observation_error',
        replacementAttestationId: null,
        explanation: EXPLANATION,
      });
      expect(goalScopedDigests(db, goalB)).toEqual(bRunning);
      expect(goalRow(db, goalB)).toEqual(bRunningRow);
      expect(proofRows(db, goalB)).toEqual([]);

      // A's approvals and attestation cannot be used by B. Each attempt is refused, and none of them writes anything.
      const whole = wholeDatabase(db);
      const repoBefore = repositoryState(repo);
      expect(
        thrownBy(() =>
          appendAttestationCorrection(db, {
            goalId: goalB,
            approvalId: disputeA.approval.id,
            expectedActionDigest: disputeA.actionDigest,
            explanation: EXPLANATION,
          }),
        ),
      ).toMatchObject({ code: 'approval_mismatch' });
      expect(
        thrownBy(() =>
          requestAttestationCorrectionApproval(db, {
            goalId: goalB,
            attestationId: attestationA,
            correctionKind: 'withdraw',
            reasonCode: 'integration_not_performed',
            explanation: EXPLANATION,
            replacementAttestationId: null,
          }),
        ),
      ).toMatchObject({ code: 'attestation_not_found' });
      const preflightB = await computeExternalCompletionPreflight(db, goalB, { attestationId: attestationA });
      expect(preflightB).toMatchObject({ outcome: 'refused', reasons: [{ code: 'attestation_not_found' }] });
      await expect(
        recordExternalCompletionDecision(db, {
          goalId: goalB,
          attestationId: attestationA,
          reviewedPreflightDigest: preflightB.digest,
          acknowledgeContentNotProven: true,
        }),
      ).rejects.toMatchObject({ code: 'preflight_refused', detail: 'attestation_not_found' });
      await expect(
        completeGoalFromExternalDecision(db, {
          goalId: goalB,
          attestationId: attestationA,
          reviewedPreflightDigest: completedA.preflight.digest,
          acknowledgeContentNotProven: true,
        }),
      ).rejects.toMatchObject({ code: 'decision_not_found' });
      expect(wholeDatabase(db)).toEqual(whole);
      expect(repositoryState(repo)).toEqual(repoBefore);

      // B is unchanged at the end: its rows, its events, and its proof count (still none; B never completed).
      expect(goalScopedDigests(db, goalB)).toEqual(bRunning);
      expect(goalRow(db, goalB)).toEqual(bRunningRow);
      expect(proofRows(db, goalB)).toEqual([]);
      expect(readGoalCompletionStanding(db, goalB)).toMatchObject({ kind: 'not_completed' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { getGoalApproval, requestGoalApproval } from './approvals.js';
import { completeGoalFromExternalDecision, ExternalCompletionError } from './externalCompletion.js';
import { readExternalCompletionProof } from './externalCompletionProof.js';
import type { ExternalCompletionPreflightReport } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  repositoryState,
  v2DecidedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { onGoalTransition } from './stateMachine.js';

/**
 * Seams on the completion path, all set after the decision is recorded so the fixture itself runs unhooked.
 * `afterPreflight` runs once after the real preflight returns, before the completion transaction. `beforeValidate`
 * queues hooks that run once each inside the Git validation of the next preflight, between its two identity snapshots.
 * `alterReport` rewrites the report of every preflight while it is set. `preflightCalls` counts preflight invocations.
 */
const seam = vi.hoisted(() => ({
  afterPreflight: null as null | (() => void),
  beforeValidate: [] as (() => void)[],
  alterReport: null as
    null | ((report: ExternalCompletionPreflightReport) => ExternalCompletionPreflightReport),
  preflightCalls: 0,
}));

vi.mock('./externalCompletionPreflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalCompletionPreflight.js')>();
  return {
    ...actual,
    computeExternalCompletionPreflightWithIdentity: async (
      db: Db,
      goalId: string,
      input: { attestationId: string },
      options?: { allowRecordedDecision?: boolean },
    ) => {
      seam.preflightCalls += 1;
      const result = await actual.computeExternalCompletionPreflightWithIdentity(db, goalId, input, options);
      const hook = seam.afterPreflight;
      seam.afterPreflight = null;
      hook?.();
      const alter = seam.alterReport;
      return alter === null ? result : { ...result, report: alter(result.report) };
    },
  };
});

vi.mock('./externalIntegration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalIntegration.js')>();
  return {
    ...actual,
    validateExternalIntegrationAttestation: (
      db: Db,
      goalId: string,
      attestationId: string,
    ): ReturnType<typeof actual.validateExternalIntegrationAttestation> => {
      seam.beforeValidate.shift()?.();
      return actual.validateExternalIntegrationAttestation(db, goalId, attestationId);
    },
  };
});

afterEach(() => {
  seam.afterPreflight = null;
  seam.beforeValidate = [];
  seam.alterReport = null;
  seam.preflightCalls = 0;
  cleanupRepoFixtures();
});

type Decided = Awaited<ReturnType<typeof v2DecidedFixture>>;

function requestFor(decided: Decided) {
  return {
    goalId: decided.fx.goalId,
    attestationId: decided.attestationId,
    reviewedPreflightDigest: decided.digest,
    acknowledgeContentNotProven: true,
  };
}

async function refusal(attempt: Promise<unknown>): Promise<{ code: string; detail: string | null }> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalCompletionError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('the completion succeeded but a refusal was expected');
}

function goalRow(fx: GoalFixture): { status: string; completed_at: string | null } {
  return fx.db.prepare('SELECT status, completed_at FROM goals WHERE id = ?').get(fx.goalId) as {
    status: string;
    completed_at: string | null;
  };
}

function proofCount(fx: GoalFixture): number {
  return (
    fx.db
      .prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?')
      .get(fx.goalId) as {
      n: number;
    }
  ).n;
}

/** A refused completion: no proof, the Goal still running, and no completion event. The race may add approvals. */
function expectNotCompleted(fx: GoalFixture): void {
  expect(goalRow(fx)).toMatchObject({ status: 'running', completed_at: null });
  expect(proofCount(fx)).toBe(0);
  expect(fx.db.inTransaction).toBe(false);
}

describe('external completion seams: Git and observation races during the completion', () => {
  it(
    'refuses a source ref that moved during the Git validation and writes no completion (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const moved = fx.sideCommit({ 'src/moved-during-validation.txt': 'moved during validation\n' });
      seam.beforeValidate.push(() => git(fx.repo, 'update-ref', decided.handoff.source.goalRef, moved));
      const dbBefore = databaseSnapshot(fx.db);

      // The moved source is caught by the attestation's source check: attestation_stale (observed).
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'attestation_stale',
      });
      expect(databaseSnapshot(fx.db)).toEqual(dbBefore);
      expectNotCompleted(fx);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses when Git disappears during the validation and restores the repository (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const gitDir = join(fx.repo, '.git');
      const hidden = join(fx.repo, '.git-hidden');
      const repoBefore = repositoryState(fx.repo);
      seam.beforeValidate.push(() => renameSync(gitDir, hidden));
      let outcome: { code: string; detail: string | null };
      try {
        outcome = await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)));
      } finally {
        renameSync(hidden, gitDir);
      }

      expect(outcome).toEqual({ code: 'preflight_refused', detail: 'git_unavailable' });
      expect(repositoryState(fx.repo)).toEqual(repoBefore);
      expectNotCompleted(fx);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'retries one observation_changed refusal and completes on the second observation (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      seam.preflightCalls = 0;
      seam.beforeValidate.push(() => {
        requestGoalApproval(fx.db, {
          goalId: fx.goalId,
          gate: 'final_acceptance',
          risk: 'high',
          reason: 'Authority changed during the first observation.',
          requestedBy: 'user',
          detail: { race: 'first' },
        });
      });

      const result = await completeGoalFromExternalDecision(fx.db, requestFor(decided));

      expect(seam.preflightCalls).toBe(2);
      expect(result.reused).toBe(false);
      expect(readStoredCompletion(fx.db, fx.goalId)).toEqual(result.completion);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses with observation_changed when both observations change and writes no completion (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      seam.preflightCalls = 0;
      seam.beforeValidate.push(
        () => {
          requestGoalApproval(fx.db, {
            goalId: fx.goalId,
            gate: 'final_acceptance',
            risk: 'high',
            reason: 'Authority changed during the first observation.',
            requestedBy: 'user',
            detail: { race: 'first' },
          });
        },
        () => {
          requestGoalApproval(fx.db, {
            goalId: fx.goalId,
            gate: 'final_acceptance',
            risk: 'high',
            reason: 'Authority changed during the second observation.',
            requestedBy: 'user',
            detail: { race: 'second' },
          });
        },
      );

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'observation_changed',
      });
      expect(seam.preflightCalls).toBe(2);
      expectNotCompleted(fx);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'completes and ignores a transition listener that throws after the commit, and unsubscribes (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const unsubscribe = onGoalTransition(() => {
        throw new Error('listener failed after commit');
      });
      let result: Awaited<ReturnType<typeof completeGoalFromExternalDecision>>;
      try {
        result = await completeGoalFromExternalDecision(fx.db, requestFor(decided));
      } finally {
        unsubscribe();
      }

      expect(result.reused).toBe(false);
      expect(goalRow(fx)).toMatchObject({ status: 'completed' });
      expect(readStoredCompletion(fx.db, fx.goalId)).toEqual(result.completion);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'completes against the attested destination when the ref advances after observation, recording the observed commit (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const attestedCommit = decided.attestation.destination.observedCommit;
      const moved = git(
        fx.repo,
        'commit-tree',
        decided.attestation.destination.observedTree,
        '-p',
        attestedCommit,
        '-m',
        'advanced after observation',
      );
      seam.afterPreflight = () => git(fx.repo, 'update-ref', decided.handoff.target.baseRef, moved);

      const result = await completeGoalFromExternalDecision(fx.db, requestFor(decided));

      expect(result.reused).toBe(false);
      expect(git(fx.repo, 'rev-parse', decided.handoff.target.baseRef)).toBe(moved);
      const read = readExternalCompletionProof(fx.db, fx.goalId, result.completion.proofId);
      expect(read.state).toBe('valid');
      if (read.state !== 'valid') return;
      expect(read.proof.destination.observedCommit).toBe(attestedCommit);
      expect(read.proof.proofLimitations).toEqual({ contentPreservation: 'not_proven' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a rebuilt action whose fields differ from the decided action with decision_action_mismatch (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      seam.alterReport = (report) => ({
        ...report,
        actionFields: { ...report.actionFields!, verificationEvidenceDigest: '0'.repeat(64) },
      });
      const before = databaseSnapshot(fx.db);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'decision_action_mismatch',
        detail: null,
      });
      expect(databaseSnapshot(fx.db)).toEqual(before);
      expectNotCompleted(fx);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a changed reviewed preflight digest with reviewed_preflight_changed (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      seam.alterReport = (report) => ({ ...report, digest: 'f'.repeat(64) });
      const before = databaseSnapshot(fx.db);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'reviewed_preflight_changed',
        detail: null,
      });
      expect(databaseSnapshot(fx.db)).toEqual(before);
      expectNotCompleted(fx);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      'a pending final acceptance',
      (fx: GoalFixture) => {
        requestGoalApproval(fx.db, {
          goalId: fx.goalId,
          gate: 'final_acceptance',
          risk: 'high',
          reason: 'Authority changed after the preflight.',
          requestedBy: 'user',
          detail: { race: 'after-preflight' },
        });
      },
      'handoff_fingerprint',
    ],
    [
      'a dispute of the attestation',
      (fx: GoalFixture, attestationId: string) => appendCorrectionForTest(fx, attestationId, 'dispute'),
      'attestation_disputed',
    ],
    [
      'a withdrawal of the attestation',
      (fx: GoalFixture, attestationId: string) => appendCorrectionForTest(fx, attestationId, 'withdraw'),
      'attestation_withdrawn',
    ],
  ] as const)(
    'refuses after the preflight when %s appears, with authority_changed_during_completion, and writes no completion (sha1)',
    async (_label, drift, detail) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      seam.afterPreflight = () => drift(fx, decided.attestationId);
      const before = databaseSnapshot(fx.db);

      const outcome = await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)));
      expect(outcome).toEqual({ code: 'authority_changed_during_completion', detail });
      expect(proofCount(fx)).toBe(0);
      expect(databaseSnapshot(fx.db).counts.goals).toBe(before.counts.goals);
      expect(goalRow(fx)).toMatchObject({ status: 'running', completed_at: null });
      expect(getGoalApproval(fx.db, decided.recorded.approvalId)).not.toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

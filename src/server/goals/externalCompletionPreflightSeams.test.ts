import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import type { AttestationCorrectionStandingProjection } from './attestationCorrection.js';
import { requestGoalApproval } from './approvals.js';
import {
  computeExternalCompletionPreflight,
  externalCompletionPreflightReportSchema,
  type ExternalCompletionPreflightReport,
  type PreflightCheckName,
  type PreflightReasonCode,
} from './externalCompletionPreflight.js';
import {
  databaseSnapshot,
  repositoryState,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures } from './repoKit.js';

/** Test-only switches read by the module mocks below. Reset before every test. */
const seam = vi.hoisted(() => ({
  correctionFailure: null as null | 'plain' | 'correction_error' | 'invalid_code_not_snake',
  validationFailure: null as null | 'plain' | 'stale_bad_code' | 'unavailable_git' | 'invalid_code_x',
  evaluationFailure: false,
  authorityFailure: false,
  actionBuilderNull: false,
  afterValidation: null as null | ((db: Db, goalId: string) => void),
  inTransactionOnEntry: null as boolean | null,
  inTransactionAfterCall: null as boolean | null,
}));

vi.mock('./attestationCorrection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attestationCorrection.js')>();
  return {
    ...actual,
    getAttestationCorrectionStanding: (
      ...args: Parameters<typeof actual.getAttestationCorrectionStanding>
    ) => {
      if (seam.correctionFailure === 'plain') throw new Error('boom');
      if (seam.correctionFailure === 'correction_error')
        throw new actual.AttestationCorrectionError('attestation_invalid', 'boom');
      if (seam.correctionFailure === 'invalid_code_not_snake') {
        const projection = actual.getAttestationCorrectionStanding(...args);
        return {
          ...projection,
          standing: 'invalid',
          correctionCount: 0,
          tip: null,
          invalidCode: 'Not Snake' as unknown as AttestationCorrectionStandingProjection['invalidCode'],
        };
      }
      return actual.getAttestationCorrectionStanding(...args);
    },
  };
});

vi.mock('./externalIntegration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalIntegration.js')>();
  return {
    ...actual,
    validateExternalIntegrationAttestation: async (db: Db, goalId: string, attestationId: string) => {
      seam.inTransactionOnEntry = db.inTransaction;
      if (seam.validationFailure === 'plain') throw new Error('boom');
      let result: Awaited<ReturnType<typeof actual.validateExternalIntegrationAttestation>>;
      if (seam.validationFailure === 'stale_bad_code')
        result = {
          state: 'stale',
          record: null,
          reason: { code: 'Bad Code!', message: 'x' },
          currentObservation: null,
        };
      else if (seam.validationFailure === 'unavailable_git')
        result = {
          state: 'unavailable',
          record: null,
          reason: { code: 'git_unavailable', message: 'x' },
          currentObservation: null,
        };
      else if (seam.validationFailure === 'invalid_code_x')
        result = {
          state: 'invalid',
          record: null,
          reason: { code: 'x', message: 'x' },
          currentObservation: null,
        };
      else result = await actual.validateExternalIntegrationAttestation(db, goalId, attestationId);
      seam.inTransactionAfterCall = db.inTransaction;
      seam.afterValidation?.(db, goalId);
      return result;
    },
  };
});

vi.mock('./completionEvaluation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./completionEvaluation.js')>();
  return {
    ...actual,
    evaluateCompletion: async (...args: Parameters<typeof actual.evaluateCompletion>) => {
      if (seam.evaluationFailure) throw new Error('boom');
      return actual.evaluateCompletion(...args);
    },
  };
});

vi.mock('./approvedCompletionAuthority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./approvedCompletionAuthority.js')>();
  return {
    ...actual,
    readApprovedCompletionAuthority: (...args: Parameters<typeof actual.readApprovedCompletionAuthority>) => {
      if (seam.authorityFailure) throw new Error('boom');
      return actual.readApprovedCompletionAuthority(...args);
    },
  };
});

vi.mock('./externalCompletionProof.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalCompletionProof.js')>();
  return {
    ...actual,
    buildExternalCompletionAction: (...args: Parameters<typeof actual.buildExternalCompletionAction>) => {
      if (seam.actionBuilderNull) return null;
      return actual.buildExternalCompletionAction(...args);
    },
  };
});

afterEach(() => {
  seam.correctionFailure = null;
  seam.validationFailure = null;
  seam.evaluationFailure = false;
  seam.authorityFailure = false;
  seam.actionBuilderNull = false;
  seam.afterValidation = null;
  seam.inTransactionOnEntry = null;
  seam.inTransactionAfterCall = null;
  cleanupRepoFixtures();
});

const HEAVY = 60_000;

function compute(fx: GoalFixture, attestationId: string): Promise<ExternalCompletionPreflightReport> {
  return computeExternalCompletionPreflight(fx.db, fx.goalId, { attestationId });
}

function snapshotOf(fx: GoalFixture) {
  return { database: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) };
}

/**
 * A refusal produced through a seam must be the only output: one reason, one failed check, no action fields, no
 * minted authority, a schema-valid report, and no change to the database, the repository or the transaction state.
 */
function expectSeamRefusal(
  fx: GoalFixture,
  report: ExternalCompletionPreflightReport,
  before: ReturnType<typeof snapshotOf>,
  reason: { code: PreflightReasonCode; detail: string | null },
  check: PreflightCheckName,
): void {
  expect(report.outcome).toBe('refused');
  expect(report.reasons).toEqual([reason]);
  expect(report.actionFields).toBeNull();
  expect(report.authority).toEqual({
    mintsApproval: false,
    mintsProof: false,
    mintsTerminalAuthority: false,
  });
  expect(report.checks.find(({ status }) => status === 'failed')).toEqual({ name: check, status: 'failed' });
  expect(externalCompletionPreflightReportSchema.parse(report)).toEqual(report);
  expect(snapshotOf(fx)).toEqual(before);
  expect(fx.db.inTransaction).toBe(false);
}

describe('external completion preflight: seam failures', () => {
  it(
    'T14 maps a thrown correction-standing read to correction_standing_unavailable without changing rows',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = databaseSnapshot(attested.fx.db);

      seam.correctionFailure = 'plain';
      const plain = await computeExternalCompletionPreflight(attested.fx.db, attested.fx.goalId, {
        attestationId: attested.attestationId,
      });
      expect(plain.outcome).toBe('refused');
      expect(plain.reasons).toEqual([{ code: 'correction_standing_unavailable', detail: null }]);
      expect(plain.checks.find(({ status }) => status === 'failed')).toEqual({
        name: 'correction_standing',
        status: 'failed',
      });
      expect(databaseSnapshot(attested.fx.db)).toEqual(before);

      seam.correctionFailure = 'correction_error';
      const typed = await computeExternalCompletionPreflight(attested.fx.db, attested.fx.goalId, {
        attestationId: attested.attestationId,
      });
      expect(typed.reasons).toEqual([{ code: 'correction_standing_unavailable', detail: null }]);
      expect(typed.checks.find(({ status }) => status === 'failed')).toEqual({
        name: 'correction_standing',
        status: 'failed',
      });
      expect(databaseSnapshot(attested.fx.db)).toEqual(before);
    },
    HEAVY,
  );

  it(
    'T15 refuses with observation_changed when an approval is recorded after the Git validation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      seam.afterValidation = (db, goalId) => {
        requestGoalApproval(db, {
          goalId,
          gate: 'final_apply',
          risk: 'high',
          reason: 'Probe approval recorded during preflight.',
          requestedBy: 'user',
          detail: { probe: 'T15' },
        });
      };
      const report = await computeExternalCompletionPreflight(attested.fx.db, attested.fx.goalId, {
        attestationId: attested.attestationId,
      });
      expect(report.outcome).toBe('refused');
      expect(report.reasons).toEqual([{ code: 'observation_changed', detail: 'handoff_fingerprint' }]);
      expect(report.checks.find(({ status }) => status === 'failed')).toEqual({
        name: 'snapshot_after',
        status: 'failed',
      });
      expect(report.actionFields).toBeNull();
    },
    HEAVY,
  );

  it(
    'T16 never runs the Git validation inside an open transaction',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const report = await computeExternalCompletionPreflight(attested.fx.db, attested.fx.goalId, {
        attestationId: attested.attestationId,
      });
      expect(report.outcome).toBe('ready');
      expect(seam.inTransactionOnEntry).toBe(false);
      expect(seam.inTransactionAfterCall).toBe(false);
      expect(attested.fx.db.inTransaction).toBe(false);
    },
    HEAVY,
  );
});

describe('external completion preflight: unexpected failures become typed refusals', () => {
  it(
    'T17a maps a thrown Git validation to preflight_unavailable at git_observation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);
      seam.validationFailure = 'plain';
      const report = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        report,
        before,
        { code: 'preflight_unavailable', detail: null },
        'git_observation',
      );
    },
    HEAVY,
  );

  it(
    'T17b maps a thrown completion evaluation to preflight_unavailable at completion_evaluation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);
      seam.evaluationFailure = true;
      const report = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        report,
        before,
        { code: 'preflight_unavailable', detail: null },
        'completion_evaluation',
      );
    },
    HEAVY,
  );

  it(
    'T17c maps a thrown approved-authority read to preflight_unavailable at definition',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);
      seam.authorityFailure = true;
      const report = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        report,
        before,
        { code: 'preflight_unavailable', detail: null },
        'definition',
      );
    },
    HEAVY,
  );

  it(
    'T18 refuses as preflight_internal_invalid at assemble when the action cannot be built',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);
      seam.actionBuilderNull = true;
      const report = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        report,
        before,
        { code: 'preflight_internal_invalid', detail: null },
        'assemble',
      );
      expect(report.checks.slice(0, 10).every(({ status }) => status === 'passed')).toBe(true);
      expect(report.facts.freshCommit).toBe(attested.attestation.destination.observedCommit);
    },
    HEAVY,
  );
});

describe('external completion preflight: refusal path never throws', () => {
  it(
    'T19 resolves with attestation_stale and no detail when the validator reason code is not snake_case',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);
      seam.validationFailure = 'stale_bad_code';
      const report = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        report,
        before,
        { code: 'attestation_stale', detail: null },
        'git_observation',
      );
    },
    HEAVY,
  );

  it(
    'T19b resolves with correction_standing_invalid and no detail when the stored invalid code is not snake_case',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);
      seam.correctionFailure = 'invalid_code_not_snake';
      const report = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        report,
        before,
        { code: 'correction_standing_invalid', detail: null },
        'correction_standing',
      );
      expect(report.facts.correctionStanding).toBe('invalid');
    },
    HEAVY,
  );

  it(
    'T23 maps a validator unavailable state to git_unavailable and an invalid state to attestation_invalid',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const before = snapshotOf(attested.fx);

      seam.validationFailure = 'unavailable_git';
      const unavailable = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        unavailable,
        before,
        { code: 'git_unavailable', detail: 'git_unavailable' },
        'git_observation',
      );

      seam.validationFailure = 'invalid_code_x';
      const invalid = await compute(attested.fx, attested.attestationId);
      expectSeamRefusal(
        attested.fx,
        invalid,
        before,
        { code: 'attestation_invalid', detail: 'x' },
        'git_observation',
      );
    },
    HEAVY,
  );
});

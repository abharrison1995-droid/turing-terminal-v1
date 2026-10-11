import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { requestGoalApproval } from './approvals.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { databaseSnapshot, v2AttestedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures } from './repoKit.js';

/** Test-only switches read by the module mocks below. Reset before every test. */
const seam = vi.hoisted(() => ({
  correctionFailure: null as null | 'plain' | 'correction_error',
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
      const result = await actual.validateExternalIntegrationAttestation(db, goalId, attestationId);
      seam.inTransactionAfterCall = db.inTransaction;
      seam.afterValidation?.(db, goalId);
      return result;
    },
  };
});

afterEach(() => {
  seam.correctionFailure = null;
  seam.afterValidation = null;
  seam.inTransactionOnEntry = null;
  seam.inTransactionAfterCall = null;
  cleanupRepoFixtures();
});

const HEAVY = 60_000;

describe('external completion preflight: seam failures', () => {
  it(
    'T14 maps a thrown correction-standing read to correction_standing_unavailable without changing rows',
    async () => {
      const attested = await v2AttestedFixture('sha1');
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
      const attested = await v2AttestedFixture('sha1');
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
      const attested = await v2AttestedFixture('sha1');
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

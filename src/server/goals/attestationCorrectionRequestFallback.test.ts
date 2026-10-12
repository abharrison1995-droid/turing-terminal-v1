import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, goalApp } from './apiKit.js';
import { databaseSnapshot, repositoryState, v2RunningAttestedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * The generic 503 fallback of the two correction routes (closes the D.4C follow-up for the decision route, and covers the
 * new request route). A plain, non-service failure must answer 503 with one bounded sentence and the code, never the
 * failure text, and must leave the whole database unchanged. The failure is injected by wrapping the two service entry
 * points, so this file is the only one that sees a non-service error from them.
 */

const seam = vi.hoisted(() => ({ requestFails: false, decisionFails: false }));

vi.mock('./attestationCorrectionRequest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attestationCorrectionRequest.js')>();
  return {
    ...actual,
    requestAttestationCorrectionAsUser: (
      ...args: Parameters<typeof actual.requestAttestationCorrectionAsUser>
    ) => {
      if (seam.requestFails) throw new Error('SQLITE_IOERR: disk detail that must not reach the client');
      return actual.requestAttestationCorrectionAsUser(...args);
    },
  };
});

vi.mock('./attestationCorrectionDecision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attestationCorrectionDecision.js')>();
  return {
    ...actual,
    decideAttestationCorrectionAsUser: (
      ...args: Parameters<typeof actual.decideAttestationCorrectionAsUser>
    ) => {
      if (seam.decisionFails) throw new Error('SQLITE_IOERR: disk detail that must not reach the client');
      return actual.decideAttestationCorrectionAsUser(...args);
    },
  };
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  seam.requestFails = false;
  seam.decisionFails = false;
  cleanupRepoFixtures();
});

const requestUrl = (goalId: string, handoffId: string, attestationId: string) =>
  `/api/goals/${goalId}/handoffs/${handoffId}/external-integration/attestations/${attestationId}/corrections`;
const decisionUrl = (goalId: string, approvalId: string) =>
  `/api/goals/${goalId}/attestation-corrections/${approvalId}/decision`;
const quoted = (digest: string) => ({ 'if-match': `"${digest}"` });
const dispute = {
  correctionKind: 'dispute',
  reasonCode: 'observation_error',
  explanation: null,
  replacementAttestationId: null,
};

describe('correction routes: generic 503 fallback', () => {
  it(
    'D4D-F1 (sha1, running Goal): a non-service failure on the request route is 503 with the bounded sentence, and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. The failure is injected at the service entry point; no real storage fault occurs.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const position = (await call(app, 'GET', url)).body.chainPosition as string;
      const before = { db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) };
      seam.requestFails = true;

      const response = await call(app, 'POST', url, dispute, quoted(position));

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'The correction request could not be recorded safely.',
        code: 'attestation_correction_unavailable',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|disk detail|stack/);
      expect({ db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) }).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-F2 (sha1, running Goal): a non-service failure on the decision route is 503 with the bounded sentence, and leaves the gate pending',
    async () => {
      // Fixture: v2RunningAttestedFixture with one pending request made through the real route, then a failing decision.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const position = (await call(app, 'GET', url)).body.chainPosition as string;
      const requested = await call(app, 'POST', url, dispute, quoted(position));
      expect(requested.status).toBe(201);
      const before = { db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) };
      seam.decisionFails = true;

      const response = await call(
        app,
        'POST',
        decisionUrl(fx.goalId, requested.body.approvalId),
        {
          decision: 'approved',
          attestationId: attested.attestationId,
          correctionKind: 'dispute',
          explanation: null,
        },
        quoted(requested.body.actionDigest),
      );

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'The attestation correction could not be recorded safely.',
        code: 'attestation_correction_unavailable',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|disk detail|stack/);
      expect({ db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) }).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

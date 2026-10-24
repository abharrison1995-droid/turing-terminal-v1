/*
 * Fixtures for completionCorrectionQualification.test.tsx. Test-only: no production module imports this file, and it is not
 * a test file (vitest does not collect it). The shapes follow the component tests' fixtures; they are written here, not
 * imported from those test files, so the qualification file does not depend on their helpers.
 */
import type {
  GoalAttestationCorrectionHistory,
  GoalAttestationCorrectionPendingRequest,
  GoalAttestationCorrectionRequested,
  GoalCompletionStanding,
  GoalCompletionStandingClaim,
  GoalDetail,
  GoalExternalCompletionDecisionRecorded,
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionStatus,
  GoalExternalCompletionStatusRecord,
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationObservation,
  GoalExternalIntegrationStoredStatus,
  GoalManualHandoffProjection,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { vi } from 'vitest';
import { calls, detail, detailRoutes, item, preview, type Routes } from './testKit';

export const GOAL = 'goal-1';
export const HANDOFF = 'handoff-v2';
export const ATT_A = 'attestation-a';
export const ATT_B = 'attestation-b';
export const ACTION_A = '6'.repeat(64);
export const ACTION_B = '9'.repeat(64);
export const PREFLIGHT_A = '7'.repeat(64);
export const PREFLIGHT_B = '3'.repeat(64);

const SOURCE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const HANDOFF_DIGEST = 'd'.repeat(64);

export const COMPLETION_PATH = `/api/goals/${GOAL}/completion`;
export const DECISION_PATH = `/api/goals/${GOAL}/completion-decision`;
export const PREFLIGHT_PATH = `/api/goals/${GOAL}/completion-preflight`;
export const CORRECTIONS_PATH = (attestationId: string) =>
  `/api/goals/${GOAL}/handoffs/${HANDOFF}/external-integration/attestations/${attestationId}/corrections`;
export const CORRECTION_DECISION_PATH = `/api/goals/${GOAL}/attestation-corrections/ap1/decision`;

export const actionFor = (attestationId: string) => (attestationId === ATT_B ? ACTION_B : ACTION_A);
export const preflightDigestFor = (attestationId: string) =>
  attestationId === ATT_B ? PREFLIGHT_B : PREFLIGHT_A;

type Decision = GoalExternalCompletionStatus['decisions'][number];

export const created = (body: unknown) => new Response(JSON.stringify(body), { status: 201 });

/** The attestation the current call names. serve() records a call before its handler runs, so this is the call in flight. */
export function attestationInCall(): string {
  const last = calls.at(-1);
  return new URL(last?.url ?? '', 'http://fixture.invalid').searchParams.get('attestationId') ?? ATT_A;
}

// --- Handoff and attestation records ---------------------------------------------------------------------------------

export function handoff(): GoalManualIntegrationHandoff {
  return {
    schemaVersion: 1,
    kind: 'turing_goal_manual_integration_handoff',
    handoffId: HANDOFF,
    goalId: GOAL,
    definition: {
      version: 2,
      hash: 'e'.repeat(64),
      approvalId: 'definition-approval-2',
      approvalIdentityDigest: 'f'.repeat(64),
    },
    finalAcceptance: { approvalId: 'acceptance-2', identityDigest: '1'.repeat(64) },
    repository: { projectId: 'project-1', identity: '2'.repeat(64), objectFormat: 'sha1', scope: 'src/**' },
    source: { goalRef: 'refs/heads/turing/goal/goal-1', commit: SOURCE, tree: TREE },
    target: {
      baseBranch: 'main',
      baseRef: 'refs/heads/main',
      observedBaseCommit: BASE,
      observedBaseTree: '3'.repeat(40),
    },
    completion: { identityDigest: '4'.repeat(64), findingsIdentityDigest: '5'.repeat(64) },
    review: {
      finalReviewId: 'review-2',
      reviewIdentityDigest: '6'.repeat(64),
      evidenceIdentityDigest: '7'.repeat(64),
      evidence: [
        {
          evidenceId: 'evidence-2',
          criterionKey: 'build',
          verifierDigest: '8'.repeat(64),
          kind: 'build',
          verdict: 'satisfies',
          identityDigest: '9'.repeat(64),
        },
      ],
      changedPathDigest: 'a'.repeat(64),
      changedPathCount: 1,
      changedPathSummaryDigest: 'b'.repeat(64),
      diffPreviewLimit: 12_000,
      diffStatDigest: 'c'.repeat(64),
      diffStatTruncated: false,
      diffPreviewDigest: 'd'.repeat(64),
      diffPreviewTruncated: false,
    },
    projection: {
      changedPaths: ['src/result.ts'],
      changedPathsTruncated: false,
      diffStat: ' src/result.ts | 1 +',
      diffPreview: '+export const answer = 42;',
      inspectionCommands: [`git show --stat ${SOURCE}`],
      manualIntegrationRequired: true,
      warning: 'Turing prepared this result but did not apply it.',
    },
    createdAt: '2026-10-09T12:00:00.000Z',
    handoffDigest: HANDOFF_DIGEST,
  };
}

export function handoffProjection(): GoalManualHandoffProjection {
  return {
    state: 'current',
    label: 'Ready for manual integration',
    handoff: handoff(),
    reason: null,
    actualApplication: 'not_performed_by_turing',
    goalCompletion: 'not_completed_by_handoff',
  };
}

export function handoffHistory() {
  return {
    handoffs: [
      {
        handoffId: HANDOFF,
        createdAt: '2026-10-09T12:00:00.000Z',
        definitionVersion: 2,
        sourceCommit: SOURCE,
        handoffDigest: HANDOFF_DIGEST,
      },
    ],
    limit: 50,
    nextOffset: null,
  };
}

/** The saved external-integration status for the given attestations, in the order the history lists them. */
export function storedStatus(attestationIds: string[]): GoalExternalIntegrationStoredStatus {
  return {
    goalId: GOAL,
    handoffId: HANDOFF,
    hasAttestation: true,
    attestations: attestationIds.map((attestationId, index) => ({
      attestationId,
      actionDigest: index === 0 ? 'f'.repeat(64) : '4'.repeat(64),
      recordDigest: index === 0 ? 'a'.repeat(64) : '5'.repeat(64),
      approvalId: `approval-external-${index}`,
      observedAt: '2026-10-09T12:30:00.000Z',
      decidedAt: '2026-10-09T12:31:00.000Z',
    })),
    approvals: [],
    limit: 20,
    attestationsHaveMore: false,
    approvalsHaveMore: false,
  };
}

/** A current attestation projection for one attestation id. Only the fields the Handoff tab reads are meaningful. */
export function attestationProjection(attestationId: string): GoalExternalIntegrationAttestationProjection {
  const observation: GoalExternalIntegrationObservation = {
    schemaVersion: 1,
    kind: 'turing_goal_external_integration_observation',
    goalId: GOAL,
    completionContractVersion: 2,
    handoff: { id: HANDOFF, digest: HANDOFF_DIGEST },
    definition: { version: 2, hash: 'e'.repeat(64), approvalId: 'definition-approval-2' },
    review: {
      finalReviewId: 'review-2',
      acceptanceApprovalId: 'acceptance-2',
      evidenceIdentityDigest: '7'.repeat(64),
    },
    repository: { projectId: 'project-1', identity: '2'.repeat(64), scope: 'src/**', objectFormat: 'sha1' },
    source: { ref: 'refs/heads/turing/goal/goal-1', commit: SOURCE, tree: TREE },
    destination: {
      ref: 'refs/heads/main',
      expectedBaseCommit: BASE,
      expectedBaseTree: '3'.repeat(40),
      observedCommit: SOURCE,
      observedTree: TREE,
    },
    proof: {
      mode: 'source_history_observed',
      sourceAncestor: true,
      baseAncestor: true,
      verifierVersion: 1,
      evidenceDigest: 'a'.repeat(64),
    },
    observedAt: '2026-10-09T12:30:00.000Z',
    actionDigest: 'f'.repeat(64),
  };
  return {
    state: 'current',
    record: {
      ...observation,
      kind: 'turing_goal_external_integration_attestation',
      attestationId,
      approvalId: `approval-external-${attestationId}`,
      decision: {
        value: 'confirm_external_integration',
        decidedBy: 'user',
        decidedAt: '2026-10-09T12:31:00.000Z',
      },
      recordDigest: 'a'.repeat(64),
    },
    reason: null,
    claim: 'source_history_observed_at_recorded_time',
    contentPreservation: 'not_proven',
    goalCompletion: 'not_completed_by_attestation',
  } as unknown as GoalExternalIntegrationAttestationProjection;
}

// --- Completion ------------------------------------------------------------------------------------------------------

export const claim = (
  qualifier: GoalCompletionStandingClaim['qualifier'] = 'none',
  trusted = false,
  contentPreservation: GoalCompletionStandingClaim['contentPreservation'] = 'not_proven',
): GoalCompletionStandingClaim => ({
  unqualifiedSuccessAllowed: trusted,
  trustedForDownstream: trusted,
  qualifier,
  contentPreservation,
});

export function completionStatus(
  state: GoalExternalCompletionStatus['state'],
  options: {
    qualifier?: GoalCompletionStandingClaim['qualifier'];
    decisions?: Decision[];
    completion?: GoalExternalCompletionStatus['completion'];
  } = {},
): GoalExternalCompletionStatus {
  const completion = options.completion ?? null;
  return {
    goalId: GOAL,
    state,
    decisions: options.decisions ?? [],
    completion,
    // Only the claim is read by the desktop panel; the rest of the standing is not needed here.
    completionStanding: {
      claim: claim(
        options.qualifier,
        false,
        completion?.contentVerificationDigest ? 'verified' : 'not_proven',
      ),
    } as unknown as GoalCompletionStanding,
  };
}

export function decisionRow(
  attestationId: string,
  actionDigest: string,
  overrides: Partial<Decision> = {},
): Decision {
  return {
    approvalId: `approval-${attestationId}`,
    actionDigest,
    attestationId,
    status: 'approved',
    valid: true,
    invalidReason: null,
    eligibility: 'eligible',
    correctionStanding: 'active_uncontested',
    ...overrides,
  };
}

export function completedRecord(attestationId: string): GoalExternalCompletionStatusRecord {
  return {
    proofId: 'proof-1',
    proofDigest: '9'.repeat(64),
    approvalId: `approval-${attestationId}`,
    actionDigest: actionFor(attestationId),
    contentVerificationDigest: 'b'.repeat(64),
    attestationId,
    observedAt: '2026-10-09T12:30:00.000Z',
    completedAt: '2026-10-09T12:40:00.000Z',
  };
}

export function preflight(attestationId: string): GoalExternalCompletionPreflightReport {
  const digest = preflightDigestFor(attestationId);
  return {
    schemaVersion: 1,
    kind: 'turing_goal_external_completion_preflight',
    goalId: GOAL,
    attestationId,
    outcome: 'ready',
    reasons: [],
    checks: [],
    facts: {
      goalStatus: 'running',
      definitionVersion: 2,
      definitionHash: 'e'.repeat(64),
      lineageDigest: null,
      mode: 'external_user_attested_v2',
      handoffId: HANDOFF,
      handoffDigest: HANDOFF_DIGEST,
      attestationActionDigest: 'f'.repeat(64),
      attestationRecordDigest: 'a'.repeat(64),
      correctionStanding: 'active_uncontested',
      correctionSequence: 0,
      destinationRef: 'refs/heads/main',
      attestedCommit: SOURCE,
      attestedTree: TREE,
      freshCommit: SOURCE,
      freshTree: TREE,
      objectFormat: 'sha1',
    },
    contentVerification: {
      verifier: 'content-verified-v1',
      verifierVersion: 2,
      status: 'verified',
      verificationDigest: '9'.repeat(64),
      changedPathCount: 1,
      mismatchCount: 0,
      mismatchPathDigest: '8'.repeat(64),
      comparisonCommit: SOURCE,
    },
    actionFields: null,
    proofLimitations: {
      contentPreservation: 'verified',
      goalCompletion: 'not_completed_by_preflight',
      destinationPolicy: 'exact_attested_tip',
    },
    authority: { mintsApproval: false, mintsProof: false, mintsTerminalAuthority: false },
    digest,
  };
}

export const recordedDecision = (attestationId: string): GoalExternalCompletionDecisionRecorded => ({
  approvalId: `approval-${attestationId}`,
  actionDigest: actionFor(attestationId),
  preflightDigest: preflightDigestFor(attestationId),
  status: 'approved',
  reused: false,
});

/**
 * Routes for the Goal's completion reads. `status` answers the saved status. `preflight` answers for the attestation the
 * call names and may return a full body (`{ preflight }`), a Response, or throw, so a failure shape can be served.
 */
export function completionRoutes(
  options: { status: () => unknown; preflight?: (attestationId: string) => unknown },
  extra: Routes = {},
): Routes {
  return {
    [COMPLETION_PATH]: options.status,
    [PREFLIGHT_PATH]: () =>
      options.preflight
        ? options.preflight(attestationInCall())
        : { preflight: preflight(attestationInCall()) },
    ...extra,
  };
}

/**
 * A Goal whose saved status moves only when an accepted write lands, as the server does. `prior` holds decisions made
 * before this review, for example a decision for another attestation that a correction has set aside.
 */
export function statefulCompletion(attestationId: string, prior: Decision[] = []) {
  let phase: 'open' | 'decided' | 'completed' = 'open';
  const routes: Routes = {
    [`POST ${DECISION_PATH}`]: () => {
      phase = 'decided';
      return created(recordedDecision(attestationId));
    },
    [`POST ${COMPLETION_PATH}`]: () => {
      phase = 'completed';
      return created({ reused: false });
    },
  };
  const status = () =>
    phase === 'open'
      ? completionStatus('not_completed', { decisions: prior })
      : phase === 'decided'
        ? completionStatus('decided', {
            decisions: [...prior, decisionRow(attestationId, actionFor(attestationId))],
          })
        : completionStatus('completed', { completion: completedRecord(attestationId) });
  return { routes, status };
}

// --- Correction ------------------------------------------------------------------------------------------------------

export const CHAIN_POSITION = 'a'.repeat(64);
export const CORRECTION_DIGEST = 'b'.repeat(64);

export function correctionHistory(
  attestationId: string,
  over: Partial<GoalAttestationCorrectionHistory> = {},
): GoalAttestationCorrectionHistory {
  return {
    goalId: GOAL,
    handoffId: HANDOFF,
    attestationId,
    standing: {
      goalId: GOAL,
      attestationId,
      standing: 'active_uncontested',
      correctionCount: 0,
      tip: null,
      invalidCode: null,
    },
    corrections: [],
    chainPosition: CHAIN_POSITION,
    pending: [],
    pendingUnreadableCount: 0,
    ...over,
  };
}

export function pendingRow(
  over: Partial<GoalAttestationCorrectionPendingRequest> = {},
): GoalAttestationCorrectionPendingRequest {
  return {
    approvalId: 'ap1',
    actionDigest: CORRECTION_DIGEST,
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    sequence: 1,
    previousCorrectionDigest: null,
    replacementAttestationId: null,
    explanationRequired: false,
    requestedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function correctionRequested(): GoalAttestationCorrectionRequested {
  return {
    approvalId: 'ap1',
    actionDigest: CORRECTION_DIGEST,
    status: 'pending',
    reused: false,
    detail: {
      correctionKind: 'dispute',
      sequence: 1,
      previousCorrectionDigest: null,
      replacementAttestationId: null,
      explanationDigest: null,
      reasonCode: 'observation_error',
    },
  };
}

// --- Phone standing (compact view) -----------------------------------------------------------------------------------

export function standing(kind: string, value: string | null, standingClaim: GoalCompletionStandingClaim) {
  return {
    schemaVersion: 1,
    goalId: GOAL,
    status: { goalStatus: 'completed', completedAt: '2026-01-01T00:00:00.000Z', reasonCode: null },
    kind,
    standing: value,
    claim: standingClaim,
  } as unknown as GoalCompletionStanding;
}

export const trustedClaim = (): GoalCompletionStandingClaim => claim('none', true, 'verified');

export const standingDetail = (completionStanding?: GoalCompletionStanding): GoalDetail =>
  detail({ status: 'completed', nextAction: { kind: 'completed' }, completionStanding });

/**
 * The compact view's routes for a list of Goals: the list, and each Goal's detail and preview. Every other read answers
 * an empty approvals list, as in the desktop fixtures.
 */
export function compactRoutes(
  goals: Array<{ id: string; title: string; goal: GoalDetail }>,
  extra: Routes = {},
): Routes {
  const routes: Routes = {
    '/api/goals': () => ({
      goals: goals.map((row) => item({ id: row.id, title: row.title, status: 'completed' })),
      total: goals.length,
      limit: 50,
    }),
    '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
  };
  for (const row of goals) {
    routes[`/api/goals/${row.id}`] = () => ({ goal: row.goal });
    routes[`/api/goals/${row.id}/preview`] = () => ({ preview: { ...preview(), goalId: row.id } });
  }
  return { ...routes, ...extra };
}

/**
 * Routes for a Goal whose Handoff tab shows the given attestations, in order. The completion reads are `completion`;
 * every attestation also gets its projection and its correction history, as the desktop Goal serves them.
 */
export function handoffRoutes(attestationIds: string[], completion: Routes, extra: Routes = {}): Routes {
  const routes: Routes = {
    ...detailRoutes(detail()),
    [`/api/goals/${GOAL}/handoffs`]: () => handoffHistory(),
    [`/api/goals/${GOAL}/handoffs/${HANDOFF}`]: () => ({ projection: handoffProjection() }),
    [`/api/goals/${GOAL}/handoffs/${HANDOFF}/external-integration`]: () => storedStatus(attestationIds),
    ...completion,
  };
  for (const id of attestationIds) {
    routes[`/api/goals/${GOAL}/handoffs/${HANDOFF}/external-integration/attestations/${id}`] = () => ({
      projection: attestationProjection(id),
    });
    routes[CORRECTIONS_PATH(id)] = () => correctionHistory(id);
  }
  return { ...routes, ...extra };
}

/** Makes the Goal view compact (phone) for the rest of the test. Restored by vi.unstubAllGlobals(). */
export function setCompact(matches: boolean): void {
  class TestMediaQuery {
    readonly matches = matches;
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  vi.stubGlobal('matchMedia', () => new TestMediaQuery());
}

import type {
  GoalCreateResponse,
  GoalCyclesResponse,
  GoalDefinitionFull,
  GoalDefinitionSummary,
  GoalDefinitionValidation,
  GoalAttestationCorrectionDecisionRecorded,
  GoalAttestationCorrectionHistory,
  GoalAttestationCorrectionKind,
  GoalAttestationCorrectionReasonCode,
  GoalAttestationCorrectionRequested,
  GoalDetail,
  GoalEventsResponse,
  GoalEvidenceResponse,
  GoalExternalIntegrationAttested,
  GoalExternalCompletionCompleted,
  GoalExternalCompletionDecisionRecorded,
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionPreflightResponse,
  GoalExternalCompletionStatus,
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationStoredStatus,
  GoalExternalIntegrationVerification,
  GoalFinalApplyPreflightView,
  GoalManualHandoffListResponse,
  GoalManualHandoffPrepared,
  GoalManualHandoffProjection,
  GoalFindingsResponse,
  GoalListResponse,
  GoalPreview,
  GoalResumeReason,
  GoalReviewsResponse,
  UnifiedApprovalsResponse,
} from '../../shared/goalApi';
import type { GoalDefinition } from '../../shared/goals';
import type { UsageAnalytics } from '../api';
import { call } from '../api';
import {
  expectCompletion,
  expectCompletionDecision,
  expectCorrectionDecided,
  expectCorrectionRequested,
} from './unknownOutcome';

/**
 * The Goal client API. Every operation is an explicit function with its own endpoint and body; nothing maps a
 * `nextAction` to a request. Reads are GETs. The only mutations are the user controls below, each of which the server
 * independently re-proves: start, resume, pause, abandon, a Goal-approval decision, a finding decision, definition
 * operations (create, save, begin revision, approve, reject), handoff preparation, exact external-integration
 * attestation, and the version-2 completion decision and Goal completion (each by its exact reviewed digest). Git final
 * apply is deliberately absent (7C). The completion reads (preflight and status) change nothing.
 */
const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};
const put = <T>(path: string, body: unknown, headers?: Record<string, string>) =>
  call<T>(path, { method: 'PUT', body: JSON.stringify(body), ...(headers ? { headers } : {}) });
const post = <T>(path: string, body: unknown, headers?: Record<string, string>) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body), ...(headers ? { headers } : {}) });
/**
 * The optimistic-concurrency precondition for changing an existing proposal: the PERSISTED hash the caller reviewed,
 * as a strong entity tag. It is a precondition only; the server recomputes and verifies its own hash.
 */
const ifMatch = (observedHash: string) => ({ 'If-Match': `"${observedHash}"` });
/**
 * A write whose successful response must have the shape the client reads. The body is read strictly, and a missing or
 * malformed success throws, so the caller treats the outcome as unknown instead of reading fields that are not there.
 */
const postChecked = <T>(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  checkShape: (value: unknown) => T,
): Promise<T> =>
  call<unknown>(path, { method: 'POST', body: JSON.stringify(body), headers }, { requireBody: true }).then(
    checkShape,
  );
const goalPath = (goalId: string) => `/api/goals/${encodeURIComponent(goalId)}`;

export const goalsApi = {
  list: (options: { status?: string; projectId?: string; limit?: number } = {}) =>
    call<GoalListResponse>(`/api/goals${query(options)}`),
  detail: async (goalId: string) => (await call<{ goal: GoalDetail }>(goalPath(goalId))).goal,
  definitions: async (goalId: string) =>
    (await call<{ definitions: GoalDefinitionSummary[] }>(`${goalPath(goalId)}/definitions`)).definitions,
  definition: async (goalId: string, version: number) =>
    (await call<{ definition: GoalDefinitionFull }>(`${goalPath(goalId)}/definitions/${version}`)).definition,
  cycles: (goalId: string) => call<GoalCyclesResponse>(`${goalPath(goalId)}/cycles`),
  evidence: (goalId: string) => call<GoalEvidenceResponse>(`${goalPath(goalId)}/evidence`),
  reviews: (goalId: string) => call<GoalReviewsResponse>(`${goalPath(goalId)}/reviews`),
  findings: (goalId: string) => call<GoalFindingsResponse>(`${goalPath(goalId)}/findings`),
  events: (goalId: string, options: { limit?: number; before?: number } = {}) =>
    call<GoalEventsResponse>(`${goalPath(goalId)}/events${query(options)}`),
  usage: (goalId: string) => call<UsageAnalytics>(`${goalPath(goalId)}/usage?range=30d`),
  /** Read-only: stored provider observations only; never generates a task or discovers a provider. */
  preview: async (goalId: string) =>
    (await call<{ preview: GoalPreview }>(`${goalPath(goalId)}/preview`)).preview,
  finalApplyPreflight: async (goalId: string) =>
    (await call<{ preflight: GoalFinalApplyPreflightView }>(`${goalPath(goalId)}/final-apply/preflight`))
      .preflight,
  manualHandoffs: (goalId: string, options: { limit?: number; offset?: number } = {}) =>
    call<GoalManualHandoffListResponse>(`${goalPath(goalId)}/handoffs${query(options)}`),
  manualHandoff: async (goalId: string, handoffId: string) =>
    (
      await call<{ projection: GoalManualHandoffProjection }>(
        `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}`,
      )
    ).projection,
  externalIntegrationStatus: (goalId: string, handoffId: string) =>
    call<GoalExternalIntegrationStoredStatus>(
      `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}/external-integration`,
    ),
  verifyExternalIntegration: async (goalId: string, handoffId: string) =>
    (
      await call<{ verification: GoalExternalIntegrationVerification }>(
        `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}/external-integration/verification`,
      )
    ).verification,
  externalIntegrationProjection: async (goalId: string, handoffId: string, attestationId: string) =>
    (
      await call<{ projection: GoalExternalIntegrationAttestationProjection }>(
        `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}/external-integration/attestations/${encodeURIComponent(attestationId)}`,
      )
    ).projection,
  confirmExternalIntegration: (goalId: string, handoffId: string, actionDigest: string) =>
    post<GoalExternalIntegrationAttested>(
      `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}/external-integration/attest`,
      { decision: 'confirm_external_integration' },
      ifMatch(actionDigest),
    ),

  // --- Version-2 completion (read-only reads first; the two writes are explicit user clicks, one request each) -----
  /** Read-only: the reviewed preflight for one attestation. A refused report is data (200), not an error. */
  completionPreflight: async (
    goalId: string,
    attestationId: string,
  ): Promise<GoalExternalCompletionPreflightReport> =>
    (
      await call<GoalExternalCompletionPreflightResponse>(
        `${goalPath(goalId)}/completion-preflight${query({ attestationId })}`,
      )
    ).preflight,
  /** Read-only: the Goal's completion state, optionally filtered to one exact action digest. */
  completionStatus: (goalId: string, actionDigest?: string) =>
    call<GoalExternalCompletionStatus>(`${goalPath(goalId)}/completion${query({ actionDigest })}`),
  /** Records the user's decision for one reviewed preflight. It completes nothing; If-Match is the preflight digest. */
  recordCompletionDecision: (
    goalId: string,
    input: { attestationId: string; preflightDigest: string; acknowledgeContentNotProven: true },
  ) =>
    postChecked<GoalExternalCompletionDecisionRecorded>(
      `${goalPath(goalId)}/completion-decision`,
      {
        decision: 'record_completion_decision',
        attestationId: input.attestationId,
        acknowledgeContentNotProven: input.acknowledgeContentNotProven,
      },
      ifMatch(input.preflightDigest),
      expectCompletionDecision,
    ),
  /** Completes the Goal for one recorded decision; If-Match is that decision's exact action digest. */
  completeGoal: (goalId: string, actionDigest: string, acknowledgeContentNotProven: true) =>
    postChecked<GoalExternalCompletionCompleted>(
      `${goalPath(goalId)}/completion`,
      { decision: 'complete_goal', acknowledgeContentNotProven },
      ifMatch(actionDigest),
      expectCompletion,
    ),

  // --- Attestation corrections (D.4D). The read changes nothing. Each write is one request on one explicit click. ---------
  /** Read-only: the verified history, the chain position a request must send, and the requests awaiting a decision. */
  correctionHistory: (goalId: string, handoffId: string, attestationId: string) =>
    call<GoalAttestationCorrectionHistory>(
      `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}/external-integration/attestations/${encodeURIComponent(attestationId)}/corrections`,
    ),
  /** Requests one correction. If-Match is the chain position the user reviewed, from the last read. */
  requestCorrection: (
    goalId: string,
    handoffId: string,
    attestationId: string,
    chainPosition: string,
    body: {
      correctionKind: GoalAttestationCorrectionKind;
      reasonCode: GoalAttestationCorrectionReasonCode;
      explanation: string | null;
      replacementAttestationId: string | null;
    },
  ) =>
    postChecked<GoalAttestationCorrectionRequested>(
      `${goalPath(goalId)}/handoffs/${encodeURIComponent(handoffId)}/external-integration/attestations/${encodeURIComponent(attestationId)}/corrections`,
      body,
      ifMatch(chainPosition),
      expectCorrectionRequested,
    ),
  /**
   * Decides one pending correction request on the D.4C route. If-Match is that request's exact action digest. The
   * explanation must be re-sent for an approval whose request carried one; the server re-checks it.
   */
  decideCorrection: (
    goalId: string,
    approvalId: string,
    actionDigest: string,
    body:
      | {
          decision: 'approved';
          attestationId: string;
          correctionKind: GoalAttestationCorrectionKind;
          explanation: string | null;
        }
      | { decision: 'denied' },
  ) =>
    postChecked<GoalAttestationCorrectionDecisionRecorded>(
      `${goalPath(goalId)}/attestation-corrections/${encodeURIComponent(approvalId)}/decision`,
      body,
      ifMatch(actionDigest),
      expectCorrectionDecided,
    ),

  unifiedApprovals: (options: { status?: 'pending'; goalId?: string; limit?: number } = {}) =>
    call<UnifiedApprovalsResponse>(`/api/approvals/unified${query(options)}`),

  // --- User controls (each one POST, no chaining) ------------------------------------------------------------------
  start: (goalId: string) => post<{ ok: true; goalStatus: string }>(`${goalPath(goalId)}/start`, {}),
  /** The reason is a closed set; the server verifies it against persisted facts. */
  resume: (goalId: string, reason: GoalResumeReason) =>
    post<{ ok: true; goalStatus: string }>(`${goalPath(goalId)}/resume`, { reason }),
  pause: (goalId: string) => post<{ status: 'paused' }>(`${goalPath(goalId)}/pause`, {}),
  abandon: (goalId: string) => post<{ status: 'abandoned' }>(`${goalPath(goalId)}/abandon`, {}),
  /** Explicit preparation only; the server binds all authority and Git identities itself. */
  prepareManualHandoff: (goalId: string) =>
    post<GoalManualHandoffPrepared>(`${goalPath(goalId)}/handoffs`, {}),
  /** Only the decision and an optional note: the server binds the approval, definition and finding itself. */
  decideFinding: (
    goalId: string,
    findingId: string,
    decision: 'accepted_by_user' | 'dismissed_by_user',
    note?: string,
  ) =>
    post<{ findingId: string; status: string; decisionApprovalId: string }>(
      `${goalPath(goalId)}/findings/${encodeURIComponent(findingId)}/decision`,
      note ? { decision, note } : { decision },
    ),
  /** Decides a Goal gate only. It never starts or resumes the Goal. Run approvals use `api.decideApproval`. */
  decideApproval: (approvalId: string, decision: 'approved' | 'denied') =>
    post<{ approvalId: string; status: string; changed: boolean }>(
      `/api/goal-approvals/${encodeURIComponent(approvalId)}/decision`,
      { decision },
    ),

  // --- Definition authority (each one request; the server re-reads, re-hashes and re-validates) ---------------------
  /** Creates the Goal shell and a PROPOSED v1. The server computes the hash; nothing is approved or started. */
  createGoal: (input: {
    projectId: string;
    title: string;
    definition: GoalDefinition;
    changeSummary?: string;
  }) =>
    post<GoalCreateResponse>('/api/goals', {
      projectId: input.projectId,
      title: input.title,
      definition: input.definition,
      ...(input.changeSummary ? { changeSummary: input.changeSummary } : {}),
    }),
  /** Saves the full document over a PROPOSED version only. No approval, hash or actor is sent. */
  saveDefinition: (
    goalId: string,
    version: number,
    observedHash: string,
    definition: GoalDefinition,
    changeSummary?: string,
  ) =>
    put<{ definition: GoalDefinitionFull }>(
      `${goalPath(goalId)}/definitions/${version}`,
      { definition, ...(changeSummary ? { changeSummary } : {}) },
      ifMatch(observedHash),
    ),
  /** Starts a revision/amendment. Without a body definition the server copies the current approved version. */
  beginRevision: (goalId: string, changeSummary?: string) =>
    post<{ version: number; definitionHash: string; validation: GoalDefinitionValidation }>(
      `${goalPath(goalId)}/definitions`,
      changeSummary ? { changeSummary } : {},
    ),
  /**
   * The dedicated atomic approval of one proposed version. The server binds the approval to the exact Goal, version and
   * hash itself; this never goes through `/api/goal-approvals/:id/decision` and never resumes the Goal.
   */
  approveDefinition: (goalId: string, version: number, observedHash: string, note?: string) =>
    post<{ version: number; definitionHash: string; approvalId: string; goalStatus: string }>(
      `${goalPath(goalId)}/definitions/${version}/approve`,
      note ? { note } : {},
      ifMatch(observedHash),
    ),
  rejectDefinition: (goalId: string, version: number, observedHash: string) =>
    post<{ version: number; goalStatus: string }>(
      `${goalPath(goalId)}/definitions/${version}/reject`,
      {},
      ifMatch(observedHash),
    ),
};

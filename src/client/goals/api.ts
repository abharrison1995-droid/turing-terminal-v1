import type {
  GoalCyclesResponse,
  GoalDefinitionFull,
  GoalDefinitionSummary,
  GoalDetail,
  GoalEventsResponse,
  GoalEvidenceResponse,
  GoalFinalApplyPreflightView,
  GoalFindingsResponse,
  GoalListResponse,
  GoalPreview,
  GoalResumeReason,
  GoalReviewsResponse,
  UnifiedApprovalsResponse,
} from '../../shared/goalApi';
import type { UsageAnalytics } from '../api';
import { call } from '../api';

/**
 * The Goal client API. Every operation is an explicit function with its own endpoint and body; nothing maps a
 * `nextAction` to a request. Reads are GETs. The only mutations are the user controls below, each of which the server
 * independently re-proves: start, resume, pause, abandon, a Goal-approval decision and a finding decision. Definition
 * authoring/amendment and final apply are deliberately absent (7B.2B and 7C).
 */
const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};
const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });
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

  unifiedApprovals: (options: { status?: 'pending'; goalId?: string; limit?: number } = {}) =>
    call<UnifiedApprovalsResponse>(`/api/approvals/unified${query(options)}`),

  // --- User controls (each one POST, no chaining) ------------------------------------------------------------------
  start: (goalId: string) => post<{ ok: true; goalStatus: string }>(`${goalPath(goalId)}/start`, {}),
  /** The reason is a closed set; the server verifies it against persisted facts. */
  resume: (goalId: string, reason: GoalResumeReason) =>
    post<{ ok: true; goalStatus: string }>(`${goalPath(goalId)}/resume`, { reason }),
  pause: (goalId: string) => post<{ status: 'paused' }>(`${goalPath(goalId)}/pause`, {}),
  abandon: (goalId: string) => post<{ status: 'abandoned' }>(`${goalPath(goalId)}/abandon`, {}),
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
};

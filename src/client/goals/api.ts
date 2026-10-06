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
  GoalReviewsResponse,
} from '../../shared/goalApi';
import type { UsageAnalytics } from '../api';
import { call } from '../api';

/**
 * Stage 7B.1: the Goal client API. It is read-only by construction: every function is a GET that passes no request
 * init, so this module cannot start, pause, approve, amend or apply anything. Response types are the canonical
 * `shared/goalApi` shapes. Mutation endpoints arrive with 7B.2 in their own module.
 */
const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};
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
};

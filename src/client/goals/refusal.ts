import { ApiError } from '../api';
import { humanize } from './presentation';

export interface Refusal {
  message: string;
  code: string | null;
  approvalId: string | null;
  /** Structured detail the server returned (e.g. validation issues); shown, never interpreted as authority. */
  detail: unknown;
}

/** A backend refusal, shown plainly. Never a success: callers must not change local state because of it. */
export function toRefusal(error: unknown): Refusal {
  if (error instanceof ApiError)
    return {
      message: error.message,
      code: error.code ?? null,
      approvalId: error.approvalId ?? null,
      detail: error.detail ?? null,
    };
  return {
    message: error instanceof Error ? error.message : 'The request failed.',
    code: null,
    approvalId: null,
    detail: null,
  };
}

export const refusalText = (refusal: Refusal): string =>
  refusal.code ? `${refusal.message} (${humanize(refusal.code)})` : refusal.message;

/** Plain wording for the definition-authority refusals whose raw server message is too terse to act on. */
const DEFINITION_REFUSALS: Record<string, string> = {
  gate_denial_not_settled: 'Turing is still settling the denied gate. Retry shortly.',
  definition_not_editable: 'That version is no longer a proposal, so it cannot be edited.',
  definition_not_proposed: 'That version is no longer a proposal. Refresh to see its current state.',
  definition_stale: 'The definition changed since it was loaded. Refresh and review it again.',
  definition_hash_mismatch:
    'The stored definition no longer matches its recorded hash. Nothing was approved.',
  proposal_exists: 'An undecided proposal already exists for this Goal. Refresh to see it.',
  goal_not_amendable: 'The Goal cannot be revised from its current state.',
};

export interface RefusalIssue {
  path: string;
  message: string;
  code: string | null;
  severity: string | null;
}

/** The structured issues in a refusal's `detail` (validation errors, request errors), bounded for display. */
export function refusalIssues(refusal: Refusal): RefusalIssue[] {
  if (!Array.isArray(refusal.detail)) return [];
  const issues: RefusalIssue[] = [];
  for (const entry of refusal.detail.slice(0, 50) as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.message !== 'string') continue;
    issues.push({
      path: typeof record.path === 'string' ? record.path : '',
      message: record.message,
      code: typeof record.code === 'string' ? record.code : null,
      severity: typeof record.severity === 'string' ? record.severity : null,
    });
  }
  return issues;
}

export const definitionRefusalText = (refusal: Refusal): string =>
  refusal.code && DEFINITION_REFUSALS[refusal.code]
    ? `${DEFINITION_REFUSALS[refusal.code]} (${humanize(refusal.code)})`
    : refusalText(refusal);

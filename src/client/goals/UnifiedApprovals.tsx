import { Check, LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import type { UnifiedApproval } from '../../shared/goalApi';
import { api } from '../api';
import { goalsApi } from './api';
import { Resource } from './parts';
import { humanize, shortHash } from './presentation';
import { approvalDecisionRefusalText, toRefusal } from './refusal';
import { useLoad } from './useLoad';

const rowKey = (approval: UnifiedApproval) => `${approval.source}:${approval.id}`;

/** Where a dedicated-service approval is decided. The inbox never decides it; it only says where to go. */
const DEDICATED_DECISION_TEXT: Record<NonNullable<UnifiedApproval['dedicatedDecision']>, string> = {
  correction: 'Decided in the correction review on the desktop.',
  completion: 'Decided in the completion review on the desktop.',
};

/** Kept with the row, because the phone must still show that the decision is waiting. */
const DESKTOP_ONLY_FINAL_ACCEPTANCE_TEXT =
  'Final acceptance is decided on the Turing Terminal desktop app. This approval stays in the pending list until it is decided there.';

/**
 * One approval surface for run and Goal approvals. Presentation is unified; authority is not: the `source`
 * discriminator alone picks the existing endpoint (a run approval to `/api/approvals/:id/decision`, a Goal approval to
 * `/api/goal-approvals/:id/decision`). A decision is one operation and is followed only by a read refresh; it never
 * resumes or starts a Goal.
 *
 * `expectedGoalApprovalId` is the approval the Goal's `nextAction` names. When it is given and not among the pending
 * Goal approvals, Goal decisions are disabled and the mismatch is shown; no other approval is ever substituted.
 */
export function UnifiedApprovals({
  goalId,
  expectedGoalApprovalId,
  refresh = 0,
  onDecided,
  heading = 'Approvals',
  decisionsEnabled = true,
  readOnlyAll = false,
}: {
  goalId?: string;
  expectedGoalApprovalId?: string | null;
  refresh?: number | string;
  onDecided?: () => void;
  heading?: string;
  /** False renders every row read-only (a terminal or manual-reconciliation Goal); the server refuses regardless. */
  decisionsEnabled?: boolean;
  /** Phone manual-reconciliation and terminal states suppress run and Goal approval mutations alike. */
  readOnlyAll?: boolean;
}) {
  const { result, reload } = useLoad(
    () => goalsApi.unifiedApprovals({ status: 'pending', ...(goalId ? { goalId } : {}), limit: 20 }),
    `approvals:${goalId ?? 'all'}`,
    refresh,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  // An outcome stays visible after its own decision (the expected approval then disappears), but is dropped when the
  // Goal now names a different approval or another Goal is shown.
  const scope = `${goalId ?? ''}|${expectedGoalApprovalId ?? ''}`;
  const [outcomeScope, setOutcomeScope] = useState(scope);
  if (outcomeScope !== scope) {
    const [previousGoal, previousExpected] = outcomeScope.split('|');
    setOutcomeScope(scope);
    if (previousGoal !== (goalId ?? '') || (previousExpected && expectedGoalApprovalId)) setOutcome(null);
  }

  async function decide(approval: UnifiedApproval, decision: 'approved' | 'denied') {
    if (busy) return;
    const key = rowKey(approval);
    setBusy(key);
    setOutcome(null);
    try {
      switch (approval.source) {
        case 'run':
          await api.decideApproval(approval.id, decision === 'approved');
          break;
        case 'goal':
          await goalsApi.decideApproval(approval.id, decision);
          break;
        default: {
          const unreachable: never = approval.source;
          throw new Error(`Unknown approval source ${String(unreachable)}.`);
        }
      }
      setOutcome({
        key,
        ok: true,
        text:
          approval.source === 'goal'
            ? `Decision recorded (${decision}). The Goal was not resumed; use the offered action if one appears.`
            : `Decision recorded (${decision}).`,
      });
    } catch (error) {
      setOutcome({
        key,
        ok: false,
        text: `Not recorded: ${approvalDecisionRefusalText(toRefusal(error), approval.gate)}`,
      });
    } finally {
      setBusy(null);
      reload();
      onDecided?.();
    }
  }

  return (
    <section className="approval-inbox goal-approvals" aria-label={heading}>
      <div className="approval-inbox-head">
        <div>
          <span className="approval-icon">
            <LockKeyhole size={17} />
          </span>
          <div>
            <h2>{heading}</h2>
          </div>
        </div>
      </div>
      <Resource result={result} label="Approvals" onRetry={reload}>
        {(data) => {
          const goalIds = new Set(
            data.approvals.filter((entry) => entry.source === 'goal').map((entry) => entry.id),
          );
          const mismatch =
            decisionsEnabled &&
            Boolean(expectedGoalApprovalId) &&
            !goalIds.has(expectedGoalApprovalId as string);
          return (
            <>
              {outcome && (
                <p
                  className={outcome.ok ? 'goal-note' : 'form-error'}
                  role={outcome.ok ? 'status' : 'alert'}
                  data-decision-outcome={outcome.ok ? 'ok' : 'refused'}
                >
                  {outcome.text}
                </p>
              )}
              {data.approvals.length === 0 && !mismatch && (
                <p className="goal-empty">Nothing is waiting for your decision.</p>
              )}
              {mismatch && (
                <p className="form-error" role="alert" data-approval-mismatch="true">
                  The Goal is waiting on approval {String(expectedGoalApprovalId).slice(0, 8)}, but it is not
                  among the pending approvals. Goal decisions are disabled here; refresh to reconcile.
                </p>
              )}
              <div className="approval-items">
                {data.approvals.map((approval) => {
                  const key = rowKey(approval);
                  const expected = approval.source === 'goal' && approval.id === expectedGoalApprovalId;
                  const desktopOnly = approval.source === 'goal' && approval.desktopOnly === true;
                  const readOnly =
                    readOnlyAll ||
                    (approval.source === 'goal' &&
                      (!decisionsEnabled || approval.decidable === false || desktopOnly));
                  // Set only on a row the server does not let the inbox decide (decidable is false for it).
                  const dedicated =
                    approval.source === 'goal' && approval.decidable === false
                      ? approval.dedicatedDecision
                      : undefined;
                  const disabled = busy !== null || (approval.source === 'goal' && mismatch);
                  const target =
                    approval.source === 'goal'
                      ? `Goal gate: ${humanize(approval.gate ?? approval.title)} (approval ${approval.id})`
                      : `Run action: ${approval.title}${approval.runId ? ` for run ${shortHash(approval.runId)}` : ''}`;
                  const primary = expected || (!expectedGoalApprovalId && data.approvals.length === 1);
                  return (
                    <div
                      className={`approval-item${expected ? ' approval-expected' : ''}`}
                      key={key}
                      data-approval-source={approval.source}
                      data-approval-id={approval.id}
                      aria-busy={busy === key}
                    >
                      <div className="approval-copy">
                        <span className={`goal-source goal-source-${approval.source}`}>
                          {approval.source === 'goal' ? 'Goal gate' : 'Run action'}
                        </span>
                        <strong>
                          {approval.source === 'goal'
                            ? humanize(approval.gate ?? approval.title)
                            : approval.title}
                        </strong>
                        <p className="approval-reason">{approval.reason}</p>
                        <small>
                          Risk: {humanize(approval.risk)}
                          {approval.source === 'run' && approval.runId
                            ? ` · run ${shortHash(approval.runId)}`
                            : ''}
                          {approval.goalId ? ` · Goal ${shortHash(approval.goalId)}` : ''}
                          {expected ? ` · expected approval ${shortHash(approval.id)}` : ''}
                          {expected ? ' · the Goal is waiting on this' : ''}
                        </small>
                        {approval.source === 'goal' && approval.gate === 'final_acceptance' && (
                          <small>Approving final acceptance does not apply anything to your branch.</small>
                        )}
                      </div>
                      {desktopOnly ? (
                        <p
                          className="goal-note"
                          data-approval-readonly="true"
                          data-approval-desktop-only="true"
                        >
                          {DESKTOP_ONLY_FINAL_ACCEPTANCE_TEXT}
                        </p>
                      ) : dedicated ? (
                        <p
                          className="goal-note"
                          data-approval-readonly="true"
                          data-dedicated-decision={dedicated}
                        >
                          {DEDICATED_DECISION_TEXT[dedicated]}
                        </p>
                      ) : readOnly ? (
                        <p className="goal-note" data-approval-readonly="true">
                          Not actionable here: this Goal cannot take approval decisions right now.
                        </p>
                      ) : (
                        <div className="approval-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={disabled}
                            aria-label={data.approvals.length > 1 ? `Deny ${target}` : undefined}
                            onClick={() => void decide(approval, 'denied')}
                          >
                            {busy === key ? 'Denying…' : 'Deny'}
                          </button>
                          <button
                            type="button"
                            className={`${primary ? 'primary-button' : 'secondary-button'} compact-button`}
                            disabled={disabled}
                            aria-busy={busy === key}
                            aria-label={data.approvals.length > 1 ? `Approve ${target}` : undefined}
                            onClick={() => void decide(approval, 'approved')}
                          >
                            <Check size={14} aria-hidden="true" />
                            {busy === key
                              ? 'Approving…'
                              : approval.source === 'run'
                                ? 'Approve once'
                                : 'Approve'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {data.total > data.approvals.length && (
                <p className="goal-empty">
                  Showing {data.approvals.length} of {data.total}.
                </p>
              )}
            </>
          );
        }}
      </Resource>
    </section>
  );
}

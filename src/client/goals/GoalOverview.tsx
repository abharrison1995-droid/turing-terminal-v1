import type {
  GoalCompletionView,
  GoalDetail,
  GoalFinalApplyPreflightView,
  GoalPreview,
} from '../../shared/goalApi';
import { goalsApi } from './api';
import { NextActionCard } from './NextAction';
import { Empty, Resource } from './parts';
import { UnifiedApprovals } from './UnifiedApprovals';
import { formatTime, humanize, shortHash } from './presentation';
import { useLoad } from './useLoad';

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="goal-fact">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** The exact approval the server's nextAction names, if any. Nothing else is ever treated as that approval. */
const expectedApprovalId = (action: GoalDetail['nextAction']): string | null =>
  action.kind === 'review_approval' || action.kind === 'final_acceptance' ? action.approvalId : null;

export function GoalOverview({
  goal,
  refresh,
  onChanged,
}: {
  goal: GoalDetail;
  refresh: number;
  onChanged: () => void;
}) {
  const cycle = goal.activeCycle ?? goal.lastCycle;
  const completion = goal.completion;
  return (
    <div className="goal-overview">
      <NextActionCard action={goal.nextAction} />

      <UnifiedApprovals
        goalId={goal.id}
        heading="Approvals for this Goal"
        expectedGoalApprovalId={expectedApprovalId(goal.nextAction)}
        refresh={refresh}
        onDecided={onChanged}
      />

      <section className="surface-panel" aria-label="Where things stand">
        <h2>Where things stand</h2>
        <dl className="goal-facts">
          <Fact label="Active milestone">{goal.activeMilestone?.title ?? 'None'}</Fact>
          <Fact label={goal.activeCycle ? 'Current cycle' : 'Most recent cycle'}>
            {cycle
              ? `#${cycle.sequence} · ${humanize(cycle.kind)} · ${humanize(cycle.status)}`
              : 'No cycles yet'}
          </Fact>
          <Fact label="Child run">
            {goal.childRun
              ? `${humanize(goal.childRun.purpose)} · ${humanize(goal.childRun.status)}`
              : humanize(goal.flags.childRun)}
          </Fact>
          <Fact label="Cycles executed">
            {goal.runtime.cyclesExecuted} ({goal.runtime.consecutiveFailedCycles} consecutive failed)
          </Fact>
          <Fact label="Active time">{Math.floor(goal.runtime.activeMs / 60_000)} min</Fact>
          <Fact label="Open findings">
            {Object.entries(goal.openFindingCounts)
              .map(([severity, count]) => `${count} ${severity}`)
              .join(' · ')}
          </Fact>
          <Fact label="Spend">
            ${goal.usageSummary.meteredSpendUsd.toFixed(2)} metered · {goal.usageSummary.events} usage events
          </Fact>
          <Fact label="Updated">{formatTime(goal.updatedAt)}</Fact>
        </dl>
      </section>

      <Milestones goal={goal} />
      {completion && <CompletionPanel completion={completion} />}
      {goal.nextAction.kind === 'final_apply' && <FinalApplyPreflight goalId={goal.id} refresh={refresh} />}
      <PreviewSection goalId={goal.id} refresh={refresh} />

      <section className="surface-panel" aria-label="Integration branch">
        <h2>Integration</h2>
        <dl className="goal-facts">
          <Fact label="Goal branch">
            <code>{goal.integrationBranch ?? '—'}</code>
          </Fact>
          <Fact label="Goal head">
            <code>{shortHash(goal.integrationHead)}</code>
          </Fact>
          <Fact label="Recorded base">
            <code>{goal.baseBranch ?? '—'}</code> @ <code>{shortHash(goal.baseCommit)}</code>
          </Fact>
        </dl>
        <p className="goal-note">Turing only changes this branch. Your own branch is never touched here.</p>
      </section>

      {goal.reasonDetail && (
        <details className="goal-debug">
          <summary>Technical detail</summary>
          <pre>{JSON.stringify(goal.reasonDetail, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function Milestones({ goal }: { goal: GoalDetail }) {
  return (
    <section className="surface-panel" aria-label="Milestones">
      <h2>Milestones</h2>
      {goal.milestones.length === 0 ? (
        <Empty>No milestones yet.</Empty>
      ) : (
        <ol className="goal-milestones">
          {goal.milestones.map((milestone) => {
            const active = goal.activeMilestone?.key === milestone.key;
            const done = milestone.satisfiedAt !== null;
            return (
              <li
                key={milestone.key}
                data-milestone-state={done ? 'satisfied' : active ? 'active' : 'remaining'}
              >
                <strong>{milestone.title}</strong>
                <span className="goal-row-meta">
                  {done ? `Satisfied ${formatTime(milestone.satisfiedAt)}` : active ? 'Active' : 'Remaining'}
                  {humanize(milestone.runtimeStatus).toLowerCase() ===
                  (done ? 'satisfied' : active ? 'active' : 'remaining')
                    ? ''
                    : ` · ${humanize(milestone.runtimeStatus)}`}
                </span>
                {milestone.evaluation && milestone.evaluation.blockers.length > 0 && (
                  <ul className="goal-plain-list goal-blockers">
                    {milestone.evaluation.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const Gate = ({
  label,
  state,
  reason,
}: {
  label: string;
  state: { required: boolean; ok: boolean };
  reason: string | null;
}) => (
  <li data-gate-state={!state.required ? 'not_required' : state.ok ? 'met' : 'unmet'}>
    <strong>{label}</strong>:{' '}
    {!state.required ? 'Not required' : state.ok ? 'Satisfied' : 'Not yet satisfied'}
    {reason && !state.ok ? <span className="goal-row-meta"> — {humanize(reason)}</span> : null}
  </li>
);

function CompletionPanel({ completion }: { completion: GoalCompletionView }) {
  return (
    <section className="surface-panel" aria-label="Completion">
      <h2>Completion</h2>
      <p>
        {completion.ok
          ? 'Every completion requirement is currently met.'
          : `${completion.failures.length} requirement${completion.failures.length === 1 ? '' : 's'} not yet met.`}
      </p>
      <ul className="goal-plain-list goal-gates">
        <Gate label="Final review" state={completion.finalReview} reason={completion.finalReview.reason} />
        <Gate
          label="Final acceptance (your gate)"
          state={completion.finalAcceptance}
          reason={completion.finalAcceptance.reason}
        />
        <Gate
          label="Final apply (separate step)"
          state={completion.finalApply}
          reason={completion.finalApply.reason}
        />
      </ul>
      {completion.failures.length > 0 && (
        <ul className="goal-plain-list goal-blockers" aria-label="Unmet requirements">
          {completion.failures.map((failure, index) => (
            <li key={`${failure.code}-${failure.subject ?? index}`}>
              <strong>{humanize(failure.code)}</strong>
              {failure.subject ? ` (${failure.subject})` : ''} — {failure.detail}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Shown only when the server's `nextAction` is `final_apply`; the client never rebuilds that readiness itself. */
function FinalApplyPreflight({ goalId, refresh }: { goalId: string; refresh: number }) {
  const { result, reload } = useLoad(() => goalsApi.finalApplyPreflight(goalId), goalId, refresh);
  return (
    <section className="surface-panel" aria-label="Final apply preflight">
      <h2>Final apply preflight</h2>
      <p className="goal-note">
        A read-only check. Completing a Goal does not modify your branch, and this screen cannot apply it.
      </p>
      <Resource result={result} label="Final apply preflight" onRetry={reload}>
        {(view: GoalFinalApplyPreflightView) => (
          <dl className="goal-facts">
            <Fact label="Status">{humanize(view.status)}</Fact>
            <Fact label="Fast-forward possible">
              {view.fastForwardPossible === null ? 'Unknown' : view.fastForwardPossible ? 'Yes' : 'No'}
            </Fact>
            <Fact label="Changed paths">{view.changedPathCount}</Fact>
            <Fact label="Safety">
              {view.safety.ok ? 'No violations' : `${view.safety.violationCount} violation(s)`}
            </Fact>
            {view.manualReconciliationRequired && (
              <Fact label="Attention">Manual reconciliation required</Fact>
            )}
          </dl>
        )}
      </Resource>
    </section>
  );
}

function PreviewSection({ goalId, refresh }: { goalId: string; refresh: number }) {
  const { result, reload } = useLoad(() => goalsApi.preview(goalId), goalId, refresh);
  return (
    <section className="surface-panel" aria-label="Preview">
      <h2>Preview</h2>
      <p className="goal-note">
        Read-only. Routing uses stored observations; nothing is generated, probed or started.
      </p>
      <Resource result={result} label="Preview" onRetry={reload}>
        {(preview: GoalPreview) => (
          <>
            {preview.limits?.breach && (
              <p className="form-error" role="alert">
                Limit reached: {humanize(preview.limits.breach.reason)} ({preview.limits.breach.observed} /{' '}
                {preview.limits.breach.limit})
              </p>
            )}
            {preview.limits ? (
              <dl className="goal-facts">
                <Fact label="Cycles left">{preview.limits.remaining.executionCycles}</Fact>
                <Fact label="Active minutes left">{preview.limits.remaining.activeMinutes}</Fact>
                <Fact label="Wall-clock days left">{preview.limits.remaining.wallClockDays}</Fact>
                <Fact label="Metered budget left">
                  {preview.limits.remaining.meteredUsd === null
                    ? 'No metered budget'
                    : `$${preview.limits.remaining.meteredUsd.toFixed(2)}`}
                </Fact>
              </dl>
            ) : (
              <Empty>No approved definition, so no limits yet.</Empty>
            )}
            {preview.billing && (
              <p>
                Billing: <strong>{humanize(preview.billing.mode)}</strong>
              </p>
            )}
            {preview.task ? (
              <p>
                Persisted task: <strong>{preview.task.title}</strong>
              </p>
            ) : (
              <p className="goal-note">
                {preview.proposalRequired
                  ? 'A proposal must be generated before the next cycle. Nothing has been generated.'
                  : 'No task is persisted.'}
              </p>
            )}
            {preview.routing && (
              <ul className="goal-plain-list" aria-label="Routes">
                {preview.routing.roles.map((role) => (
                  <li key={role.role} data-route-status={role.status}>
                    <strong>{humanize(role.role)}</strong>:{' '}
                    {role.status === 'resolved'
                      ? `${role.selection?.modelId ?? role.selection?.providerId ?? 'resolved'}`
                      : `Refused (${humanize(role.code)})`}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Resource>
    </section>
  );
}

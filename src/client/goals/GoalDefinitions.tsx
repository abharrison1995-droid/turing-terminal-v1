import { useState } from 'react';
import type { GoalDefinitionFull, GoalDefinitionSummary } from '../../shared/goalApi';
import type { GoalRoute } from '../../shared/goals';
import { goalsApi } from './api';
import { Empty, Resource } from './parts';
import { formatTime, humanize, shortHash } from './presentation';
import { useLoad } from './useLoad';

export function DefinitionsPanel({
  goalId,
  currentVersion,
}: {
  goalId: string;
  currentVersion: number | null;
}) {
  const list = useLoad(() => goalsApi.definitions(goalId), goalId);
  const [chosen, setChosen] = useState<number | null>(null);
  return (
    <Resource result={list.result} label="Definitions" onRetry={list.reload}>
      {(definitions: GoalDefinitionSummary[]) => {
        if (definitions.length === 0) return <Empty>No definition has been authored yet.</Empty>;
        const version = chosen ?? currentVersion ?? definitions[definitions.length - 1]!.version;
        return (
          <div className="goal-definitions">
            <ol className="goal-version-list" aria-label="Definition versions">
              {definitions.map((entry) => (
                <li key={entry.version}>
                  <button
                    type="button"
                    className={`goal-version${entry.version === version ? ' goal-version-active' : ''}`}
                    aria-pressed={entry.version === version}
                    onClick={() => setChosen(entry.version)}
                  >
                    <strong>v{entry.version}</strong>
                    <span className="status-pill" data-definition-status={entry.status}>
                      {humanize(entry.status)}
                    </span>
                    {entry.version === currentVersion && <span className="goal-needs-you">Current</span>}
                    <span className="goal-row-meta">{entry.changeSummary}</span>
                  </button>
                </li>
              ))}
            </ol>
            <DefinitionBody
              goalId={goalId}
              version={version}
              summary={definitions.find((d) => d.version === version)}
            />
          </div>
        );
      }}
    </Resource>
  );
}

function DefinitionBody({
  goalId,
  version,
  summary,
}: {
  goalId: string;
  version: number;
  summary: GoalDefinitionSummary | undefined;
}) {
  const { result, reload } = useLoad(() => goalsApi.definition(goalId, version), `${goalId}:${version}`);
  return (
    <Resource result={result} label={`Definition v${version}`} onRetry={reload}>
      {(full: GoalDefinitionFull) => {
        const { contract, milestones, routing, review, limits } = full.definition;
        return (
          <article className="goal-definition" aria-label={`Definition v${version}`}>
            {!full.validation.valid && (
              <p className="form-error" role="alert">
                {full.validation.errors.length} validation error(s) on this version.
              </p>
            )}
            <section className="surface-panel">
              <h3>Outcome</h3>
              <p>{contract.outcome}</p>
              <h3>Success criteria</h3>
              <ul className="goal-plain-list">
                {contract.successCriteria.map((criterion) => (
                  <li key={criterion.key}>
                    <strong>{criterion.key}</strong>
                    {criterion.required ? '' : ' (optional)'} — {criterion.statement}
                    <span className="goal-row-meta">
                      {' '}
                      Verified by {criterion.verification.map((spec) => humanize(spec.kind)).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
              {contract.nonGoals.length > 0 && (
                <>
                  <h3>Non-goals</h3>
                  <ul className="goal-plain-list">
                    {contract.nonGoals.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {contract.constraints.length > 0 && (
                <>
                  <h3>Constraints</h3>
                  <ul className="goal-plain-list">
                    {contract.constraints.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <section className="surface-panel">
              <h3>Milestones</h3>
              <ol className="goal-plain-list">
                {milestones.map((milestone) => (
                  <li key={milestone.key}>
                    <strong>{milestone.title}</strong> — {milestone.objective}
                    <span className="goal-row-meta">
                      {' '}
                      Criteria: {milestone.criteria.join(', ') || 'none'}
                      {milestone.dependsOn.length ? ` · after ${milestone.dependsOn.join(', ')}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="surface-panel">
              <h3>Routing</h3>
              <ul className="goal-plain-list">
                {Object.entries(routing.roles).map(([role, route]) => (
                  <li key={role}>
                    <strong>{humanize(role)}</strong>: {describeRoute(route)}
                  </li>
                ))}
              </ul>
              <p className="goal-row-meta">
                Workflows: planning {routing.workflows.planning}, execution {routing.workflows.execution},
                review {routing.workflows.review}, verification {routing.workflows.verification}
              </p>
              <p className="goal-row-meta">
                Final-review independence: {humanize(routing.independence.finalReview)}
              </p>
            </section>
            <section className="surface-panel">
              <h3>Review policy</h3>
              <p>
                {review.onMilestoneComplete ? 'Review at each milestone. ' : ''}
                {review.final ? 'Final review required. ' : ''}
                {review.periodic
                  ? `Periodic review every ${review.periodic.everyNExecutionCycles} cycles.`
                  : 'No periodic review.'}
              </p>
              <p className="goal-row-meta">
                Final acceptance by you:{' '}
                {contract.completionPolicy.requireUserAcceptance ? 'required' : 'not required'} · apply to
                base: {humanize(contract.completionPolicy.applyToBase)}
              </p>
            </section>
            <section className="surface-panel">
              <h3>Limits</h3>
              <dl className="goal-facts">
                <div className="goal-fact">
                  <dt>Execution cycles</dt>
                  <dd>{limits.maxExecutionCycles}</dd>
                </div>
                <div className="goal-fact">
                  <dt>Consecutive failed cycles</dt>
                  <dd>{limits.maxConsecutiveFailedCycles}</dd>
                </div>
                <div className="goal-fact">
                  <dt>Active minutes</dt>
                  <dd>{limits.maxActiveMinutes}</dd>
                </div>
                <div className="goal-fact">
                  <dt>Wall-clock days</dt>
                  <dd>{limits.maxWallClockDays}</dd>
                </div>
                <div className="goal-fact">
                  <dt>Parallel agents</dt>
                  <dd>{limits.maxParallelAgents}</dd>
                </div>
                <div className="goal-fact">
                  <dt>Billing</dt>
                  <dd>
                    {humanize(limits.billingMode)}
                    {limits.maxMeteredUsd !== null ? ` · up to $${limits.maxMeteredUsd}` : ''}
                  </dd>
                </div>
              </dl>
            </section>
            <details className="goal-debug">
              <summary>Version details</summary>
              <dl className="goal-facts">
                <div className="goal-fact">
                  <dt>Hash</dt>
                  <dd>
                    <code>{shortHash(full.definitionHash)}</code>
                  </dd>
                </div>
                <div className="goal-fact">
                  <dt>Created</dt>
                  <dd>
                    {formatTime(full.createdAt)} by {humanize(full.createdBy)}
                  </dd>
                </div>
                <div className="goal-fact">
                  <dt>Approved</dt>
                  <dd>{summary?.approvedAt ? formatTime(summary.approvedAt) : '—'}</dd>
                </div>
                <div className="goal-fact">
                  <dt>Parent version</dt>
                  <dd>{full.parentVersion ?? '—'}</dd>
                </div>
              </dl>
            </details>
          </article>
        );
      }}
    </Resource>
  );
}

function describeRoute(route: GoalRoute | undefined): string {
  if (!route) return 'Not defined';
  if (route.kind === 'pool') return `Pool ${route.poolId}`;
  const configuration = route.member.configuration;
  return `Pinned ${configuration.modelDisplayName ?? configuration.modelId ?? configuration.providerId ?? 'route'}`;
}

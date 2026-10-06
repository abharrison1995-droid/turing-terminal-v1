import type { GoalCycleView, GoalEvidenceView, GoalFindingView, GoalReviewView } from '../../shared/goalApi';
import { goalsApi } from './api';
import { Empty, Resource, TruncationNote } from './parts';
import { formatTime, humanize, shortHash } from './presentation';
import { useLoad } from './useLoad';

export function CyclesPanel({ goalId }: { goalId: string }) {
  const { result, reload } = useLoad(() => goalsApi.cycles(goalId), goalId);
  return (
    <Resource result={result} label="Cycles" onRetry={reload}>
      {(data) =>
        data.cycles.length === 0 ? (
          <Empty>No cycles yet. A Goal advances in cycles; each cycle launches finite Turing runs.</Empty>
        ) : (
          <>
            <p className="goal-note">
              Goal → cycles → finite Turing runs. A Goal is never one long model session.
            </p>
            <ol className="goal-cycles" aria-label="Cycles">
              {data.cycles.map((cycle: GoalCycleView) => (
                <li key={cycle.id} className="surface-panel" data-cycle-status={cycle.status}>
                  <h3>
                    Cycle {cycle.sequence} · {humanize(cycle.kind)}{' '}
                    <span className="status-pill">{humanize(cycle.status)}</span>
                  </h3>
                  <dl className="goal-facts">
                    <div className="goal-fact">
                      <dt>Trigger</dt>
                      <dd>{humanize(cycle.triggerCode)}</dd>
                    </div>
                    <div className="goal-fact">
                      <dt>Milestone</dt>
                      <dd>{cycle.milestoneKey ?? '—'}</dd>
                    </div>
                    <div className="goal-fact">
                      <dt>Started</dt>
                      <dd>{formatTime(cycle.createdAt)}</dd>
                    </div>
                    <div className="goal-fact">
                      <dt>Finished</dt>
                      <dd>{formatTime(cycle.finishedAt)}</dd>
                    </div>
                    <div className="goal-fact">
                      <dt>Commits</dt>
                      <dd>
                        <code>{shortHash(cycle.baseIntegrationCommit)}</code> →{' '}
                        <code>{shortHash(cycle.resultIntegrationCommit)}</code>
                      </dd>
                    </div>
                  </dl>
                  {cycle.validatedTask && (
                    <p>
                      Task: <strong>{cycle.validatedTask.title}</strong>
                    </p>
                  )}
                  {cycle.outcome && (cycle.outcome.code || cycle.outcome.summary) && (
                    <p>
                      Outcome: {cycle.outcome.code ? <strong>{humanize(cycle.outcome.code)}</strong> : null}
                      {cycle.outcome.summary ? ` — ${cycle.outcome.summary}` : ''}
                    </p>
                  )}
                  {cycle.routeResolutions.length > 0 && (
                    <p className="goal-row-meta">
                      Routes:{' '}
                      {cycle.routeResolutions
                        .map(
                          (route) => `${route.role}: ${route.modelId ?? route.providerId ?? route.routeKind}`,
                        )
                        .join(' · ')}
                    </p>
                  )}
                  {Object.entries(cycle.runs).some(([, runs]) => runs.length > 0) && (
                    <ul className="goal-plain-list" aria-label="Child runs">
                      {Object.entries(cycle.runs).flatMap(([group, runs]) =>
                        runs.map((run) => (
                          <li key={run.id} data-run-purpose={run.purpose}>
                            Run <code>{shortHash(run.id)}</code> · {humanize(group)} · {humanize(run.status)}
                          </li>
                        )),
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            <TruncationNote shown={data.cycles.length} total={data.total} />
          </>
        )
      }
    </Resource>
  );
}

export function ReviewsPanel({ goalId }: { goalId: string }) {
  const { result, reload } = useLoad(() => goalsApi.reviews(goalId), goalId);
  return (
    <Resource result={result} label="Reviews" onRetry={reload}>
      {(data) =>
        data.reviews.length === 0 ? (
          <Empty>No reviews yet.</Empty>
        ) : (
          <>
            <ul className="goal-reviews" aria-label="Reviews">
              {data.reviews.map((review: GoalReviewView) => (
                <li key={review.id} className="surface-panel" data-review-status={review.status}>
                  <h3>
                    {humanize(review.kind)} review{' '}
                    <span className="status-pill">{humanize(review.status)}</span>
                    {review.blocking && <span className="status-pill goal-tone-danger">Blocking</span>}
                    {review.verdict && (
                      <span className="status-pill">Verdict: {humanize(review.verdict)}</span>
                    )}
                  </h3>
                  <p className="goal-row-meta">
                    {review.milestoneKey ? `Milestone ${review.milestoneKey} · ` : ''}
                    definition v{review.definitionVersion} · to{' '}
                    <code>{shortHash(review.reviewedToCommit)}</code> ·{' '}
                    {review.currentAtHead ? 'Current at the Goal head' : 'Not current at the Goal head'}
                  </p>
                  {review.report && (
                    <p>
                      {review.report.newFindings.length} new finding
                      {review.report.newFindings.length === 1 ? '' : 's'} ·{' '}
                      {review.report.criterionProgress.filter((entry) => entry.assessment === 'met').length}/
                      {review.report.criterionProgress.length} criteria met
                      {review.report.scopeDrift ? ' · scope drift' : ''}
                      {review.report.architectureDrift ? ' · architecture drift' : ''}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <TruncationNote shown={data.reviews.length} total={data.total} />
          </>
        )
      }
    </Resource>
  );
}

export function FindingsPanel({ goalId }: { goalId: string }) {
  const { result, reload } = useLoad(() => goalsApi.findings(goalId), goalId);
  return (
    <Resource result={result} label="Findings" onRetry={reload}>
      {(data) =>
        data.findings.length === 0 ? (
          <Empty>No findings.</Empty>
        ) : (
          <>
            <ul className="goal-findings" aria-label="Findings">
              {data.findings.map((finding: GoalFindingView) => (
                <li
                  key={finding.id}
                  className="surface-panel"
                  data-finding-status={finding.status}
                  data-finding-severity={finding.severity}
                >
                  <h3>
                    <span className={`severity severity-${finding.severity}`}>{finding.severity}</span>{' '}
                    {humanize(finding.category)}{' '}
                    <span className="status-pill">{humanize(finding.status)}</span>
                  </h3>
                  <p>{finding.description}</p>
                  {finding.affectedFiles.length > 0 && (
                    <p className="goal-row-meta">Files: {finding.affectedFiles.join(', ')}</p>
                  )}
                  <p className="goal-row-meta">
                    First seen in review <code>{shortHash(finding.firstSeenReviewId)}</code>
                    {finding.resolvedByReviewId
                      ? ` · resolved by review ${shortHash(finding.resolvedByReviewId)}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
            <TruncationNote shown={data.findings.length} total={data.total} />
          </>
        )
      }
    </Resource>
  );
}

export function EvidencePanel({ goalId }: { goalId: string }) {
  const { result, reload } = useLoad(() => goalsApi.evidence(goalId), goalId);
  return (
    <Resource result={result} label="Evidence" onRetry={reload}>
      {(data) => {
        if (data.evidence.length === 0) return <Empty>No evidence recorded yet.</Empty>;
        const groups = new Map<string, GoalEvidenceView[]>();
        for (const row of data.evidence)
          groups.set(row.criterionKey, [...(groups.get(row.criterionKey) ?? []), row]);
        return (
          <>
            <p className="goal-note">
              {data.integrationHead
                ? `Freshness is judged against the Goal head ${shortHash(data.integrationHead)}.`
                : 'The repository could not be read, so freshness could not be fully assessed.'}
            </p>
            {[...groups.entries()].map(([criterionKey, rows]) => (
              <section key={criterionKey} className="surface-panel" aria-label={`Criterion ${criterionKey}`}>
                <h3>{criterionKey}</h3>
                <ul className="goal-evidence">
                  {rows.map((row) => (
                    <li
                      key={row.id}
                      className={`goal-evidence-row goal-evidence-${row.freshness}`}
                      data-freshness={row.freshness}
                    >
                      <span className={`goal-fresh goal-fresh-${row.freshness}`}>
                        {row.freshness === 'current' ? 'Current' : 'Stale'}
                      </span>
                      <span>
                        {humanize(row.kind)} · {humanize(row.verdict)}
                        {row.freshness === 'stale' && row.staleReason ? (
                          <span className="goal-stale-reason"> — stale: {humanize(row.staleReason)}</span>
                        ) : null}
                      </span>
                      <span className="goal-row-meta">
                        definition v{row.definitionVersion}
                        {row.subject.commit ? ` · commit ${shortHash(row.subject.commit)}` : ''}
                        {row.subject.tree ? ` · tree ${shortHash(row.subject.tree)}` : ''}
                        {row.subject.path ? ` · ${row.subject.path}` : ''} · {formatTime(row.recordedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <TruncationNote shown={data.evidence.length} total={data.total} />
          </>
        );
      }}
    </Resource>
  );
}

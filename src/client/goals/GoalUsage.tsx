import { formatMetric } from '../phase36';
import { goalsApi } from './api';
import { Empty, Resource } from './parts';
import { useLoad } from './useLoad';

/**
 * The Goal Engine has no usage ledger of its own: this is the shared usage analytics filtered to the Goal by the
 * server, shown with the same metrics and provenance wording as the Usage page.
 */
export function UsagePanel({ goalId }: { goalId: string }) {
  const { result, reload } = useLoad(() => goalsApi.usage(goalId), goalId);
  return (
    <Resource result={result} label="Usage" onRetry={reload}>
      {(usage) =>
        usage.totals.events === 0 ? (
          <Empty>No usage has been recorded for this Goal in the last 30 days.</Empty>
        ) : (
          <>
            <p className="goal-note">
              Shared Turing usage analytics filtered to this Goal, last 30 days. Missing telemetry stays
              “Unavailable”, never zero.
            </p>
            <dl className="goal-facts">
              <div className="goal-fact">
                <dt>Usage events</dt>
                <dd>{usage.totals.events}</dd>
              </div>
              <div className="goal-fact">
                <dt>Requests</dt>
                <dd>{usage.totals.requests}</dd>
              </div>
              <div className="goal-fact">
                <dt>Input tokens</dt>
                <dd>{formatMetric(usage.totals.inputTokens)}</dd>
              </div>
              <div className="goal-fact">
                <dt>Output tokens</dt>
                <dd>{formatMetric(usage.totals.outputTokens)}</dd>
              </div>
              <div className="goal-fact">
                <dt>Metered cost</dt>
                <dd>{formatMetric(usage.totals.actualMeteredCostUsd, 'usd')}</dd>
              </div>
              <div className="goal-fact">
                <dt>Equivalent value</dt>
                <dd>{formatMetric(usage.totals.equivalentValueUsd, 'usd')}</dd>
              </div>
            </dl>
            {usage.byModel.length > 0 && (
              <table className="goal-table" aria-label="Usage by model">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Lane</th>
                    <th>Events</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td>{row.billingLane ?? '—'}</td>
                      <td>{row.events}</td>
                      <td>{formatMetric(row.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )
      }
    </Resource>
  );
}

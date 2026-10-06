import { useState } from 'react';
import type { GoalFindingView } from '../../shared/goalApi';
import { goalsApi } from './api';
import { Empty, Resource, TruncationNote } from './parts';
import { humanize, shortHash } from './presentation';
import { refusalText, toRefusal } from './refusal';
import { useLoad } from './useLoad';

type Decision = 'accepted_by_user' | 'dismissed_by_user';
const VERB: Record<Decision, string> = { accepted_by_user: 'Accept', dismissed_by_user: 'Dismiss' };

/**
 * Goal findings with the user's decision. Only an `open` finding can be decided. The request carries the decision and an
 * optional note and nothing else: the server creates and binds the approval, definition and finding atomically. A
 * decision is followed by a read refresh only; it never resumes the Goal or launches remediation.
 */
export function FindingsPanel({
  goalId,
  refresh,
  onDecided,
}: {
  goalId: string;
  refresh: number;
  onDecided: () => void;
}) {
  const { result, reload } = useLoad(() => goalsApi.findings(goalId), goalId, refresh);
  const [pending, setPending] = useState<{ finding: GoalFindingView; decision: Decision } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (!pending || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const decided = await goalsApi.decideFinding(
        goalId,
        pending.finding.id,
        pending.decision,
        note.trim() || undefined,
      );
      setMessage({
        ok: true,
        text: `Finding ${humanize(decided.status).toLowerCase()}. Nothing was resumed.`,
      });
    } catch (error) {
      setMessage({ ok: false, text: `Not recorded: ${refusalText(toRefusal(error))}` });
    } finally {
      setBusy(false);
      setPending(null);
      setNote('');
      reload();
      onDecided();
    }
  }

  return (
    <Resource result={result} label="Findings" onRetry={reload}>
      {(data) => (
        <>
          {message && (
            <p
              className={message.ok ? 'goal-note' : 'form-error'}
              role={message.ok ? 'status' : 'alert'}
              data-finding-outcome={message.ok ? 'ok' : 'refused'}
            >
              {message.text}
            </p>
          )}
          {data.findings.length === 0 ? (
            <Empty>No findings.</Empty>
          ) : (
            <>
              <ul className="goal-findings" aria-label="Findings">
                {data.findings.map((finding) => (
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
                    {finding.status === 'open' && (
                      <div className="goal-control-buttons">
                        {(Object.keys(VERB) as Decision[]).map((decision) => (
                          <button
                            key={decision}
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            data-finding-decision={decision}
                            onClick={() => setPending({ finding, decision })}
                          >
                            {VERB[decision]} finding
                          </button>
                        ))}
                      </div>
                    )}
                    {pending?.finding.id === finding.id && (
                      <div className="goal-confirm" role="alertdialog" aria-label="Confirm finding decision">
                        <strong>
                          {VERB[pending.decision]} this {finding.severity} finding?
                        </strong>
                        <p>{finding.description}</p>
                        <p className="goal-note">
                          {finding.severity === 'critical' || finding.severity === 'high'
                            ? `This is a ${finding.severity} finding. `
                            : ''}
                          This changes whether the Goal can complete. It does not resume the Goal or start any
                          work.
                        </p>
                        <label className="form-field">
                          <span>Note (optional)</span>
                          <input
                            type="text"
                            maxLength={1000}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                          />
                        </label>
                        <div className="goal-control-buttons">
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busy}
                            onClick={() => void submit()}
                          >
                            Confirm {VERB[pending.decision].toLowerCase()}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => setPending(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <TruncationNote shown={data.findings.length} total={data.total} />
            </>
          )}
        </>
      )}
    </Resource>
  );
}

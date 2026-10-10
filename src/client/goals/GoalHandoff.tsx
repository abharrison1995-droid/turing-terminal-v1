import { useEffect, useRef, useState } from 'react';
import type {
  GoalDetail,
  GoalManualHandoffProjection,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import { ConfirmPanel } from './DefinitionParts';
import { goalsApi } from './api';
import { Empty } from './parts';
import { formatTime, shortHash } from './presentation';
import { useLoad } from './useLoad';

function FullIdentity({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="goal-handoff-identity">
      <dt>{label}</dt>
      <dd>
        {value ? (
          <code aria-label={`${label}, full value`} title={value}>
            {value}
          </code>
        ) : (
          'Unavailable'
        )}
      </dd>
    </div>
  );
}

function stateText(projection: GoalManualHandoffProjection | null): string {
  if (!projection) return 'Currentness has not been checked';
  switch (projection.state) {
    case 'current':
      return 'Ready for manual integration';
    case 'stale':
      return 'Handoff stale — review the updated Goal before preparing another';
    case 'unavailable':
      return 'Currentness cannot be verified';
    case 'invalid':
      return 'Handoff record could not be validated';
  }
}

function HandoffDetail({ projection }: { projection: GoalManualHandoffProjection }) {
  const record = projection.handoff;
  if (!record) {
    return (
      <section className="surface-panel" aria-label="Handoff validation">
        <h3>{stateText(projection)}</h3>
        {projection.reason && <p role="status">{projection.reason.message}</p>}
        <p className="goal-note">
          The stored handoff is retained for history. No Git operation has been performed.
        </p>
      </section>
    );
  }
  const canCopy = projection.state === 'current';
  return (
    <>
      <section
        className={`surface-panel goal-handoff-status goal-handoff-${projection.state}`}
        aria-label="Handoff status"
      >
        <h3>{stateText(projection)}</h3>
        <p>
          Turing prepared this result but did not apply it. Your base branch and working files were not
          changed by preparation. You control the subsequent Git integration.
        </p>
        {projection.reason && <p className="goal-handoff-reason">{projection.reason.message}</p>}
        <p className="goal-row-meta">
          Git base application: not performed · Goal completion: not completed by handoff
        </p>
      </section>

      <section className="surface-panel" aria-label="Exact Git identities">
        <h3>Exact Git identities</h3>
        <dl className="goal-handoff-identities">
          <FullIdentity label="Registered project" value={record.repository.projectId} />
          <FullIdentity label="Repository identity" value={record.repository.identity} />
          <FullIdentity label="Project scope" value={record.repository.scope || '(repository root)'} />
          <FullIdentity label="Object format" value={record.repository.objectFormat} />
          <FullIdentity label="Goal integration ref" value={record.source.goalRef} />
          <FullIdentity label="Full source commit" value={record.source.commit} />
          <FullIdentity label="Full source tree" value={record.source.tree} />
          <FullIdentity label="Recorded base branch" value={record.target.baseBranch} />
          <FullIdentity label="Full base ref" value={record.target.baseRef} />
          <FullIdentity label="Observed base commit" value={record.target.observedBaseCommit} />
          <FullIdentity label="Observed base tree" value={record.target.observedBaseTree} />
        </dl>
        <p className="goal-row-meta">
          Short source {shortHash(record.source.commit)} · short base{' '}
          {shortHash(record.target.observedBaseCommit)}
        </p>
      </section>

      <section className="surface-panel" aria-label="Acceptance and verification">
        <h3>Acceptance and verification</h3>
        <dl className="goal-facts">
          <div className="goal-fact">
            <dt>Approved definition</dt>
            <dd>
              Version {record.definition.version} · {record.definition.hash}
            </dd>
          </div>
          <div className="goal-fact">
            <dt>Definition approval identity</dt>
            <dd>
              <code>{record.definition.approvalId}</code>
            </dd>
          </div>
          <div className="goal-fact">
            <dt>Final acceptance identity</dt>
            <dd>
              <code>{record.finalAcceptance.approvalId}</code>
            </dd>
          </div>
          <div className="goal-fact">
            <dt>Passing independent final review</dt>
            <dd>
              <code>{record.review.finalReviewId}</code>
            </dd>
          </div>
          <div className="goal-fact">
            <dt>Verification evidence</dt>
            <dd>{record.review.evidence.length} selected records; all bound verdicts are “satisfies”.</dd>
          </div>
          <div className="goal-fact">
            <dt>Changed paths</dt>
            <dd>{record.review.changedPathCount.toLocaleString()}</dd>
          </div>
          <div className="goal-fact">
            <dt>Handoff digest</dt>
            <dd>
              <code>{record.handoffDigest}</code>
            </dd>
          </div>
          <div className="goal-fact">
            <dt>Created</dt>
            <dd>{formatTime(record.createdAt)}</dd>
          </div>
        </dl>
        {record.review.evidence.length > 0 && (
          <details>
            <summary>Selected verification evidence ({record.review.evidence.length})</summary>
            <ul className="goal-plain-list goal-handoff-evidence">
              {record.review.evidence.slice(0, 20).map((evidence) => (
                <li key={evidence.evidenceId}>
                  <code>{evidence.criterionKey}</code> · {evidence.kind} · {evidence.verdict} ·{' '}
                  <code>{evidence.evidenceId}</code>
                </li>
              ))}
            </ul>
            {record.review.evidence.length > 20 && (
              <p className="goal-row-meta">
                Showing the first 20 of {record.review.evidence.length} selected records.
              </p>
            )}
          </details>
        )}
      </section>

      <section className="surface-panel" aria-label="Changed files and diff preview">
        <h3>Changed files</h3>
        <p className="goal-row-meta">
          {record.projection.changedPathsTruncated
            ? `Showing the first ${record.projection.changedPaths.length} of ${record.review.changedPathCount.toLocaleString()} changed paths.`
            : `Showing all ${record.review.changedPathCount.toLocaleString()} changed paths.`}
        </p>
        <ul className="goal-plain-list goal-handoff-paths">
          {record.projection.changedPaths.map((path, index) => (
            <li key={`${path}-${index}`}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
        <h3>Diff summary</h3>
        {record.review.diffStatTruncated && (
          <p className="goal-handoff-warning">Diff summary is truncated.</p>
        )}
        <pre className="goal-handoff-code" aria-label="Bounded diff summary">
          <code>{record.projection.diffStat}</code>
        </pre>
        <h3>Bounded diff preview</h3>
        {record.review.diffPreviewTruncated && (
          <p className="goal-handoff-warning">
            This preview is truncated. The complete change set is not shown here.
          </p>
        )}
        <pre className="goal-handoff-code goal-handoff-diff" aria-label="Bounded diff preview">
          <code>
            {record.projection.diffPreview.split(/(?<=\n)/).map((line, index) => {
              const tone =
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'addition'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'removal'
                    : 'context';
              return (
                <span key={`${index}-${line.slice(0, 24)}`} className={`goal-diff-${tone}`}>
                  {line}
                </span>
              );
            })}
          </code>
        </pre>
        <p className="goal-row-meta">The preview is display text only. It is never executed.</p>
      </section>

      <InspectionCommands record={record} enabled={canCopy} />
    </>
  );
}

function InspectionCommands({ record, enabled }: { record: GoalManualIntegrationHandoff; enabled: boolean }) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const commands = record.projection.inspectionCommands.join('\n');
  const copy = async () => {
    if (!enabled) return;
    setCopied(false);
    setFallback(false);
    const clipboard = typeof window === 'undefined' ? undefined : window.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setFallback(true);
      return;
    }
    try {
      await clipboard.writeText(commands);
      setCopied(true);
    } catch {
      setFallback(true);
    }
  };
  return (
    <section className="surface-panel" aria-label="Read-only inspection commands">
      <h3>Read-only inspection commands</h3>
      <p>
        These commands use the full object IDs above. Turing only displays or copies them; it never runs them.
      </p>
      <pre className="goal-handoff-code">
        <code>{commands}</code>
      </pre>
      <button type="button" className="secondary-button" disabled={!enabled} onClick={() => void copy()}>
        Copy read-only commands
      </button>
      {!enabled && (
        <p className="goal-handoff-warning">
          This historical handoff is not current; its commands are not offered as current instructions.
        </p>
      )}
      {copied && <p role="status">Commands copied.</p>}
      {fallback && (
        <label className="goal-handoff-fallback">
          Clipboard access is unavailable. Select and copy these commands manually.
          <textarea
            readOnly
            rows={3}
            value={commands}
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Selectable read-only commands"
          />
        </label>
      )}
    </section>
  );
}

export function GoalHandoff({ goal, refresh }: { goal: GoalDetail; refresh: number }) {
  const [localRefresh, setLocalRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [refusal, setRefusal] = useState('');
  const list = useLoad(
    () => goalsApi.manualHandoffs(goal.id, { limit: 50, offset: historyOffset }),
    `${goal.id}:handoffs:${historyOffset}`,
    `${refresh}:${localRefresh}`,
  );
  const selected = useLoad<GoalManualHandoffProjection | null>(
    () => (selectedId ? goalsApi.manualHandoff(goal.id, selectedId) : Promise.resolve(null)),
    `${goal.id}:${selectedId ?? 'none'}`,
    `${refresh}:${localRefresh}`,
  );

  useEffect(() => {
    if (list.result.state !== 'ready') return;
    if (selectedId && list.result.data.handoffs.some((row) => row.handoffId === selectedId)) return;
    setSelectedId(list.result.data.handoffs[0]?.handoffId ?? null);
  }, [list.result, selectedId]);

  const refreshAll = () => {
    setUnknownOutcome(false);
    setLocalRefresh((value) => value + 1);
  };
  const prepare = async () => {
    if (preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    setRefusal('');
    setAnnouncement('');
    try {
      const response = await goalsApi.prepareManualHandoff(goal.id);
      setSelectedId(response.handoffId);
      setLocalRefresh((value) => value + 1);
      setConfirming(false);
      setAnnouncement(
        response.reused
          ? 'The identical immutable handoff already existed and was reused.'
          : 'Handoff record saved. Checking currentness now.',
      );
    } catch (error) {
      setConfirming(false);
      if (error instanceof ApiError && error.status < 500) {
        setRefusal(`${error.message}${error.code ? ` (${error.code})` : ''}`);
      } else {
        setAnnouncement(
          'The request outcome was unknown. Reloading saved handoffs before enabling another preparation attempt.',
        );
        try {
          await goalsApi.manualHandoffs(goal.id);
          setLocalRefresh((value) => value + 1);
          setUnknownOutcome(false);
        } catch {
          setUnknownOutcome(true);
          setRefusal('Saved handoffs could not be reloaded. Refresh the list before trying again.');
        }
      }
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  };

  return (
    <div className="goal-handoff" aria-busy={preparing}>
      <section className="surface-panel goal-handoff-intro" aria-label="Manual integration handoff">
        <h2>Manual integration handoff</h2>
        {goal.nextAction.kind === 'final_apply' ? (
          <p>
            Your Goal result has been verified and accepted. Turing can prepare an immutable record with the
            exact changes and evidence for your review.
          </p>
        ) : (
          <p>
            A manual handoff is a durable review record for a verified and accepted Goal result. Preparation
            is available only after the server confirms that the current result meets those requirements.
          </p>
        )}
        <p>
          Your base branch and working files are not changed. You control any later Git integration through
          your chosen workflow.
        </p>
        <div className="goal-handoff-actions">
          <button type="button" className="secondary-button" onClick={refreshAll} disabled={preparing}>
            Refresh currentness
          </button>
          {goal.nextAction.kind === 'final_apply' && (
            <button
              type="button"
              className="primary-button"
              onClick={() => setConfirming(true)}
              disabled={preparing || unknownOutcome}
            >
              Prepare handoff
            </button>
          )}
        </div>
        {goal.nextAction.kind !== 'final_apply' && (
          <p className="goal-row-meta">
            Handoff preparation is available only when the server confirms the accepted result is eligible.
            The current Goal state does not offer preparation.
          </p>
        )}
        {unknownOutcome && (
          <p className="form-error" role="alert">
            Preparation is paused until a successful handoff-list refresh confirms the saved state.
          </p>
        )}
        {refusal && (
          <p className="form-error" role="alert">
            {refusal}
          </p>
        )}
        {announcement && (
          <p role="status" aria-live="polite">
            {announcement}
          </p>
        )}
      </section>

      {confirming && (
        <ConfirmPanel
          label="Prepare handoff"
          title="Prepare an immutable handoff?"
          description="Turing will validate and save the exact result and evidence. This does not change a Git ref, checkout, index, working file, or Goal completion state. You will perform any later integration yourself."
          busy={preparing}
          onCancel={() => setConfirming(false)}
        >
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              data-confirm-safe
              disabled={preparing}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              data-confirm-restore-trigger
              disabled={preparing}
              onClick={() => void prepare()}
            >
              {preparing ? 'Preparing…' : 'Confirm preparation'}
            </button>
          </div>
        </ConfirmPanel>
      )}

      <section className="surface-panel" aria-label="Saved handoffs">
        <div className="goal-handoff-heading-row">
          <h3>Saved handoffs</h3>
          <button type="button" className="secondary-button" onClick={() => list.reload()}>
            Refresh list
          </button>
        </div>
        {list.result.state === 'loading' && <p role="status">Loading saved handoffs…</p>}
        {list.result.state === 'error' && (
          <p className="form-error" role="alert">
            Saved handoffs could not be loaded. {list.result.message}
          </p>
        )}
        {list.result.state === 'ready' && list.result.data.handoffs.length === 0 && (
          <Empty>No handoffs have been prepared for this Goal.</Empty>
        )}
        {list.result.state === 'ready' && list.result.data.handoffs.length > 0 && (
          <ul className="goal-plain-list goal-handoff-history">
            {list.result.data.handoffs.map((row) => (
              <li key={row.handoffId}>
                <button
                  type="button"
                  className="goal-version"
                  aria-pressed={selectedId === row.handoffId}
                  onClick={() => setSelectedId(row.handoffId)}
                >
                  <span>
                    v{row.definitionVersion} · {formatTime(row.createdAt)}
                  </span>
                  <code>
                    {shortHash(row.sourceCommit)} · {shortHash(row.handoffDigest)}
                  </code>
                  <span>
                    {selectedId === row.handoffId && selected.result.state === 'ready'
                      ? stateText(selected.result.data)
                      : 'Select to validate currentness'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.result.state === 'ready' && (
          <div className="goal-handoff-actions">
            {historyOffset > 0 && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}
              >
                Newer handoffs
              </button>
            )}
            {list.result.data.nextOffset !== null && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setHistoryOffset(historyOffset + 50)}
              >
                Older handoffs
              </button>
            )}
          </div>
        )}
      </section>

      {selectedId && (
        <section className="goal-handoff-projection" aria-label="Selected handoff review">
          {selected.result.state === 'loading' && (
            <p role="status">Checking this handoff against the current Goal and Git identities…</p>
          )}
          {selected.result.state === 'error' && (
            <p className="form-error" role="alert">
              Currentness could not be verified. {selected.result.message}
            </p>
          )}
          {selected.result.state === 'ready' && selected.result.data && (
            <HandoffDetail projection={selected.result.data} />
          )}
        </section>
      )}
    </div>
  );
}

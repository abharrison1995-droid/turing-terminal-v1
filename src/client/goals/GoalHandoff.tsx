import { useEffect, useRef, useState } from 'react';
import type {
  GoalDetail,
  GoalManualHandoffListResponse,
  GoalManualHandoffProjection,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import { ConfirmPanel } from './DefinitionParts';
import { GoalExternalIntegration } from './GoalExternalIntegration';
import { goalsApi } from './api';
import { Empty } from './parts';
import { formatTime, shortHash } from './presentation';
import { useLoad } from './useLoad';

type PreparationState =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'confirmed'; handoffId: string }
  | { state: 'refused'; message: string }
  | { state: 'uncertain' }
  | { state: 'reconciling' }
  | { state: 'reconciliation_failed'; message: string }
  | { state: 'reconciled'; message: string };

const HANDOFF_HISTORY_LIMIT = 50;
const MAX_RECONCILIATION_PAGES = 100;
const HANDOFF_UI_MEMORY_PREFIX = 'turing.goalHandoff.ui.v1:';

interface HandoffUiMemory {
  selectedId: string | null;
  historyOffset: number;
  uncertainOutcome: boolean;
}

function readHandoffUiMemory(goalId: string): HandoffUiMemory | null {
  try {
    const raw = window.sessionStorage.getItem(`${HANDOFF_UI_MEMORY_PREFIX}${goalId}`);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Partial<HandoffUiMemory>;
    return {
      selectedId: typeof record.selectedId === 'string' ? record.selectedId : null,
      historyOffset:
        Number.isSafeInteger(record.historyOffset) && (record.historyOffset ?? -1) >= 0
          ? record.historyOffset!
          : 0,
      uncertainOutcome: record.uncertainOutcome === true,
    };
  } catch {
    return null;
  }
}

function updateHandoffUiMemory(goalId: string, update: Partial<HandoffUiMemory>) {
  try {
    const previous = readHandoffUiMemory(goalId) ?? {
      selectedId: null,
      historyOffset: 0,
      uncertainOutcome: false,
    };
    window.sessionStorage.setItem(
      `${HANDOFF_UI_MEMORY_PREFIX}${goalId}`,
      JSON.stringify({ ...previous, ...update }),
    );
  } catch {
    // Session storage is only a navigation/reload safeguard; the in-memory UI remains usable if it is unavailable.
  }
}

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
  const [savedUi] = useState(() => readHandoffUiMemory(goal.id));
  const [localRefresh, setLocalRefresh] = useState(0);
  const [reconciledListPage, setReconciledListPage] = useState<{
    goalId: string;
    offset: number;
    data: GoalManualHandoffListResponse;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(savedUi?.selectedId ?? null);
  const [historyOffset, setHistoryOffset] = useState(savedUi?.historyOffset ?? 0);
  const [confirming, setConfirming] = useState(false);
  const [preparation, setPreparation] = useState<PreparationState>(
    savedUi?.uncertainOutcome ? { state: 'uncertain' } : { state: 'idle' },
  );
  const preparingRef = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const [refusal, setRefusal] = useState('');
  const mountedRef = useRef(true);
  const reconciliationInFlightRef = useRef(false);
  const reconciliationGenerationRef = useRef(0);
  const preparing = preparation.state === 'pending';
  const preparationLocked =
    preparation.state === 'uncertain' ||
    preparation.state === 'reconciling' ||
    preparation.state === 'reconciliation_failed';
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
  const historyResult =
    reconciledListPage?.goalId === goal.id && reconciledListPage.offset === historyOffset
      ? { state: 'ready' as const, data: reconciledListPage.data }
      : list.result;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reconciliationGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (historyResult.state !== 'ready') return;
    // Only initialize from history when the user has no stronger selection intent. A selected ID may
    // legitimately be absent from a cached page while a new handoff's projection/history is loading.
    if (selectedId === null) {
      const initialId = historyResult.data.handoffs[0]?.handoffId ?? null;
      if (initialId !== null) {
        updateHandoffUiMemory(goal.id, { selectedId: initialId });
        setSelectedId(initialId);
      }
    }
  }, [goal.id, historyResult, selectedId]);

  useEffect(() => {
    setReconciledListPage(null);
  }, [goal.id, historyOffset, localRefresh, refresh]);

  const reconcileUnknownOutcome = async () => {
    if (reconciliationInFlightRef.current) return;
    const goalId = goal.id;
    const requestId = ++reconciliationGenerationRef.current;
    reconciliationInFlightRef.current = true;
    setPreparation({ state: 'reconciling' });
    setRefusal('');
    try {
      // A page with nextOffset cannot establish that the full scoped history was observed. Walk the
      // bounded metadata pages in order; if the configured bound is exceeded, keep preparation locked.
      let offset = 0;
      let pageCount = 0;
      let displayedPage: GoalManualHandoffListResponse | null = null;
      const seenHandoffIds = new Set<string>();
      for (;;) {
        if (!mountedRef.current || goal.id !== goalId || requestId !== reconciliationGenerationRef.current)
          return;
        const page = await goalsApi.manualHandoffs(goalId, {
          limit: HANDOFF_HISTORY_LIMIT,
          offset,
        });
        if (!mountedRef.current || goal.id !== goalId || requestId !== reconciliationGenerationRef.current)
          return;
        pageCount += 1;
        if (page.limit !== HANDOFF_HISTORY_LIMIT || page.handoffs.length > HANDOFF_HISTORY_LIMIT) {
          throw new Error('The saved handoff history response exceeded its page bound.');
        }
        for (const row of page.handoffs) {
          if (
            typeof row.handoffId !== 'string' ||
            row.handoffId.length === 0 ||
            seenHandoffIds.has(row.handoffId)
          ) {
            throw new Error('The saved handoff history changed or repeated an ID during pagination.');
          }
          seenHandoffIds.add(row.handoffId);
        }
        if (offset === historyOffset) displayedPage = page;
        if (page.nextOffset === null) break;
        if (
          pageCount >= MAX_RECONCILIATION_PAGES ||
          !Number.isSafeInteger(page.nextOffset) ||
          page.nextOffset !== offset + HANDOFF_HISTORY_LIMIT ||
          page.nextOffset > 100_000
        ) {
          throw new Error('The saved handoff history is too large to reconcile completely.');
        }
        offset = page.nextOffset;
      }
      if (!mountedRef.current || goal.id !== goalId || requestId !== reconciliationGenerationRef.current)
        return;
      if (!displayedPage) {
        throw new Error('The displayed history page was not included in the completed reconciliation read.');
      }
      setReconciledListPage({ goalId, offset: historyOffset, data: displayedPage });
      const message =
        'The bounded saved-handoff history was freshly read across all pages. This does not identify whether the failed request persisted. Review the refreshed list; any further preparation still requires confirmation and identical content is reused by the server.';
      setPreparation({
        state: 'reconciled',
        message,
      });
      updateHandoffUiMemory(goalId, { uncertainOutcome: false });
      setAnnouncement(message);
      selected.reload();
    } catch (error) {
      if (!mountedRef.current || goal.id !== goalId || requestId !== reconciliationGenerationRef.current)
        return;
      const message =
        error instanceof Error
          ? error.message
          : 'The saved handoff history could not establish a complete recovery state.';
      setPreparation({ state: 'reconciliation_failed', message });
      updateHandoffUiMemory(goalId, { uncertainOutcome: true });
      setRefusal(
        `Preparation remains paused because a fresh, complete handoff-history read could not verify the outcome. ${message}`,
      );
    } finally {
      if (requestId === reconciliationGenerationRef.current) reconciliationInFlightRef.current = false;
    }
  };

  const refreshAll = () => {
    setLocalRefresh((value) => value + 1);
    if (preparation.state === 'uncertain' || preparation.state === 'reconciliation_failed') {
      void reconcileUnknownOutcome();
    }
  };
  const prepare = async () => {
    if (preparingRef.current || preparationLocked) return;
    preparingRef.current = true;
    setPreparation({ state: 'pending' });
    // If this tab unmounts while the request is in flight, reopening it must start locked and reconcile.
    updateHandoffUiMemory(goal.id, { uncertainOutcome: true });
    setRefusal('');
    setAnnouncement('');
    try {
      const response = await goalsApi.prepareManualHandoff(goal.id);
      if (!mountedRef.current) return;
      setPreparation({ state: 'confirmed', handoffId: response.handoffId });
      updateHandoffUiMemory(goal.id, { selectedId: response.handoffId, uncertainOutcome: false });
      setSelectedId(response.handoffId);
      setLocalRefresh((value) => value + 1);
      setConfirming(false);
      setAnnouncement(
        response.reused
          ? 'The identical immutable handoff already existed and was reused.'
          : 'Handoff record saved. Checking currentness now.',
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setConfirming(false);
      if (error instanceof ApiError && error.status < 500) {
        const message = `${error.message}${error.code ? ` (${error.code})` : ''}`;
        setPreparation({ state: 'refused', message });
        updateHandoffUiMemory(goal.id, { uncertainOutcome: false });
        setRefusal(message);
      } else {
        setPreparation({ state: 'uncertain' });
        updateHandoffUiMemory(goal.id, { uncertainOutcome: true });
        setAnnouncement(
          'The request outcome is unknown. Reading the complete saved-handoff history before allowing another preparation attempt.',
        );
        await reconcileUnknownOutcome();
      }
    } finally {
      preparingRef.current = false;
    }
  };

  const projection = selected.result.state === 'ready' ? selected.result.data : null;
  const projectionMatchesSelection =
    projection !== null &&
    (projection.handoff === null
      ? projection.state === 'invalid'
      : projection.handoff.goalId === goal.id && projection.handoff.handoffId === selectedId);
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
          <button
            type="button"
            className="secondary-button"
            onClick={refreshAll}
            disabled={preparing || preparation.state === 'reconciling'}
          >
            {preparation.state === 'reconciling' ? 'Reconciling handoff history…' : 'Refresh currentness'}
          </button>
          {goal.nextAction.kind === 'final_apply' && (
            <button
              type="button"
              className="primary-button"
              onClick={() => setConfirming(true)}
              disabled={preparing || preparationLocked}
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
        {preparation.state === 'uncertain' && (
          <p className="form-error" role="alert">
            Preparation is paused until a fresh, complete, Goal-scoped handoff-history read establishes a safe
            recovery state.
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
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setReconciledListPage(null);
              list.reload();
            }}
          >
            Refresh list
          </button>
        </div>
        {historyResult.state === 'loading' && <p role="status">Loading saved handoffs…</p>}
        {historyResult.state === 'error' && (
          <p className="form-error" role="alert">
            Saved handoffs could not be loaded. {historyResult.message}
          </p>
        )}
        {historyResult.state === 'ready' && historyResult.data.handoffs.length === 0 && (
          <Empty>No handoffs have been prepared for this Goal.</Empty>
        )}
        {historyResult.state === 'ready' && historyResult.data.handoffs.length > 0 && (
          <ul className="goal-plain-list goal-handoff-history">
            {historyResult.data.handoffs.map((row) => (
              <li key={row.handoffId}>
                <button
                  type="button"
                  className="goal-version"
                  aria-pressed={selectedId === row.handoffId}
                  onClick={() => {
                    updateHandoffUiMemory(goal.id, { selectedId: row.handoffId });
                    setSelectedId(row.handoffId);
                  }}
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
        {historyResult.state === 'ready' && (
          <div className="goal-handoff-actions">
            {historyOffset > 0 && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const nextOffset = Math.max(0, historyOffset - HANDOFF_HISTORY_LIMIT);
                  updateHandoffUiMemory(goal.id, { historyOffset: nextOffset });
                  setHistoryOffset(nextOffset);
                }}
              >
                Newer handoffs
              </button>
            )}
            {historyResult.data.nextOffset !== null && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const nextOffset = historyOffset + HANDOFF_HISTORY_LIMIT;
                  updateHandoffUiMemory(goal.id, { historyOffset: nextOffset });
                  setHistoryOffset(nextOffset);
                }}
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
            <p role="status">
              Handoff {shortHash(selectedId)} is selected. Checking it against the current Goal and Git
              identities…
            </p>
          )}
          {selected.result.state === 'error' && (
            <div>
              <p className="form-error" role="alert">
                Handoff {shortHash(selectedId)} remains selected, but currentness could not be verified.{' '}
                {selected.result.message}
              </p>
              <button type="button" className="secondary-button" onClick={selected.reload}>
                Retry currentness check
              </button>
            </div>
          )}
          {selected.result.state === 'ready' && !projectionMatchesSelection && (
            <p className="form-error" role="alert">
              Handoff {shortHash(selectedId)} remains selected, but the response did not match this Goal and
              handoff. Currentness cannot be verified.
            </p>
          )}
          {projectionMatchesSelection && projection && (
            <>
              <HandoffDetail projection={projection} />
              {projection.handoff && (
                <GoalExternalIntegration
                  key={`${goal.id}:${projection.handoff.handoffId}`}
                  goalId={goal.id}
                  goalTitle={goal.title}
                  handoff={projection.handoff}
                  handoffCurrent={projection.state === 'current'}
                  refresh={`${refresh}:${localRefresh}`}
                />
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

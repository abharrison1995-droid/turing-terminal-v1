import { useEffect, useRef, useState } from 'react';
import type { GoalDefinitionFull, GoalDetail } from '../../shared/goalApi';
import { goalsApi } from './api';
import { ConfirmPanel, RefusalAlert, ValidationReport } from './DefinitionParts';
import {
  diffLines,
  formatDefinitionText,
  parseDefinitionText,
  parseFailureText,
  prettyDefinition,
} from './definitionDoc';
import { useLoad } from './useLoad';
import { shortHash } from './presentation';
import { toRefusal, type Refusal } from './refusal';

type Pending = null | { kind: 'approve' | 'reject'; version: number; hash: string };

/** What an approval changes, in the user's words. Derived from persisted facts only. */
function proposalKind(goal: Pick<GoalDetail, 'status'>, full: Pick<GoalDefinitionFull, 'parentVersion'>) {
  if (full.parentVersion === null) return 'initial' as const;
  return goal.status === 'draft' ? ('revision' as const) : ('amendment' as const);
}

const KIND_LABEL = {
  initial: 'Initial definition',
  revision: 'Revision of a ready Goal',
  amendment: 'Amendment of an executing Goal',
} as const;

/**
 * The editor and authority actions for ONE persisted proposed version. Typing changes only local text; Save, Approve
 * and Reject are three separate explicit requests, each re-proved by the server. Approve never saves, Save never
 * approves, and a confirmation is bound to the version and persisted hash that were on screen when it opened.
 */
export function ProposalWorkbench({
  goal,
  full,
  onChanged,
  onDirty,
}: {
  goal: GoalDetail;
  full: GoalDefinitionFull;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const persisted = prettyDefinition(full.definition);
  const [text, setText] = useState(persisted);
  const [base, setBase] = useState({ hash: full.definitionHash, text: persisted });
  // After our own Save the server's canonical text may differ from what was typed; reseed once when its hash arrives.
  const [reseedNext, setReseedNext] = useState(false);
  const [summary, setSummary] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'reject'>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const dirty = text !== base.text;
  const hashMoved = base.hash !== full.definitionHash;
  if (hashMoved && (!dirty || reseedNext)) {
    setBase({ hash: full.definitionHash, text: persisted });
    setText(persisted);
    setReseedNext(false);
    setParseError(null);
  }
  // The persisted proposal changed under unsaved text: Save would overwrite someone else's change, so it must reset.
  const stale = hashMoved && dirty && !reseedNext;
  // An approval confirmation never survives a change of the persisted content it was shown for.
  if (pending && (pending.hash !== full.definitionHash || pending.version !== full.version)) setPending(null);

  const reportDirty = useRef(onDirty);
  reportDirty.current = onDirty;
  useEffect(() => {
    reportDirty.current(dirty);
  }, [dirty]);
  useEffect(() => () => reportDirty.current(false), []);

  const kind = proposalKind(goal, full);
  const live = parseDefinitionText(text);

  async function run(which: 'save' | 'approve' | 'reject', request: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(which);
    setRefusal(null);
    setMessage(null);
    try {
      await request();
      setMessage(done);
      if (which === 'save') setReseedNext(true);
    } catch (error) {
      setRefusal(toRefusal(error));
    } finally {
      setBusy(null);
      setPending(null);
      onChanged();
    }
  }

  function save() {
    const parsed = parseDefinitionText(text);
    if (!parsed.ok) {
      setParseError(parseFailureText(parsed));
      return;
    }
    setParseError(null);
    void run(
      'save',
      () =>
        goalsApi.saveDefinition(
          goal.id,
          full.version,
          full.definitionHash,
          parsed.value,
          summary.trim() || undefined,
        ),
      `Saved v${full.version}. Review the new hash and validation below before approving.`,
    );
  }

  function format() {
    const out = formatDefinitionText(text);
    if (out.ok) {
      setText(out.text);
      setParseError(null);
    } else setParseError(live.ok ? 'Could not format.' : parseFailureText(live));
  }

  const reset = () => {
    setText(persisted);
    setBase({ hash: full.definitionHash, text: persisted });
    setParseError(null);
    setConfirmReset(false);
  };

  const approvable = !dirty && !stale && full.validation.valid && busy === null;
  return (
    <section
      className="goal-workbench surface-panel"
      aria-label={`Edit proposed definition v${full.version}`}
      aria-busy={busy !== null}
    >
      <header className="goal-workbench-head">
        <h3>
          Proposed definition v{full.version} <span className="status-pill">{KIND_LABEL[kind]}</span>
        </h3>
        <p className="goal-row-meta">
          Persisted hash <code data-persisted-hash="true">{shortHash(full.definitionHash)}</code> · parent{' '}
          {full.parentVersion === null ? 'none' : `v${full.parentVersion}`} ·{' '}
          <span data-dirty={dirty ? 'true' : 'false'}>
            {dirty ? 'Unsaved changes' : 'No unsaved changes'}
          </span>
        </p>
      </header>
      <ValidationReport validation={full.validation} />
      {kind !== 'initial' && <Comparison goalId={goal.id} proposal={full} />}
      <label className="form-field">
        <span>Definition document (JSON)</span>
        <textarea
          className="goal-json-editor"
          aria-label="Definition JSON"
          spellCheck={false}
          value={text}
          rows={22}
          onChange={(event) => {
            setText(event.target.value);
            setReseedNext(false);
            setParseError(null);
          }}
        />
      </label>
      {!live.ok && (
        <p className="goal-note" data-parse-state="invalid">
          Not valid JSON yet: {parseFailureText(live)}
        </p>
      )}
      {parseError && (
        <p className="form-error" role="alert" data-parse-error="true">
          Nothing was sent: {parseError}
        </p>
      )}
      {stale && (
        <p className="form-error" role="alert" data-stale-editor="true">
          The persisted proposal changed since you started editing. Reset to the persisted proposal to
          continue; saving is disabled so it cannot overwrite that change.
        </p>
      )}
      <label className="form-field">
        <span>Change summary (optional)</span>
        <input value={summary} maxLength={500} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <div className="goal-control-buttons">
        <button type="button" className="secondary-button" onClick={format}>
          Format JSON
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!dirty || busy !== null}
          onClick={() => (dirty ? setConfirmReset(true) : reset())}
        >
          Reset to persisted
        </button>
        <button
          type="button"
          className="primary-button"
          data-action="save-definition"
          disabled={!dirty || stale || busy !== null}
          aria-busy={busy === 'save'}
          onClick={save}
        >
          {busy === 'save' ? 'Saving…' : 'Save proposed definition'}
        </button>
      </div>
      {confirmReset && (
        <ConfirmPanel
          label="Confirm reset"
          title="Discard your unsaved edits?"
          description="The editor returns to the persisted proposal. Nothing is sent to the server."
          onCancel={() => setConfirmReset(false)}
        >
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              data-confirm-safe
              onClick={() => setConfirmReset(false)}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="secondary-button goal-danger"
              data-confirm-restore-trigger
              onClick={reset}
            >
              Discard edits
            </button>
          </div>
        </ConfirmPanel>
      )}
      <hr />
      <div className="goal-control-buttons">
        <button
          type="button"
          className="primary-button"
          data-action="approve-definition"
          disabled={!approvable}
          onClick={() => setPending({ kind: 'approve', version: full.version, hash: full.definitionHash })}
        >
          Approve definition v{full.version}
        </button>
        <button
          type="button"
          className="secondary-button goal-danger"
          data-action="reject-definition"
          disabled={busy !== null}
          onClick={() => setPending({ kind: 'reject', version: full.version, hash: full.definitionHash })}
        >
          Reject proposed definition
        </button>
      </div>
      {!approvable && busy === null && (
        <p className="goal-note" data-approve-blocked="true">
          {dirty
            ? 'Save your changes before approving, so the exact persisted content is what you approve.'
            : stale
              ? 'Reset the editor to the persisted proposal before approving.'
              : !full.validation.valid
                ? 'Fix the validation errors and save before approving.'
                : ''}
        </p>
      )}
      {pending?.kind === 'approve' && (
        <ConfirmPanel
          label="Confirm approve definition"
          title={`Approve v${full.version} of “${goal.title}”?`}
          description="Approval makes this exact definition immutable and current. Changing it later needs a new revision."
          onCancel={() => setPending(null)}
          busy={busy !== null}
        >
          <dl className="goal-facts">
            <div className="goal-fact">
              <dt>Kind</dt>
              <dd>{KIND_LABEL[kind]}</dd>
            </div>
            <div className="goal-fact">
              <dt>Version / hash</dt>
              <dd>
                v{full.version} · <code>{shortHash(full.definitionHash)}</code>
              </dd>
            </div>
            <div className="goal-fact">
              <dt>Warnings</dt>
              <dd>{full.validation.warnings.length}</dd>
            </div>
            <div className="goal-fact">
              <dt>Change summary</dt>
              <dd>{full.changeSummary}</dd>
            </div>
          </dl>
          {kind === 'amendment' && (
            <p>
              Approving the amendment does not resume the Goal. It stays waiting for you until you resume it
              yourself.
            </p>
          )}
          <label className="form-field">
            <span>Approval note (optional)</span>
            <input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== null}
              data-confirm-safe
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy !== null}
              aria-busy={busy === 'approve'}
              onClick={() =>
                void run(
                  'approve',
                  () =>
                    goalsApi.approveDefinition(
                      goal.id,
                      full.version,
                      full.definitionHash,
                      note.trim() || undefined,
                    ),
                  `Approved v${full.version}. Showing the refreshed state.`,
                )
              }
            >
              {busy === 'approve' ? 'Approving…' : 'Confirm approval'}
            </button>
          </div>
        </ConfirmPanel>
      )}
      {pending?.kind === 'reject' && (
        <ConfirmPanel
          label="Confirm reject definition"
          title={`Reject proposed definition v${full.version}?`}
          description={`Rejecting only proposal v${full.version} does not delete or abandon the Goal.`}
          onCancel={() => setPending(null)}
          busy={busy !== null}
        >
          <p>
            This discards only this proposal. It does not delete or abandon the Goal.
            {kind === 'amendment'
              ? ' The Goal stays waiting for you until you explicitly resume it.'
              : kind === 'revision'
                ? ' The Goal returns to its approved definition.'
                : ''}
          </p>
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== null}
              data-confirm-safe
              onClick={() => setPending(null)}
            >
              Keep proposal
            </button>
            <button
              type="button"
              className="secondary-button goal-danger"
              disabled={busy !== null}
              aria-busy={busy === 'reject'}
              onClick={() =>
                void run(
                  'reject',
                  () => goalsApi.rejectDefinition(goal.id, full.version, full.definitionHash),
                  `Rejected v${full.version}. Showing the refreshed state.`,
                )
              }
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject proposal'}
            </button>
          </div>
        </ConfirmPanel>
      )}
      {refusal && <RefusalAlert refusal={refusal} />}
      {message && !refusal && (
        <p className="goal-note" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

/** Persisted parent vs persisted proposal. Bounded line diff; no semantic engine, no unsaved text. */
function Comparison({ goalId, proposal }: { goalId: string; proposal: GoalDefinitionFull }) {
  const parent = proposal.parentVersion as number;
  const { result, reload } = useLoad(
    () => goalsApi.definition(goalId, parent),
    `${goalId}:${parent}:compare`,
    proposal.definitionHash,
  );
  if (result.state === 'loading')
    return (
      <p className="goal-note" role="status">
        Loading comparison…
      </p>
    );
  if (result.state === 'error')
    return (
      <div className="form-error" role="alert">
        <span>Comparison could not be loaded: {result.message}</span>
        <button type="button" className="secondary-button" onClick={reload}>
          Retry comparison
        </button>
      </div>
    );
  const before = result.data;
  const lines = diffLines(prettyDefinition(before.definition), prettyDefinition(proposal.definition));
  const changed = lines?.filter((line) => line.kind !== 'same').length ?? 0;
  return (
    <details className="goal-compare" open>
      <summary>
        Compare with v{parent} (
        {lines ? `${changed} changed line${changed === 1 ? '' : 's'}` : 'too large to compare'})
      </summary>
      <p className="goal-row-meta">
        v{parent} <code>{shortHash(before.definitionHash)}</code> (
        {before.validation.valid ? 'valid' : 'not valid'}) → v{proposal.version}{' '}
        <code>{shortHash(proposal.definitionHash)}</code> ({proposal.validation.valid ? 'valid' : 'not valid'}
        ) · {proposal.changeSummary}
      </p>
      {lines && (
        <pre className="goal-diff" aria-label="Definition changes">
          {lines.map((line, index) => (
            <span key={index} className={`goal-diff-${line.kind}`} data-diff={line.kind}>
              {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </details>
  );
}

/** "Revise Goal": one explicit request that makes the server copy the current approved definition into a proposal. */
export function RevisionControl({ goal, onChanged }: { goal: GoalDetail; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const stateKey = `${goal.status}|${goal.reasonCode ?? ''}|${goal.nextAction.kind}`;
  const [shownFor, setShownFor] = useState(stateKey);
  if (shownFor !== stateKey) {
    setShownFor(stateKey);
    setConfirming(false);
  }

  async function begin() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await goalsApi.beginRevision(goal.id, summary.trim() || undefined);
      setConfirming(false);
      setSummary('');
    } catch (error) {
      setRefusal(toRefusal(error));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const executing = goal.status !== 'ready';
  return (
    <section className="goal-controls" aria-label="Revise Goal" aria-busy={busy}>
      <div className="goal-control-buttons">
        <button
          type="button"
          className="secondary-button"
          data-action="revise-goal"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          Revise Goal
        </button>
      </div>
      {confirming && (
        <ConfirmPanel
          label="Confirm begin revision"
          title={executing ? 'Begin an amendment?' : 'Begin a revision?'}
          description={
            executing
              ? 'Turing copies the current approved definition into a proposal. The Goal waits for you after the amendment begins; nothing resumes automatically.'
              : 'Turing copies the current approved definition into a proposal. The Goal returns to draft for review; nothing changes until you approve it.'
          }
          onCancel={() => setConfirming(false)}
          busy={busy}
        >
          <label className="form-field">
            <span>Change summary (optional)</span>
            <input value={summary} maxLength={500} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              data-confirm-safe
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void begin()}
            >
              {busy ? 'Starting…' : executing ? 'Begin amendment' : 'Begin revision'}
            </button>
          </div>
        </ConfirmPanel>
      )}
      {refusal && <RefusalAlert refusal={refusal} />}
    </section>
  );
}

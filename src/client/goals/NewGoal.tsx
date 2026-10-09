import { useEffect, useRef, useState } from 'react';
import type { ProjectProfile } from '../../shared/types';
import { goalsApi } from './api';
import { RefusalAlert, ConfirmPanel } from './DefinitionParts';
import { formatDefinitionText, parseDefinitionText, parseFailureText } from './definitionDoc';
import { toRefusal, type Refusal } from './refusal';

/**
 * Manual Grand Project creation. It sends exactly one `POST /api/goals` when the user presses Create: the server makes
 * the Goal shell and a PROPOSED v1. Nothing here approves, starts, resumes, calls a model or touches a branch.
 * Projects come from the registered list the app already holds; this flow never registers one.
 */
export function NewGoal({
  projects,
  onCancel,
  onCreated,
  onOpenProjects,
  onUnsavedChange,
}: {
  projects: ProjectProfile[];
  onCancel: () => void;
  onCreated: (goalId: string) => void;
  onOpenProjects?: () => void;
  /** True while the form holds anything the user typed or chose (a boolean only). */
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const touched = title !== '' || text !== '' || summary !== '' || projectId !== '';

  const report = useRef(onUnsavedChange);
  report.current = onUnsavedChange;
  useEffect(() => {
    report.current?.(touched);
  }, [touched]);
  useEffect(() => () => report.current?.(false), []);

  if (projects.length === 0)
    return (
      <section className="surface-panel goal-new" aria-label="New Grand Project">
        <h2>New Grand Project</h2>
        <p className="goal-empty">
          No projects are registered yet. A Grand Project belongs to an existing project, so add one on the
          Projects page first.
        </p>
        <div className="goal-control-buttons">
          {onOpenProjects && (
            <button type="button" className="primary-button" onClick={onOpenProjects}>
              Open Projects
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onCancel}>
            Back to Grand Projects
          </button>
        </div>
      </section>
    );

  async function create() {
    if (busy) return;
    setRefusal(null);
    setLocalError(null);
    if (!projectId) return setLocalError('Choose a project.');
    if (title.trim() === '') return setLocalError('Enter a title.');
    const parsed = parseDefinitionText(text);
    if (!parsed.ok) return setLocalError(parseFailureText(parsed));
    setBusy(true);
    try {
      const created = await goalsApi.createGoal({
        projectId,
        title: title.trim(),
        definition: parsed.value,
        ...(summary.trim() ? { changeSummary: summary.trim() } : {}),
      });
      onCreated(created.goalId);
    } catch (error) {
      setRefusal(toRefusal(error));
      setBusy(false);
    }
  }

  return (
    <section className="surface-panel goal-new" aria-label="New Grand Project" aria-busy={busy}>
      <h2>New Grand Project</h2>
      <p className="goal-row-meta">
        This creates a draft with a proposed definition. Nothing starts, no model is called and your branch is
        not touched; you review and approve the definition next.
      </p>
      <label className="form-field">
        <span>Project</span>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Choose a registered project…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field">
        <span>Title</span>
        <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="form-field">
        <span>Change summary (optional)</span>
        <input value={summary} maxLength={500} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <label className="form-field">
        <span>Definition document (JSON)</span>
        <textarea
          className="goal-json-editor"
          aria-label="Definition JSON"
          spellCheck={false}
          rows={20}
          value={text}
          placeholder='{ "contract": {…}, "milestones": […], "routing": {…}, "review": {…}, "limits": {…} }'
          onChange={(event) => setText(event.target.value)}
        />
        <small>
          A complete definition: contract, milestones, routing, review and limits. The server validates it.
        </small>
      </label>
      {localError && (
        <p className="form-error" role="alert" data-local-error="true">
          Nothing was sent: {localError}
        </p>
      )}
      {refusal && <RefusalAlert refusal={refusal} prefix="Not created" />}
      <div className="goal-control-buttons">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            const out = formatDefinitionText(text);
            if (out.ok) setText(out.text);
            else setLocalError('The text is not valid JSON, so it cannot be formatted.');
          }}
        >
          Format JSON
        </button>
        <button
          type="button"
          className="primary-button"
          data-action="create-goal"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : 'Create draft'}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => (touched ? setConfirmCancel(true) : onCancel())}
        >
          Cancel
        </button>
      </div>
      {confirmCancel && (
        <ConfirmPanel
          label="Confirm discard new Grand Project"
          title="Discard this draft form?"
          description="Nothing has been created. What you typed will be lost."
          onCancel={() => setConfirmCancel(false)}
        >
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              data-confirm-safe
              onClick={() => setConfirmCancel(false)}
            >
              Keep editing
            </button>
            <button type="button" className="secondary-button goal-danger" onClick={onCancel}>
              Discard
            </button>
          </div>
        </ConfirmPanel>
      )}
    </section>
  );
}

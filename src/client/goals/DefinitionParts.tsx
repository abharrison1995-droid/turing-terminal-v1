import { useId, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { GoalDefinitionValidation, GoalValidationIssue } from '../../shared/goalApi';
import { definitionRefusalText, refusalIssues, type Refusal } from './refusal';

/** The server's validation result for a persisted proposal, shown prominently and never recomputed here. */
export function ValidationReport({ validation }: { validation: GoalDefinitionValidation }) {
  const { valid, errors, warnings } = validation;
  return (
    <section
      className={`goal-validation ${valid ? 'goal-validation-ok' : 'goal-validation-bad'}`}
      aria-label="Definition validation"
      data-validation-valid={valid ? 'true' : 'false'}
    >
      <strong role={valid ? 'status' : 'alert'}>
        {valid ? 'Valid' : 'Not valid'} — {errors.length} error{errors.length === 1 ? '' : 's'},{' '}
        {warnings.length} warning{warnings.length === 1 ? '' : 's'}
      </strong>
      {!valid && <p>This definition cannot be approved until its errors are fixed and saved.</p>}
      <IssueList issues={[...errors, ...warnings]} />
    </section>
  );
}

function IssueList({ issues }: { issues: GoalValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="goal-plain-list goal-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.path}:${issue.code}:${index}`} data-issue-severity={issue.severity}>
          <strong>{issue.severity === 'error' ? 'Error' : 'Warning'}</strong>{' '}
          <code>{issue.path || '(document)'}</code> <code>{issue.code}</code> — {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** A server refusal, shown with its code and any structured issue details. Never "something went wrong". */
export function RefusalAlert({ refusal, prefix = 'Not done' }: { refusal: Refusal; prefix?: string }) {
  const issues = refusalIssues(refusal);
  return (
    <div className="form-error" role="alert" data-refusal-code={refusal.code ?? ''}>
      <p>
        {prefix}: {definitionRefusalText(refusal)}
      </p>
      {issues.length > 0 && (
        <ul className="goal-plain-list goal-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.path}:${index}`}>
              {issue.severity ? <strong>{issue.severity === 'error' ? 'Error' : 'Warning'} </strong> : null}
              {issue.path ? <code>{issue.path}</code> : null} {issue.code ? <code>{issue.code}</code> : null}{' '}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An in-app confirmation. It performs nothing itself: the caller's explicit confirm button is the only mutation. */
export function ConfirmPanel({
  label,
  title,
  description,
  onCancel,
  busy = false,
  headingLevel = 2,
  children,
}: {
  label: string;
  title: string;
  description: string;
  onCancel: () => void;
  busy?: boolean;
  /** The title's heading level, so a dialog nested in a panel can keep the outline straight. Defaults to h2. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  children: ReactNode;
}) {
  const id = useId();
  const Title = `h${headingLevel}` as const;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const restoreTrigger = useRef(false);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !root.current?.contains(active)) trigger.current = active;
    const safeAction = root.current?.querySelector<HTMLElement>('[data-confirm-safe]:not(:disabled)');
    (safeAction ?? root.current)?.focus();
    return () => {
      if (restoreTrigger.current && trigger.current?.isConnected) trigger.current.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    event.stopPropagation();
    restoreTrigger.current = true;
    cancel.current();
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-confirm-safe], [data-confirm-restore-trigger]')) {
      restoreTrigger.current = true;
    }
  };

  return (
    <div
      ref={root}
      className="goal-confirm"
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-confirm-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClickCapture={onClickCapture}
    >
      <Title id={`${id}-title`}>{title}</Title>
      <p id={`${id}-description`}>{description}</p>
      {children}
    </div>
  );
}

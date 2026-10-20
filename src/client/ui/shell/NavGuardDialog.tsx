import { useId, type RefObject } from 'react';

export interface NavGuardDialogProps {
  /** Owned by App, which focuses the safe action on open and restores the invoker on cancel. */
  dialogRef: RefObject<HTMLDivElement | null>;
  onKeepEditing: () => void;
  onDiscard: () => void;
  /** Copy for a guard other than the Grand Project one. Defaults keep the original wording. */
  title?: string;
  description?: string;
  discardLabel?: string;
  /** False when leaving loses nothing, so the leave button is not styled as destructive. */
  destructive?: boolean;
}

/**
 * The unsaved Grand Project guard. Rendered only while a navigation is held; App owns the held navigation, the focus
 * bookkeeping and the unsaved flag. Escape, Tab trapping and the button copy are unchanged from the App version.
 */
export function NavGuardDialog({
  dialogRef,
  onKeepEditing,
  onDiscard,
  title = 'Discard unsaved Grand Project changes?',
  description = 'You have definition text that has not been saved. Leaving Grand Projects will discard those local changes.',
  discardLabel = 'Discard and leave',
  destructive = true,
}: NavGuardDialogProps) {
  const navGuardId = useId();
  return (
    <div className="nav-guard-backdrop">
      <div
        ref={dialogRef}
        className="goal-confirm nav-guard"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${navGuardId}-title`}
        aria-describedby={`${navGuardId}-description`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onKeepEditing();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
          if (!focusable?.length) return;
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          const focusIsInside = dialogRef.current?.contains(document.activeElement) ?? false;
          if (!focusIsInside) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id={`${navGuardId}-title`}>{title}</h2>
        <p id={`${navGuardId}-description`}>{description}</p>
        <div className="goal-control-buttons">
          <button
            type="button"
            className="secondary-button"
            data-confirm-safe
            onClick={() => onKeepEditing()}
          >
            Keep editing
          </button>
          <button
            type="button"
            className={`secondary-button ${destructive ? 'goal-danger' : ''}`.trim()}
            onClick={() => onDiscard()}
          >
            {discardLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

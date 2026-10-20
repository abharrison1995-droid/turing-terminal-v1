import { useId, type RefObject } from 'react';

export interface NavGuardDialogProps {
  /** Owned by App, which focuses the safe action on open and restores the invoker on cancel. */
  dialogRef: RefObject<HTMLDivElement | null>;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * The unsaved Grand Project guard. Rendered only while a navigation is held; App owns the held navigation, the focus
 * bookkeeping and the unsaved flag. Escape, Tab trapping and the button copy are unchanged from the App version.
 */
export function NavGuardDialog({ dialogRef, onKeepEditing, onDiscard }: NavGuardDialogProps) {
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
        <h2 id={`${navGuardId}-title`}>Discard unsaved Grand Project changes?</h2>
        <p id={`${navGuardId}-description`}>
          You have definition text that has not been saved. Leaving Grand Projects will discard those local
          changes.
        </p>
        <div className="goal-control-buttons">
          <button
            type="button"
            className="secondary-button"
            data-confirm-safe
            onClick={() => onKeepEditing()}
          >
            Keep editing
          </button>
          <button type="button" className="secondary-button goal-danger" onClick={() => onDiscard()}>
            Discard and leave
          </button>
        </div>
      </div>
    </div>
  );
}

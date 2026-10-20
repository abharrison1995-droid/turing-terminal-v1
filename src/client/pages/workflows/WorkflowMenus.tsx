import { useRef, type ReactNode } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useDismissibleDetails } from '../shared/useDismissibleDetails';
import { ADD_STAGE_GROUPS, type AddStageOption } from './stageFactory';

/** Grouped list of the existing stage types. Choosing one adds it at the end and opens its editor; nothing else changes. */
export function AddStageMenu({ onAdd }: { onAdd: (option: AddStageOption) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissibleDetails(ref);
  return (
    <details className="stage-menu add-stage-menu" ref={ref}>
      <summary className="secondary-button">
        <Plus size={14} aria-hidden="true" /> Add stage
      </summary>
      <div className="stage-menu-list" role="group" aria-label="Stage types">
        {ADD_STAGE_GROUPS.map((group) => (
          <div className="stage-menu-group" key={group.id} role="group" aria-label={group.label}>
            <p className="stage-menu-heading">{group.label}</p>
            {group.options.map((option) => (
              <button
                type="button"
                className={`stage-menu-item ${option.kind === 'decisionGate' ? 'stage-menu-item-decision' : ''}`}
                key={option.id}
                onClick={() => onAdd(option)}
              >
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Secondary workflow actions (duplicate, import, export), kept out of the primary row. */
export function MoreActionsMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissibleDetails(ref);
  return (
    <details className="stage-menu more-actions-menu" ref={ref}>
      <summary className="quiet-button" aria-label="More workflow actions">
        <MoreHorizontal size={16} aria-hidden="true" /> More
      </summary>
      <div className="stage-menu-list stage-menu-list-narrow">{children}</div>
    </details>
  );
}

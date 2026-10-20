import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export type RunTab = 'activity' | 'changes' | 'details';

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' },
  { id: 'details', label: 'Details' },
];

/**
 * ARIA tabs for one run. Every panel stays mounted and the inactive ones are hidden, so a draft or an open stage inside a
 * panel survives a switch. The fetched run and diff belong to RunDetail, which passes the panel content in.
 */
export function RunWorkspaceTabs({
  tab,
  onSelect,
  panels,
}: {
  tab: RunTab;
  onSelect: (tab: RunTab) => void;
  panels: Record<RunTab, ReactNode>;
}) {
  const buttons = useRef<Record<RunTab, HTMLButtonElement | null>>({
    activity: null,
    changes: null,
    details: null,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = TABS[next]!.id;
    onSelect(id);
    buttons.current[id]?.focus();
  };

  return (
    <div className="run-workspace">
      <div className="run-tabs" role="tablist" aria-label="Run sections">
        {TABS.map((item, index) => {
          const selected = item.id === tab;
          return (
            <button
              key={item.id}
              ref={(node) => {
                buttons.current[item.id] = node;
              }}
              type="button"
              role="tab"
              id={`run-tab-${item.id}`}
              className="run-tab"
              aria-selected={selected}
              aria-controls={`run-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {TABS.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`run-panel-${item.id}`}
          aria-labelledby={`run-tab-${item.id}`}
          className="run-tab-panel"
          hidden={item.id !== tab}
          tabIndex={0}
        >
          {panels[item.id]}
        </div>
      ))}
    </div>
  );
}

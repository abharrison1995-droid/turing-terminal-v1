import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Activity, Plus, RefreshCw } from 'lucide-react';
import { NAV_ITEMS } from './navModel';
import {
  filterPaletteCommands,
  runCommand,
  type PaletteActions,
  type PaletteCommand,
  type PaletteGroup,
} from './commands';

const GROUP_ORDER: readonly PaletteGroup[] = ['Go to', 'Recent runs', 'Data'];

function iconFor(command: PaletteCommand) {
  if (command.kind === 'refresh') return RefreshCw;
  if (command.kind === 'open-run') return Activity;
  if (command.page === 'command') return Plus;
  return NAV_ITEMS.find((item) => item.id === command.page)?.icon ?? Plus;
}

export interface CommandPaletteProps {
  commands: readonly PaletteCommand[];
  actions: PaletteActions;
  /**
   * Closes the palette and restores focus to the invoker. Called before a command runs, so a navigation that the Grand
   * Projects guard holds captures the correct element to return to.
   */
  onClose: () => void;
}

/**
 * Command palette (UI0_SPEC D-6): navigation, "New task", recent runs and a GET-only refresh. It holds no API client
 * and runs commands only through the three PaletteActions it is given.
 */
export function CommandPalette({ commands, actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  const results = filterPaletteCommands(commands, query);
  const current = results.length ? Math.min(active, results.length - 1) : -1;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const run = (command: PaletteCommand) => {
    onClose();
    runCommand(command, actions);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = results.length;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        return;
      case 'ArrowDown':
        if (!count) return;
        event.preventDefault();
        setActive((current + 1) % count);
        return;
      case 'ArrowUp':
        if (!count) return;
        event.preventDefault();
        setActive((current - 1 + count) % count);
        return;
      case 'Home':
        if (!count) return;
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        if (!count) return;
        event.preventDefault();
        setActive(count - 1);
        return;
      case 'Enter': {
        const command = results[current];
        if (!command) return;
        event.preventDefault();
        run(command);
        return;
      }
      case 'Tab': {
        // Focus stays inside the dialog: cycle through its focusable controls, never out to the page behind.
        event.preventDefault();
        const focusable = [
          ...(dialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ??
            []),
        ];
        if (!focusable.length) return;
        const last = focusable.length - 1;
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey) focusable[index <= 0 ? last : index - 1]!.focus();
        else focusable[index === -1 || index === last ? 0 : index + 1]!.focus();
        return;
      }
      default:
        return;
    }
  };

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: results.filter((command) => command.group === group),
  })).filter((entry) => entry.items.length > 0);

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // Focusable so a click on a non-option area keeps focus inside the dialog, where the key handler runs.
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label="Search commands"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          placeholder="Type a command or run"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <div id={listboxId} className="palette-listbox" role="listbox" aria-label="Commands">
          {groups.map(({ group, items }) => (
            <div key={group} className="palette-group" role="group" aria-label={group}>
              <div className="palette-group-label" aria-hidden="true">
                {group}
              </div>
              {items.map((command) => {
                const index = results.indexOf(command);
                const Icon = iconFor(command);
                return (
                  <div
                    key={command.id}
                    id={optionId(index)}
                    className="palette-option"
                    role="option"
                    aria-selected={index === current}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(command)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{command.label}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {results.length === 0 && (
          <p className="palette-empty" role="status">
            No matching commands
          </p>
        )}
        <p className="palette-hint" aria-hidden="true">
          Up and down to move, Enter to run, Esc to close
        </p>
      </div>
    </div>
  );
}

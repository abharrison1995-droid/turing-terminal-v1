import type { RunSummary } from '../../../shared/types';
import type { Page } from '../../pages/shared/types';
import { shortTask } from '../../pages/shared/runStatus';
import { NAV_ITEMS } from './navModel';

/**
 * The static command ids the palette may offer (UI0_SPEC section 14, UI.1c scope section 3). Open-run entries are
 * generated from the recent runs at runtime and are not listed here. Nothing that mutates, restarts, cancels, resumes,
 * approves, pairs, renames, exports or touches a Goal belongs in this list.
 */
export const PALETTE_COMMAND_IDS = [
  'nav-workflows',
  'nav-projects',
  'nav-goals',
  'nav-runs',
  'nav-usage',
  'nav-machines',
  'nav-settings',
  'new-task',
  'refresh-data',
] as const;

export type PaletteCommandId = (typeof PALETTE_COMMAND_IDS)[number];

export type PaletteGroup = 'Go to' | 'Recent runs' | 'Data';

/** Maximum open-run entries shown in the palette. */
export const MAX_RUN_COMMANDS = 5;

export type PaletteCommand =
  | { kind: 'navigate'; id: string; label: string; group: PaletteGroup; page: Page }
  | { kind: 'open-run'; id: string; label: string; group: PaletteGroup; runId: string }
  | { kind: 'refresh'; id: 'refresh-data'; label: string; group: PaletteGroup };

/** The only capabilities a palette command may use. `run` receives nothing else: no API client, no Goal or approval calls. */
export interface PaletteActions {
  navigate: (page: Page) => void;
  openRun: (runId: string) => void;
  refresh: () => void;
}

const NAV_COMMAND_PAGES: ReadonlyArray<{ id: PaletteCommandId; page: Page }> = [
  { id: 'nav-workflows', page: 'workflows' },
  { id: 'nav-projects', page: 'projects' },
  { id: 'nav-goals', page: 'goals' },
  { id: 'nav-runs', page: 'runs' },
  { id: 'nav-usage', page: 'usage' },
  { id: 'nav-machines', page: 'machines' },
  { id: 'nav-settings', page: 'settings' },
];

/**
 * The palette registry, in display order: the seven Workspace destinations, "New task", up to five open runs taken from
 * the sidebar's recent list, then "Refresh data" (a GET of the dashboard and nothing else).
 */
export function buildPaletteCommands(recentRuns: readonly RunSummary[]): PaletteCommand[] {
  const navigation: PaletteCommand[] = NAV_COMMAND_PAGES.map(({ id, page }) => ({
    kind: 'navigate',
    id,
    label: NAV_ITEMS.find((item) => item.id === page)?.label ?? page,
    group: 'Go to',
    page,
  }));
  const newTask: PaletteCommand = {
    kind: 'navigate',
    id: 'new-task',
    label: 'New task',
    group: 'Go to',
    page: 'command',
  };
  const runs: PaletteCommand[] = recentRuns.slice(0, MAX_RUN_COMMANDS).map((run) => ({
    kind: 'open-run',
    id: `open-run:${run.id}`,
    label: `Open run: ${shortTask(run.prompt)}`,
    group: 'Recent runs',
    runId: run.id,
  }));
  const refresh: PaletteCommand = {
    kind: 'refresh',
    id: 'refresh-data',
    label: 'Refresh data',
    group: 'Data',
  };
  return [...navigation, newTask, ...runs, refresh];
}

/** Case-insensitive substring match on the visible label. An empty query matches everything. */
export function filterPaletteCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  return commands.filter((command) => command.label.toLowerCase().includes(needle));
}

/** Runs one command through the three capabilities the palette is given. */
export function runCommand(command: PaletteCommand, actions: PaletteActions): void {
  switch (command.kind) {
    case 'navigate':
      actions.navigate(command.page);
      return;
    case 'open-run':
      actions.openRun(command.runId);
      return;
    case 'refresh':
      actions.refresh();
      return;
  }
}

// @vitest-environment jsdom

// UI.1c RED tests for the command palette (scope section 3, matrix S3, S4, S8). They drive the palette through the App
// shell and assert only keys, DOM roles and focus, so they do not depend on CommandPalette's props.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../../../shared/types';
import { definitionFull, detail, item, openGoal, serve } from '../../goals/testKit';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
vi.mock('../../api', async (importActual) => ({
  ...(await importActual<typeof import('../../api')>()),
  api: {
    dashboard: () => dashboard(),
    providers: vi.fn(),
    addProject: vi.fn(),
    patchProject: vi.fn(),
    refreshProject: vi.fn(),
    refreshProviders: vi.fn(),
    saveWorkflow: vi.fn(),
    duplicateWorkflow: vi.fn(),
    connectionProfiles: vi.fn(async () => ({ profiles: [] })),
    modelPresets: vi.fn(async () => ({ presets: [] })),
    rules: vi.fn(async () => ({ rules: [] })),
    saveRule: vi.fn(),
    deleteRule: vi.fn(),
    previewRun: vi.fn(),
    startRun: vi.fn(),
    run: vi.fn(),
    executionOperations: vi.fn(async () => ({ operations: [] })),
    diff: vi.fn(),
    cancelRun: vi.fn(),
    resumeRun: vi.fn(),
    intervene: vi.fn(),
    decideApproval: vi.fn(),
    usage: vi.fn(async () => Promise.reject(new Error('offline'))),
    usageAnalytics: vi.fn(async () => Promise.reject(new Error('offline'))),
    renameMachine: vi.fn(),
    claimPairing: vi.fn(),
    claimPairingRequest: vi.fn(),
    completePairing: vi.fn(),
    exportWorkflows: vi.fn(),
    budgets: vi.fn(async () => Promise.reject(new Error('offline'))),
    tailscaleReadiness: vi.fn(async () => Promise.reject(new Error('offline'))),
    webPushConfig: vi.fn(async () => Promise.reject(new Error('offline'))),
    usageExportUrl: vi.fn(() => '/api/usage/export'),
  },
}));

import App from '../../App';

const HOME = 'What should we work on?';
const GUARD = 'Discard unsaved Grand Project changes?';
const WORKSPACE = [
  'Workflows',
  'Projects',
  'Grand Projects',
  'Runs & history',
  'Usage',
  'Machines',
  'Settings',
];
const RUNS = [
  {
    id: 'run-1',
    prompt: 'Add importer tests',
    status: 'running',
    projectName: 'Turing Terminal',
    createdAt: '2026-01-02T00:00:00.000Z',
    stages: [],
  },
  {
    id: 'run-2',
    prompt: 'Fix the parser',
    status: 'running',
    projectName: 'Turing Terminal',
    createdAt: '2026-01-01T00:00:00.000Z',
    stages: [],
  },
];

const snapshot = (overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot =>
  ({
    machine: {
      id: 'machine',
      name: 'Development machine',
      hostname: 'dev-host',
      os: 'linux',
      status: 'online',
      lastSeenAt: new Date().toISOString(),
    },
    projects: [],
    workflows: [],
    providers: [],
    runs: [],
    approvals: [],
    usage: {
      events: 0,
      localMinutesToday: 0,
      inputTokens: null,
      outputTokens: null,
      provenance: 'locally observed',
    },
    ...overrides,
  }) as unknown as DashboardSnapshot;

const sidebar = () => within(screen.getByRole('complementary', { name: 'Primary navigation' }));
const dialog = () => screen.queryByRole('dialog', { name: 'Command palette' });
const listbox = () => screen.getByRole('listbox');
const optionNames = () =>
  within(listbox())
    .getAllByRole('option')
    .map((option) => option.textContent?.trim() ?? '');

/** Presses the shortcut on whatever has focus. Returns false when the page prevented the browser default. */
function pressShortcut(init: KeyboardEventInit = { key: 'k', ctrlKey: true }) {
  return fireEvent.keyDown(document.activeElement ?? document.body, init);
}

async function openPalette() {
  pressShortcut();
  return screen.findByRole('dialog', { name: 'Command palette' });
}

function proposedRoutes() {
  const proposed = definitionFull(1, { status: 'proposed', approvedAt: null, approvedBy: null });
  const goal = detail({
    status: 'draft',
    nextAction: { kind: 'approve_definition', version: 1 },
    reasonCode: null,
    currentDefinitionVersion: null,
    needsUser: false,
  });
  const summary = { ...proposed } as Record<string, unknown>;
  for (const key of ['definition', 'validation', 'goalId']) delete summary[key];
  return {
    '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }),
    '/api/goals/goal-1': () => ({ goal }),
    '/api/goals/goal-1/preview': () => ({ preview: {} }),
    '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    '/api/goals/goal-1/definitions': () => ({ definitions: [summary] }),
    '/api/goals/goal-1/definitions/1': () => ({ definition: proposed }),
  };
}

/** Opens Grand Projects on a proposal and types into the definition editor, leaving unsaved work. */
async function openDirtyGoalEditor() {
  serve(proposedRoutes());
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: HOME });
  await user.click(sidebar().getByRole('button', { name: 'Grand Projects' }));
  await openGoal(user);
  await screen.findByLabelText('Next action');
  await user.click(screen.getByRole('tab', { name: 'Definitions' }));
  fireEvent.change(await screen.findByLabelText('Definition JSON'), {
    target: { value: '{"typed": "unsaved"}' },
  });
  await screen.findByText('Unsaved changes');
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
  serve({
    '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
    '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
  });
  dashboard.mockResolvedValue(snapshot({ runs: RUNS as unknown as DashboardSnapshot['runs'] }));
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('opening and closing the palette (section 3 keys)', () => {
  it('Ctrl+K opens a modal "Command palette" dialog, focuses its combobox and prevents the browser default', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    const notPrevented = pressShortcut();

    const opened = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(opened.getAttribute('aria-modal')).toBe('true');
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
  });

  it('Meta+K opens the palette as well', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    pressShortcut({ key: 'k', metaKey: true });

    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });

  it('a second Ctrl+K closes the open palette', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    await openPalette();

    pressShortcut();

    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('Alt, Shift and IME-composing presses do not open it', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    pressShortcut({ key: 'k', ctrlKey: true, altKey: true });
    pressShortcut({ key: 'K', ctrlKey: true, shiftKey: true });
    pressShortcut({ key: 'k', ctrlKey: true, isComposing: true });
    expect(dialog()).toBeNull();

    // Control: the plain shortcut still opens, so the absence above is the modifier rule and not a dead shortcut.
    pressShortcut();
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });
});

describe('combobox and listbox semantics (section 3 aria)', () => {
  it('the input is a combobox controlling a listbox of groups and options, in the registry order', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    await openPalette();

    const combo = screen.getByRole('combobox');
    expect(combo.getAttribute('aria-expanded')).toBe('true');
    expect(combo.getAttribute('aria-autocomplete')).toBe('list');
    const controls = combo.getAttribute('aria-controls');
    expect(controls && document.getElementById(controls)?.getAttribute('role')).toBe('listbox');
    expect(listbox().querySelectorAll('[role="group"]').length).toBeGreaterThan(0);

    const names = optionNames();
    for (const label of WORKSPACE) expect(names.some((name) => name.includes(label))).toBe(true);
    expect(names.some((name) => name.includes('New task'))).toBe(true);
    expect(names.filter((name) => name.startsWith('Open run: '))).toHaveLength(2);
    expect(names.some((name) => name.startsWith('Open run: ') && name.includes('Add importer tests'))).toBe(
      true,
    );
    expect(names).toHaveLength(WORKSPACE.length + 1 + RUNS.length + 1);
    expect(names[names.length - 1]).toContain('Refresh data');
  });

  it('ArrowDown and ArrowUp move aria-activedescendant, ArrowUp wraps, Home and End jump to the ends', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    await openPalette();
    const combo = screen.getByRole('combobox');
    const options = within(listbox()).getAllByRole('option');
    const active = () => combo.getAttribute('aria-activedescendant');

    expect(active()).toBe(options[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(options[1]!.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(active()).toBe(options[options.length - 1]!.id);
    await user.keyboard('{Home}');
    expect(active()).toBe(options[0]!.id);
    await user.keyboard('{End}');
    expect(active()).toBe(options[options.length - 1]!.id);
  });

  it('a query with no match shows the status message "No matching commands" and no options', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    const opened = await openPalette();

    await user.keyboard('zzqx');

    expect(within(opened).getByRole('status').textContent?.trim()).toBe('No matching commands');
    expect(within(opened).queryAllByRole('option')).toHaveLength(0);
  });
});

describe('running commands', () => {
  it('Enter runs the active option: the palette closes and that page opens', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    await openPalette();

    await user.keyboard('usage{Enter}');

    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy();
  });

  it('a page change from the palette moves focus to the new page heading', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    await openPalette();

    await user.keyboard('usage{Enter}');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Usage' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe('closing and focus (matrix S4)', () => {
  it('Esc closes the palette and returns focus to the element that opened it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    const invoker = screen.getByRole('button', { name: 'Notifications' });
    act(() => invoker.focus());
    await openPalette();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(invoker);
  });

  it('Tab and Shift+Tab stay inside the dialog', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    const opened = await openPalette();

    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      expect(opened.contains(document.activeElement)).toBe(true);
    }
    for (let step = 0; step < 3; step += 1) {
      await user.tab({ shift: true });
      expect(opened.contains(document.activeElement)).toBe(true);
    }
  });
});

describe('guard dialog interplay (matrix S3)', () => {
  it('Ctrl+K is ignored while the unsaved-Grand-Project guard is open', async () => {
    const user = await openDirtyGoalEditor();
    await user.click(sidebar().getByRole('button', { name: 'Projects' }));
    await screen.findByRole('alertdialog', { name: GUARD });

    pressShortcut();

    expect(dialog()).toBeNull();
    expect(screen.getByRole('alertdialog', { name: GUARD })).toBeTruthy();

    // Control: once the guard is dismissed the same shortcut opens the palette again.
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: GUARD })).toBeNull());
    pressShortcut();
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });

  it('a palette navigation held by the guard returns focus to the palette invoker on Keep editing', async () => {
    const user = await openDirtyGoalEditor();
    const invoker = screen.getByRole('tab', { name: 'Definitions' });
    act(() => invoker.focus());
    await openPalette();

    await user.keyboard('usage{Enter}');

    await screen.findByRole('alertdialog', { name: GUARD });
    expect(dialog()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(document.activeElement).toBe(invoker));
    expect(screen.getByLabelText('Definition JSON')).toBeTruthy();
  });

  it('Discard and leave from a palette navigation opens the target with its heading focused', async () => {
    const user = await openDirtyGoalEditor();
    await openPalette();

    await user.keyboard('usage{Enter}');
    await screen.findByRole('alertdialog', { name: GUARD });
    await user.click(screen.getByRole('button', { name: 'Discard and leave' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Usage' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole('alertdialog', { name: GUARD })).toBeNull();
  });
});

describe('pairing and the compact trigger', () => {
  it('Ctrl+K does nothing while this device must be paired', async () => {
    dashboard.mockRejectedValue(new Error('Pair this device to continue.'));
    render(<App />);
    await waitFor(() => expect(document.querySelector('.app-shell')).toBeNull());

    pressShortcut();

    expect(dialog()).toBeNull();
  });

  it('on a narrow viewport a trigger advertises Control+K and Meta+K and opens the palette', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media.includes('max-width'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    const trigger = document.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Control+K Meta+K"]');
    expect(trigger?.tagName).toBe('BUTTON');
    await user.click(trigger!);

    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });
});

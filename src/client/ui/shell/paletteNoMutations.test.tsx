// @vitest-environment jsdom

// UI.1c RED tests for matrix S8: running every palette command, from the desktop shortcut and from the compact trigger,
// sends no mutation. Only "Refresh data" reads the dashboard, and it does so once. The dashboard poll is faked so the
// count cannot drift during a run.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../../../shared/types';
import { posts, serve } from '../../goals/testKit';

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

import { api } from '../../api';
import App from '../../App';

const HOME = 'What should the agents do?';

/** Every mock API member that changes state. The palette may call none of them. */
const MUTATING_API = [
  'addProject',
  'patchProject',
  'refreshProject',
  'refreshProviders',
  'saveWorkflow',
  'duplicateWorkflow',
  'saveRule',
  'deleteRule',
  'cancelRun',
  'resumeRun',
  'intervene',
  'decideApproval',
  'renameMachine',
  'claimPairing',
  'claimPairingRequest',
  'completePairing',
  'exportWorkflows',
] as const;

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
    runs: RUNS,
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

const dialog = () => screen.queryByRole('dialog', { name: 'Command palette' });
const optionsOf = () => within(screen.getByRole('listbox')).getAllByRole('option');
const trigger = () => document.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Control+K Meta+K"]');

const openDesktop = async () => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'k', ctrlKey: true });
  await screen.findByRole('dialog', { name: 'Command palette' });
};

const openCompact = async () => {
  const user = userEvent.setup();
  await user.click(trigger()!);
  await screen.findByRole('dialog', { name: 'Command palette' });
};

/** Runs each option in turn, reopening the palette every time, and records how many dashboard reads each one caused. */
async function runEveryCommand(open: () => Promise<void>) {
  await open();
  const labels = optionsOf().map((option) => option.textContent?.trim() ?? '');
  const user = userEvent.setup();
  const reads: Array<{ label: string; dashboardReads: number }> = [];
  // Close the palette used to read the labels; opening again while open would toggle it shut.
  await user.keyboard('{Escape}');
  await waitFor(() => expect(dialog()).toBeNull());
  for (const label of labels) {
    await open();
    const before = dashboard.mock.calls.length;
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: label }));
    await waitFor(() => expect(dialog()).toBeNull());
    reads.push({ label, dashboardReads: dashboard.mock.calls.length - before });
  }
  return { labels, reads };
}

function expectNoMutations() {
  expect(posts()).toEqual([]);
  for (const name of MUTATING_API) {
    const member = (api as unknown as Record<string, { mock: { calls: unknown[] } }>)[name];
    expect(member?.mock.calls, name).toEqual([]);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
  dashboard.mockResolvedValue(snapshot());
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('every palette command is a navigation or a GET refresh (matrix S8)', () => {
  it('from the Ctrl+K shortcut: no mutation, and only "Refresh data" reads the dashboard, once', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    const { labels, reads } = await runEveryCommand(openDesktop);

    expect(labels.length).toBe(11);
    expect(reads.filter((read) => read.dashboardReads > 0)).toEqual([
      { label: 'Refresh data', dashboardReads: 1 },
    ]);
    expectNoMutations();
  });

  it('from the compact trigger: no mutation, and only "Refresh data" reads the dashboard, once', async () => {
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
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    const { labels, reads } = await runEveryCommand(openCompact);

    expect(labels.length).toBe(11);
    expect(reads.filter((read) => read.dashboardReads > 0)).toEqual([
      { label: 'Refresh data', dashboardReads: 1 },
    ]);
    expectNoMutations();
  });

  it('offers no restricted action: no restart, cancel, resume, approval, Goal write, pairing or save', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    await openDesktop();

    const restricted =
      /restart|cancel|resume|approv|decid|intervene|save|delete|create|goal|pair|rename|export|stop|start/i;
    const labels = optionsOf().map((option) => option.textContent?.trim() ?? '');
    const offending = labels.filter((label) => !label.startsWith('Open run: ') && restricted.test(label));
    expect(offending).toEqual([]);
  });
});

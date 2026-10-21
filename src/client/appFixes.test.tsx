// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot, RunSummary } from '../shared/types';
import type { DesktopRuntime } from './desktop';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
const desktopRuntime = vi.fn<() => Promise<DesktopRuntime>>();
const restartMaster = vi.fn<() => Promise<DesktopRuntime>>();
vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      dashboard: () => dashboard(),
      rules: vi.fn(async () => ({ rules: [] })),
      executionOperations: vi.fn(async () => ({ operations: [] })),
      run: vi.fn(async () => ({ effectiveRules: [], decisions: [] })),
      diff: vi.fn(),
    },
  };
});
vi.mock('./desktop', async (importActual) => ({
  ...(await importActual<typeof import('./desktop')>()),
  isDesktopShell: () => true,
  setMasterApiBase: vi.fn(),
  desktop: {
    runtime: () => desktopRuntime(),
    restartMaster: () => restartMaster(),
    setKeepMasterOnClose: vi.fn(),
    setStartAtLogin: vi.fn(),
    openLogFolder: vi.fn(),
    quit: vi.fn(),
  },
}));

import { api } from './api';
import App from './App';
import { setMasterApiBase } from './desktop';

const runtimeFixture = (overrides: Partial<DesktopRuntime> = {}): DesktopRuntime => ({
  status: 'Running',
  version: '1.0.0-rc2',
  port: 4317,
  masterUrl: 'http://127.0.0.1:4317',
  uptimeSeconds: 10,
  startedByApp: true,
  error: null,
  logPath: '/logs/master.log',
  dataPath: '/data',
  keepMasterOnClose: true,
  startAtLogin: false,
  tools: [],
  ...overrides,
});

const snapshot = (runs: RunSummary[]): DashboardSnapshot =>
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
    runs,
    approvals: [],
    usage: {
      events: 0,
      localMinutesToday: 0,
      inputTokens: null,
      outputTokens: null,
      provenance: 'locally observed',
    },
  }) as unknown as DashboardSnapshot;

const runFixture = (overrides: Partial<RunSummary>): RunSummary => ({
  id: 'run-1',
  machineId: 'machine',
  projectId: 'project-1',
  projectName: 'Project',
  workflowId: 'workflow-1',
  workflowName: 'Workflow',
  prompt: 'Stop control task',
  profile: 'economy',
  permissionMode: 'normal',
  refinePrompt: false,
  status: 'running',
  branch: null,
  worktreePath: null,
  summary: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  stages: [],
  elapsedMs: 0,
  remainingMs: null,
  cancellable: true,
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.mocked(setMasterApiBase).mockClear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('desktop Master restart from settings', () => {
  let restarted = false;
  beforeEach(() => {
    restarted = false;
    dashboard.mockResolvedValue(snapshot([]));
    desktopRuntime.mockImplementation(async () =>
      runtimeFixture(restarted ? { masterUrl: 'http://127.0.0.1:4999', port: 4999 } : {}),
    );
    restartMaster.mockImplementation(async () => {
      restarted = true;
      return runtimeFixture({ masterUrl: 'http://127.0.0.1:4999', port: 4999 });
    });
  });

  const openSettingsAndRestart = async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await within(screen.getByRole('navigation', { name: 'Workspace' })).findByRole('button', {
        name: 'Settings',
      }),
    );
    await user.click(await screen.findByRole('button', { name: /Restart Master/ }));
  };

  it('applies the master URL returned by the restart before refreshing status', async () => {
    await openSettingsAndRestart();
    await waitFor(() => expect(setMasterApiBase).toHaveBeenCalledWith('http://127.0.0.1:4999'));
    const applied = vi.mocked(setMasterApiBase).mock.invocationCallOrder[0]!;
    await waitFor(() => {
      const lastStatusRead = desktopRuntime.mock.invocationCallOrder.at(-1)!;
      expect(lastStatusRead).toBeGreaterThan(applied);
    });
  });

  it('reads the runtime first when the restart returns none, then applies its master URL', async () => {
    restartMaster.mockImplementation(async () => {
      restarted = true;
      return undefined as unknown as DesktopRuntime;
    });
    await openSettingsAndRestart();
    await waitFor(() => expect(setMasterApiBase).toHaveBeenCalledWith('http://127.0.0.1:4999'));
  });
});

describe('run detail state', () => {
  it('clears the diff and intervention draft when another run is selected', async () => {
    dashboard.mockResolvedValue(
      snapshot([
        runFixture({ id: 'run-a', prompt: 'First task', status: 'running' }),
        runFixture({ id: 'run-b', prompt: 'Second task', status: 'running' }),
      ]),
    );
    vi.mocked(api.diff).mockResolvedValue({
      diff: 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
      truncated: false,
      cwd: '/repo',
    });
    const user = userEvent.setup();
    render(<App />);
    const tasks = within(await screen.findByRole('navigation', { name: 'Tasks' }));
    await user.click(await tasks.findByRole('button', { name: /First task/ }));
    await user.click(await screen.findByRole('button', { name: 'View diff' }));
    expect((await screen.findAllByText(/file\.ts/)).length).toBeGreaterThan(0);
    await user.type(screen.getByPlaceholderText(/Add a constraint/), 'Keep the public API stable');

    await user.click(tasks.getByRole('button', { name: /Second task/ }));
    await waitFor(() => expect(screen.queryAllByText(/file\.ts/)).toHaveLength(0));
    expect((screen.getByPlaceholderText(/Add a constraint/) as HTMLTextAreaElement).value).toBe('');
  });
});

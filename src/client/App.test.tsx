// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot, RunSummary } from '../shared/types';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
const claimPairing = vi.fn();
const completePairing = vi.fn();
const claimPairingRequest = vi.fn();
vi.mock('./api', async (importActual) => ({
  ...(await importActual<typeof import('./api')>()),
  api: {
    dashboard: () => dashboard(),
    providers: vi.fn(),
    addProject: vi.fn(),
    patchProject: vi.fn(),
    refreshProject: vi.fn(),
    saveWorkflow: vi.fn(),
    duplicateWorkflow: vi.fn(),
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
    usage: vi.fn(),
    renameMachine: vi.fn(),
    claimPairing: (...args: unknown[]) => claimPairing(...args),
    claimPairingRequest: (...args: unknown[]) => claimPairingRequest(...args),
    completePairing: (...args: unknown[]) => completePairing(...args),
    exportWorkflows: vi.fn(),
  },
}));

import { api } from './api';
import App from './App';

describe('Turing Terminal shell', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    dashboard.mockResolvedValue({
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
    });
  });

  it('loads the command center and navigates to project setup', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'What should the agents do?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add project/ })).toBeTruthy();
  });

  it('opens the Grand Projects area from navigation without disturbing other pages', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ goals: [], total: 0, limit: 50 }), { status: 200 })),
    );
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(
      within(screen.getByRole('complementary', { name: 'Primary navigation' })).getByRole('button', {
        name: 'Grand Projects',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Grand Projects' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
  });

  it('counts Goal approvals in the bell and nav once, and lists them with their source', async () => {
    const base = await dashboard();
    dashboard.mockResolvedValue({
      ...base,
      approvals: [],
      goals: { active: 1, needsUser: 1, total: 1 },
      goalApprovals: { pending: 2, approvals: [] },
    } as unknown as DashboardSnapshot);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            approvals: [
              {
                source: 'goal',
                id: 'ga-1',
                goalId: 'g1',
                title: 'each_cycle',
                gate: 'each_cycle',
                reason: 'Next cycle',
                risk: 'medium',
                status: 'pending',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                source: 'goal',
                id: 'ga-2',
                goalId: 'g1',
                title: 'final_acceptance',
                gate: 'final_acceptance',
                reason: 'Accept',
                risk: 'high',
                status: 'pending',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            total: 2,
            limit: 20,
          }),
          { status: 200 },
        );
      }),
    );
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    expect(await screen.findByLabelText('2 pending approvals')).toBeTruthy();
    expect(screen.getAllByLabelText('2 Goal approvals pending')).toHaveLength(1);
    expect(await screen.findAllByText('Goal gate')).toHaveLength(2);
    expect(urls.some((url) => url.includes('/api/approvals/unified'))).toBe(true);
  });

  it('shows a pairing gate instead of workspace data until the phone is approved', async () => {
    const user = userEvent.setup();
    dashboard.mockRejectedValue(new Error('Pair this device with the desktop before using it.'));
    claimPairing.mockResolvedValue({ requestId: 'pair-request', status: 'awaiting_desktop_approval' });
    completePairing.mockResolvedValue({ status: 'waiting_for_desktop_approval' });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Connect this device' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'What should the agents do?' })).toBeNull();
    await user.type(screen.getByLabelText('Pairing code'), '0123456789abcdef');
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    expect(await screen.findByText(/Waiting for desktop approval/)).toBeTruthy();
    expect(claimPairing).toHaveBeenCalledWith('0123456789ABCDEF', 'My phone');
  });

  it('claims a QR pairing request and removes its UUID from the browser address', async () => {
    const user = userEvent.setup();
    const requestId = 'b6d4143b-0c1d-4c58-87c3-d8202c8c2ad1';
    window.history.pushState({}, '', `/?pairRequest=${requestId}`);
    dashboard.mockRejectedValue(new Error('Pair this device with the desktop before using it.'));
    claimPairingRequest.mockResolvedValue({ requestId, status: 'awaiting_desktop_approval' });
    completePairing.mockResolvedValue({ status: 'waiting_for_desktop_approval' });
    render(<App />);

    expect(await screen.findByText(/QR pairing request detected/)).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(''));
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    expect(claimPairingRequest).toHaveBeenCalledWith(requestId, 'My phone');
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  describe('Stop control', () => {
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
      status: 'queued',
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
    const openRun = async (run: RunSummary) => {
      const base = await dashboard();
      dashboard.mockResolvedValue({ ...base, runs: [run] });
      vi.mocked(api.run).mockRejectedValue(new Error('offline'));
      vi.stubGlobal(
        'EventSource',
        class {
          addEventListener() {}
          close() {}
        },
      );
      const user = userEvent.setup();
      render(<App />);
      await user.click(
        await within(screen.getByRole('navigation', { name: 'Tasks' })).findByRole('button', {
          name: /Stop control task/,
        }),
      );
      return user;
    };

    it('reports a cancelled queued run as one that will not start', async () => {
      const user = await openRun(runFixture({ status: 'queued' }));
      vi.mocked(api.cancelRun).mockResolvedValue({ accepted: true, status: 'cancelled' });
      await user.click(await screen.findByRole('button', { name: 'Stop run' }));
      expect(await screen.findByText('Queued run cancelled. It will not start.')).toBeTruthy();
    });

    it('reports a stop of an executing run as a provider termination', async () => {
      const user = await openRun(runFixture({ status: 'running' }));
      vi.mocked(api.cancelRun).mockResolvedValue({ accepted: true });
      await user.click(await screen.findByRole('button', { name: 'Stop run' }));
      expect(
        await screen.findByText('Stop requested. The provider process is being terminated.'),
      ).toBeTruthy();
    });

    it('hides Stop for an active run the server marks not cancellable', async () => {
      await openRun(runFixture({ status: 'queued', cancellable: false }));
      expect(await screen.findByRole('button', { name: /All runs/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
    });
  });

  it('saves a second master profile without saving any authentication token', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(
      within(screen.getByRole('complementary', { name: 'Primary navigation' })).getByRole('button', {
        name: 'Machines',
      }),
    );

    expect(await screen.findByText('Development machine · selected')).toBeTruthy();
    await user.type(screen.getByLabelText('Machine name'), 'Build desktop');
    await user.type(screen.getByLabelText('Serve address'), 'https://build-desktop.tailnet.ts.net');
    await user.click(screen.getByRole('button', { name: 'Save machine profile' }));

    expect(await screen.findByText('Build desktop')).toBeTruthy();
    expect(window.localStorage.getItem('turing-terminal.machine-profiles.v1')).toContain(
      'build-desktop.tailnet.ts.net',
    );
    expect(window.localStorage.getItem('turing-terminal.machine-profiles.v1')).not.toContain('token');
  });
});

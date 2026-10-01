// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../shared/types';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
const claimPairing = vi.fn();
const completePairing = vi.fn();
const claimPairingRequest = vi.fn();
vi.mock('./api', () => ({
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

    expect(await screen.findByRole('heading', { name: 'Command Center' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add project/ })).toBeTruthy();
  });

  it('shows a pairing gate instead of workspace data until the phone is approved', async () => {
    const user = userEvent.setup();
    dashboard.mockRejectedValue(new Error('Pair this device with the desktop before using it.'));
    claimPairing.mockResolvedValue({ requestId: 'pair-request', status: 'awaiting_desktop_approval' });
    completePairing.mockResolvedValue({ status: 'waiting_for_desktop_approval' });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Connect this device' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Command Center' })).toBeNull();
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

  it('saves a second master profile without saving any authentication token', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Command Center' });
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

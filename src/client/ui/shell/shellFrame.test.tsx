// @vitest-environment jsdom

// UI.1c RED tests for the responsive frame and the states around it (scope sections 1, 2, matrix S4 and S7). The stale
// banner and machine-rail cases use fake timers for the 6s dashboard poll only, so no test waits in real time.

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../../../shared/types';
import { serve } from '../../goals/testKit';
import { ErrorState } from '../../pages/shared/parts';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
vi.mock('../../api', async (importActual) => ({
  ...(await importActual<typeof import('../../api')>()),
  api: {
    dashboard: () => dashboard(),
    providers: vi.fn(),
    rules: vi.fn(async () => ({ rules: [] })),
    executionOperations: vi.fn(async () => ({ operations: [] })),
    run: vi.fn(),
    usage: vi.fn(async () => Promise.reject(new Error('offline'))),
    usageAnalytics: vi.fn(async () => Promise.reject(new Error('offline'))),
    budgets: vi.fn(async () => Promise.reject(new Error('offline'))),
    tailscaleReadiness: vi.fn(async () => Promise.reject(new Error('offline'))),
    webPushConfig: vi.fn(async () => Promise.reject(new Error('offline'))),
    usageExportUrl: vi.fn(() => '/api/usage/export'),
  },
}));

import App from '../../App';

const HOME = 'What should the agents do?';

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

const workspaceNav = () => within(screen.getByRole('navigation', { name: 'Workspace' }));
const railText = () => document.querySelector('.machine-rail')?.textContent ?? '';
const mainArea = () => document.querySelector('.app-main');

beforeEach(() => {
  window.localStorage.clear();
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

describe('loading and first-load failure (matrix S7)', () => {
  it('while the first dashboard request is pending, Loading is a polite status region', async () => {
    dashboard.mockReturnValue(new Promise<DashboardSnapshot>(() => {}));

    render(<App />);

    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Connecting to the local master');
  });

  it('a first-load failure shows an ErrorState alert in the main area with the message and Retry, and no banner', async () => {
    dashboard.mockRejectedValue(new Error('The desktop master is unavailable.'));

    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The desktop master is unavailable.');
    within(alert).getByRole('button', { name: /Retry/ });
    expect(alert.closest('.app-main')).not.toBeNull();
    expect(document.querySelector('.global-error')).toBeNull();
    expect(screen.queryByText('Showing last known data')).toBeNull();
    expect(screen.queryByRole('heading', { name: HOME })).toBeNull();
  });

  it('Retry on a first-load failure requests the dashboard again and renders the page on success', async () => {
    const user = userEvent.setup();
    dashboard.mockRejectedValueOnce(new Error('The desktop master is unavailable.'));
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Retry/ }));

    expect(await screen.findByRole('heading', { name: HOME })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(dashboard.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('ErrorState is an alert that shows its message and calls onRetry from its Retry button', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="The desktop master is unavailable." onRetry={onRetry} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The desktop master is unavailable.');
    await user.click(within(alert).getByRole('button', { name: /Retry/ }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('stale data after a failed refresh (matrix S7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  /** Lets the 6s poll fire once, which triggers the failing refresh. Asserts the poll ran, so timer setup cannot pass silently. */
  async function pollOnce() {
    const before = dashboard.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(dashboard.mock.calls.length).toBe(before + 1);
  }

  it('a failed refresh after a success keeps the last snapshot under "Showing last known data" with Retry', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    dashboard.mockRejectedValue(new Error('The desktop master stopped responding.'));

    await pollOnce();

    expect(await screen.findByText('Showing last known data')).toBeTruthy();
    expect(screen.getByRole('heading', { name: HOME })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart Master' })).toBeNull();
  });

  it('the desktop shell keeps Restart Master on the stale banner', async () => {
    vi.stubGlobal('isTauri', true);
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    dashboard.mockRejectedValue(new Error('The desktop master stopped responding.'));

    await pollOnce();

    expect(await screen.findByText('Showing last known data')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart Master' })).toBeTruthy();
  });

  it('the machine rail reads Online while connected and Unavailable after a failed refresh', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    expect(railText()).toMatch(/Online/);

    dashboard.mockRejectedValue(new Error('The desktop master stopped responding.'));
    await pollOnce();

    expect(await screen.findByText('Showing last known data')).toBeTruthy();
    expect(railText()).toMatch(/Unavailable/);
    expect(railText()).not.toMatch(/Online/);
  });
});

describe('narrow-viewport drawer (matrix S4)', () => {
  it('the hamburger reports aria-expanded, controls the sidebar, and opens it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    const menu = screen.getByRole('button', { name: /open navigation/i });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    const panelId = menu.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId!);
    expect(panel?.tagName).toBe('ASIDE');

    await user.click(menu);

    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(panel!.classList.contains('sidebar-open')).toBe(true);
  });

  it('while the drawer is open the main area is inert', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });

    await user.click(screen.getByRole('button', { name: /open navigation/i }));

    expect(mainArea()?.hasAttribute('inert')).toBe(true);
  });

  it('Esc closes the drawer, lifts inert and returns focus to the hamburger', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    const menu = screen.getByRole('button', { name: /open navigation/i });
    await user.click(menu);
    act(() => workspaceNav().getByRole('button', { name: 'Usage' }).focus());

    await user.keyboard('{Escape}');

    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(mainArea()?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(menu);
  });
});

// @vitest-environment jsdom

// UI.1c review fixes, kept apart from the earlier shell suites: Restart Master on a first-load failure, one main
// landmark for the loading and error states, palette focus and pairing, the compact drawer on resize, and combobox ARIA.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../../../shared/types';
import { serve } from '../../goals/testKit';
import { ErrorState } from '../../pages/shared/parts';
import { CommandPalette } from './CommandPalette';
import { buildPaletteCommands, type PaletteActions } from './commands';

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

const restartMaster = vi.hoisted(() => vi.fn(async () => ({ masterUrl: 'http://localhost:3000' })));
vi.mock('../../desktop', async (importActual) => {
  const actual = await importActual<typeof import('../../desktop')>();
  return { ...actual, desktop: { ...actual.desktop, restartMaster } };
});

// The pairing page is replaced by a stub that completes pairing on click, so the test can return to the shell.
vi.mock('../../pages/DevicePairingPage', async () => {
  const { createElement } = await import('react');
  return {
    DevicePairingPage: ({ onPaired }: { onPaired: () => void }) =>
      createElement('button', { type: 'button', onClick: () => onPaired() }, 'Pairing stub'),
  };
});

import App from '../../App';

const HOME = 'What should we work on?';
const PALETTE = 'Command palette';

const snapshot = (): DashboardSnapshot =>
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
  }) as unknown as DashboardSnapshot;

const mainCount = () => document.querySelectorAll('main').length;
const mainArea = () => document.querySelector('.app-main');

beforeEach(() => {
  window.localStorage.clear();
  serve({
    '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
    '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
  });
  dashboard.mockReset();
  dashboard.mockResolvedValue(snapshot());
  restartMaster.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('first-load failure keeps Restart Master in the desktop shell (review 1)', () => {
  it('ErrorState shows no Restart Master without onRestart, and calls it when given', async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    const { unmount } = render(<ErrorState message="Down." onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Restart Master' })).toBeNull();
    unmount();

    render(<ErrorState message="Down." onRetry={() => {}} onRestart={onRestart} />);
    await user.click(screen.getByRole('button', { name: 'Restart Master' }));

    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('the desktop shell offers Restart Master on a first-load failure, and recovers when the master comes back', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('isTauri', true);
    dashboard.mockReset();
    dashboard.mockRejectedValueOnce(new Error('The desktop master is unavailable.'));
    dashboard.mockResolvedValue(snapshot());
    render(<App />);

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Restart Master' }));

    expect(restartMaster).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { name: HOME })).toBeTruthy();
  });

  it('the browser shell does not offer Restart Master on a first-load failure', async () => {
    dashboard.mockReset();
    dashboard.mockRejectedValue(new Error('The desktop master is unavailable.'));
    render(<App />);

    const alert = await screen.findByRole('alert');

    expect(within(alert).queryByRole('button', { name: 'Restart Master' })).toBeNull();
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeTruthy();
  });
});

describe('loading and error states sit in one main landmark (review 2)', () => {
  it('while the first dashboard request is pending, the status region is inside the only main', async () => {
    dashboard.mockReset();
    dashboard.mockReturnValue(new Promise<DashboardSnapshot>(() => {}));
    render(<App />);

    const status = await screen.findByRole('status');

    expect(mainCount()).toBe(1);
    expect(status.closest('main')).not.toBeNull();
    expect(status.closest('.app-main')).not.toBeNull();
  });

  it('a first-load failure keeps one main, with the alert inside it and the title as the page h1', async () => {
    dashboard.mockReset();
    dashboard.mockRejectedValue(new Error('The desktop master is unavailable.'));
    render(<App />);

    const alert = await screen.findByRole('alert');

    expect(mainCount()).toBe(1);
    expect(alert.closest('main')).not.toBeNull();
    expect(mainArea()?.querySelector('h1')?.textContent).toBe('Could not load the workspace');
  });

  it('ErrorState on its own is a main landmark with the alert inside it', () => {
    render(<ErrorState message="Down." onRetry={() => {}} />);

    expect(mainCount()).toBe(1);
    expect(screen.getByRole('alert').closest('main')).not.toBeNull();
  });
});

describe('command palette focus and pairing (review 3 and 4)', () => {
  const actions: PaletteActions = { navigate: vi.fn(), openRun: vi.fn(), refresh: vi.fn() };

  it('a click on a non-option area keeps focus in the dialog, so Esc still closes it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette commands={buildPaletteCommands([])} actions={actions} onClose={onClose} />);

    await user.click(document.querySelector<HTMLElement>('.palette-hint')!);
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a palette open when this device must be paired is closed, and does not reappear after pairing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: PALETTE })).toBeTruthy();

    // The 6s poll fails with a pairing error, which swaps the shell for the pairing page.
    dashboard.mockRejectedValue(new Error('Pair this device to continue.'));
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(await screen.findByRole('button', { name: 'Pairing stub' })).toBeTruthy();

    dashboard.mockResolvedValue(snapshot());
    fireEvent.click(screen.getByRole('button', { name: 'Pairing stub' }));

    expect(await screen.findByRole('heading', { name: HOME })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: PALETTE })).toBeNull();
  });
});

describe('the compact drawer closes when the viewport widens (review 5)', () => {
  it('widening past the compact breakpoint closes the open drawer and lifts inert from the main area', async () => {
    const user = userEvent.setup();
    let compact = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (media: string) => ({
      get matches() {
        return media === '(max-width: 680px)' && compact;
      },
      media,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    }));
    render(<App />);
    await screen.findByRole('heading', { name: HOME });
    const menu = screen.getByRole('button', { name: /open navigation/i });
    await user.click(menu);
    expect(mainArea()?.hasAttribute('inert')).toBe(true);

    compact = false;
    act(() => listeners.forEach((listener) => listener()));

    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(mainArea()?.hasAttribute('inert')).toBe(false);
  });
});

describe('combobox ARIA follows the results (review 6)', () => {
  const actions: PaletteActions = { navigate: vi.fn(), openRun: vi.fn(), refresh: vi.fn() };

  it('with no matching command the combobox is collapsed and points at no listbox or option', async () => {
    const user = userEvent.setup();
    render(<CommandPalette commands={buildPaletteCommands([])} actions={actions} onClose={() => {}} />);
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBeTruthy();

    await user.type(input, 'zzzzqqq');

    expect(screen.getByText('No matching commands')).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-controls')).toBe(false);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
});

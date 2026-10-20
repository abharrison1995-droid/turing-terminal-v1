// @vitest-environment jsdom

// Characterization of the App shell (navigation, topbar, notifications, deep links and the
// Workflow Studio mobile default). These cases pin the current observable behaviour so the page
// components can move out of App.tsx without changing what a user sees. They are not a spec.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot, WorkflowDefinition } from '../shared/types';
import { item, serve } from './goals/testKit';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
vi.mock('./api', async (importActual) => ({
  ...(await importActual<typeof import('./api')>()),
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
    // Settings and Usage read these on mount. They reject so each page's own error path runs.
    budgets: vi.fn(async () => Promise.reject(new Error('offline'))),
    tailscaleReadiness: vi.fn(async () => Promise.reject(new Error('offline'))),
    webPushConfig: vi.fn(async () => Promise.reject(new Error('offline'))),
    usageExportUrl: vi.fn(() => '/api/usage/export'),
  },
}));

import App from './App';
import { resetWorkflowDraftStore } from './pages/workflows/draftStore';

const WORKSPACE_NAV = [
  'Workflows',
  'Projects',
  'Grand Projects',
  'Runs & history',
  'Usage',
  'Machines',
  'Settings',
] as const;

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

// Minimal workflow: enough for the Workflow Studio to render its sections.
const WORKFLOW = {
  id: 'standard-dev-loop',
  name: 'Standard dev loop',
  description: 'Plan, implement and review.',
  template: 'standard-dev-loop',
  executionProfile: 'balanced',
  permissionMode: 'normal',
  promptRefinementDefault: false,
  maxRemediationRounds: 1,
  maxParallelAgents: 1,
  maxDurationMinutes: 30,
  retryPolicy: { maxAttempts: 1 },
  isolatedWorktree: false,
  subscriptionOnly: true,
  billingMode: 'subscriptions-only',
  meteredBudget: {},
  externalDecisionDataPolicy: 'block',
  lockProviders: false,
  contextPolicy: {
    strategy: 'balanced',
    maxFiles: 20,
    maxEstimatedTokens: 20000,
    maxFileBytes: 200000,
    includeGlobs: [],
    excludeGlobs: [],
    includeCurrentDiff: false,
    includeTestOutput: false,
    includeBuildOutput: false,
    includePreviousArtifact: false,
    includePreviousTranscript: false,
    onLimitExceeded: 'compact',
  },
  stages: [{ id: 'plan', label: 'Plan', kind: 'planner' }],
  version: 1,
} as unknown as WorkflowDefinition;

/** Stubs matchMedia so only the mobile studio breakpoint answers; other queries never match. */
function stubNarrowViewport(narrow: boolean) {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: narrow && media === '(max-width: 680px)',
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const workspaceNav = () => within(screen.getByRole('navigation', { name: 'Workspace' }));
const sidebar = () => within(screen.getByRole('complementary', { name: 'Primary navigation' }));
const topbarTitle = () => document.querySelector('.topbar-title')?.textContent;
const currentWorkspaceItems = () =>
  workspaceNav()
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-current') === 'page')
    .map((button) => button.textContent?.trim());

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetWorkflowDraftStore();
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  dashboard.mockResolvedValue(snapshot());
});

describe('App shell navigation', () => {
  it('lists the Workspace destinations in order, with no Reviews, Overview or Home entry', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });

    const names = workspaceNav()
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());
    expect(names).toEqual([...WORKSPACE_NAV]);
    for (const removed of ['Reviews', 'Overview', 'Home']) {
      expect(workspaceNav().queryByRole('button', { name: removed })).toBeNull();
    }
    expect(sidebar().getByRole('button', { name: 'Turing Terminal home' })).toBeTruthy();
    expect(sidebar().getByRole('button', { name: 'New task' })).toBeTruthy();
  });

  it('starts on the command page with no nav item marked current and the New task title', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'What should the agents do?' })).toBeTruthy();
    expect(currentWorkspaceItems()).toEqual([]);
    expect(
      sidebar()
        .queryAllByRole('button')
        .filter((b) => b.hasAttribute('aria-current')),
    ).toEqual([]);
    expect(topbarTitle()).toBe('New task');
  });

  it.each([
    ['Workflows', 'Workflows'],
    ['Projects', 'Projects'],
    ['Grand Projects', 'Grand Projects'],
    ['Runs & history', 'Runs & history'],
    ['Usage', 'Usage'],
    ['Machines', 'Machines'],
    ['Settings', 'Settings'],
  ])(
    '%s marks only itself current, retitles the topbar and shows its page heading',
    async (label, heading) => {
      serve({
        '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
        '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
      });
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('heading', { name: 'What should the agents do?' });

      await user.click(workspaceNav().getByRole('button', { name: label }));

      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
      expect(currentWorkspaceItems()).toEqual([label]);
      expect(topbarTitle()).toBe(label);
      expect(screen.queryByRole('heading', { name: 'What should the agents do?' })).toBeNull();
    },
  );

  it('New task and the brand button both return to the command page heading', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });

    await user.click(workspaceNav().getByRole('button', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();

    await user.click(sidebar().getByRole('button', { name: 'New task' }));
    expect(await screen.findByRole('heading', { name: 'What should the agents do?' })).toBeTruthy();
    expect(currentWorkspaceItems()).toEqual([]);
    expect(topbarTitle()).toBe('New task');

    await user.click(workspaceNav().getByRole('button', { name: 'Usage' }));
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeTruthy();
    await user.click(sidebar().getByRole('button', { name: 'Turing Terminal home' }));
    expect(await screen.findByRole('heading', { name: 'What should the agents do?' })).toBeTruthy();
    expect(topbarTitle()).toBe('New task');
  });

  it('the notifications bell opens Runs & history and marks that nav item current', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });

    await user.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('heading', { name: 'Runs & history' })).toBeTruthy();
    expect(currentWorkspaceItems()).toEqual(['Runs & history']);
    expect(topbarTitle()).toBe('Runs & history');
  });
});

describe('App shell deep links', () => {
  it('a Grand Projects notification URL opens that page, marks it current and removes only its parameters', async () => {
    window.history.replaceState({}, '', '/?page=goals&goalId=goal-1&pairRequest=pair-token');
    serve({
      '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }),
      '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Grand Projects' })).toBeTruthy();
    expect(currentWorkspaceItems()).toEqual(['Grand Projects']);
    expect(topbarTitle()).toBe('Grand Projects');
    expect(screen.queryByRole('heading', { name: 'What should the agents do?' })).toBeNull();
    await waitFor(() => expect(window.location.search).toBe('?pairRequest=pair-token'));
  });
});

// The long accordion form (Basics, Safety, Agents, Context, Generation) was replaced by a compact stage list plus named
// secondary settings panels (provider and workflow redesign). Same observable contract, new presentation: on a phone and
// on a wide screen alike, the stage sequence is in the foreground, no stage editor is expanded by default, and the
// detailed settings panels start closed. Full behaviour coverage lives in pages/WorkflowsPage.test.tsx.
describe('Workflow Studio defaults', () => {
  const openWorkflows = async (narrow: boolean) => {
    stubNarrowViewport(narrow);
    dashboard.mockResolvedValue(snapshot({ workflows: [WORKFLOW] }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(workspaceNav().getByRole('button', { name: 'Workflows' }));
    expect(await screen.findByRole('heading', { name: 'Workflow Studio' })).toBeTruthy();
  };
  const stageToggles = () =>
    screen.getAllByRole('button').filter((button) => button.classList.contains('stage-row-toggle'));

  it.each([
    ['a narrow viewport', true],
    ['a wide viewport', false],
  ])(
    'on %s lists the stages collapsed and keeps the detailed settings panels closed',
    async (_name, narrow) => {
      await openWorkflows(narrow);

      expect(stageToggles().length).toBeGreaterThan(0);
      expect(stageToggles().every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true);
      for (const name of [
        'Safety and billing',
        'Retry and limits',
        'Context',
        'Generation defaults',
        'Instructions',
      ]) {
        const panel = screen.getByText(name, { selector: '.workflow-setting-name' }).closest('details');
        expect(panel, name).toBeTruthy();
        expect(panel!.open, name).toBe(false);
      }
      expect(screen.getByRole('button', { name: 'Save workflow' })).toHaveProperty('disabled', true);
    },
  );
});

// Workflow drafts live outside the page so a trip to Settings (to set up a provider) and back loses nothing, while
// leaving the editor for any other page asks first. Behaviour of the editor itself is in pages/WorkflowsPage.test.tsx.
describe('Workflow editor, unsaved drafts and the Settings handoff', () => {
  const openWorkflows = async () => {
    stubNarrowViewport(false);
    dashboard.mockResolvedValue(snapshot({ workflows: [WORKFLOW] }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(workspaceNav().getByRole('button', { name: 'Workflows' }));
    await screen.findByRole('heading', { name: 'Workflow Studio' });
    return user;
  };
  const rename = async (user: Awaited<ReturnType<typeof openWorkflows>>, value: string) => {
    const input = screen.getByRole('textbox', { name: 'Workflow name' });
    await user.clear(input);
    await user.type(input, value);
  };

  it('asks before leaving with unsaved edits, and Keep editing leaves everything as it was', async () => {
    const user = await openWorkflows();
    await rename(user, 'Edited in place');

    await user.click(workspaceNav().getByRole('button', { name: 'Projects' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Leave Workflow Studio with unsaved changes?',
    });
    await user.click(within(dialog).getByRole('button', { name: /keep editing/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe(
      'Edited in place',
    );
  });

  it('does not prompt when nothing is unsaved', async () => {
    const user = await openWorkflows();

    await user.click(workspaceNav().getByRole('button', { name: 'Projects' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
  });

  it('opens Providers & connections from a stage, then returns to the same unsaved draft without a prompt', async () => {
    const user = await openWorkflows();
    await rename(user, 'Draft kept across Settings');
    await user.click(
      within(screen.getByRole('list', { name: 'Stages' })).getByRole('button', { name: /^Plan/ }),
    );

    await user.click(screen.getByRole('button', { name: /Set up providers/ }));

    expect(await screen.findByRole('heading', { name: 'Providers & connections' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Your workflow draft is kept')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back to Workflows' }));

    expect(await screen.findByRole('heading', { name: 'Workflow Studio' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe(
      'Draft kept across Settings',
    );
  });
});

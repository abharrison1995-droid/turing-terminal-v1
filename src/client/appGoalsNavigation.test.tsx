// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../shared/types';
import { calls, definitionFull, detail, item, openGoal, posts, serve, type Routes } from './goals/testKit';

const dashboard = vi.fn<() => Promise<DashboardSnapshot>>();
vi.mock('./api', async (importActual) => ({
  ...(await importActual<typeof import('./api')>()),
  api: {
    dashboard: () => dashboard(),
    providers: vi.fn(),
    rules: vi.fn(async () => ({ rules: [] })),
    executionOperations: vi.fn(async () => ({ operations: [] })),
    run: vi.fn(),
    usage: vi.fn(),
  },
}));

import App from './App';

const base = (projects: unknown[]): DashboardSnapshot =>
  ({
    machine: {
      id: 'machine',
      name: 'Development machine',
      hostname: 'dev-host',
      os: 'linux',
      status: 'online',
      lastSeenAt: new Date().toISOString(),
    },
    projects,
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

const PROJECT = {
  id: 'project-1',
  name: 'Turing Terminal',
  path: '/p/project-1',
  gitRoot: '/p/project-1',
  branch: 'main',
  dirty: false,
  packageManager: 'npm',
  languages: [],
  frameworks: [],
  buildCommand: null,
  testCommand: null,
  lintCommand: null,
  readmePath: null,
  instructionFiles: [],
  machineId: 'machine',
  createdAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
  dashboard.mockResolvedValue(base([PROJECT]));
});

const nav = () => within(screen.getByRole('complementary', { name: 'Primary navigation' }));
const guardTitle = 'Discard unsaved Grand Project changes?';

function proposedRoutes(): Routes {
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

async function openDirtyEditor() {
  serve(proposedRoutes());
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'What should the agents do?' });
  await user.click(nav().getByRole('button', { name: 'Grand Projects' }));
  await openGoal(user);
  await screen.findByLabelText('Next action');
  await user.click(screen.getByRole('tab', { name: 'Definitions' }));
  const editor = (await screen.findByLabelText('Definition JSON')) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: '{"typed": "unsaved"}' } });
  await screen.findByText('Unsaved changes');
  return user;
}

describe('Grand Projects unsaved-work navigation guard (7B.2B.1)', () => {
  it('a dirty proposal editor blocks sidebar navigation; Keep editing retains page and text', async () => {
    const user = await openDirtyEditor();
    await user.click(nav().getByRole('button', { name: 'Projects' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm leave Grand Projects' });
    expect(dialog.textContent).toContain(guardTitle);
    expect(screen.queryByRole('heading', { name: 'Projects' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog', { name: 'Confirm leave Grand Projects' })).toBeNull();
    expect((screen.getByLabelText('Definition JSON') as HTMLTextAreaElement).value).toBe(
      '{"typed": "unsaved"}',
    );
    expect(posts()).toEqual([]);
  });

  it('Discard and leave navigates to the destination and sends nothing', async () => {
    const user = await openDirtyEditor();
    await user.click(nav().getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog', { name: 'Confirm leave Grand Projects' })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('guards the brand, New task and bell paths too, and a cancelled path stays on Goals', async () => {
    const user = await openDirtyEditor();
    await user.click(screen.getByRole('button', { name: /New task/ }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    await user.click(screen.getByRole('button', { name: /Notifications|pending approvals/ }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Definition JSON')).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it('a dirty New Grand Project form is blocked the same way', async () => {
    serve({
      '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
      '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(nav().getByRole('button', { name: 'Grand Projects' }));
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    await user.type(await screen.findByLabelText('Title'), 'half typed');
    await user.click(nav().getByRole('button', { name: 'Projects' }));
    await screen.findByRole('alertdialog', { name: 'Confirm leave Grand Projects' });
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('half typed');
    await user.click(nav().getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it('with no dirty work navigation is immediate and never prompts', async () => {
    serve({
      '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
      '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(nav().getByRole('button', { name: 'Grand Projects' }));
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    await user.click(nav().getByRole('button', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('"Open Projects" from the empty New Grand Project form uses the guarded path and navigates', async () => {
    dashboard.mockResolvedValue(base([]));
    serve({
      '/api/goals': () => ({ goals: [], total: 0, limit: 50 }),
      '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'What should the agents do?' });
    await user.click(nav().getByRole('button', { name: 'Grand Projects' }));
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    await user.click(await screen.findByRole('button', { name: 'Open Projects' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy());
  });
});

describe('Goal notification deep links', () => {
  it('opens the exact Goal from a navigation-only URL, then cleans only its parameters', async () => {
    window.history.replaceState({}, '', '/?page=goals&goalId=goal-1&pairRequest=pair-token');
    serve(proposedRoutes());
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Ship the importer' })).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'GET' && call.path === '/api/goals/goal-1')).toBe(true),
    );
    expect(posts()).toEqual([]);
    expect(window.location.search).toBe('?pairRequest=pair-token');
  });

  it('shows a normal not-found state for an exact missing Goal without selecting another', async () => {
    window.history.replaceState({}, '', '/?page=goals&goalId=goal-missing');
    serve({
      '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }),
      '/api/goals/goal-missing': () =>
        new Response(JSON.stringify({ error: 'Goal was not found.' }), { status: 404 }),
    });
    render(<App />);
    expect(await screen.findByText(/Goal could not be loaded/)).toBeTruthy();
    expect(calls.some((call) => call.path === '/api/goals/goal-1')).toBe(false);
    expect(posts()).toEqual([]);
  });

  it('ignores a malformed Goal ID and does not select a different listed Goal', async () => {
    window.history.replaceState({}, '', '/?page=goals&goalId=..%2Fgoal-1');
    serve({ '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }) });
    render(<App />);
    expect(await screen.findByRole('list', { name: 'Grand Projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ship the importer/ })).toBeTruthy();
    expect(calls.some((call) => call.path.startsWith('/api/goals/') && call.path !== '/api/goals')).toBe(
      false,
    );
    expect(posts()).toEqual([]);
  });
});

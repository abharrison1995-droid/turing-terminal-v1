// @vitest-environment jsdom

// UI.2 tests for the Home composition (UI2_SCOPE sections 1 and 3, matrix A1 to A5). They render the real CommandCenter
// with fixtures, so the composition is judged from the DOM a user reaches. Tests marked GREEN guard behaviour that
// already holds and must stay green after UI.2. Tests marked RED fail until the UI.2 Home work lands. No test waits in
// real time: the preview is a resolved mock, and findBy* returns as soon as the element exists.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardSnapshot,
  ProjectProfile,
  RunPreview,
  WorkflowDefinition,
} from '../../../shared/types';
import { serve } from '../../goals/testKit';
import { CommandCenter } from '../CommandCenter';

const previewRun = vi.hoisted(() => vi.fn());
vi.mock('../../api', async (importActual) => ({
  ...(await importActual<typeof import('../../api')>()),
  api: {
    previewRun,
    startRun: vi.fn(),
    decideApproval: vi.fn(),
  },
}));

const HOME = 'What should the agents do?';
const REVIEW = 'Review run preview';
const TASK = 'Fix the parser';

const PROJECT = {
  id: 'project-1',
  name: 'Turing Terminal',
  path: '/repo',
  gitRoot: '/repo',
  branch: 'main',
  dirty: false,
} as unknown as ProjectProfile;

const readyStage = {
  id: 'stage-impl',
  label: 'Implement',
  kind: 'implementer' as const,
  enabled: true,
  backendId: 'claude-code',
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
};
/** An AI stage with no model assignment: the Home blockers and the Run gating read this. */
const unsetStage = { id: 'stage-review', label: 'Review', kind: 'reviewer' as const, enabled: true };

const workflow = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
  ({
    id: 'standard-dev-loop',
    name: 'Standard dev loop',
    description: '',
    template: 'standard',
    executionProfile: 'balanced',
    permissionMode: 'normal',
    promptRefinementDefault: false,
    maxRemediationRounds: 2,
    maxParallelAgents: 2,
    maxDurationMinutes: 120,
    retryPolicy: { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 8000 },
    isolatedWorktree: true,
    subscriptionOnly: true,
    billingMode: 'subscriptions-only',
    lockProviders: true,
    contextPolicy: {},
    stages: [readyStage],
    version: 1,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as WorkflowDefinition;

const pendingApproval = {
  id: 'approval-1',
  runId: 'run-1',
  stageId: null,
  operation: 'git push',
  reason: 'Push the integration branch',
  risk: 'medium',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  respondedAt: null,
};

const snapshot = (overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot =>
  ({
    machine: {
      id: 'machine',
      name: 'Development machine',
      hostname: 'dev-host',
      os: 'linux',
      status: 'online',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    },
    projects: [PROJECT],
    workflows: [workflow()],
    providers: [],
    runs: [],
    approvals: [],
    usage: {
      events: 3,
      localMinutesToday: 0,
      inputTokens: null,
      outputTokens: null,
      provenance: 'locally observed',
    },
    ...overrides,
  }) as unknown as DashboardSnapshot;

/** A preview with the fields RunPreviewPanel reads. Routing and assignments are empty, which the panel allows. */
const previewFixture = (canStart: boolean): RunPreview =>
  ({
    project: PROJECT,
    workflow: workflow(),
    machine: snapshot().machine,
    task: TASK,
    profile: 'balanced',
    permissionMode: 'normal',
    refinePrompt: false,
    subscriptionOnly: true,
    billingMode: 'subscriptions-only',
    lockProviders: true,
    effectiveRules: [],
    branchStrategy: 'worktree',
    expectedAiStages: 1,
    canStart,
    warnings: [],
    providerAssignments: [],
    billingSummary: [],
    providerFallbackStatus: [],
    contextWarnings: [],
  }) as unknown as RunPreview;

const renderHome = (value: DashboardSnapshot = snapshot()) =>
  render(
    <CommandCenter
      snapshot={value}
      onRefresh={vi.fn()}
      onNavigate={vi.fn()}
      onStart={vi.fn()}
      onNotice={vi.fn()}
    />,
  );

const reviewButton = () => screen.getByRole('button', { name: REVIEW }) as HTMLButtonElement;
const taskBox = () => screen.getByLabelText(HOME);

beforeEach(() => {
  serve({ '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }) });
  previewRun.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home heading order and approvals (matrix A1)', () => {
  it('[RED] the first heading in Home is the h1 "What should the agents do?" even with an approval pending', () => {
    renderHome(snapshot({ approvals: [pendingApproval] as unknown as DashboardSnapshot['approvals'] }));

    const first = document.querySelector('h1, h2, h3, h4, h5, h6');

    expect(first?.tagName).toBe('H1');
    expect(first?.textContent).toBe(HOME);
  });

  it('[GREEN guard] a pending approval renders the Unified approvals section exactly once', () => {
    renderHome(snapshot({ approvals: [pendingApproval] as unknown as DashboardSnapshot['approvals'] }));

    expect(document.querySelectorAll('section[aria-label="Approval required"]')).toHaveLength(1);
  });
});

describe('launch blockers (matrix A2)', () => {
  const noProject = snapshot({ projects: [], workflows: [workflow({ stages: [unsetStage] })] });

  it('[RED] blockers are an h2 group with an item count, each item carrying an icon and a word', () => {
    renderHome(noProject);

    const group = screen.getByRole('group', { name: /Before you can run/ });
    const heading = within(group).getByRole('heading', { level: 2, name: /Before you can run/ });

    expect(heading.textContent).toMatch(/\b2\b/);
    const items = [...group.querySelectorAll('li')];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.querySelector('svg')).not.toBeNull();
      expect(item.textContent).toMatch(/Set up|No project|needs/);
    }
  });

  it('[RED] Run is described by the blockers, not only by the hint line', () => {
    renderHome(noProject);

    const ids = (reviewButton().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');

    expect(ids.length).toBeGreaterThan(0);
    expect(described).toMatch(/No project registered/);
  });

  it('[GREEN guard] Run stays enabled when only stage models are missing, because the server preview is authoritative', async () => {
    const user = userEvent.setup();
    renderHome(snapshot({ workflows: [workflow({ stages: [unsetStage] })] }));

    await user.type(taskBox(), TASK);

    expect(reviewButton().disabled).toBe(false);
    expect(screen.getByText(/Set up the stage models first/)).toBeTruthy();
  });
});

describe('no paid fallback and the Options allow-list (matrix A3, A4)', () => {
  it('[GREEN guard] no composer control or option names a paid fallback', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: 'Options' }));

    const controls = [
      ...document.querySelectorAll('form.composer button, form.composer option, form.composer input'),
    ];
    const names = controls.map(
      (control) =>
        `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''} ${(control as HTMLInputElement).value ?? ''}`,
    );

    expect(names.filter((name) => /fallback|payg|auto.*paid/i.test(name))).toEqual([]);
  });

  it('[GREEN guard] Options holds only the real-field controls, bound as before', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: 'Options' }));
    const panel = document.getElementById('composer-options');
    expect(panel).not.toBeNull();
    const nameOf = (control: Element) =>
      control.closest('label')?.querySelector('strong')?.textContent ??
      control.closest('label')?.querySelector('span')?.textContent;

    const scoped = within(panel as HTMLElement);
    expect(scoped.getAllByRole('combobox').map(nameOf)).toEqual([
      'Execution profile',
      'Permission mode',
      'Billing mode for this run',
    ]);
    expect(scoped.getAllByRole('checkbox').map(nameOf)).toEqual([
      'Refine and confirm the task before execution',
      'Lock configured providers and models',
    ]);
    expect(scoped.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual([
      'Edit in Workflow Studio',
    ]);
  });
});

describe('Safeguards and usage (matrix A4, usage snapshot)', () => {
  it('[RED] Safeguards is a read-only region with no interactive elements that states the workflow billing mode', () => {
    renderHome(
      snapshot({
        workflows: [workflow({ billingMode: 'subscriptions-plus-decision-budget', subscriptionOnly: false })],
      }),
    );

    const strip = screen.getByRole('region', { name: 'Safeguards' });

    expect(
      strip.querySelectorAll('button, input, select, textarea, a[href], [tabindex], [role="button"]'),
    ).toHaveLength(0);
    expect(strip.textContent).toContain('Subscriptions + Decision Budget');
    expect(strip.textContent).not.toContain('Subscriptions Only');
  });

  it('[RED] the usage snapshot shows its provenance word from snapshot.usage', () => {
    renderHome();

    expect(document.querySelector('.home-column')?.textContent).toContain('locally observed');
  });
});

describe('run preview heading and focus (matrix A5)', () => {
  it('[GREEN guard] a previewRun payload has exactly the existing keys and the workflow billing default', async () => {
    const user = userEvent.setup();
    previewRun.mockResolvedValue({ preview: previewFixture(true) });
    renderHome();

    await user.type(taskBox(), TASK);
    await user.click(reviewButton());

    expect(previewRun).toHaveBeenCalledTimes(1);
    const payload = previewRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'billingMode',
      'enigmaConfirmed',
      'lockProviders',
      'permissionMode',
      'profile',
      'projectId',
      'refinePrompt',
      'task',
      'workflowId',
    ]);
    expect(payload).toMatchObject({ billingMode: 'subscriptions-only', task: TASK, lockProviders: true });
  });

  it('[GREEN guard] a ready preview is headed "Ready to hand off"', async () => {
    const user = userEvent.setup();
    previewRun.mockResolvedValue({ preview: previewFixture(true) });
    renderHome();

    await user.type(taskBox(), TASK);
    await user.click(reviewButton());

    expect(await screen.findByRole('heading', { name: 'Ready to hand off' })).toBeTruthy();
  });

  it('[RED] a preview that cannot start is headed "Setup needed before this can start"', async () => {
    const user = userEvent.setup();
    previewRun.mockResolvedValue({ preview: previewFixture(false) });
    renderHome();

    await user.type(taskBox(), TASK);
    await user.click(reviewButton());

    expect(await screen.findByRole('heading', { name: 'Setup needed before this can start' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ready to hand off' })).toBeNull();
  });

  it('[RED] focus moves to the preview heading when the preview appears, and not on first render', async () => {
    const user = userEvent.setup();
    previewRun.mockResolvedValue({ preview: previewFixture(true) });
    renderHome();
    expect(document.activeElement).toBe(document.body);

    await user.type(taskBox(), TASK);
    await user.click(reviewButton());
    const heading = await screen.findByRole('heading', { name: 'Ready to hand off' });

    expect(document.activeElement).toBe(heading);
  });
});

describe('new Home files stay off the approval path', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('[RED] LaunchBlockers, RunPreviewPanel and Safeguards exist and never import decideApproval', () => {
    for (const file of ['LaunchBlockers.tsx', 'RunPreviewPanel.tsx', 'Safeguards.tsx']) {
      const path = join(here, file);
      expect(existsSync(path), `${file} exists`).toBe(true);
      expect(readFileSync(path, 'utf8'), file).not.toMatch(/decideApproval/);
    }
  });
});

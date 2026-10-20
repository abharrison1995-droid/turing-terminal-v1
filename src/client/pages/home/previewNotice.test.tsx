// @vitest-environment jsdom

// UI.2 review round 2 (finding 10). The Home run-preview notice must match the preview's canStart. RED before the fix:
// a preview that cannot start was announced as "Run preview is ready". GREEN guard: a startable preview keeps the
// original announcement. The preview is a resolved mock, so no test waits in real time.

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardSnapshot,
  ProjectProfile,
  RunPreview,
  WorkflowDefinition,
} from '../../../shared/types';
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

const workflow = (): WorkflowDefinition =>
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
  }) as unknown as WorkflowDefinition;

const snapshot = (): DashboardSnapshot =>
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
      events: 0,
      localMinutesToday: 0,
      inputTokens: null,
      outputTokens: null,
      provenance: 'locally observed',
    },
  }) as unknown as DashboardSnapshot;

/** A preview with the fields RunPreviewPanel reads. */
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

/** Types a task, asks for a preview, and returns the notices the Home page announced. */
async function reviewAndCollectNotices(canStart: boolean): Promise<string[]> {
  const user = userEvent.setup();
  previewRun.mockResolvedValue({ preview: previewFixture(canStart) });
  const onNotice = vi.fn();
  render(
    <CommandCenter
      snapshot={snapshot()}
      onRefresh={vi.fn()}
      onNavigate={vi.fn()}
      onStart={vi.fn()}
      onNotice={onNotice}
    />,
  );

  await user.type(screen.getByLabelText(HOME), TASK);
  await user.click(screen.getByRole('button', { name: 'Review run preview' }));
  await screen.findByRole('heading', {
    name: canStart ? 'Ready to hand off' : 'Setup needed before this can start',
  });

  return onNotice.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  previewRun.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('run preview notice matches canStart (finding 10)', () => {
  it('[RED] a preview that cannot start is not announced as "Run preview is ready"', async () => {
    const notices = await reviewAndCollectNotices(false);

    expect(notices.join(' ')).not.toMatch(/Run preview is ready/);
    expect(notices).toContain('Preview loaded. Setup is needed before this can start.');
  });

  it('[GREEN guard] a startable preview is still announced as ready', async () => {
    const notices = await reviewAndCollectNotices(true);

    expect(notices.some((notice) => notice.startsWith('Run preview is ready'))).toBe(true);
  });
});

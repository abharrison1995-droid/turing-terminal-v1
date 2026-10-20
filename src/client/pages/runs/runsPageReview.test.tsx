// @vitest-environment jsdom

// UI.2 review round 2 (findings 1, 2, 3, 7 and 11). These render the real RunsPage with fixtures and drive it the way a
// user does. Each RED test fails on the code that preceded this change and passes after it. GREEN guards hold both
// before and after. No test waits in real time: requests are resolved or rejected mocks, and waitFor and findBy only poll.

import { useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot, RunSummary } from '../../../shared/types';
import { api } from '../../api';
import { serve } from '../../goals/testKit';
import { RunsPage } from '../RunsPage';

vi.mock('../../api', async (importActual) => ({
  ...(await importActual<typeof import('../../api')>()),
  api: {
    run: vi.fn(),
    executionOperations: vi.fn(),
    diff: vi.fn(),
    decideApproval: vi.fn(),
    cancelRun: vi.fn(),
    resumeRun: vi.fn(),
    intervene: vi.fn(),
    replayRun: vi.fn(),
    duplicateRunWorkflow: vi.fn(),
  },
}));

const FAILED_ID = 'run-failed';
const RUNNING_ID = 'run-running';
const FAILED_TASK = 'Fix the parser';
const RUNNING_TASK = 'Add the importer';

const stage = (overrides: Record<string, unknown>) => ({
  id: 'stage-1',
  runId: FAILED_ID,
  stageKey: 'implement',
  kind: 'implementer',
  title: 'Implement',
  sequence: 1,
  backendId: null,
  providerId: null,
  modelId: null,
  status: 'failed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  output: null,
  error: 'Tests failed',
  logs: null,
  attempts: [],
  ...overrides,
});

const run = (overrides: Record<string, unknown>) =>
  ({
    machineId: 'machine',
    projectId: 'project-1',
    projectName: 'Turing Terminal',
    workflowId: 'standard-dev-loop',
    workflowName: 'Standard dev loop',
    profile: 'balanced',
    permissionMode: 'normal',
    refinePrompt: false,
    branch: 'turing/run',
    worktreePath: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    stages: [stage({})],
    elapsedMs: 60_000,
    remainingMs: null,
    ...overrides,
  }) as unknown as RunSummary;

const failedRun = run({ id: FAILED_ID, prompt: FAILED_TASK, status: 'failed' });
const runningRun = run({
  id: RUNNING_ID,
  prompt: RUNNING_TASK,
  status: 'running',
  completedAt: null,
  stages: [stage({ id: 'stage-2', runId: RUNNING_ID, status: 'running', finishedAt: null, error: null })],
});

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
    projects: [],
    workflows: [],
    providers: [],
    runs: [failedRun, runningRun],
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

type RunDetails = Awaited<ReturnType<typeof api.run>>;
const details = (value: RunSummary): RunDetails =>
  ({
    run: value,
    effectiveRules: [],
    findings: [],
    decisions: [],
    gitOperations: [],
    events: [],
  }) as unknown as RunDetails;

const DIFF = [
  'diff --git a/src/parser.ts b/src/parser.ts',
  'index 1111111..2222222 100644',
  '--- a/src/parser.ts',
  '+++ b/src/parser.ts',
  '@@ -1 +1 @@',
  '-const b = 2;',
  '+const b = 3;',
].join('\n');

const SECOND_DIFF = [
  'diff --git a/src/second.ts b/src/second.ts',
  'index 3333333..4444444 100644',
  '--- a/src/second.ts',
  '+++ b/src/second.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

/** Names that the Details tab shows before its data is fetched or after a failed fetch. */
const INVENTED_EMPTY_STATES = [
  /brokered operations/,
  /No mediated provider tools/,
  /recorded operations/,
  /No first-class Git operations/,
  /Saved rule snapshot/,
];

/** A stateful host, so Back can clear the selection the way the shell does. */
function Harness({ value, initialId }: { value: DashboardSnapshot; initialId: string | null }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialId);
  const selectedRun = value.runs.find((item) => item.id === selectedRunId) ?? null;
  return (
    <RunsPage
      snapshot={value}
      selectedRun={selectedRun}
      selectedRunId={selectedRunId}
      onSelect={setSelectedRunId}
      onRefresh={vi.fn()}
      onNotice={vi.fn()}
      onNavigate={vi.fn()}
    />
  );
}

const renderRuns = (selectedId: string | null = FAILED_ID, value: DashboardSnapshot = snapshot()) =>
  render(<Harness value={value} initialId={selectedId} />);

const changesTab = () => screen.getByRole('tab', { name: 'Changes' });
const activityTab = () => screen.getByRole('tab', { name: 'Activity' });
const detailsTab = () => screen.getByRole('tab', { name: 'Details' });
const detailsPanel = () => screen.getByRole('tabpanel', { name: 'Details' });

const expectNoInventedEmptyState = (panel: HTMLElement) => {
  for (const pattern of INVENTED_EMPTY_STATES)
    expect(panel.textContent ?? '', String(pattern)).not.toMatch(pattern);
};

beforeEach(() => {
  vi.clearAllMocks();
  serve({ '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }) });
  vi.mocked(api.run).mockImplementation(async (id: string) =>
    details(id === RUNNING_ID ? runningRun : failedRun),
  );
  vi.mocked(api.executionOperations).mockResolvedValue({ operations: [] } as never);
  vi.mocked(api.diff).mockResolvedValue({ diff: DIFF, truncated: false, cwd: '/repo' } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Details shows counts and empty text only for fetched data (finding 1)', () => {
  it('[RED] before details load, the Details tab shows no operation count and no empty-state text', async () => {
    const user = userEvent.setup();
    vi.mocked(api.executionOperations).mockReturnValueOnce(new Promise(() => {}));
    renderRuns(FAILED_ID);

    await user.click(detailsTab());

    expectNoInventedEmptyState(detailsPanel());
  });

  it('[RED] after a failed load, the Details tab shows no invented counts or empty text', async () => {
    const user = userEvent.setup();
    vi.mocked(api.executionOperations).mockRejectedValueOnce(new Error('offline'));
    renderRuns(FAILED_ID);
    await screen.findByRole('alert');

    await user.click(detailsTab());

    expectNoInventedEmptyState(detailsPanel());
  });

  it('[GREEN guard] after a successful load, a real empty result is shown as zero with its empty text', async () => {
    const user = userEvent.setup();
    renderRuns(FAILED_ID);
    await user.click(detailsTab());

    await waitFor(() => expect(detailsPanel().textContent).toMatch(/0 brokered operations/));
    expect(detailsPanel().textContent).toMatch(/No mediated provider tools have been requested yet/);
  });
});

describe('details error and stale details (findings 7 and 11)', () => {
  it('[RED] a failed load shows an alert with an icon and the word "Error", and Retry remains', async () => {
    vi.mocked(api.run).mockRejectedValueOnce(new Error('offline'));
    renderRuns(FAILED_ID);

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('Run details could not be loaded');
    expect(alert.textContent).toMatch(/Error/);
    expect(alert.querySelector('svg')).not.toBeNull();
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('[RED] a failed refresh keeps the earlier details visible and says "Showing earlier details"', async () => {
    const user = userEvent.setup();
    const { rerender } = renderRuns(FAILED_ID);
    await waitFor(() => expect(screen.queryByText(/Loading run details/)).toBeNull());

    vi.mocked(api.run).mockRejectedValueOnce(new Error('offline'));
    const changed = run({
      id: FAILED_ID,
      prompt: FAILED_TASK,
      status: 'failed',
      stages: [stage({ status: 'passed', error: null })],
    });
    rerender(<Harness value={snapshot({ runs: [changed, runningRun] })} initialId={FAILED_ID} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Showing earlier details');
    expect(alert.querySelector('svg')).not.toBeNull();

    await user.click(detailsTab());
    expect(detailsPanel().textContent).toMatch(/0 brokered operations/);
  });
});

describe('View diff focus (finding 3)', () => {
  it('[RED] View diff moves focus to the Changes tab once it has selected it', async () => {
    const user = userEvent.setup();
    renderRuns(FAILED_ID);

    await user.click(screen.getByRole('button', { name: 'View diff' }));

    expect(changesTab().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(changesTab());
  });

  it('[RED] when Changes is already selected, View diff focuses the tab and does not refetch a finished run', async () => {
    const user = userEvent.setup();
    renderRuns(FAILED_ID);
    await user.click(changesTab());
    await waitFor(() => expect(api.diff).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'View diff' }));

    expect(document.activeElement).toBe(changesTab());
    expect(api.diff).toHaveBeenCalledTimes(1);
  });
});

describe('Changes refetch and races (finding 2)', () => {
  it('[RED] an active run refetches the diff on each activation of Changes', async () => {
    const user = userEvent.setup();
    renderRuns(RUNNING_ID);

    await user.click(changesTab());
    await waitFor(() => expect(api.diff).toHaveBeenCalledTimes(1));
    await user.click(activityTab());
    await user.click(changesTab());

    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it('[GREEN guard] a finished run loads its diff once across repeated activations', async () => {
    const user = userEvent.setup();
    renderRuns(FAILED_ID);

    await user.click(changesTab());
    await user.click(activityTab());
    await user.click(changesTab());

    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it('[RED] a late response from an earlier activation does not replace the newer diff', async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: unknown) => void) | undefined;
    vi.mocked(api.diff)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }) as never,
      )
      .mockResolvedValueOnce({ diff: SECOND_DIFF, truncated: false, cwd: '/repo' } as never);
    renderRuns(RUNNING_ID);

    await user.click(changesTab());
    await user.click(activityTab());
    await user.click(changesTab());
    const panel = screen.getByRole('tabpanel', { name: 'Changes' });
    await within(panel).findByText('src/second.ts');

    await act(async () => {
      resolveFirst?.({ diff: DIFF, truncated: false, cwd: '/repo' });
    });

    expect(within(panel).queryByText('src/parser.ts')).toBeNull();
    expect(within(panel).getByText('src/second.ts')).toBeTruthy();
  });
});

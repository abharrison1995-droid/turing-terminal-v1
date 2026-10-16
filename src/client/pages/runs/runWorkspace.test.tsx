// @vitest-environment jsdom

// UI.2 tests for the read-only run workspace (UI2_SCOPE sections 1 and 3, matrix R1 to R4). They render the real
// RunsPage with fixtures and drive it the way a user does. Tests marked GREEN guard behaviour that already holds and must
// stay green after UI.2. Tests marked RED fail until the UI.2 run workspace lands. No test waits in real time: the
// requests are resolved or rejected mocks, and waitFor only polls for the state a click has just caused.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const LOG_LINE = 'npm test: 2 failing';

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
  logs: LOG_LINE,
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

/** Three files: one removed line, three added lines, and a context line. The --- and +++ headers must not count. */
const DIFF = [
  'diff --git a/src/parser.ts b/src/parser.ts',
  'index 1111111..2222222 100644',
  '--- a/src/parser.ts',
  '+++ b/src/parser.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  'diff --git a/src/index.ts b/src/index.ts',
  'index 3333333..4444444 100644',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -5,0 +6,2 @@',
  '+export * from "./parser";',
  '+export const version = 2;',
  'diff --git a/README.md b/README.md',
  'index 5555555..6666666 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  ' # Turing',
].join('\n');

const TRUNCATED_NOTICE = 'Turing kept the first 512 KB of this diff.';
const EMPTY_NOTICE = 'No tracked changes in this working tree.';

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
const openChanges = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(changesTab());
  return screen.getByRole('tabpanel', { name: 'Changes' });
};

beforeEach(() => {
  vi.clearAllMocks();
  serve({ '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }) });
  vi.mocked(api.run).mockImplementation(async (id: string) =>
    details(id === RUNNING_ID ? runningRun : failedRun),
  );
  vi.mocked(api.executionOperations).mockResolvedValue({ operations: [] } as never);
  vi.mocked(api.diff).mockResolvedValue({ diff: DIFF, truncated: false, cwd: '/repo' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('run page heading and tabs (matrix R1)', () => {
  it('[RED] a selected run renders an sr-only h1 "Runs & history"', async () => {
    renderRuns();

    expect(screen.getByRole('heading', { level: 1, name: 'Runs & history' })).toBeTruthy();
  });

  it('[RED] Activity, Changes and Details are ARIA tabs; arrow, Home and End move selection and focus, without refetching', async () => {
    const user = userEvent.setup();
    renderRuns();
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(activityTab().getAttribute('aria-selected')).toBe('true');

    activityTab().focus();
    await user.keyboard('{ArrowRight}');
    expect(changesTab().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(changesTab());

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{Home}');
    expect(activityTab().getAttribute('aria-selected')).toBe('true');
    expect(api.run).toHaveBeenCalledTimes(1);
  });
});

describe('lazy diff (matrix R1, R2)', () => {
  it('[RED] the diff loads on first activation of Changes, and "View diff" selects Changes', async () => {
    const user = userEvent.setup();
    renderRuns();
    expect(api.diff).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'View diff' }));

    expect(changesTab().getAttribute('aria-selected')).toBe('true');
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(api.diff).toHaveBeenCalledWith(FAILED_ID);
  });

  it('[RED] the diff is split per file, with added and removed lines marked in text as well as colour', async () => {
    const user = userEvent.setup();
    renderRuns();

    const panel = await openChanges(user);

    expect(within(panel).getByText('src/parser.ts')).toBeTruthy();
    expect(within(panel).getByText('src/index.ts')).toBeTruthy();
    expect(within(panel).getByText('README.md')).toBeTruthy();
    expect(within(panel).getAllByText('added')).toHaveLength(3);
    expect(within(panel).getAllByText('removed')).toHaveLength(1);
  });

  it('[RED] a truncated diff shows a truncated notice and the server message; an empty diff shows the server message', async () => {
    const user = userEvent.setup();
    vi.mocked(api.diff).mockResolvedValueOnce({
      diff: DIFF,
      truncated: true,
      cwd: '/repo',
      message: TRUNCATED_NOTICE,
    });
    const { unmount } = renderRuns();

    const truncatedPanel = await openChanges(user);

    expect(within(truncatedPanel).getByText(TRUNCATED_NOTICE)).toBeTruthy();
    expect(truncatedPanel.textContent).toMatch(/truncated|partial/i);
    unmount();

    vi.mocked(api.diff).mockResolvedValueOnce({
      diff: '',
      truncated: false,
      cwd: '/repo',
      message: EMPTY_NOTICE,
    });
    renderRuns();

    const emptyPanel = await openChanges(user);

    expect(within(emptyPanel).getByText(EMPTY_NOTICE)).toBeTruthy();
  });

  it('[RED] a very large diff is capped with a visible notice', async () => {
    const user = userEvent.setup();
    const huge = [
      'diff --git a/big.txt b/big.txt',
      '@@ -0,0 +1,5000 @@',
      ...Array.from({ length: 5000 }, (_, index) => `+line ${index}`),
    ].join('\n');
    vi.mocked(api.diff).mockResolvedValueOnce({ diff: huge, truncated: false, cwd: '/repo' });
    renderRuns();

    const panel = await openChanges(user);

    expect(panel.textContent).toMatch(/limit|capped|first \d/i);
  });
});

describe('details loading and error (matrix R3)', () => {
  it('[RED] while run details load, a polite status region says so', () => {
    vi.mocked(api.run).mockReturnValueOnce(new Promise<RunDetails>(() => {}));
    renderRuns();

    const status = screen.getByRole('status');

    expect(status.textContent).toMatch(/Loading/);
  });

  it('[RED] a failed run-details request shows an alert with Retry, and Retry loads the details', async () => {
    const user = userEvent.setup();
    vi.mocked(api.run).mockRejectedValueOnce(new Error('offline'));
    renderRuns();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Run details could not be loaded');
    await user.click(within(alert).getByRole('button', { name: /Retry/ }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.run).toHaveBeenCalledTimes(2);
  });
});

describe('back link and read-only Changes (matrix R1, R4)', () => {
  it('[RED] "All runs" returns focus to the originating run row', async () => {
    const user = userEvent.setup();
    renderRuns();

    await user.click(screen.getByRole('button', { name: /All runs/ }));

    const active = document.activeElement as HTMLElement | null;
    expect(active?.classList.contains('full-run-row')).toBe(true);
    expect(active?.textContent).toContain(FAILED_TASK);
  });

  it('[RED] the Changes panel has no text field and no save, edit, terminal, editor or file-tree control', async () => {
    const user = userEvent.setup();
    renderRuns();

    const panel = await openChanges(user);

    expect(within(panel).queryAllByRole('textbox')).toEqual([]);
    for (const control of within(panel).queryAllByRole('button')) {
      expect(control.textContent ?? '').not.toMatch(
        /save|edit|terminal|editor|file tree|apply|revert|write/i,
      );
    }
  });
});

describe('no fabricated progress, approvals and logs (matrix R2, R4)', () => {
  it('[GREEN guard] a running run shows no progressbar and no percentage', async () => {
    renderRuns(RUNNING_ID);
    await screen.findByRole('heading', { name: RUNNING_TASK });

    const detail = document.querySelector('.run-detail-panel');
    expect(detail).not.toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(detail?.textContent ?? '').not.toMatch(/%/);
  });

  it('[GREEN guard] pending approvals render the Unified approvals section exactly once', () => {
    renderRuns(
      FAILED_ID,
      snapshot({ approvals: [{ id: 'approval-1' }] as unknown as DashboardSnapshot['approvals'] }),
    );

    expect(document.querySelectorAll('section[aria-label="Approval required"]')).toHaveLength(1);
  });

  it('[GREEN guard] a failed stage shows its logs', () => {
    renderRuns(FAILED_ID);

    expect(screen.getByText(LOG_LINE)).toBeTruthy();
  });

  it('[RED] the new run-workspace files exist and never import decideApproval', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['RunWorkspaceTabs.tsx', 'RunDiff.tsx', 'diffModel.ts']) {
      const path = join(here, file);
      expect(existsSync(path), `${file} exists`).toBe(true);
      expect(readFileSync(path, 'utf8'), file).not.toMatch(/decideApproval/);
    }
  });
});

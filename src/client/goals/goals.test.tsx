// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GoalCyclesResponse,
  GoalDetail,
  GoalEvidenceResponse,
  GoalEvidenceView,
  GoalListItem,
  GoalNextAction,
  GoalPreview,
} from '../../shared/goalApi';
import type { GoalStatus } from '../../shared/goals';
import { describeNextAction } from './presentation';
import { GoalsPage } from './GoalsPage';

expect.extend({
  toHaveAttribute(received: Element, name: string, value?: string) {
    const actual = received.getAttribute(name);
    return {
      pass: value === undefined ? actual !== null : actual === value,
      message: () => `expected attribute ${name} to be ${String(value)} but was ${String(actual)}`,
    };
  },
  toHaveTextContent(received: Element, text: string | RegExp) {
    const content = received.textContent ?? '';
    return {
      pass: typeof text === 'string' ? content.includes(text) : text.test(content),
      message: () => `expected text ${String(text)} in "${content}"`,
    };
  },
  toBeInTheDocument(received: Element | null) {
    return {
      pass: received !== null && received.isConnected,
      message: () => 'expected element in the document',
    };
  },
});
declare module 'vitest' {
  interface Assertion {
    toHaveAttribute(name: string, value?: string): void;
    toHaveTextContent(text: string | RegExp): void;
    toBeInTheDocument(): void;
  }
}

const NOW = '2026-01-01T00:00:00.000Z';

const item = (overrides: Partial<GoalListItem> = {}): GoalListItem => ({
  id: 'goal-1',
  projectId: 'project-1',
  projectName: 'Turing Terminal',
  title: 'Ship the importer',
  status: 'running',
  reasonCode: null,
  reasonDetail: null,
  needsUser: false,
  attention: [],
  paused: false,
  pendingApprovalCount: 0,
  currentDefinitionVersion: 1,
  activeMilestone: { key: 'm1', title: 'Parser', runtimeStatus: 'active' },
  lastCycle: {
    id: 'c1',
    sequence: 3,
    kind: 'execution',
    status: 'succeeded',
    triggerCode: 'scheduled',
    finishedAt: NOW,
  },
  nextAction: { kind: 'wait_for_turing' },
  integrationBranch: 'turing/goal-1',
  integrationHead: 'abcdef1234567890',
  openFindingCounts: { critical: 0, high: 0, medium: 1, low: 0 },
  usageSummary: { events: 4, inputTokens: 10, outputTokens: 5, meteredSpendUsd: 0 },
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const detail = (overrides: Partial<GoalDetail> = {}): GoalDetail => ({
  ...item(),
  approvedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  baseBranch: 'main',
  baseCommit: '1111111111111',
  runtime: { cyclesExecuted: 3, consecutiveFailedCycles: 0, remediationAttempts: {}, activeMs: 120_000 },
  currentDefinition: null,
  proposedDefinition: null,
  definitions: [],
  milestones: [
    {
      key: 'm0',
      title: 'Scaffold',
      ordinal: 0,
      runtimeStatus: 'satisfied',
      satisfiedAt: NOW,
      evaluation: null,
    },
    {
      key: 'm1',
      title: 'Parser',
      ordinal: 1,
      runtimeStatus: 'active',
      satisfiedAt: null,
      evaluation: { state: 'open', blockers: ['criterion parse-ok unmet'] },
    },
    { key: 'm2', title: 'Writer', ordinal: 2, runtimeStatus: 'pending', satisfiedAt: null, evaluation: null },
  ],
  activeCycle: null,
  childRun: null,
  memory: null,
  pendingApprovals: [],
  completion: null,
  flags: { cycleActive: false, childRun: 'none', proposalRequired: false, userNeeded: false },
  ...overrides,
});

const preview = (): GoalPreview => ({
  goalId: 'goal-1',
  status: 'running',
  reasonCode: null,
  definition: null,
  activeMilestone: null,
  runtime: detail().runtime,
  limits: null,
  integration: { branch: null, head: null, tree: null },
  currentCycle: null,
  routing: null,
  billing: null,
  proposalRequired: false,
  task: null,
  completion: null,
  blockers: [],
  pendingApprovals: [],
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
  nextAction: { kind: 'wait_for_turing' },
});

const evidenceRow = (overrides: Partial<GoalEvidenceView>): GoalEvidenceView => ({
  id: 'e1',
  kind: 'verifier_run',
  criterionKey: 'parse-ok',
  verifierDigest: 'd',
  verdict: 'satisfies',
  definitionVersion: 1,
  subject: {
    commit: 'aaaaaaaaaaaa',
    tree: 'bbbbbbbbbbbb',
    path: null,
    reviewedToCommit: null,
    reviewedToTree: null,
  },
  cycleId: null,
  runId: null,
  reviewId: null,
  recordedAt: NOW,
  freshness: 'current',
  ...overrides,
});

type Routes = Record<string, () => unknown>;
let calls: Array<{ url: string; method: string }>;

function serve(routes: Routes) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
      const handler = routes[path];
      if (!handler) return new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 });
      const body = handler();
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const detailRoutes = (goal: GoalDetail, extra: Routes = {}): Routes => ({
  '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }),
  '/api/goals/goal-1': () => ({ goal }),
  '/api/goals/goal-1/preview': () => ({ preview: preview() }),
  ...extra,
});

async function openGoal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Goal list', () => {
  it('shows a populated list with project, status, next action and needs-you', async () => {
    serve({
      '/api/goals': () => ({
        goals: [
          item(),
          item({
            id: 'goal-2',
            title: 'Fix the exporter',
            status: 'needs_user',
            reasonCode: 'gate_pending',
            needsUser: true,
            nextAction: { kind: 'review_approval', approvalId: 'a1' },
          }),
          item({
            id: 'goal-3',
            title: 'Old work',
            status: 'blocked',
            needsUser: true,
            nextAction: { kind: 'resolve_blocker', reasonCode: 'budget_exceeded' },
          }),
        ],
        total: 3,
        limit: 50,
      }),
    });
    render(<GoalsPage />);
    const list = await screen.findByRole('list', { name: 'Grand Projects' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-needs-user', 'false');
    expect(rows[0]).toHaveTextContent('Turing Terminal');
    expect(rows[1]).toHaveAttribute('data-needs-user', 'true');
    expect(rows[1]).toHaveTextContent('Needs you');
    expect(rows[1]).toHaveTextContent('Review an approval');
    expect(rows[2]).toHaveTextContent('Blocked');
    expect(rows[0]).not.toHaveTextContent('Needs you');
  });

  it('shows an empty state', async () => {
    serve({ '/api/goals': () => ({ goals: [], total: 0, limit: 50 }) });
    render(<GoalsPage />);
    expect(await screen.findByText(/No Grand Projects yet/)).toBeInTheDocument();
  });

  it('shows loading, then an error with a retry that reloads', async () => {
    let fail = true;
    serve({
      '/api/goals': () =>
        fail
          ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
          : { goals: [item()], total: 1, limit: 50 },
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading/);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ship the importer')).toBeInTheDocument();
  });
});

describe('Goal cockpit', () => {
  const statuses: Array<[GoalStatus, GoalNextAction]> = [
    ['running', { kind: 'wait_for_turing' }],
    ['paused', { kind: 'resume' }],
    ['needs_user', { kind: 'review_approval', approvalId: 'a1' }],
    ['blocked', { kind: 'resolve_blocker', reasonCode: 'budget_exceeded' }],
    ['completed', { kind: 'completed' }],
  ];
  it.each(statuses)('renders a %s Goal', async (status, nextAction) => {
    serve(
      detailRoutes(
        detail({ status, nextAction, needsUser: status === 'needs_user' || status === 'blocked' }),
      ),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    expect(await screen.findByLabelText('Next action')).toHaveAttribute('data-next-action', nextAction.kind);
    expect(document.querySelector(`[data-goal-status="${status}"]`)).not.toBeNull();
    expect(screen.getByLabelText('Milestones')).toHaveTextContent('Scaffold');
  });

  it('separates satisfied, active and remaining milestones', async () => {
    serve(detailRoutes(detail()));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    const milestones = await screen.findByLabelText('Milestones');
    const states = [...milestones.querySelectorAll('li[data-milestone-state]')].map((li) =>
      li.getAttribute('data-milestone-state'),
    );
    expect(states).toEqual(['satisfied', 'active', 'remaining']);
    expect(milestones).toHaveTextContent('criterion parse-ok unmet');
  });

  it('presents manual_reconciliation as a fail-closed alert and wait_for_turing as active work', () => {
    const matrix: GoalNextAction[] = [
      { kind: 'review_approval', approvalId: 'a' },
      { kind: 'resume' },
      { kind: 'revise_goal' },
      { kind: 'wait_for_turing' },
      { kind: 'manual_reconciliation' },
      { kind: 'final_acceptance', approvalId: null },
      { kind: 'final_apply' },
    ];
    const views = matrix.map(describeNextAction);
    expect(new Set(views.map((view) => view.label)).size).toBe(matrix.length);
    expect(views.filter((view) => view.failClosed).map((view) => view.kind)).toEqual([
      'manual_reconciliation',
    ]);
    expect(describeNextAction({ kind: 'wait_for_turing' }).summary).toMatch(/Nothing is needed/);
    expect(describeNextAction({ kind: 'final_apply' }).summary).toMatch(/separate step/);
    expect(describeNextAction({ kind: 'final_acceptance', approvalId: null }).summary).toMatch(
      /does not change your branch/,
    );
  });

  it('renders manual_reconciliation with an alert role and no action control', async () => {
    serve(
      detailRoutes(
        detail({
          status: 'needs_user',
          reasonCode: 'gate_pending',
          nextAction: { kind: 'manual_reconciliation' },
        }),
      ),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    const card = await screen.findByLabelText('Next action');
    expect(card).toHaveAttribute('role', 'alert');
    expect(card).toHaveTextContent('Failed closed');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('shows final acceptance and final apply as distinct read-only gates with no apply control', async () => {
    const completion = {
      ok: false,
      definitionVersion: 1,
      definitionHash: 'h',
      integrationHead: 'abc',
      integrationTree: 'def',
      failures: [{ code: 'final_apply_required' as const, detail: 'Apply to base is required.' }],
      finalReview: { required: true, ok: true, reason: null },
      finalAcceptance: { required: true, ok: true, approvalId: 'a1', reason: null },
      finalApply: { required: true, ok: false, basis: null, reason: 'final_apply_required' },
    };
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' }, completion }), {
        '/api/goals/goal-1/final-apply/preflight': () => ({
          preflight: {
            status: 'ready',
            recordedBaseBranch: 'main',
            recordedBaseCommit: 'x',
            currentBranch: 'main',
            currentHead: 'x',
            dirty: false,
            integrationHead: 'abc',
            goalRef: 'ref',
            fastForwardPossible: true,
            ahead: 1,
            behind: 0,
            changedPathCount: 2,
            changedPaths: ['a', 'b'],
            safety: { ok: true, violationCount: 0 },
            appliedExternallySupported: false,
            manualReconciliationRequired: false,
          },
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    const gates = await screen.findByLabelText('Completion');
    expect(
      within(gates)
        .getByText(/Final acceptance \(your gate\)/)
        .closest('li'),
    ).toHaveAttribute('data-gate-state', 'met');
    expect(
      within(gates)
        .getByText(/Final apply \(separate step\)/)
        .closest('li'),
    ).toHaveAttribute('data-gate-state', 'unmet');
    const preflight = await screen.findByLabelText('Final apply preflight');
    expect(preflight).toHaveTextContent('cannot apply it');
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('keeps current and stale evidence visibly different', async () => {
    const evidence: GoalEvidenceResponse = {
      evidence: [
        evidenceRow({ id: 'e1', freshness: 'current' }),
        evidenceRow({ id: 'e2', freshness: 'stale', staleReason: 'verifier_not_current' }),
      ],
      total: 2,
      limit: 100,
      integrationHead: 'abcdef1234567890',
    };
    serve(detailRoutes(detail(), { '/api/goals/goal-1/evidence': () => evidence }));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Evidence' }));
    const current = (await screen.findAllByText('Current'))[0]!.closest('li')!;
    const stale = screen.getByText('Stale').closest('li')!;
    expect(current).toHaveAttribute('data-freshness', 'current');
    expect(stale).toHaveAttribute('data-freshness', 'stale');
    expect(stale).toHaveTextContent('stale: Verifier not current');
    expect(current).not.toHaveTextContent(/stale/i);
    expect(stale.className).not.toEqual(current.className);
  });

  it('shows cycles with their child runs', async () => {
    const cycles: GoalCyclesResponse = {
      cycles: [
        {
          id: 'c1',
          sequence: 1,
          kind: 'execution',
          status: 'succeeded',
          triggerCode: 'scheduled',
          definitionVersion: 1,
          milestoneKey: 'm1',
          baseIntegrationCommit: 'aaaaaaaaaaaa',
          resultIntegrationCommit: 'bbbbbbbbbbbb',
          validatedTask: null,
          routeResolutions: [],
          reviewPlan: null,
          remediationPlan: null,
          verifierDigests: null,
          outcome: { code: 'integrated', summary: 'Done', changedFiles: [] },
          runs: { work: [{ id: 'run-12345678', purpose: 'work', status: 'completed', createdAt: NOW }] },
          createdAt: NOW,
          finishedAt: NOW,
        },
      ],
      total: 1,
      limit: 50,
    };
    serve(detailRoutes(detail(), { '/api/goals/goal-1/cycles': () => cycles }));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Cycles' }));
    expect(await screen.findByText(/Goal → cycles → finite Turing runs/)).toBeInTheDocument();
    expect(screen.getByLabelText('Child runs')).toHaveTextContent('run-123456');
  });

  it('performs only GET requests while browsing every tab', async () => {
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/cycles': () => ({ cycles: [], total: 0, limit: 50 }),
        '/api/goals/goal-1/reviews': () => ({ reviews: [], total: 0, limit: 50 }),
        '/api/goals/goal-1/findings': () => ({ findings: [], total: 0, limit: 100 }),
        '/api/goals/goal-1/evidence': () => ({ evidence: [], total: 0, limit: 100, integrationHead: null }),
        '/api/goals/goal-1/definitions': () => ({ definitions: [] }),
        '/api/goals/goal-1/usage': () => ({
          totals: { events: 0 },
          byModel: [],
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    for (const name of ['Cycles', 'Reviews', 'Findings', 'Evidence', 'Definitions', 'Usage', 'Overview'])
      await user.click(await screen.findByRole('tab', { name }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(6));
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.every((call) => call.url.includes('/api/goals'))).toBe(true);
  });
});

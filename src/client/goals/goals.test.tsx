// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GoalCyclesResponse,
  GoalDefinitionFull,
  GoalDefinitionSummary,
  GoalEvidenceResponse,
  GoalNextAction,
} from '../../shared/goalApi';
import type { GoalStatus } from '../../shared/goals';
import { describeNextAction } from './presentation';
import { GoalsPage } from './GoalsPage';
import { NOW, calls, detail, detailRoutes, evidenceRow, item, openGoal, preview, serve } from './testKit';

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
    await user.click(screen.getByRole('button', { name: 'Retry loading Grand Projects' }));
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
    expect(describeNextAction({ kind: 'final_apply' }).summary).toMatch(/immutable handoff/);
    expect(describeNextAction({ kind: 'final_apply' }).tone).toBe('attention');
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

  it('uses unique tab panels and roving Arrow/Home/End keyboard navigation without a mutation', async () => {
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/cycles': () => ({ cycles: [], total: 0, limit: 50 }),
        '/api/goals/goal-1/reviews': () => ({ reviews: [], total: 0, limit: 50 }),
        '/api/goals/goal-1/findings': () => ({ findings: [], total: 0, limit: 50 }),
        '/api/goals/goal-1/evidence': () => ({ evidence: [], total: 0, limit: 50 }),
        '/api/goals/goal-1/definitions': () => ({ definitions: [] }),
        '/api/goals/goal-1/usage': () => ({ totals: { events: 0 }, byModel: [] }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await screen.findByLabelText('Next action');
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Selected Goal' }));

    const tabs = screen.getAllByRole('tab');
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls') ?? ''));
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    expect(new Set(panels.map((panel) => panel?.id)).size).toBe(tabs.length);
    expect(panels.every((panel) => panel !== null)).toBe(true);
    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toBe('Overview');
    expect(panels[0]?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    await user.keyboard('{ArrowRight}');
    const cycles = screen.getByRole('tab', { name: 'Cycles' });
    expect(document.activeElement).toBe(cycles);
    expect(cycles.getAttribute('aria-selected')).toBe('true');
    expect(
      document.getElementById(cycles.getAttribute('aria-controls') ?? '')?.getAttribute('hidden'),
    ).toBeNull();

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(overview);
    await user.keyboard('{End}');
    const handoff = screen.getByRole('tab', { name: 'Handoff' });
    expect(document.activeElement).toBe(handoff);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(overview);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(handoff);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
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
    serve(detailRoutes(detail({ nextAction: { kind: 'final_apply' }, completion }), {}));
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
        .getByText(/Manual integration \(separate user step\)/)
        .closest('li'),
    ).toHaveAttribute('data-gate-state', 'unmet');
    expect(screen.queryByLabelText('Final apply preflight')).toBeNull();
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
    expect(
      calls.every((call) => call.url.includes('/api/goals') || call.url.includes('/api/approvals/unified')),
    ).toBe(true);
  });
});

const definitionSummary = (version: number): GoalDefinitionSummary => ({
  version,
  parentVersion: version > 1 ? version - 1 : null,
  status: 'approved',
  definitionHash: `hash${version}${'0'.repeat(10)}`,
  changeSummary: `Change ${version}`,
  createdBy: 'user',
  createdAt: NOW,
  approvedAt: NOW,
  approvedBy: 'user',
  approvalId: null,
});

const definitionFull = (version: number): GoalDefinitionFull => ({
  ...definitionSummary(version),
  goalId: 'goal-1',
  validation: { valid: true, errors: [], warnings: [] },
  definition: {
    contract: {
      outcome: `Outcome of version ${version}`,
      successCriteria: [],
      nonGoals: [],
      constraints: [],
      deliverables: [],
      completionPolicy: {
        requireFinalReview: true,
        requireUserAcceptance: false,
        applyToBase: 'required',
        maxOpenFindings: { critical: 0, high: 0 },
        highSeverityResolution: 'review-only',
      },
    },
    milestones: [],
    routing: {
      roles: {},
      pools: [],
      workflows: { planning: 'p', execution: 'e', review: 'r', verification: 'v' },
      independence: { finalReview: 'none', against: [], allowFloatingFinalReviewer: false },
    },
    review: {
      onMilestoneComplete: true,
      final: true,
      blocking: { periodic: false, milestone: true, final: true },
    },
    limits: {
      maxExecutionCycles: 10,
      maxConsecutiveFailedCycles: 3,
      maxRemediationAttempts: 3,
      maxActiveMinutes: 60,
      maxWallClockDays: 2,
      maxParallelAgents: 1,
      maxMeteredUsd: null,
      billingMode: 'subscriptions-only',
      humanGates: {
        eachCycle: false,
        beforeMilestoneComplete: false,
        poolRouteFirstUse: false,
        finalAcceptance: false,
      },
    },
  },
});

describe('Goal cockpit read-state correctness (7B.1A)', () => {
  it('Refresh re-reads Goal detail and the active tab only, and renders the new data', async () => {
    let head = 'aaaaaaaaaaaa';
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/evidence': () => ({
          evidence: [
            evidenceRow({
              subject: { commit: head, tree: null, path: null, reviewedToCommit: null, reviewedToTree: null },
            }),
          ],
          total: 1,
          limit: 100,
          integrationHead: head,
        }),
        '/api/goals/goal-1/reviews': () => ({ reviews: [], total: 0, limit: 50 }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Evidence' }));
    expect(await screen.findByText(/commit aaaaaaaaaa/)).toBeInTheDocument();
    const before = calls.length;
    head = 'bbbbbbbbbbbb';
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/commit bbbbbbbbbb/)).toBeInTheDocument();
    const after = calls.slice(before).map((call) => call.url.replace(/^https?:\/\/[^/]+/, ''));
    expect(after).toContain('/api/goals/goal-1');
    expect(after).toContain('/api/goals/goal-1/evidence');
    expect(after.some((url) => url.includes('/reviews'))).toBe(false);
    expect(
      after.some((url) => url.includes('/cycles') || url.includes('/findings') || url.includes('/usage')),
    ).toBe(false);
  });

  it('Refresh on Overview re-reads the preview', async () => {
    let tasks = 0;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/preview': () => {
          tasks += 1;
          return { preview: preview() };
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await screen.findByLabelText('Preview');
    await waitFor(() => expect(tasks).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(tasks).toBe(2));
  });

  it('never shows definition v1 under a pending v2', async () => {
    let releaseV2: () => void = () => undefined;
    const v2Gate = new Promise<void>((resolve) => (releaseV2 = resolve));
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/definitions': () => ({
          definitions: [definitionSummary(1), definitionSummary(2)],
        }),
        '/api/goals/goal-1/definitions/1': () => ({ definition: definitionFull(1) }),
        '/api/goals/goal-1/definitions/2': async () => {
          await v2Gate;
          return { definition: definitionFull(2) };
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Definitions' }));
    expect(await screen.findByText('Outcome of version 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /v2/ }));
    await screen.findByText(/Loading Definition v2/);
    expect(screen.queryByText('Outcome of version 1')).toBeNull();
    releaseV2();
    expect(await screen.findByText('Outcome of version 2')).toBeInTheDocument();
    expect(screen.queryByText('Outcome of version 1')).toBeNull();
  });

  const unmet = {
    ok: false,
    definitionVersion: 1,
    definitionHash: 'h',
    integrationHead: 'abc',
    integrationTree: 'def',
    failures: [{ code: 'criterion_unsatisfied' as const, subject: 'parse-ok', detail: 'Not yet.' }],
    finalReview: { required: true, ok: false, reason: 'final_review_missing' },
    finalAcceptance: { required: false, ok: true, approvalId: null, reason: null },
    finalApply: { required: true, ok: false, basis: null, reason: 'final_apply_required' },
  };

  it('does not mount or request the final-apply preflight unless nextAction is final_apply', async () => {
    serve(detailRoutes(detail({ nextAction: { kind: 'wait_for_turing' }, completion: unmet })));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await screen.findByLabelText('Completion');
    await screen.findByLabelText('Preview');
    expect(screen.queryByLabelText('Final apply preflight')).toBeNull();
    expect(calls.some((call) => call.url.includes('final-apply'))).toBe(false);
  });

  it('keeps the legacy preflight out of the ordinary overview and offers manual handoff review', async () => {
    serve(
      detailRoutes(
        detail({ nextAction: { kind: 'final_apply' }, completion: { ...unmet, ok: true, failures: [] } }),
      ),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    expect(await screen.findByLabelText('Completion')).toBeInTheDocument();
    expect(screen.queryByLabelText('Final apply preflight')).toBeNull();
    expect(calls.some((call) => call.url.includes('final-apply'))).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    expect(await screen.findByText(/Turing can prepare an immutable record/)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

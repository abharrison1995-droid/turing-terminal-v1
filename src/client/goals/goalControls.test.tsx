// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalDetail, GoalFindingView, GoalNextAction, UnifiedApproval } from '../../shared/goalApi';
import type { GoalStatus } from '../../shared/goals';
import { GoalsPage } from './GoalsPage';
import { UnifiedApprovals } from './UnifiedApprovals';
import { calls, detail, detailRoutes, item, openGoal, posts, refuse, serve, type Routes } from './testKit';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OK = { ok: true, goalStatus: 'running' };
const goal = (status: GoalStatus, nextAction: GoalNextAction, reasonCode: string | null = null): GoalDetail =>
  detail({ status, nextAction, reasonCode, needsUser: status === 'needs_user' || status === 'blocked' });
const postPaths = () => posts().map((call) => `${call.method} ${call.path}`);
const detailGets = () =>
  calls.filter((call) => call.method === 'GET' && call.path === '/api/goals/goal-1').length;

async function open(g: GoalDetail, extra: Routes = {}, strict = false) {
  serve(detailRoutes(g, extra));
  const user = userEvent.setup();
  render(
    strict ? (
      <StrictMode>
        <GoalsPage />
      </StrictMode>
    ) : (
      <GoalsPage />
    ),
  );
  await openGoal(user);
  await screen.findByLabelText('Next action');
  return user;
}
const controls = () => screen.queryByLabelText('Goal controls');

describe('Goal lifecycle controls', () => {
  it('Start: exactly one POST, refreshes on success, and decides no approval', async () => {
    const user = await open(goal('ready', { kind: 'start' }), { 'POST /api/goals/goal-1/start': () => OK });
    const before = detailGets();
    await user.click(await screen.findByRole('button', { name: 'Start Goal' }));
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before));
    expect(postPaths()).toEqual(['POST /api/goals/goal-1/start']);
    expect(posts()[0]!.body).toEqual({});
  });

  it('Start refusal is shown with its code, nothing is auto-approved, and state is re-read', async () => {
    const user = await open(goal('ready', { kind: 'start' }), {
      'POST /api/goals/goal-1/start': () =>
        refuse(409, 'The Goal waits for a first-use route approval.', 'gate_pending', {
          approvalId: 'a1b2c3d4-7777',
        }),
    });
    const before = detailGets();
    await user.click(await screen.findByRole('button', { name: 'Start Goal' }));
    const alert = await screen.findByText(/Not done:/);
    expect(alert.textContent).toContain('first-use route approval');
    expect(alert.textContent).toContain('Gate pending');
    expect(alert.textContent).toContain('a1b2c3d4');
    expect(alert.closest('[data-refusal-code]')?.getAttribute('data-refusal-code')).toBe('gate_pending');
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before));
    expect(postPaths()).toEqual(['POST /api/goals/goal-1/start']);
  });

  it('drops a success note once the server reports a different state', async () => {
    let current = goal('ready', { kind: 'start' });
    const user = await open(current, {
      '/api/goals/goal-1': () => ({ goal: current }),
      'POST /api/goals/goal-1/start': () => {
        current = goal('running', { kind: 'wait_for_turing' });
        return OK;
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Start Goal' }));
    await screen.findByRole('button', { name: 'Pause Goal' });
    expect(screen.queryByText(/Start Goal: done/)).toBeNull();
  });

  it('is not offered when the server does not advise start', async () => {
    await open(goal('ready', { kind: 'approve_definition', version: 2 }));
    expect(screen.queryByRole('button', { name: 'Start Goal' })).toBeNull();
  });

  it('Pause is offered only while running and performs only /pause', async () => {
    const user = await open(goal('running', { kind: 'wait_for_turing' }), {
      'POST /api/goals/goal-1/pause': () => ({ status: 'paused' }),
    });
    expect(screen.getByText(/Work already running is not cancelled/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause Goal' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(postPaths()).toEqual(['POST /api/goals/goal-1/pause']);
    expect(calls.some((call) => /cancel/.test(call.path))).toBe(false);
  });

  it('does not offer Pause while reviewing', async () => {
    await open(goal('reviewing', { kind: 'wait_for_turing' }));
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
    expect(controls()).toBeNull();
  });

  it('resumes a paused Goal with user_resume', async () => {
    const user = await open(goal('paused', { kind: 'resume' }), {
      'POST /api/goals/goal-1/resume': () => OK,
    });
    await user.click(screen.getByRole('button', { name: 'Resume Goal' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ reason: 'user_resume' });
  });

  it('retries a blocked Goal with blocker_resolved and keeps a refusal visible after the refresh', async () => {
    const user = await open(
      goal('blocked', { kind: 'resolve_blocker', reasonCode: 'repo_dirty' }, 'repo_dirty'),
      {
        'POST /api/goals/goal-1/resume': () =>
          refuse(409, 'The Goal cannot proceed: repo_dirty.', 'repo_dirty'),
      },
    );
    await user.click(screen.getByRole('button', { name: 'Retry after resolving blocker' }));
    expect(posts()[0]!.body).toEqual({ reason: 'blocker_resolved' });
    expect((await screen.findByText(/Not done:/)).textContent).toContain('repo_dirty');
    await waitFor(() => expect(detailGets()).toBeGreaterThan(1));
    expect(screen.getByText(/Not done:/)).toBeTruthy();
  });

  it('resumes an interrupted run through the Goal with run_resumed and chooses no run itself', async () => {
    const user = await open(goal('needs_user', { kind: 'resume_run', runId: 'run-9' }, 'run_interrupted'), {
      'POST /api/goals/goal-1/resume': () => OK,
    });
    await user.click(screen.getByRole('button', { name: 'Resume interrupted run' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.path).toBe('/api/goals/goal-1/resume');
    expect(posts()[0]!.body).toEqual({ reason: 'run_resumed' });
    expect(JSON.stringify(posts()[0]!.body)).not.toContain('run-9');
  });

  it('offers gate_resolved only for a resolved exact gate, as a separate explicit resume', async () => {
    const user = await open(goal('needs_user', { kind: 'resume' }, 'gate_pending'), {
      'POST /api/goals/goal-1/resume': () => OK,
    });
    await user.click(screen.getByRole('button', { name: 'Resume after gate' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ reason: 'gate_resolved' });
  });

  it('offers no resume for a bare "resume" when no persisted fact supports a reason', async () => {
    await open(goal('needs_user', { kind: 'resume' }, 'run_interrupted'));
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
  });

  it('offers no amendment resume and no definition control', async () => {
    await open(goal('needs_user', { kind: 'resume_after_amendment', resolved: [] }, 'amendment_in_progress'));
    expect(screen.queryByRole('button', { name: /Resume|Approve definition|Amend|Revise/ })).toBeNull();
  });

  it.each([
    ['needs_user', 'gate_pending'],
    ['blocked', 'gate_binding_invalid'],
  ] as const)('offers no control at all in manual_reconciliation (%s)', async (status, reason) => {
    await open(goal(status, { kind: 'manual_reconciliation' }, reason));
    expect(controls()).toBeNull();
    expect(screen.queryByRole('button', { name: /Start|Resume|Retry|Abandon|Pause/ })).toBeNull();
    expect(postPaths()).toEqual([]);
  });

  it('Abandon needs a deliberate confirmation and is not offered while running or reviewing', async () => {
    const user = await open(
      goal('paused', { kind: 'resume' }),
      { 'POST /api/goals/goal-1/abandon': () => ({ status: 'abandoned' }) },
      true,
    );
    const abandon = screen.getByRole('button', { name: 'Abandon Goal' });
    await user.click(abandon);
    const dialog = screen.getByRole('alertdialog', { name: 'Abandon this Goal?' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')?.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(dialog.querySelector('p')?.id);
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep Goal' }));
    expect(dialog.textContent).toContain('history stays recorded');
    expect(dialog.textContent).toContain('Nothing is applied to your branch');
    expect(posts()).toHaveLength(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(abandon);
    expect(posts()).toHaveLength(0);
    await user.click(abandon);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep Goal' }));
    expect(document.activeElement).toBe(abandon);
    await user.click(abandon);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abandon Goal' }));
    await waitFor(() => expect(postPaths()).toEqual(['POST /api/goals/goal-1/abandon']));
  });

  it.each(['running', 'reviewing'] as const)('never offers Abandon while %s', async (status) => {
    await open(goal(status, { kind: 'wait_for_turing' }));
    expect(screen.queryByRole('button', { name: 'Abandon Goal' })).toBeNull();
  });

  it('keeps final apply informational: no apply control and no apply request', async () => {
    await open(goal('running', { kind: 'final_apply' }));
    expect(await screen.findByLabelText('Next action')).toHaveTextContent('manual integration review');
    expect(screen.queryByLabelText('Final apply preflight')).toBeNull();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    expect(calls.some((call) => /final-apply/.test(call.path))).toBe(false);
  });

  it('prevents duplicate submission while a request is in flight', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const user = await open(goal('paused', { kind: 'resume' }), {
      'POST /api/goals/goal-1/resume': async () => {
        await held;
        return OK;
      },
    });
    const button = screen.getByRole('button', { name: 'Resume Goal' });
    await user.click(button);
    await user.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Resume Goal' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(posts()).toHaveLength(1);
  });
});

const approval = (overrides: Partial<UnifiedApproval>): UnifiedApproval => ({
  source: 'goal',
  id: 'ga-1',
  goalId: 'goal-1',
  title: 'each_cycle',
  gate: 'each_cycle',
  reason: 'Approve the next cycle',
  risk: 'medium',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
const runApproval = approval({
  source: 'run',
  id: 'ra-1',
  runId: 'run-1',
  title: 'git push',
  gate: undefined,
  reason: 'Push the branch',
  risk: 'high',
});
const listOf =
  (...approvals: UnifiedApproval[]) =>
  () => ({ approvals, total: approvals.length, limit: 20 });

describe('Unified approvals in the cockpit', () => {
  it('shows run and Goal approvals together with their source, risk and reason, and reads a bounded Goal-filtered list', async () => {
    await open(goal('running', { kind: 'wait_for_turing' }), {
      '/api/approvals/unified': listOf(approval({}), runApproval),
    });
    const rows = await screen.findAllByText(/Goal gate|Run action/);
    expect(rows.map((row) => row.textContent)).toEqual(['Goal gate', 'Run action']);
    const section = screen.getByLabelText('Approvals for this Goal');
    expect(section.textContent).toContain('Approve the next cycle');
    expect(section.textContent).toContain('Risk: Medium');
    expect(section.textContent).toContain('Risk: High');
    expect(
      within(section).getByRole('button', { name: 'Approve Goal gate: Each cycle (approval ga-1)' }),
    ).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: 'Approve Run action: git push for run run-1' }),
    ).toBeTruthy();
    const read = calls.find((call) => call.path === '/api/approvals/unified')!;
    expect(read.url).toContain('status=pending');
    expect(read.url).toContain('goalId=goal-1');
    expect(read.url).toContain('limit=20');
  });

  it('shows empty and error-with-retry states', async () => {
    let fail = true;
    const user = await open(goal('running', { kind: 'wait_for_turing' }), {
      '/api/approvals/unified': () => (fail ? refuse(500, 'down', 'x') : listOf()()),
    });
    expect((await screen.findByText(/Approvals could not be loaded/)).textContent).toContain('down');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry loading Approvals' }));
    expect(await screen.findByText('Nothing is waiting for your decision.')).toBeTruthy();
  });

  it('decides a run approval only through the run endpoint', async () => {
    const user = await open(goal('running', { kind: 'wait_for_turing' }), {
      '/api/approvals/unified': listOf(runApproval),
      'POST /api/approvals/ra-1/decision': () => ({ decided: true, approved: true }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve once' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(postPaths()).toEqual(['POST /api/approvals/ra-1/decision']);
    expect(posts()[0]!.body).toEqual({ approved: true });
  });

  it('decides a Goal approval only through the Goal endpoint, then only reads: no resume, no start', async () => {
    const user = await open(
      goal('needs_user', { kind: 'review_approval', approvalId: 'ga-1' }, 'gate_pending'),
      {
        '/api/approvals/unified': listOf(approval({})),
        'POST /api/goal-approvals/ga-1/decision': () => ({
          approvalId: 'ga-1',
          status: 'approved',
          changed: true,
        }),
      },
    );
    const before = detailGets();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before));
    expect(postPaths()).toEqual(['POST /api/goal-approvals/ga-1/decision']);
    expect(posts()[0]!.body).toEqual({ decision: 'approved' });
    expect(calls.some((call) => /\/(resume|start)$/.test(call.path))).toBe(false);
    expect((await screen.findByText(/The Goal was not resumed/)).textContent).toContain('approved');
  });

  it('denies a Goal approval without starting an amendment or resuming', async () => {
    const user = await open(
      goal('needs_user', { kind: 'review_approval', approvalId: 'ga-1' }, 'gate_pending'),
      {
        '/api/approvals/unified': listOf(approval({})),
        'POST /api/goal-approvals/ga-1/decision': () => ({
          approvalId: 'ga-1',
          status: 'denied',
          changed: true,
        }),
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ decision: 'denied' });
    expect(postPaths()).toEqual(['POST /api/goal-approvals/ga-1/decision']);
  });

  it('highlights the exact approval the Goal names', async () => {
    await open(goal('needs_user', { kind: 'review_approval', approvalId: 'ga-1' }, 'gate_pending'), {
      '/api/approvals/unified': listOf(approval({ id: 'ga-2' }), approval({ id: 'ga-1' })),
    });
    await screen.findAllByText('Goal gate');
    const expected = document.querySelectorAll('.approval-expected');
    expect(expected).toHaveLength(1);
    expect(expected[0]!.getAttribute('data-approval-id')).toBe('ga-1');
  });

  it('never decides another approval when the named one is missing', async () => {
    const user = await open(
      goal('needs_user', { kind: 'review_approval', approvalId: 'ga-A' }, 'gate_pending'),
      {
        '/api/approvals/unified': listOf(approval({ id: 'ga-B' })),
      },
    );
    const alert = await screen.findByText(/not among the pending approvals/);
    expect(alert.textContent).toContain('ga-A');
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await user.click(approve);
    expect(posts()).toHaveLength(0);
  });

  it('shows a refusal from the Goal approval endpoint and does not claim success', async () => {
    const user = await open(
      goal('needs_user', { kind: 'review_approval', approvalId: 'ga-1' }, 'gate_pending'),
      {
        '/api/approvals/unified': listOf(approval({})),
        'POST /api/goal-approvals/ga-1/decision': () => refuse(409, 'Already decided.', 'already_decided'),
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const refused = await screen.findByText(/Not recorded:/);
    expect(refused.textContent).toContain('Already decided');
    expect(refused.getAttribute('data-decision-outcome')).toBe('refused');
  });

  it('falls back to the final-acceptance desktop note when an older projection offers the decision', async () => {
    const user = await open(goal('running', { kind: 'final_acceptance', approvalId: 'fa-1' }), {
      '/api/approvals/unified': listOf(
        approval({
          id: 'fa-1',
          gate: 'final_acceptance',
          title: 'final_acceptance',
          reason: 'Accept the result',
          decidable: true,
        }),
      ),
      'POST /api/goal-approvals/fa-1/decision': () =>
        refuse(
          403,
          'Final acceptance can be decided on the Turing Terminal desktop app only.',
          'desktop_required',
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const refused = await screen.findByText(/Not recorded:/);
    expect(refused.textContent).toContain(
      'Final acceptance is decided on the Turing Terminal desktop app. Open Turing Terminal on desktop to decide it.',
    );
    expect(refused.textContent).not.toContain('Desktop Required');
  });

  it('keeps the generic refusal for desktop_required on another gate', async () => {
    const user = await open(
      goal('needs_user', { kind: 'review_approval', approvalId: 'ga-1' }, 'gate_pending'),
      {
        '/api/approvals/unified': listOf(approval({ decidable: true })),
        'POST /api/goal-approvals/ga-1/decision': () =>
          refuse(403, 'Decide this on the desktop.', 'desktop_required'),
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const refused = await screen.findByText(/Not recorded:/);
    expect(refused.textContent).toContain('Decide this on the desktop.');
    expect(refused.textContent).toContain('Desktop required');
    expect(refused.textContent).not.toContain('Final acceptance is decided');
  });

  it('keeps generic refusal handling for another code on final_acceptance', async () => {
    const user = await open(goal('running', { kind: 'final_acceptance', approvalId: 'fa-1' }), {
      '/api/approvals/unified': listOf(
        approval({
          id: 'fa-1',
          gate: 'final_acceptance',
          title: 'final_acceptance',
          reason: 'Accept the result',
          decidable: true,
        }),
      ),
      'POST /api/goal-approvals/fa-1/decision': () => refuse(409, 'Already decided.', 'already_decided'),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const refused = await screen.findByText(/Not recorded:/);
    expect(refused.textContent).toContain('Already decided.');
    expect(refused.textContent).toContain('Already decided');
    expect(refused.textContent).not.toContain(
      'Final acceptance is decided on the Turing Terminal desktop app.',
    );
  });

  it('handles final acceptance as a Goal approval that applies nothing', async () => {
    const user = await open(goal('running', { kind: 'final_acceptance', approvalId: 'fa-1' }), {
      '/api/approvals/unified': listOf(
        approval({
          id: 'fa-1',
          gate: 'final_acceptance',
          title: 'final_acceptance',
          reason: 'Accept the result',
        }),
      ),
      'POST /api/goal-approvals/fa-1/decision': () => ({
        approvalId: 'fa-1',
        status: 'approved',
        changed: true,
      }),
    });
    expect((await screen.findByLabelText('Approvals for this Goal')).textContent).toContain(
      'does not apply anything to your branch',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(postPaths()).toEqual(['POST /api/goal-approvals/fa-1/decision']);
    expect(calls.some((call) => /apply|resume|start/.test(call.path) && call.method !== 'GET')).toBe(false);
  });
});

const finding = (overrides: Partial<GoalFindingView>): GoalFindingView => ({
  id: 'f1',
  severity: 'high',
  category: 'security',
  description: 'Token logged in debug output',
  affectedFiles: ['src/log.ts'],
  status: 'open',
  firstSeenReviewId: 'review-1',
  lastSeenReviewId: 'review-1',
  resolvedByReviewId: null,
  decisionApprovalId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
const findingsOf =
  (...findings: GoalFindingView[]) =>
  () => ({ findings, total: findings.length, limit: 100 });
const findingsGets = () =>
  calls.filter((call) => call.method === 'GET' && call.path.endsWith('/findings')).length;

describe('Finding decisions', () => {
  const openFindings = async (findings: GoalFindingView[], extra: Routes = {}) => {
    const user = await open(goal('running', { kind: 'wait_for_turing' }), {
      '/api/goals/goal-1/findings': findingsOf(...findings),
      ...extra,
    });
    await user.click(screen.getByRole('tab', { name: 'Findings' }));
    await screen.findByRole('list', { name: 'Findings' });
    return user;
  };

  it('offers Accept/Dismiss only on an open finding', async () => {
    await openFindings([
      finding({}),
      finding({ id: 'f2', status: 'resolved' }),
      finding({ id: 'f3', status: 'accepted_by_user' }),
    ]);
    expect(screen.getAllByRole('button', { name: /Accept high finding|Dismiss high finding/ })).toHaveLength(
      2,
    );
    expect(document.querySelectorAll('[data-finding-status="resolved"] button')).toHaveLength(0);
    expect(document.querySelectorAll('[data-finding-status="accepted_by_user"] button')).toHaveLength(0);
  });

  it('confirms, sends only the decision and note, refreshes, and resumes nothing', async () => {
    const user = await openFindings([finding({})], {
      'POST /api/goals/goal-1/findings/f1/decision': () => ({
        findingId: 'f1',
        status: 'accepted_by_user',
        decisionApprovalId: 'ap-1',
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Accept high finding: Security' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Accept this high finding?' });
    expect(dialog.textContent).toContain('Accept this high finding?');
    expect(dialog.textContent).toContain('Token logged in debug output');
    expect(dialog.textContent).toContain('This is a high finding');
    expect(posts()).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Known and tracked');
    const findingsBefore = findingsGets();
    const detailBefore = detailGets();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm accept' }));
    await waitFor(() => expect(findingsGets()).toBeGreaterThan(findingsBefore));
    await waitFor(() => expect(detailGets()).toBeGreaterThan(detailBefore));
    expect(postPaths()).toEqual(['POST /api/goals/goal-1/findings/f1/decision']);
    expect(posts()[0]!.body).toEqual({ decision: 'accepted_by_user', note: 'Known and tracked' });
    expect(Object.keys(posts()[0]!.body as object).sort()).toEqual(['decision', 'note']);
    expect(JSON.stringify(posts()[0]!.body)).not.toMatch(/approval|hash|version|head|review/i);
    expect(calls.some((call) => /\/(resume|start)$/.test(call.path))).toBe(false);
    expect((await screen.findByText(/Nothing was resumed/)).getAttribute('data-finding-outcome')).toBe('ok');
  });

  it('dismisses with no note field when none is typed', async () => {
    const user = await openFindings([finding({ severity: 'low' })], {
      'POST /api/goals/goal-1/findings/f1/decision': () => ({
        findingId: 'f1',
        status: 'dismissed_by_user',
        decisionApprovalId: 'ap-1',
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Dismiss low finding: Security' }));
    await user.click(screen.getByRole('button', { name: 'Confirm dismiss' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ decision: 'dismissed_by_user' });
  });

  it('cancelling the confirmation sends nothing', async () => {
    const user = await openFindings([finding({})]);
    await user.click(screen.getByRole('button', { name: 'Dismiss high finding: Security' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('shows a server refusal and does not claim the decision happened', async () => {
    const user = await openFindings([finding({})], {
      'POST /api/goals/goal-1/findings/f1/decision': () =>
        refuse(409, 'A remediation is being integrated.', 'finding_integration_in_progress'),
    });
    await user.click(screen.getByRole('button', { name: 'Accept high finding: Security' }));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));
    const refused = await screen.findByText(/Not recorded:/);
    expect(refused.textContent).toContain('Finding integration in progress');
    expect(refused.getAttribute('data-finding-outcome')).toBe('refused');
    expect(document.querySelector('[data-finding-status="open"]')).not.toBeNull();
  });
});

describe('Terminalisation and fail-closed authority (7B.2A.1)', () => {
  const stuck = approval({ id: 'ga-9' });
  const openFinding = finding({});

  it('shows a server-refused Abandon with its code, keeps the Goal paused and refreshes', async () => {
    const user = await open(goal('paused', { kind: 'resume' }), {
      'POST /api/goals/goal-1/abandon': () =>
        refuse(
          409,
          'The Goal still has work in flight. Wait for it to finish, then abandon the Goal.',
          'goal_work_in_flight',
        ),
    });
    const before = detailGets();
    await user.click(screen.getByRole('button', { name: 'Abandon Goal' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abandon Goal' }));
    const alert = await screen.findByText(/Not done:/);
    expect(alert.textContent).toContain('work in flight');
    expect(alert.closest('[data-refusal-code]')?.getAttribute('data-refusal-code')).toBe(
      'goal_work_in_flight',
    );
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before));
    expect(screen.getByRole('button', { name: 'Resume Goal' })).toBeTruthy();
    expect(screen.queryByText(/Abandoned/)).toBeNull();
    expect(postPaths()).toEqual(['POST /api/goals/goal-1/abandon']);
  });

  it('offers no controls and no decisions on an abandoned Goal, even if stale data lists a pending gate', async () => {
    const user = await open(goal('abandoned', { kind: 'abandoned' }), {
      '/api/approvals/unified': listOf(stuck),
      '/api/goals/goal-1/findings': findingsOf(openFinding),
    });
    expect(controls()).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Approve|Deny)$/ })).toBeNull();
    expect(document.querySelector('[data-approval-readonly]')).not.toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Findings' }));
    await screen.findByRole('list', { name: 'Findings' });
    expect(screen.queryByRole('button', { name: /Accept finding|Dismiss finding/ })).toBeNull();
    expect(screen.getByText('Token logged in debug output')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('manual_reconciliation: no lifecycle, approval or finding mutation; Refresh and diagnostics remain', async () => {
    const g = goal('needs_user', { kind: 'manual_reconciliation' }, 'gate_pending');
    const user = await open(g, {
      '/api/approvals/unified': listOf(stuck, runApproval),
      '/api/goals/goal-1/findings': findingsOf(openFinding),
    });
    expect(controls()).toBeNull();
    expect(screen.queryByRole('button', { name: /Start|Resume|Retry|Pause|Abandon/ })).toBeNull();
    // The Goal's own approval is shown for diagnosis but cannot be decided; the Deny/Approve buttons of a run approval are unrelated.
    const goalRow = document.querySelector('[data-approval-source="goal"]')!;
    expect(goalRow.textContent).toContain('Approve the next cycle');
    expect(within(goalRow as HTMLElement).queryByRole('button')).toBeNull();
    expect(screen.queryByText(/not among the pending approvals/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Findings' }));
    await screen.findByRole('list', { name: 'Findings' });
    expect(screen.queryByRole('button', { name: /Accept finding|Dismiss finding/ })).toBeNull();
    expect(screen.getByText('Token logged in debug output')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('the global inbox shows a server-flagged non-decidable Goal row read-only and never POSTs for it', async () => {
    serve({
      '/api/approvals/unified': listOf(
        approval({ id: 'ga-1', decidable: false }),
        approval({ id: 'ga-2', decidable: true }),
      ),
      'POST /api/goal-approvals/ga-2/decision': () =>
        refuse(
          409,
          'This Goal needs manual reconciliation; its approvals cannot be decided here.',
          'manual_reconciliation_required',
        ),
    });
    const user = userEvent.setup();
    render(<UnifiedApprovals heading="Approval required" />);
    await screen.findAllByText('Goal gate');
    const rows = [...document.querySelectorAll('[data-approval-source="goal"]')];
    expect(within(rows[0] as HTMLElement).queryByRole('button')).toBeNull();
    // A row the client believes decidable is still refused by the server; the refusal is shown and nothing else happens.
    await user.click(
      within(rows[1] as HTMLElement).getByRole('button', {
        name: 'Approve Goal gate: Each cycle (approval ga-2)',
      }),
    );
    const refused = await screen.findByText(/Not recorded:/);
    expect(refused.textContent).toContain('Manual reconciliation required');
    expect(postPaths()).toEqual(['POST /api/goal-approvals/ga-2/decision']);
    expect(calls.some((call) => /\/(resume|start)$/.test(call.path))).toBe(false);
  });

  it('a dedicated correction or completion row has no decision controls and says where it is decided', async () => {
    serve({
      '/api/approvals/unified': listOf(
        approval({
          id: 'ga-c',
          gate: 'user_confirmation',
          decidable: false,
          dedicatedDecision: 'correction',
        }),
        approval({
          id: 'ga-k',
          gate: 'user_confirmation',
          decidable: false,
          dedicatedDecision: 'completion',
        }),
        approval({ id: 'ga-3', decidable: true }),
      ),
    });
    render(<UnifiedApprovals heading="Approval required" />);
    await screen.findAllByText('Goal gate');
    const rows = [...document.querySelectorAll('[data-approval-source="goal"]')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(rows[0]!.textContent).toContain('Decided in the correction review on the desktop.');
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(rows[1]!.textContent).toContain('Decided in the completion review on the desktop.');
    // A decidable row keeps its buttons; the dedicated line is not shown on it.
    expect(within(rows[2]!).getByRole('button', { name: /^Approve/ })).toBeTruthy();
    expect(within(rows[2]!).getByRole('button', { name: /^Deny/ })).toBeTruthy();
    expect(rows[2]!.textContent).not.toContain('review on the desktop');
  });

  it('an ordinary healthy Goal still decides approvals and findings', async () => {
    const user = await open(goal('running', { kind: 'wait_for_turing' }), {
      '/api/approvals/unified': listOf(approval({ decidable: true })),
      'POST /api/goal-approvals/ga-1/decision': () => ({
        approvalId: 'ga-1',
        status: 'approved',
        changed: true,
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(postPaths()).toEqual(['POST /api/goal-approvals/ga-1/decision']));
  });
});

describe('Mutation contract', () => {
  it('browsing every tab and refreshing issues no POST; only a user action does', async () => {
    const user = await open(goal('running', { kind: 'wait_for_turing' }), {
      '/api/goals/goal-1/cycles': () => ({ cycles: [], total: 0, limit: 50 }),
      '/api/goals/goal-1/reviews': () => ({ reviews: [], total: 0, limit: 50 }),
      '/api/goals/goal-1/findings': findingsOf(finding({})),
      '/api/goals/goal-1/evidence': () => ({ evidence: [], total: 0, limit: 100, integrationHead: null }),
      '/api/goals/goal-1/definitions': () => ({ definitions: [] }),
      '/api/goals/goal-1/usage': () => ({ totals: { events: 0 }, byModel: [] }),
    });
    for (const name of ['Cycles', 'Reviews', 'Findings', 'Evidence', 'Definitions', 'Usage', 'Overview']) {
      await user.click(await screen.findByRole('tab', { name }));
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
    }
    await screen.findByLabelText('Next action');
    expect(posts()).toHaveLength(0);
  });
});

void item;

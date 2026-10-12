// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalDetail, UnifiedApproval } from '../../shared/goalApi';
import type { ProjectProfile } from '../../shared/types';
import { GOAL_COMPACT_QUERY } from './useCompactViewport';
import { GoalsPage } from './GoalsPage';
import { calls, definitionFull, detail, detailRoutes, item, openGoal, posts, serve } from './testKit';

class TestEventSource {
  static instances: TestEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

const goalApproval = (overrides: Partial<UnifiedApproval> = {}): UnifiedApproval => ({
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

const runApproval = (): UnifiedApproval => ({
  source: 'run',
  id: 'ra-1',
  runId: 'run-1',
  goalId: 'goal-1',
  title: 'git push',
  reason: 'Push the branch',
  risk: 'high',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
});

class TestMediaQueryList implements MediaQueryList {
  readonly media = GOAL_COMPACT_QUERY;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null = null;
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();
  private readonly legacyListeners = new Set<(this: MediaQueryList, event: MediaQueryListEvent) => void>();

  constructor(public matches: boolean) {}

  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener) this.listeners.add(listener);
  }

  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    if (!listener) return;
    this.listeners.delete(listener);
  }

  addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null): void {
    if (listener) this.legacyListeners.add(listener);
  }

  removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null): void {
    if (listener) this.legacyListeners.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
    return !event.defaultPrevented;
  }

  dispatch(matches: boolean): void {
    this.matches = matches;
    const event = Object.assign(new Event('change'), {
      matches,
      media: this.media,
    }) as unknown as MediaQueryListEvent;
    for (const listener of this.listeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
    for (const listener of this.legacyListeners) listener.call(this, event);
    this.onchange?.call(this, event);
  }
}

function setCompact(matches: boolean): TestMediaQueryList {
  const query = new TestMediaQueryList(matches);
  vi.stubGlobal('matchMedia', (_media: string) => query);
  return query;
}

function installEventSource(): void {
  TestEventSource.instances = [];
  vi.stubGlobal('EventSource', TestEventSource);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  TestEventSource.instances = [];
});

describe('phone Goal cockpit', () => {
  it('uses a compact Goal list and cockpit with truthful needs-you, progress, approvals, and no authoring controls', async () => {
    setCompact(true);
    const goal = detail({
      status: 'needs_user',
      reasonCode: 'gate_pending',
      needsUser: true,
      pendingApprovalCount: 1,
      nextAction: { kind: 'review_approval', approvalId: 'ga-1' },
      activeCycle: {
        id: 'cycle-3',
        sequence: 3,
        kind: 'execution',
        status: 'waiting_for_user',
        triggerCode: 'scheduled',
        milestoneKey: 'm1',
        createdAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
      },
      childRun: { id: 'run-1', purpose: 'execution', status: 'waiting_for_approval' },
    });
    serve(
      detailRoutes(goal, {
        '/api/goals': () => ({
          goals: [
            item({
              status: 'needs_user',
              reasonCode: 'gate_pending',
              needsUser: true,
              pendingApprovalCount: 1,
              nextAction: { kind: 'review_approval', approvalId: 'ga-1' },
            }),
          ],
          total: 1,
          limit: 50,
        }),
        '/api/approvals/unified': () => ({ approvals: [goalApproval()], total: 1, limit: 20 }),
        'POST /api/goal-approvals/ga-1/decision': () => ({
          approvalId: 'ga-1',
          status: 'approved',
          changed: true,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);

    const list = await screen.findByRole('list', { name: 'Grand Projects' });
    expect(within(list).getByRole('button').className).toContain('goal-row-mobile');
    expect(screen.queryByRole('button', { name: /New Grand Project/ })).toBeNull();
    expect(
      screen.getByText('Create and edit Grand Project definitions from the desktop interface.'),
    ).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /Ship the importer/ }));

    expect(await screen.findByRole('heading', { name: 'Ship the importer' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent('Gate pending');
    expect(screen.getByLabelText('Next action')).toHaveTextContent('Review an approval');
    expect(screen.getByLabelText('Current progress')).toHaveTextContent('Parser');
    expect(screen.getByLabelText('Current progress')).toHaveTextContent('#3');
    expect(screen.getByLabelText('Current progress')).toHaveTextContent('Execution · Waiting for user');
    expect(
      screen.getByLabelText('Approvals for this Goal').querySelector('[data-approval-id="ga-1"]'),
    ).not.toBeNull();
    expect(
      screen.getByLabelText('Approvals for this Goal').querySelector('[data-approval-id="ga-1"]'),
    ).toHaveAttribute('data-approval-source', 'goal');
    expect(screen.queryByRole('tab', { name: 'Definitions' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Findings' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Start Goal|Abandon Goal|Accept finding|Dismiss finding|Apply/i }),
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts().map((call) => call.path)).toEqual(['/api/goal-approvals/ga-1/decision']);
    expect(calls.some((call) => /\/(resume|start)$/.test(call.path))).toBe(false);
  });

  it('dispatches unified run and Goal approvals to their own endpoints without resuming the Goal', async () => {
    setCompact(true);
    const goal = detail({
      status: 'needs_user',
      reasonCode: 'gate_pending',
      needsUser: true,
      nextAction: { kind: 'review_approval', approvalId: 'ga-1' },
    });
    serve(
      detailRoutes(goal, {
        '/api/approvals/unified': () => ({ approvals: [runApproval(), goalApproval()], total: 2, limit: 20 }),
        'POST /api/approvals/ra-1/decision': () => ({ decided: true, approved: true }),
        'POST /api/goal-approvals/ga-1/decision': () => ({
          approvalId: 'ga-1',
          status: 'approved',
          changed: true,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await screen.findByRole('button', { name: 'Approve Run action: git push for run run-1' });
    await user.click(screen.getByRole('button', { name: 'Approve Run action: git push for run run-1' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Approve Goal gate: Each cycle (approval ga-1)' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map((call) => call.path)).toEqual([
      '/api/approvals/ra-1/decision',
      '/api/goal-approvals/ga-1/decision',
    ]);
    expect(calls.some((call) => /\/(resume|start)$/.test(call.path))).toBe(false);
  });

  it('offers only pause and the exact server-proven resume reasons', async () => {
    setCompact(true);
    const running = detail({ status: 'running', nextAction: { kind: 'wait_for_turing' } });
    serve(detailRoutes(running, { 'POST /api/goals/goal-1/pause': () => ({ status: 'paused' }) }));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await user.click(await screen.findByRole('button', { name: 'Pause Goal' }));
    await waitFor(() => expect(posts().map((call) => call.path)).toEqual(['/api/goals/goal-1/pause']));
    cleanup();

    const resumable = detail({
      status: 'needs_user',
      nextAction: { kind: 'resume_after_amendment', resolved: ['amendment_approved', 'amendment_discarded'] },
    });
    serve(
      detailRoutes(resumable, {
        'POST /api/goals/goal-1/resume': () => ({ ok: true, goalStatus: 'running' }),
      }),
    );
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await user.click(await screen.findByRole('button', { name: 'Resume after approved amendment' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toEqual({ reason: 'amendment_approved' });
    expect(screen.queryByRole('button', { name: 'Start Goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abandon Goal' })).toBeNull();
  });

  it('keeps manual reconciliation read-only, including run approvals attached to the Goal', async () => {
    setCompact(true);
    const goal = detail({
      status: 'blocked',
      needsUser: true,
      nextAction: { kind: 'manual_reconciliation' },
    });
    serve(
      detailRoutes(goal, {
        '/api/approvals/unified': () => ({
          approvals: [runApproval(), goalApproval({ decidable: false })],
          total: 2,
          limit: 20,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    expect(await screen.findByText('This Goal needs manual reconciliation on the desktop.')).toBeTruthy();
    await screen.findAllByText(/Not actionable here/);
    expect(screen.queryByRole('button', { name: /Approve|Deny/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause|Resume|Abandon|Start/ })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it.each(['completed', 'abandoned'] as const)(
    'keeps run and Goal approvals read-only for a terminal %s Goal',
    async (status) => {
      setCompact(true);
      const goal = detail({
        status,
        nextAction: { kind: status === 'completed' ? 'completed' : 'abandoned' },
      });
      serve(
        detailRoutes(goal, {
          '/api/approvals/unified': () => ({
            approvals: [runApproval(), goalApproval()],
            total: 2,
            limit: 20,
          }),
        }),
      );
      const user = userEvent.setup();
      render(<GoalsPage />);
      await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
      await screen.findAllByText(/Not actionable here/);
      expect(screen.queryByRole('button', { name: /Approve|Deny/ })).toBeNull();
      expect(posts()).toEqual([]);
    },
  );

  it('fails closed when the exact Goal approval is absent from the unified inbox', async () => {
    setCompact(true);
    const goal = detail({
      status: 'needs_user',
      reasonCode: 'gate_pending',
      needsUser: true,
      nextAction: { kind: 'review_approval', approvalId: 'ga-expected' },
    });
    serve(
      detailRoutes(goal, {
        '/api/approvals/unified': () => ({
          approvals: [goalApproval({ id: 'ga-other' })],
          total: 1,
          limit: 20,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    expect(await screen.findByText(/not among the pending approvals/)).toBeTruthy();
    const other = screen
      .getByLabelText('Approvals for this Goal')
      .querySelector('[data-approval-id="ga-other"]');
    expect(other?.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    expect(posts()).toEqual([]);
  });

  it.each([
    [
      detail({ status: 'ready', nextAction: { kind: 'start' } }),
      'This Grand Project is ready. Start it from the desktop interface.',
    ],
    [
      detail({ status: 'draft', nextAction: { kind: 'author_definition' } }),
      'Definition changes require the desktop interface.',
    ],
    [
      detail({ status: 'draft', nextAction: { kind: 'approve_definition', version: 1 } }),
      'Definition changes require the desktop interface.',
    ],
    [
      detail({ status: 'ready', nextAction: { kind: 'revise_goal' } }),
      'Definition changes require the desktop interface.',
    ],
    [
      detail({ status: 'completed', nextAction: { kind: 'final_apply' } }),
      'This Goal is ready for manual-integration review. Open Turing Terminal on desktop to prepare and inspect the handoff. Your Git branch will not be changed automatically.',
    ],
  ])('shows a truthful desktop-only explanation for %s', async (goal, explanation) => {
    setCompact(true);
    serve(detailRoutes(goal));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    expect(await screen.findByText(explanation)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Start Goal|Abandon Goal|Apply|Approve definition|Revise Goal/i }),
    ).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('keeps desktop creation, definitions, and lifecycle controls available above the compact breakpoint', async () => {
    setCompact(false);
    const goal = detail({ status: 'ready', nextAction: { kind: 'start' } });
    serve(
      detailRoutes(goal, { 'POST /api/goals/goal-1/start': () => ({ ok: true, goalStatus: 'running' }) }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    expect(await screen.findByRole('button', { name: /New Grand Project/ })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    expect(await screen.findByRole('tab', { name: 'Definitions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Goal' })).toBeTruthy();
  });

  it('shows no completion review and no completion control on the phone cockpit', async () => {
    setCompact(true);
    serve(detailRoutes(detail({ status: 'running', nextAction: { kind: 'wait_for_turing' } })));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await screen.findByLabelText('Next action');
    expect(screen.queryByRole('tab', { name: 'Handoff' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Completion review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record completion decision' })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('opens one exact Goal EventSource, refreshes on events, closes on selection change, and ignores errors', async () => {
    setCompact(true);
    installEventSource();
    let firstGoal: GoalDetail = detail({ status: 'running', nextAction: { kind: 'wait_for_turing' } });
    const secondGoal = detail({
      id: 'goal-2',
      title: 'Fix the parser',
      status: 'paused',
      nextAction: { kind: 'resume' },
    });
    serve({
      '/api/goals': () => ({
        goals: [
          item(),
          item({ id: 'goal-2', title: 'Fix the parser', status: 'paused', nextAction: { kind: 'resume' } }),
        ],
        total: 2,
        limit: 50,
      }),
      '/api/goals/goal-1': () => ({ goal: firstGoal }),
      '/api/goals/goal-1/preview': () => ({ preview: {} }),
      '/api/goals/goal-2': () => ({ goal: secondGoal }),
      '/api/goals/goal-2/preview': () => ({ preview: {} }),
      '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
    });
    const user = userEvent.setup();
    const view = render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await screen.findByLabelText('Next action');
    expect(TestEventSource.instances).toHaveLength(1);
    const first = TestEventSource.instances[0]!;
    expect(new URL(first.url, window.location.origin).searchParams.get('goalId')).toBe('goal-1');
    const readsBeforeEvent = calls.filter((call) => call.path === '/api/goals/goal-1').length;
    firstGoal = { ...firstGoal, status: 'paused', reasonCode: 'user' };
    first.emit('state_changed');
    await waitFor(() => expect(document.querySelector('[data-goal-status="paused"]')).not.toBeNull());
    expect(calls.filter((call) => call.path === '/api/goals/goal-1').length).toBeGreaterThan(
      readsBeforeEvent,
    );
    first.emit('error');
    expect(posts()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Grand Projects' }));
    await user.click(await screen.findByRole('button', { name: /Fix the parser/ }));
    await screen.findByRole('heading', { name: 'Fix the parser' });
    expect(first.closed).toBe(true);
    expect(TestEventSource.instances).toHaveLength(2);
    expect(
      new URL(TestEventSource.instances[1]!.url, window.location.origin).searchParams.get('goalId'),
    ).toBe('goal-2');
    view.unmount();
    expect(TestEventSource.instances[1]!.closed).toBe(true);
  });
});

describe('responsive Goal authoring transitions', () => {
  it('pins a dirty definition editor through compact mode until explicit discard, and clears on resize back', async () => {
    const viewport = setCompact(false);
    const proposed = definitionFull(1, { status: 'proposed', approvedAt: null, approvedBy: null });
    const goal = detail({
      status: 'draft',
      nextAction: { kind: 'approve_definition', version: 1 },
      currentDefinitionVersion: null,
    });
    const summary = { ...proposed } as Record<string, unknown>;
    for (const key of ['definition', 'validation', 'goalId']) delete summary[key];
    serve(
      detailRoutes(goal, {
        '/api/goals/goal-1/definitions': () => ({ definitions: [summary] }),
        '/api/goals/goal-1/definitions/1': () => ({ definition: proposed }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Definitions' }));
    const editor = (await screen.findByLabelText('Definition JSON')) as HTMLTextAreaElement;
    const unsaved = '{"contract":{"outcome":"keep exactly"}}';
    fireEvent.change(editor, { target: { value: unsaved } });
    await screen.findByText('Unsaved changes');

    act(() => viewport.dispatch(true));
    const firstPrompt = await screen.findByRole('alertdialog', { name: 'Switch to phone view?' });
    expect((screen.getByLabelText('Definition JSON') as HTMLTextAreaElement).value).toBe(unsaved);
    expect(document.querySelector('.goal-mobile-cockpit')).toBeNull();
    expect(document.querySelector('.goals-page-compact')).toBeNull();
    expect(posts()).toEqual([]);
    await user.click(within(firstPrompt).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog', { name: 'Switch to phone view?' })).toBeNull();
    expect((screen.getByLabelText('Definition JSON') as HTMLTextAreaElement).value).toBe(unsaved);
    expect(document.querySelector('.goal-mobile-cockpit')).toBeNull();
    expect(posts()).toEqual([]);

    act(() => viewport.dispatch(false));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Switch to phone view?' })).toBeNull(),
    );
    act(() => viewport.dispatch(true));
    const secondPrompt = await screen.findByRole('alertdialog', { name: 'Switch to phone view?' });
    await user.click(within(secondPrompt).getByRole('button', { name: 'Discard and switch to phone view' }));
    await waitFor(() => expect(document.querySelector('.goal-mobile-cockpit')).not.toBeNull());
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Definitions' })).toBeNull();
    expect(posts()).toEqual([]);

    act(() => viewport.dispatch(false));
    await screen.findByRole('tab', { name: 'Definitions' });
    expect(screen.queryByRole('alertdialog', { name: 'Switch to phone view?' })).toBeNull();
    expect(((await screen.findByLabelText('Definition JSON')) as HTMLTextAreaElement).value).not.toBe(
      unsaved,
    );
    expect(posts()).toEqual([]);
  });

  it('preserves a dirty New Grand Project form through Keep editing and discards only on explicit switch', async () => {
    const viewport = setCompact(false);
    serve({ '/api/goals': () => ({ goals: [], total: 0, limit: 50 }) });
    const project = { id: 'project-1', name: 'Turing Terminal' } as unknown as ProjectProfile;
    const user = userEvent.setup();
    render(<GoalsPage projects={[project]} />);
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    await user.type(screen.getByLabelText('Title'), 'Keep this draft');
    const draft = '{"local":"draft text"}';
    fireEvent.change(screen.getByLabelText('Definition JSON'), { target: { value: draft } });

    act(() => viewport.dispatch(true));
    const prompt = await screen.findByRole('alertdialog', { name: 'Switch to phone view?' });
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Keep this draft');
    expect((screen.getByLabelText('Definition JSON') as HTMLTextAreaElement).value).toBe(draft);
    expect(document.querySelector('.goal-mobile-cockpit')).toBeNull();
    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Keep this draft');
    expect((screen.getByLabelText('Definition JSON') as HTMLTextAreaElement).value).toBe(draft);
    expect(posts()).toEqual([]);

    act(() => viewport.dispatch(false));
    act(() => viewport.dispatch(true));
    const discardPrompt = await screen.findByRole('alertdialog', { name: 'Switch to phone view?' });
    await user.click(within(discardPrompt).getByRole('button', { name: 'Discard and switch to phone view' }));
    await screen.findByText('No Grand Projects yet. Create a definition from the desktop interface.');
    expect(screen.queryByRole('region', { name: 'New Grand Project' })).toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.queryByLabelText('Definition JSON')).toBeNull();
    expect(document.querySelector('.goals-page-compact')).not.toBeNull();
    expect(posts()).toEqual([]);
  });

  it('closes an untouched New Grand Project form when entering compact mode without prompting', async () => {
    const viewport = setCompact(false);
    serve({ '/api/goals': () => ({ goals: [], total: 0, limit: 50 }) });
    const project = { id: 'project-1', name: 'Turing Terminal' } as unknown as ProjectProfile;
    const user = userEvent.setup();
    render(<GoalsPage projects={[project]} />);
    await user.click(await screen.findByRole('button', { name: /New Grand Project/ }));
    expect(screen.getByRole('region', { name: 'New Grand Project' })).toBeTruthy();

    act(() => viewport.dispatch(true));
    await screen.findByText('No Grand Projects yet. Create a definition from the desktop interface.');
    expect(screen.queryByRole('alertdialog', { name: 'Switch to phone view?' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'New Grand Project' })).toBeNull();
    expect(document.querySelector('.goals-page-compact')).not.toBeNull();
    expect(posts()).toEqual([]);
  });

  it('does not stack a compact prompt over the shell navigation guard', async () => {
    const viewport = setCompact(false);
    const proposed = definitionFull(1, { status: 'proposed', approvedAt: null, approvedBy: null });
    const goal = detail({
      status: 'draft',
      nextAction: { kind: 'approve_definition', version: 1 },
      currentDefinitionVersion: null,
    });
    const summary = { ...proposed } as Record<string, unknown>;
    for (const key of ['definition', 'validation', 'goalId']) delete summary[key];
    serve(
      detailRoutes(goal, {
        '/api/goals/goal-1/definitions': () => ({ definitions: [summary] }),
        '/api/goals/goal-1/definitions/1': () => ({ definition: proposed }),
      }),
    );
    const user = userEvent.setup();
    const view = render(<GoalsPage navigationGuardActive />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Definitions' }));
    fireEvent.change(await screen.findByLabelText('Definition JSON'), {
      target: { value: '{"dirty":true}' },
    });
    await screen.findByText('Unsaved changes');
    act(() => viewport.dispatch(true));
    expect(screen.queryByRole('alertdialog', { name: 'Switch to phone view?' })).toBeNull();
    expect(screen.getByLabelText('Definition JSON')).toBeTruthy();
    view.rerender(<GoalsPage navigationGuardActive={false} />);
    expect(await screen.findByRole('alertdialog', { name: 'Switch to phone view?' })).toBeTruthy();
    expect(posts()).toEqual([]);
  });
});

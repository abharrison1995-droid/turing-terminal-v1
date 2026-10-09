import { describe, expect, it } from 'vitest';
import type { GoalListItem, UnifiedApproval } from '../shared/goalApi.js';
import type { DashboardSnapshot } from '../shared/types.js';
import { notificationsForSnapshot } from './notificationEvents.js';

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    machine: {} as DashboardSnapshot['machine'],
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
      provenance: 'unavailable',
    },
    ...overrides,
  };
}

describe('browser notification events', () => {
  it('does not notify for the initial snapshot or unchanged runs', () => {
    const current = snapshot();
    expect(notificationsForSnapshot(null, current)).toEqual([]);
    expect(notificationsForSnapshot(current, snapshot())).toEqual([]);
  });

  it('notifies once when a run completes and avoids exposing the task text', () => {
    const previous = snapshot({
      runs: [
        { id: 'run-1', status: 'running', prompt: 'private task', projectName: 'private project' } as never,
      ],
    });
    const current = snapshot({
      runs: [
        { id: 'run-1', status: 'completed', prompt: 'private task', projectName: 'private project' } as never,
      ],
    });
    const notifications = notificationsForSnapshot(previous, current);
    expect(notifications).toEqual([
      {
        key: 'run:run-1:completed',
        title: 'Workflow completed',
        body: 'Open Turing Terminal to inspect the run.',
      },
    ]);
  });

  it('notifies when prompt refinement requires user confirmation', () => {
    const previous = snapshot({
      runs: [{ id: 'run-refine', status: 'running', refinePrompt: true } as never],
    });
    const current = snapshot({
      runs: [{ id: 'run-refine', status: 'waiting_for_user', refinePrompt: true } as never],
    });
    expect(notificationsForSnapshot(previous, current)).toEqual([
      {
        key: 'run:run-refine:waiting_for_user',
        title: 'Clarification required',
        body: 'Review the refined task specification to continue the workflow.',
      },
    ]);
  });

  it('announces new approvals and provider sign-in loss without revealing action details', () => {
    const provider = {
      id: 'codex-cli',
      authentication: 'connected',
      detected: true,
    } as DashboardSnapshot['providers'][number];
    const approval = { id: 'approval-1', status: 'pending', operation: 'write secrets' } as never;
    const current = snapshot({
      approvals: [approval],
      providers: [{ ...provider, authentication: 'disconnected' }],
    });
    const events = notificationsForSnapshot(snapshot({ providers: [provider] }), current);
    expect(events.map((event) => event.key)).toEqual([
      'approval:approval-1',
      'provider:codex-cli:disconnected',
    ]);
    expect(events.some((event) => event.body.includes('secrets'))).toBe(false);
  });

  it('notifies once for new Goal approvals and actionable needs-user transitions', () => {
    const goal = {
      id: 'goal-a',
      status: 'running',
      reasonCode: null,
      updatedAt: '2026-10-09T10:00:00.000Z',
    } as unknown as GoalListItem;
    const previous = snapshot({
      goals: { total: 1, active: 1, needsUser: 0, blocked: 0, paused: 0, cards: [goal] },
    });
    const approval = {
      source: 'goal',
      id: 'approval-a',
      goalId: 'goal-a',
      title: 'review',
      reason: 'private details',
      risk: 'medium',
      status: 'pending',
      createdAt: '2026-10-09T10:01:00.000Z',
    } as unknown as UnifiedApproval;
    const currentGoal = {
      ...goal,
      status: 'needs_user',
      reasonCode: 'gate_pending',
      pendingApprovalCount: 1,
      updatedAt: '2026-10-09T10:01:00.000Z',
    } as GoalListItem;
    const current = snapshot({
      goals: { total: 1, active: 0, needsUser: 1, blocked: 0, paused: 0, cards: [currentGoal] },
      goalApprovals: { pending: 1, approvals: [approval] },
    });

    expect(notificationsForSnapshot(previous, current)).toEqual([
      {
        key: 'goal-approval:approval-a',
        title: 'Grand Project needs approval',
        body: 'Open Turing Terminal to review the Goal gate.',
      },
    ]);
    expect(
      notificationsForSnapshot(
        current,
        snapshot({
          goals: { total: 1, active: 0, needsUser: 1, blocked: 0, paused: 0, cards: [currentGoal] },
          goalApprovals: { pending: 1, approvals: [approval] },
        }),
      ),
    ).toEqual([]);

    const alreadyNotifiedApproval = snapshot({
      goals: { total: 1, active: 1, needsUser: 0, blocked: 0, paused: 0, cards: [goal] },
      goalApprovals: { pending: 1, approvals: [approval] },
    });
    expect(notificationsForSnapshot(alreadyNotifiedApproval, current)).toEqual([]);

    const noApprovalTransition = snapshot({
      goals: {
        total: 1,
        active: 0,
        needsUser: 1,
        blocked: 0,
        paused: 0,
        cards: [{ ...currentGoal, reasonCode: 'scope_violation' }],
      },
    });
    expect(notificationsForSnapshot(previous, noApprovalTransition).map((event) => event.title)).toEqual([
      'Grand Project needs you',
    ]);
  });

  it('does not infer Goal completion from disappearance in bounded dashboard cards', () => {
    const previous = snapshot({
      goals: {
        total: 9,
        active: 1,
        needsUser: 0,
        blocked: 0,
        paused: 0,
        cards: [{ id: 'goal-a', status: 'running' } as never],
      },
    });
    const current = snapshot({
      goals: { total: 9, active: 1, needsUser: 0, blocked: 0, paused: 0, cards: [] },
    });
    expect(notificationsForSnapshot(previous, current)).toEqual([]);
  });
});

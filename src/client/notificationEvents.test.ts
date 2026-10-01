import { describe, expect, it } from 'vitest';
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
});

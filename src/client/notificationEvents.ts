import type { DashboardSnapshot } from '../shared/types.js';

type SnapshotSummary = Pick<DashboardSnapshot, 'runs' | 'approvals' | 'providers'>;

export interface BrowserNotificationEvent {
  key: string;
  title: string;
  body: string;
}

const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled']);

export function notificationsForSnapshot(
  previous: SnapshotSummary | null,
  current: SnapshotSummary | null,
): BrowserNotificationEvent[] {
  if (!previous || !current) return [];
  const events: BrowserNotificationEvent[] = [];
  const previousRuns = new Map(previous.runs.map((run) => [run.id, run.status]));
  for (const run of current.runs) {
    const oldStatus = previousRuns.get(run.id);
    if (oldStatus !== 'waiting_for_user' && run.status === 'waiting_for_user') {
      events.push({
        key: `run:${run.id}:waiting_for_user`,
        title: 'Clarification required',
        body: 'Review the refined task specification to continue the workflow.',
      });
      continue;
    }
    if (oldStatus === run.status || !terminalRunStatuses.has(run.status)) continue;
    const title =
      run.status === 'completed'
        ? 'Workflow completed'
        : run.status === 'failed'
          ? 'Workflow failed'
          : 'Workflow stopped';
    events.push({
      key: `run:${run.id}:${run.status}`,
      title,
      body: 'Open Turing Terminal to inspect the run.',
    });
  }

  const previousPending = new Set(
    previous.approvals.filter((approval) => approval.status === 'pending').map((approval) => approval.id),
  );
  for (const approval of current.approvals) {
    if (approval.status !== 'pending' || previousPending.has(approval.id)) continue;
    events.push({
      key: `approval:${approval.id}`,
      title: 'Approval required',
      body: 'Open Turing Terminal to review the requested action.',
    });
  }

  const previousProviders = new Map(previous.providers.map((provider) => [provider.id, provider]));
  for (const provider of current.providers) {
    const oldProvider = previousProviders.get(provider.id);
    if (
      oldProvider?.authentication !== 'connected' ||
      provider.authentication === 'connected' ||
      !provider.detected
    )
      continue;
    events.push({
      key: `provider:${provider.id}:disconnected`,
      title: 'Provider connection needs attention',
      body: 'Open Turing Terminal settings to check provider sign-in.',
    });
  }
  return events;
}

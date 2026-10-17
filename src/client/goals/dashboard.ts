import type { DashboardSnapshot } from '../../shared/types';

/** Run approvals and Goal approvals are separate sets; the total adds them and never counts one twice. */
export const pendingApprovalCounts = (snapshot: DashboardSnapshot | null) => {
  const run = snapshot?.approvals.length ?? 0;
  const goal = snapshot?.goalApprovals?.pending ?? 0;
  return { run, goal, total: run + goal };
};

/**
 * Changes whenever the dashboard's pending approvals change, so the unified list re-reads when new data arrives without
 * any extra polling of its own.
 */
export const approvalSignature = (snapshot: DashboardSnapshot): string =>
  [
    ...snapshot.approvals.map((approval) => `r${approval.id}`),
    ...(snapshot.goalApprovals?.approvals.map((approval) => `g${approval.id}`) ?? []),
  ].join(',');

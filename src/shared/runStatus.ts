import type { RunStatus } from './types.js';

/**
 * Run statuses the Stop control acts on. The server's `cancellable` flag and the client's active set both derive from
 * this one list, so they cannot drift. `cancelling` is absent: a stop already in flight needs no second control.
 */
export const STOPPABLE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'retrying',
];

/** Statuses of a run that has not settled: the stoppable set plus a stop already in flight. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [...STOPPABLE_RUN_STATUSES, 'cancelling'];

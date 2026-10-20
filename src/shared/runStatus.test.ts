import { describe, expect, it } from 'vitest';
import { ACTIVE_RUN_STATUSES, STOPPABLE_RUN_STATUSES } from './runStatus.js';

describe('run status sets', () => {
  it('derives the active set from the stoppable set plus a stop in flight', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual([...STOPPABLE_RUN_STATUSES, 'cancelling']);
    expect(STOPPABLE_RUN_STATUSES).not.toContain('cancelling');
  });

  it('never calls a settled or paused run stoppable', () => {
    for (const status of ['paused', 'paused_limit_reached', 'cancelled', 'failed', 'completed'] as const)
      expect(STOPPABLE_RUN_STATUSES).not.toContain(status);
  });
});

/**
 * An in-process FIFO mutex keyed by Goal id. It serializes completion decisions for one Goal inside this Node
 * process, so an identical concurrent request runs after the first one commits and sees its row. It is a convenience:
 * cross-process safety comes from `BEGIN IMMEDIATE` and the unique constraints on the decision and proof rows.
 */

/** Callers allowed to wait behind the holder of one Goal's lock. The next caller is refused with `completion_busy`. */
export const GOAL_COMPLETION_MAX_WAITERS = 8;

export class GoalCompletionLockError extends Error {
  readonly code = 'completion_busy' as const;

  constructor(readonly goalId: string) {
    super('Too many completion requests are waiting for this Goal. Try again shortly.');
    this.name = 'GoalCompletionLockError';
  }
}

interface Queue {
  /** Settles when the most recently queued caller has finished. Never rejects. */
  tail: Promise<void>;
  /** Callers that hold a place: the holder plus every waiter. */
  pending: number;
}

const queues = new Map<string, Queue>();

/**
 * Runs `run` after every earlier caller for the same Goal has finished, then releases the lock, even when `run` throws.
 * Callers for different Goals never wait for each other. A caller that finds the holder plus eight waiters is refused
 * before anything runs.
 */
export async function withGoalCompletionLock<T>(goalId: string, run: () => Promise<T> | T): Promise<T> {
  const queue = queues.get(goalId) ?? { tail: Promise.resolve(), pending: 0 };
  if (queue.pending > GOAL_COMPLETION_MAX_WAITERS) throw new GoalCompletionLockError(goalId);
  queues.set(goalId, queue);
  queue.pending += 1;

  const earlier = queue.tail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.tail = earlier.then(() => turn);

  await earlier;
  try {
    return await run();
  } finally {
    release();
    queue.pending -= 1;
    if (queue.pending === 0 && queues.get(goalId) === queue) queues.delete(goalId);
  }
}

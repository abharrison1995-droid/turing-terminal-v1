import { describe, expect, it } from 'vitest';
import {
  GOAL_COMPLETION_MAX_WAITERS,
  GoalCompletionLockError,
  withGoalCompletionLock,
} from './goalCompletionLock.js';

/** A promise that the test settles by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets every already-queued microtask and immediate callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('goal completion lock', () => {
  it('runs callers for one Goal in arrival order and never overlaps them', async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const hold = gate();
    const enter = (label: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`${label}:start`);
    };
    const leave = (label: string) => {
      active -= 1;
      events.push(`${label}:end`);
    };

    const first = withGoalCompletionLock('goal-fifo', async () => {
      enter('first');
      await hold.promise;
      leave('first');
      return 'first';
    });
    const second = withGoalCompletionLock('goal-fifo', async () => {
      enter('second');
      leave('second');
      return 'second';
    });
    const third = withGoalCompletionLock('goal-fifo', () => {
      enter('third');
      leave('third');
      return 'third';
    });

    await settle();
    expect(events).toEqual(['first:start']);
    hold.open();

    await expect(Promise.all([first, second, third])).resolves.toEqual(['first', 'second', 'third']);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'third:start',
      'third:end',
    ]);
    expect(maxActive).toBe(1);
  });

  it('lets callers for different Goals run while another Goal holds its lock', async () => {
    const hold = gate();
    const held = withGoalCompletionLock('goal-held', () => hold.promise.then(() => 'held'));
    await expect(withGoalCompletionLock('goal-free', () => 'free')).resolves.toBe('free');
    hold.open();
    await expect(held).resolves.toBe('held');
  });

  it('releases the lock when the holder throws, so the next caller runs', async () => {
    const failing = withGoalCompletionLock('goal-throw', () => {
      throw new Error('holder failed');
    });
    const next = withGoalCompletionLock('goal-throw', () => 'after');

    await expect(failing).rejects.toThrow('holder failed');
    await expect(next).resolves.toBe('after');
  });

  it('releases the lock when the holder rejects asynchronously', async () => {
    const failing = withGoalCompletionLock('goal-async-throw', async () => {
      await settle();
      throw new Error('async holder failed');
    });
    const next = withGoalCompletionLock('goal-async-throw', () => 'after async');

    await expect(failing).rejects.toThrow('async holder failed');
    await expect(next).resolves.toBe('after async');
  });

  it('refuses the caller beyond the holder and eight waiters with completion_busy and runs nothing for it', async () => {
    expect(GOAL_COMPLETION_MAX_WAITERS).toBe(8);
    const hold = gate();
    const holder = withGoalCompletionLock('goal-cap', () => hold.promise.then(() => 'holder'));
    const waiters = Array.from({ length: GOAL_COMPLETION_MAX_WAITERS }, (_, index) =>
      withGoalCompletionLock('goal-cap', () => `waiter ${index}`),
    );

    let refusedRan = false;
    const refused = withGoalCompletionLock('goal-cap', () => {
      refusedRan = true;
      return 'refused';
    });
    await expect(refused).rejects.toBeInstanceOf(GoalCompletionLockError);
    await expect(refused).rejects.toMatchObject({ code: 'completion_busy' });

    hold.open();
    await expect(holder).resolves.toBe('holder');
    await expect(Promise.all(waiters)).resolves.toEqual(
      Array.from({ length: GOAL_COMPLETION_MAX_WAITERS }, (_, index) => `waiter ${index}`),
    );
    expect(refusedRan).toBe(false);
    await expect(withGoalCompletionLock('goal-cap', () => 'free again')).resolves.toBe('free again');
  });
});

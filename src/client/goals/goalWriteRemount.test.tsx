// @vitest-environment jsdom

/*
 * A completion write that is in flight survives its panel. The panel can be unmounted by a selection change and mounted
 * again while the response is still held. These cases hold each response with a deferred promise that the test settles by
 * hand, so no timer and no sleep decides the order. The in-flight registry is module state, so it is cleared after each case.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { goalsApi } from './api';
import { COMPLETION_COPY, COMPLETION_RECOVERY_COPY } from './completionModel';
import { GoalCompletion } from './GoalCompletion';
import {
  beginInflight,
  clearInflightWritesForTests,
  type InflightWrite,
  isInflight,
  MAX_INFLIGHT_WRITES,
} from './inflightWrites';
import { posts, serve } from './testKit';
import {
  ACTION_A,
  ATT_A,
  ATT_B,
  COMPLETION_PATH,
  completedRecord,
  completionRoutes,
  completionStatus,
  created,
  decisionRow,
  GOAL,
  preflight,
} from './qualificationKit';

const IN_PROGRESS = 'A write for this review is still in progress. Reading the saved state…';
const COMPLETED_HEADING = 'Completed on a recorded decision. Turing has not proven content preservation.';

/** A promise that the test settles by hand. Nothing here waits on time. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The Complete write for the decision recorded on attestation A, as the registry names it. */
const completeWrite = (over: Partial<InflightWrite> = {}): InflightWrite => ({
  goalId: GOAL,
  handoffId: null,
  attestationId: ATT_A,
  kind: 'complete',
  identity: ACTION_A,
  detail: null,
  ...over,
});

const decidedStatus = () => completionStatus('decided', { decisions: [decisionRow(ATT_A, ACTION_A)] });

/** Waits for the completion region to finish its reads, without a timer. */
async function settledCompletion(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: COMPLETION_COPY.panelTitle });
  await waitFor(() => expect(region.getAttribute('aria-busy')).toBe('false'));
  return region;
}

/** Acknowledges the decided review and presses Complete Goal once. */
async function pressComplete(user: ReturnType<typeof userEvent.setup>, region: HTMLElement) {
  await user.click(within(region).getByRole('checkbox'));
  await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.completeLabel }));
}

afterEach(() => {
  cleanup();
  clearInflightWritesForTests();
  vi.restoreAllMocks();
});

describe('a Complete write that is in flight across a remount', () => {
  it('shows the write as in progress, sends it once, and shows the saved state when the held response settles', async () => {
    const user = userEvent.setup();
    const response = deferred<void>();
    let persisted = false;
    serve(
      completionRoutes(
        {
          status: () =>
            persisted
              ? completionStatus('completed', { completion: completedRecord(ATT_A) })
              : decidedStatus(),
        },
        {
          [`POST ${COMPLETION_PATH}`]: async () => {
            await response.promise;
            persisted = true;
            return created({ reused: false });
          },
        },
      ),
    );

    const first = render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const before = await settledCompletion();
    await pressComplete(user, before);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(isInflight(completeWrite())).toBe(true);
    first.unmount();

    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const remounted = await settledCompletion();
    expect(await within(remounted).findByText(IN_PROGRESS)).toBeTruthy();
    expect(within(remounted).getByRole('button', { name: COMPLETION_COPY.completeLabel })).toHaveProperty(
      'disabled',
      true,
    );
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
    expect(posts()).toHaveLength(1);

    await act(async () => {
      response.resolve();
    });
    expect(await within(remounted).findByText(COMPLETED_HEADING)).toBeTruthy();
    expect(within(remounted).queryByText(IN_PROGRESS)).toBeNull();
    expect(isInflight(completeWrite())).toBe(false);
    expect(posts()).toHaveLength(1);
  });
});

describe('a write that settles after navigation', () => {
  it("shows nothing from Goal A in Goal B's view and sends nothing for Goal B", async () => {
    const user = userEvent.setup();
    const response = deferred<void>();
    let persisted = false;
    serve({
      [COMPLETION_PATH]: () =>
        persisted ? completionStatus('completed', { completion: completedRecord(ATT_A) }) : decidedStatus(),
      [`POST ${COMPLETION_PATH}`]: async () => {
        await response.promise;
        persisted = true;
        return created({ reused: false });
      },
      '/api/goals/goal-2/completion': () => completionStatus('not_completed'),
      '/api/goals/goal-2/completion-preflight': () => ({ preflight: preflight(ATT_B) }),
    });

    const view = render(
      <GoalCompletion key={`${GOAL}:${ATT_A}`} goalId={GOAL} attestationId={ATT_A} refresh={0} />,
    );
    const goalA = await settledCompletion();
    await pressComplete(user, goalA);
    await waitFor(() => expect(posts()).toHaveLength(1));

    // The parent keys the panel by selection, so a Goal switch mounts a new instance.
    view.rerender(
      <GoalCompletion key={`goal-2:${ATT_B}`} goalId="goal-2" attestationId={ATT_B} refresh={0} />,
    );
    const goalB = await settledCompletion();
    expect(within(goalB).queryByText(IN_PROGRESS)).toBeNull();
    expect(
      goalB.querySelector('.goal-completion-state')?.classList.contains('goal-completion-not_completed'),
    ).toBe(true);

    await act(async () => {
      response.resolve();
    });
    for (let flush = 0; flush < 10; flush += 1) await act(async () => {});

    expect(goalB.textContent).not.toContain(COMPLETED_HEADING);
    expect(goalB.textContent).not.toContain('Completed earlier');
    expect(within(goalB).queryByText(IN_PROGRESS)).toBeNull();
    expect(
      goalB.querySelector('.goal-completion-state')?.classList.contains('goal-completion-completed'),
    ).toBe(false);
    expect(posts().filter((call) => call.path.includes('goal-2'))).toEqual([]);
    expect(posts()).toHaveLength(1);
  });
});

describe('a lost Complete response', () => {
  it('goes to the unknown-outcome path, removes its entry on settle, and is not sent again', async () => {
    const user = userEvent.setup();
    const response = deferred<void>();
    serve(
      completionRoutes(
        { status: decidedStatus },
        {
          [`POST ${COMPLETION_PATH}`]: () => response.promise,
        },
      ),
    );

    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const region = await settledCompletion();
    await pressComplete(user, region);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(isInflight(completeWrite())).toBe(true);

    await act(async () => {
      response.reject(new TypeError('Failed to fetch'));
    });
    expect(await within(region).findByText(COMPLETION_RECOVERY_COPY.completeStillRecorded)).toBeTruthy();
    expect(isInflight(completeWrite())).toBe(false);
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
    expect(posts()).toHaveLength(1);
  });
});

describe('a full in-flight registry', () => {
  it('sends no Complete write, keeps the control disabled, and says to wait or refresh', async () => {
    const user = userEvent.setup();
    serve(completionRoutes({ status: decidedStatus }));
    // Sixteen unresolved writes for another Goal fill the page's registry.
    for (let index = 0; index < MAX_INFLIGHT_WRITES; index += 1) {
      const handle = beginInflight(
        {
          goalId: 'goal-9',
          handoffId: null,
          attestationId: 'attestation-z',
          kind: 'record',
          identity: index.toString(16).padStart(64, '0'),
          detail: null,
        },
        'other-panel',
      );
      expect(handle).not.toBe('busy');
    }

    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const region = await settledCompletion();
    await pressComplete(user, region);
    expect(await within(region).findByText(COMPLETION_COPY.inFlightBusy)).toBeTruthy();
    expect(within(region).getByRole('button', { name: COMPLETION_COPY.completeLabel })).toHaveProperty(
      'disabled',
      true,
    );
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
    expect(posts()).toEqual([]);
    expect(isInflight(completeWrite())).toBe(false);
  });
});

describe('a Complete call that throws before it returns a promise', () => {
  it('settles its entry, sends nothing, and leaves no hold for a fresh mount to read', async () => {
    const user = userEvent.setup();
    serve(completionRoutes({ status: decidedStatus }));
    const complete = vi.spyOn(goalsApi, 'completeGoal').mockImplementationOnce(() => {
      throw new Error('synchronous failure before the request');
    });

    const first = render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const before = await settledCompletion();
    await pressComplete(user, before);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(isInflight(completeWrite())).toBe(false);
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
    expect(posts()).toEqual([]);
    first.unmount();

    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const remounted = await settledCompletion();
    expect(within(remounted).queryByText(IN_PROGRESS)).toBeNull();
    await user.click(within(remounted).getByRole('checkbox'));
    expect(within(remounted).getByRole('button', { name: COMPLETION_COPY.completeLabel })).toHaveProperty(
      'disabled',
      false,
    );
    expect(posts()).toEqual([]);
  });
});

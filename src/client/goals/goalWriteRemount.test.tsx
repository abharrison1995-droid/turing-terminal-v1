// @vitest-environment jsdom

/*
 * A completion write that is in flight survives its panel. The panel can be unmounted by a selection change and mounted
 * again while the response is still held. These cases hold each response with a deferred promise that the test settles by
 * hand, so no timer and no sleep decides the order. The in-flight registry is module state, so it is cleared after each case.
 *
 * The registry is page memory only. A page reload loses it. A write whose response was lost is then handled by the
 * server-side unknown-outcome read path, and the registry never resubmits anything. The cases at the end of this file
 * hold that limit and the launch points' synchronous-throw and double-click behaviour.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { goalsApi } from './api';
import { COMPLETION_COPY, COMPLETION_RECOVERY_COPY } from './completionModel';
import { GoalCompletion } from './GoalCompletion';
import {
  beginInflight,
  clearInflightWritesForTests,
  type InflightHandle,
  type InflightWrite,
  isInflight,
  MAX_INFLIGHT_WRITES,
  settleInflight,
} from './inflightWrites';
import { calls, posts, serve } from './testKit';
import {
  ACTION_A,
  ATT_A,
  ATT_B,
  COMPLETION_PATH,
  completedRecord,
  completionRoutes,
  completionStatus,
  created,
  DECISION_PATH,
  decisionRow,
  GOAL,
  PREFLIGHT_A,
  preflight,
  recordedDecision,
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

/** Two synchronous clicks on one control, inside one act(). No render, read or timer can run between them. */
function clickTwiceInOneAct(control: HTMLElement) {
  act(() => {
    fireEvent.click(control);
    fireEvent.click(control);
  });
}

/** Lets resolved promise callbacks run. Each turn is a microtask flush inside act(), not a timer. */
async function flushMicrotasks(turns = 5) {
  for (let turn = 0; turn < turns; turn += 1) await act(async () => {});
}

const recordWrite = (over: Partial<InflightWrite> = {}): InflightWrite => ({
  goalId: GOAL,
  handoffId: null,
  attestationId: ATT_A,
  kind: 'record',
  identity: PREFLIGHT_A,
  detail: null,
  ...over,
});

describe('launch controls fired twice synchronously in one act()', () => {
  it('Record completion decision sends exactly one decision write', async () => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    serve(
      completionRoutes(
        { status: () => completionStatus('not_completed') },
        { [`POST ${DECISION_PATH}`]: () => response.promise },
      ),
    );
    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    clickTwiceInOneAct(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
    expect(isInflight(recordWrite())).toBe(true);

    await act(async () => {
      response.resolve(created(recordedDecision(ATT_A)));
    });
    await waitFor(() => expect(isInflight(recordWrite())).toBe(false));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
  });

  it('Complete Goal sends exactly one completion write', async () => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    serve(
      completionRoutes({ status: decidedStatus }, { [`POST ${COMPLETION_PATH}`]: () => response.promise }),
    );
    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    clickTwiceInOneAct(within(region).getByRole('button', { name: COMPLETION_COPY.completeLabel }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
    expect(isInflight(completeWrite())).toBe(true);

    await act(async () => {
      response.resolve(created({ reused: false }));
    });
    await waitFor(() => expect(isInflight(completeWrite())).toBe(false));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
  });
});

describe('the known read-before-settle window', () => {
  // Known window, pinned so that a change to it is deliberate. Panel B's read begins while attestation A's Complete write is
  // unresolved in this page, and that write settles before B's read completes. The mechanism is that settleInflight
  // notifies only the panels for the same Goal and attestation scope, so B is not told and does not read again. The
  // GET count below observes that mechanism: B issues exactly one status GET, its initial read, and none after A's write
  // settles. A change that notifies every scope makes B refresh, which issues a second GET and fails this test. A fix that
  // closes the window must change that assertion, and this comment, deliberately. The server decides the click.
  it('shows Record enabled from a read begun before another attestation settled, and sends the click', async () => {
    const user = userEvent.setup();
    const read = deferred<unknown>();
    serve(
      completionRoutes(
        { status: () => read.promise },
        { [`POST ${DECISION_PATH}`]: () => created(recordedDecision(ATT_B)) },
      ),
    );
    const statusGets = () =>
      calls.filter((call) => call.method === 'GET' && call.path === COMPLETION_PATH).length;
    render(<GoalCompletion goalId={GOAL} attestationId={ATT_B} refresh={0} />);
    await waitFor(() => expect(statusGets()).toBe(1));

    const handleA = beginInflight(completeWrite(), 'panel-a');
    expect(handleA).not.toBe('busy');
    await act(async () => {
      settleInflight(handleA as InflightHandle);
    });
    await flushMicrotasks();
    expect(statusGets()).toBe(1);

    await act(async () => {
      read.resolve(completionStatus('not_completed'));
    });
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    const record = within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel });
    expect(record).toHaveProperty('disabled', false);
    await user.click(record);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.path).toBe(DECISION_PATH);
  });
});

describe('a synchronous throw from recordCompletionDecision', () => {
  it('settles its entry, sends nothing, and shows the unknown-outcome copy until the saved state is read', async () => {
    const user = userEvent.setup();
    const reread = deferred<unknown>();
    let reads = 0;
    serve(
      completionRoutes({
        status: () => {
          reads += 1;
          return reads === 1 ? completionStatus('not_completed') : reread.promise;
        },
      }),
    );
    const record = vi.spyOn(goalsApi, 'recordCompletionDecision').mockImplementationOnce(() => {
      throw new Error('synchronous failure before the request');
    });

    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));

    // The reducer's unknown-outcome branch: the notice is the reconciling copy, and no refusal is set.
    expect(await within(region).findByText(COMPLETION_RECOVERY_COPY.reconciling)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(isInflight(recordWrite())).toBe(false);
    expect(posts()).toEqual([]);

    await act(async () => {
      reread.resolve(completionStatus('not_completed'));
    });
    expect(await within(region).findByText(COMPLETION_RECOVERY_COPY.recordAbsent)).toBeTruthy();
    await user.click(within(region).getByRole('checkbox'));
    expect(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel })).toHaveProperty(
      'disabled',
      false,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });
});

describe('the registry is page memory only', () => {
  it('after a reload-equivalent clear and a remount, no write is sent without a user action', async () => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    serve(
      completionRoutes({ status: decidedStatus }, { [`POST ${COMPLETION_PATH}`]: () => response.promise }),
    );
    const first = render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const before = await settledCompletion();
    await pressComplete(user, before);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(isInflight(completeWrite())).toBe(true);
    first.unmount();

    // Module memory is what a page reload discards, and clearInflightWritesForTests stands in for that here.
    clearInflightWritesForTests();
    expect(isInflight(completeWrite())).toBe(false);
    serve(
      completionRoutes(
        { status: decidedStatus },
        { [`POST ${COMPLETION_PATH}`]: () => created({ reused: false }) },
      ),
    );
    render(<GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={0} />);
    const remounted = await settledCompletion();
    await flushMicrotasks();

    // The mount performs reads only. Zero writes are sent before any user action.
    expect(within(remounted).queryByText(IN_PROGRESS)).toBeNull();
    expect(posts()).toEqual([]);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    await act(async () => {
      response.resolve(created({ reused: false }));
    });
  });
});

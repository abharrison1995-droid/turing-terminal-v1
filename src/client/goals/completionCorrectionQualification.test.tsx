// @vitest-environment jsdom

/*
 * Qualification of the D.4F completion and correction behaviour against the directive's twenty requirements. Each case is
 * an assertion over behaviour; the requirement numbers are in each title. Everything here runs in jsdom: roles, text,
 * focus, classes and the requests a click or a read sends. It does not prove layout, colour rendering, screen-reader
 * output, real tab order or device behaviour. The static cases (QF12 to QF14) read source files with regular expressions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalCompletionStanding } from '../../shared/goalApi';
import { COMPLETION_COPY, COMPLETION_RECOVERY_COPY } from './completionModel';
import { CORRECTION_COPY, CORRECTION_RECOVERY_COPY } from './correctionModel';
import { GoalCompletion } from './GoalCompletion';
import { type CorrectionReplacementOption, GoalCorrection } from './GoalCorrection';
import { GoalsPage } from './GoalsPage';
import { clearInflightWritesForTests } from './inflightWrites';
import { calls, detail, openGoal, posts, refuse, serve, type Routes } from './testKit';
import {
  ACTION_A,
  ACTION_B,
  ATT_A,
  ATT_B,
  attestationInCall,
  CHAIN_POSITION,
  claim,
  COMPLETION_PATH,
  compactRoutes,
  CORRECTION_DECISION_PATH,
  CORRECTION_DIGEST,
  CORRECTIONS_PATH,
  completedRecord,
  completionRoutes,
  completionStatus,
  correctionHistory,
  correctionRequested,
  created,
  DECISION_PATH,
  decisionRow,
  GOAL,
  HANDOFF,
  handoffRoutes,
  pendingRow,
  PREFLIGHT_A,
  PREFLIGHT_B,
  PREFLIGHT_PATH,
  recordedDecision,
  setCompact,
  standing,
  standingDetail,
  statefulCompletion,
  trustedClaim,
} from './qualificationKit';

const REPLACEMENTS: CorrectionReplacementOption[] = [
  { attestationId: ATT_B, label: '10:00 · ddddd', title: 'd'.repeat(64) },
];

// Vitest runs from the project root. import.meta.url is not a file URL under jsdom, so paths come from the cwd.
const SRC_CLIENT = resolve(process.cwd(), 'src/client');
const GOALS_DIR = resolve(SRC_CLIENT, 'goals');

afterEach(() => {
  cleanup();
  clearInflightWritesForTests();
  vi.unstubAllGlobals();
});

// --- Helpers ---------------------------------------------------------------------------------------------------------

const gets = () => calls.filter((call) => call.method === 'GET').length;
const completionMounts = (refresh: number) => (
  <GoalCompletion goalId={GOAL} attestationId={ATT_A} refresh={refresh} />
);
const correctionMounts = (refresh: number) => (
  <GoalCorrection
    goalId={GOAL}
    handoffId={HANDOFF}
    attestationId={ATT_A}
    refresh={refresh}
    replacementOptions={REPLACEMENTS}
  />
);
const withOutside = (node: ReactElement) => (
  <>
    <input aria-label="Elsewhere" />
    {node}
  </>
);

/** The completion region once its reads have ended (aria-busy is false only then). */
async function settledCompletion(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: COMPLETION_COPY.panelTitle });
  await waitFor(() => expect(region.getAttribute('aria-busy')).toBe('false'));
  return region;
}

/** The correction region once its history has loaded. */
async function settledCorrection(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByText(CORRECTION_COPY.loading)).toBeNull());
  return screen.getByRole('region', { name: CORRECTION_COPY.panelTitle });
}

/** Text of a panel and of every named element under it, for wording scans. */
function wording(root: HTMLElement): string {
  const named = Array.from(root.querySelectorAll<HTMLElement>('[aria-label]')).map(
    (element) => element.getAttribute('aria-label') ?? '',
  );
  return [root.textContent ?? '', root.getAttribute('aria-label') ?? '', ...named].join('\n');
}

/** Removes the negated forms, so only a positive claim that the Goal is completed can match. "Goal was not completed" is covered too. */
const withoutNegations = (text: string) => text.replace(/not completed/gi, '');

/** Window and document events a page can fire while a review is open. None of them may send a write. */
async function fireAmbientEvents() {
  await act(async () => {
    for (const type of ['focus', 'blur', 'online', 'offline', 'resize', 'storage'])
      window.dispatchEvent(new Event(type));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The name a control exposes: its aria-label, its labelling text, its label element, or its own text. */
function accessibleName(element: HTMLElement): string {
  const explicit = element.getAttribute('aria-label');
  if (explicit) return explicit.trim();
  const ids = element.getAttribute('aria-labelledby');
  if (ids)
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement
  )
    if (element.labels && element.labels.length > 0)
      return Array.from(element.labels, (label) => label.textContent ?? '')
        .join(' ')
        .trim();
  return (element.textContent ?? '').trim();
}

const describeElement = (element: HTMLElement) => `${element.tagName}:${accessibleName(element)}`;

/** The wording a failed read may show: it names the read, not a write. */
const READ_FAILURE_FORBIDDEN = /may have|may still|reconcil|unconfirmed|do not assume|check again before/i;

/** The server text and the raw codes the read fixtures inject. None of them may reach the rendered text. */
const SERVER_SENTINEL = 'Server text that must not show.';
const RAW_SERVER_CODES = /external_completion_unavailable|completion_read_failed|correction_read_failed/;

/** Asserts that the page as a whole shows neither the injected server text nor a raw server code. */
function expectNoServerText() {
  const text = document.body.textContent ?? '';
  expect(text).not.toContain(SERVER_SENTINEL);
  expect(text).not.toMatch(RAW_SERVER_CODES);
}

const historyDisputed = (attestationId: string) =>
  correctionHistory(attestationId, {
    corrections: [
      {
        correctionId: 'c1',
        correctionKind: 'dispute',
        sequence: 1,
        correctionDigest: CORRECTION_DIGEST,
        previousCorrectionDigest: null,
        actionDigest: CORRECTION_DIGEST,
        approvalId: 'ap1',
        reasonCode: 'observation_error',
        explanation: null,
        replacementAttestationId: null,
        replacementRecordDigest: null,
        decidedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    standing: {
      goalId: GOAL,
      attestationId,
      standing: 'disputed',
      correctionCount: 1,
      tip: null,
      invalidCode: null,
    },
  });

const decidedStatus = () => completionStatus('decided', { decisions: [decisionRow(ATT_A, ACTION_A)] });

const READ_FAILURES: Array<[string, () => unknown]> = [
  ['a server fault', () => refuse(503, 'Server text that must not show.', 'external_completion_unavailable')],
  [
    'a lost response',
    () => {
      throw new TypeError('Failed to fetch');
    },
  ],
  ['an unusable success body', () => new Response('<html>not a record</html>', { status: 200 })],
];

/** Every read takes the same failures, so the status read is covered by the same list. */
const STATUS_READ_FAILURES = READ_FAILURES;

/** A read failure may say only that the review could not be read. It must not claim a write, and it offers none. */
function expectReadFailureOnly(root: HTMLElement) {
  expect(wording(root)).not.toMatch(READ_FAILURE_FORBIDDEN);
  expect(wording(root)).not.toContain(SERVER_SENTINEL);
  expect(wording(root)).not.toMatch(RAW_SERVER_CODES);
  expectNoServerText();
  expect(within(root).queryByRole('button', { name: COMPLETION_COPY.recordLabel })).toBeNull();
  expect(within(root).queryByRole('button', { name: COMPLETION_COPY.completeLabel })).toBeNull();
  expect(within(root).queryByRole('checkbox')).toBeNull();
  expect(posts()).toEqual([]);
}

// --- Completion and correction states, ambient triggers (QF01) -------------------------------------------------------

const COMPLETION_STATES: Array<[string, () => Routes]> = [
  ['a ready review', () => completionRoutes({ status: () => completionStatus('not_completed') })],
  ['a decided review', () => completionRoutes({ status: decidedStatus })],
  [
    'a completed Goal',
    () =>
      completionRoutes({
        status: () => completionStatus('completed', { completion: completedRecord(ATT_A) }),
      }),
  ],
  [
    'a contested Goal',
    () =>
      completionRoutes({
        status: () => completionStatus('contested', { qualifier: 'disputed_by_user' }),
      }),
  ],
  [
    'a legacy Goal',
    () =>
      completionRoutes({
        status: () => completionStatus('legacy', { qualifier: 'legacy_not_v2_attested' }),
      }),
  ],
  ['an invalid Goal', () => completionRoutes({ status: () => completionStatus('invalid') })],
];

/**
 * The Complete control each completion state shows once it is read after a remount, with no tick. Only a decided review
 * offers the control, and it is disabled until the user acknowledges it. Every other state shows no control at all.
 */
const COMPLETE_CONTROL_BY_STATE: Record<string, 'present-disabled' | 'absent'> = {
  'a ready review': 'absent',
  'a decided review': 'present-disabled',
  'a completed Goal': 'absent',
  'a contested Goal': 'absent',
  'a legacy Goal': 'absent',
  'an invalid Goal': 'absent',
};

const CORRECTION_STATES: Array<[string, () => Routes]> = [
  ['an idle history', () => ({ [CORRECTIONS_PATH(ATT_A)]: () => correctionHistory(ATT_A) })],
  [
    'a gate in the chain',
    () => ({
      [CORRECTIONS_PATH(ATT_A)]: () => correctionHistory(ATT_A, { pending: [pendingRow()] }),
    }),
  ],
  [
    'a gate out of date',
    () => ({
      [CORRECTIONS_PATH(ATT_A)]: () => correctionHistory(ATT_A, { pending: [pendingRow({ sequence: 4 })] }),
    }),
  ],
];

describe('QF01 ambient triggers never write', () => {
  it.each(COMPLETION_STATES)(
    'QF01 (requirements 1, 2, 3): %s sends no write on refresh, remount or window events',
    async (label, build) => {
      serve(build());
      const first = render(completionMounts(0));
      const region = await settledCompletion();
      const before = gets();
      for (const refresh of [1, 2, 3]) {
        first.rerender(completionMounts(refresh));
        await settledCompletion();
      }
      // Non-vacuous: the refresh bumps really re-read the saved state.
      expect(gets()).toBeGreaterThan(before);
      await fireAmbientEvents();
      expect(posts()).toEqual([]);
      expect(region.isConnected).toBe(true);

      first.unmount();
      serve(build());
      render(completionMounts(0));
      await settledCompletion();
      await fireAmbientEvents();
      expect(posts()).toEqual([]);
      // Complete Goal is never enabled without its own tick. Each state has an expected control, so a missing entry fails.
      const expected = COMPLETE_CONTROL_BY_STATE[label];
      expect(expected).toBeDefined();
      const complete = screen.queryByRole('button', { name: COMPLETION_COPY.completeLabel });
      if (expected === 'present-disabled') {
        expect(complete).not.toBeNull();
        expect(complete).toHaveProperty('disabled', true);
      } else {
        expect(complete).toBeNull();
      }
    },
  );

  it.each(CORRECTION_STATES)(
    'QF01 (requirements 1, 2, 3): correction %s sends no write on refresh, remount or window events',
    async (_label, build) => {
      serve(build());
      const first = render(correctionMounts(0));
      await settledCorrection();
      const before = gets();
      for (const refresh of [1, 2, 3]) {
        first.rerender(correctionMounts(refresh));
        await act(async () => {});
      }
      expect(gets()).toBeGreaterThan(before);
      await fireAmbientEvents();
      expect(posts()).toEqual([]);

      first.unmount();
      serve(build());
      render(correctionMounts(0));
      await settledCorrection();
      await fireAmbientEvents();
      expect(posts()).toEqual([]);
    },
  );
});

describe('QF02 a decision is never worded as a completion', () => {
  it('QF02 (requirement 4): a decided review says a decision is recorded and the Goal is not completed yet', async () => {
    serve(completionRoutes({ status: decidedStatus }));
    render(completionMounts(0));
    const region = await settledCompletion();
    expect(within(region).getByText(COMPLETION_COPY.recordedNotCompleted)).toBeTruthy();
    expect(withoutNegations(wording(region))).not.toMatch(/\bcompleted\b/i);
    expect(posts()).toEqual([]);
  });

  it('QF02 (requirement 4): a lost Complete whose saved state still shows the decision never says completed, and is not repeated', async () => {
    const user = userEvent.setup();
    serve(
      completionRoutes(
        { status: decidedStatus },
        {
          [`POST ${COMPLETION_PATH}`]: () => {
            throw new TypeError('Failed to fetch');
          },
        },
      ),
    );
    render(completionMounts(0));
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.completeLabel }));
    expect(await within(region).findByText(COMPLETION_RECOVERY_COPY.completeStillRecorded)).toBeTruthy();
    expect(withoutNegations(wording(region))).not.toMatch(/\bcompleted\b/i);
    expect(region.textContent).not.toContain('Completed on a recorded decision');
    expect(posts().map((call) => call.path)).toEqual([COMPLETION_PATH]);
  });

  it('QF02 (requirement 4): after a real Record click the review still says the Goal is not completed yet', async () => {
    const user = userEvent.setup();
    const goal = statefulCompletion(ATT_A);
    serve(completionRoutes({ status: goal.status }, goal.routes));
    render(completionMounts(0));
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
    expect(await within(region).findByText(COMPLETION_COPY.recordedNotCompleted)).toBeTruthy();
    expect(withoutNegations(wording(region))).not.toMatch(/\bcompleted\b/i);
    expect(posts().map((call) => call.path)).toEqual([DECISION_PATH]);
  });
});

// --- Keyboard and names (QF03a, QF03b) ------------------------------------------------------------------------------

const CONTROL_SELECTOR = 'button, input, select, textarea, a[href], [tabindex], [role="button"]';
const NATIVE_CONTROLS = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'];

type Arrange = () => Promise<HTMLElement>;

const CONTROL_STATES: Array<[string, Arrange]> = [
  [
    'a ready review',
    async () => {
      serve(completionRoutes({ status: () => completionStatus('not_completed') }));
      render(completionMounts(0));
      return settledCompletion();
    },
  ],
  [
    'a decided review',
    async () => {
      serve(completionRoutes({ status: decidedStatus }));
      render(completionMounts(0));
      return settledCompletion();
    },
  ],
  [
    'a refused record',
    async () => {
      const user = userEvent.setup();
      serve(
        completionRoutes(
          { status: () => completionStatus('not_completed') },
          { [`POST ${DECISION_PATH}`]: () => refuse(409, 'stale', 'completion_conflict') },
        ),
      );
      render(completionMounts(0));
      const region = await settledCompletion();
      await user.click(within(region).getByRole('checkbox'));
      await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
      await within(region).findByRole('alert');
      return region;
    },
  ],
  [
    'a reconciling review',
    async () => {
      const user = userEvent.setup();
      let reads = 0;
      serve(
        completionRoutes(
          {
            status: () => {
              reads += 1;
              return reads === 1
                ? completionStatus('not_completed')
                : refuse(503, 'Server text that must not show.', 'completion_read_failed');
            },
          },
          {
            [`POST ${DECISION_PATH}`]: () => {
              throw new TypeError('Failed to fetch');
            },
          },
        ),
      );
      render(completionMounts(0));
      const region = await settledCompletion();
      await user.click(within(region).getByRole('checkbox'));
      await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
      await within(region).findByRole('button', { name: COMPLETION_COPY.checkAgain });
      return region;
    },
  ],
  [
    'a completed Goal',
    async () => {
      serve(
        completionRoutes({
          status: () => completionStatus('completed', { completion: completedRecord(ATT_A) }),
        }),
      );
      render(completionMounts(0));
      return settledCompletion();
    },
  ],
  [
    'a contested Goal',
    async () => {
      serve(
        completionRoutes({
          status: () => completionStatus('contested', { qualifier: 'disputed_by_user' }),
        }),
      );
      render(completionMounts(0));
      return settledCompletion();
    },
  ],
  [
    'an idle correction history',
    async () => {
      serve({ [CORRECTIONS_PATH(ATT_A)]: () => correctionHistory(ATT_A) });
      render(correctionMounts(0));
      await screen.findByRole('button', { name: 'Dispute this attestation' });
      return settledCorrection();
    },
  ],
  [
    'an open correction review',
    async () => {
      const user = userEvent.setup();
      serve({ [CORRECTIONS_PATH(ATT_A)]: () => correctionHistory(ATT_A) });
      render(correctionMounts(0));
      await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
      await screen.findByRole('alertdialog', { name: 'Dispute this attestation?' });
      return settledCorrection();
    },
  ],
  [
    'a correction gate',
    async () => {
      serve({
        [CORRECTIONS_PATH(ATT_A)]: () => correctionHistory(ATT_A, { pending: [pendingRow()] }),
      });
      render(correctionMounts(0));
      await screen.findByRole('group', { name: CORRECTION_COPY.gateHeading });
      return settledCorrection();
    },
  ],
];

describe('QF03 controls are native, named and ordered', () => {
  it.each(CONTROL_STATES)(
    'QF03a (requirement 5): in %s every control is native, named and has no positive tab index',
    async (_label, arrange) => {
      const root = await arrange();
      const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        if (control.getAttribute('role') === 'button') expect(control.tagName).toBe('BUTTON');
        const tabIndex = control.getAttribute('tabindex');
        // A non-control focus target (the alert, a heading, a dialog root) may take -1. No control may.
        if (tabIndex !== null) {
          expect(tabIndex).toBe('-1');
          expect(NATIVE_CONTROLS).not.toContain(control.tagName);
        }
        expect(accessibleName(control).length).toBeGreaterThan(0);
      }
    },
  );

  it('QF03a (requirement 5): in the ready review, Tab visits each enabled control once, in DOM order', async () => {
    const user = userEvent.setup();
    serve(completionRoutes({ status: () => completionStatus('not_completed') }));
    render(completionMounts(0));
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    const expected = Array.from(
      region.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    );
    expect(expected).toHaveLength(2);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    const visited: string[] = [];
    for (let step = 0; step < expected.length; step += 1) {
      await user.tab();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement) visited.push(describeElement(focused));
    }
    expect(visited).toEqual(expected.map(describeElement));
  });
});

describe('QF03b correction by keyboard only', () => {
  it('QF03b (requirement 5): a correction is opened, escaped, reopened, requested and confirmed without a pointer', async () => {
    const user = userEvent.setup();
    let recorded = false;
    serve({
      [CORRECTIONS_PATH(ATT_A)]: () => (recorded ? historyDisputed(ATT_A) : correctionHistory(ATT_A)),
      [`POST ${CORRECTIONS_PATH(ATT_A)}`]: () => correctionRequested(),
      [`POST ${CORRECTION_DECISION_PATH}`]: () => {
        recorded = true;
        return { approvalId: 'ap1', status: 'approved' };
      },
    });
    render(correctionMounts(0));
    const dispute = await screen.findByRole('button', { name: 'Dispute this attestation' });
    act(() => dispute.focus());

    // Enter opens the review, and Escape closes it with no request and returns focus to the opener.
    await user.keyboard('{Enter}');
    await screen.findByRole('alertdialog', { name: 'Dispute this attestation?' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // A re-render can replace the opener's node, so focus is checked against the connected control with the same name.
    const opener = screen.getByRole('button', { name: 'Dispute this attestation' });
    expect(document.activeElement).toBe(opener);
    expect(posts()).toEqual([]);

    // Reopened: focus starts on Cancel, the safe action. Shift+Tab walks back to the reason select.
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog', { name: 'Dispute this attestation?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByLabelText(CORRECTION_COPY.explanationLabel));
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByLabelText(CORRECTION_COPY.reasonLabel));

    // The reason is chosen with selectOptions, because jsdom does not model arrow keys on a select. Every activation after
    // that is a keyboard key.
    await user.selectOptions(screen.getByLabelText(CORRECTION_COPY.reasonLabel), 'observation_error');
    await user.keyboard('{Tab}{Tab}{Tab}');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Request dispute' }));
    await user.keyboard('{Enter}');
    await screen.findByRole('group', { name: CORRECTION_COPY.gateHeading });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.path).toBe(CORRECTIONS_PATH(ATT_A));
    expect(posts()[0]?.headers['if-match']).toBe(`"${CHAIN_POSITION}"`);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: CORRECTION_COPY.confirmLabel }));
    await user.keyboard('{Enter}');
    expect(await screen.findByText(CORRECTION_COPY.recordedNote)).toBeTruthy();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.path).toBe(CORRECTION_DECISION_PATH);
    expect(posts()[1]?.headers['if-match']).toBe(`"${CORRECTION_DIGEST}"`);
    expect(posts()[1]?.body).toEqual({
      decision: 'approved',
      attestationId: ATT_A,
      correctionKind: 'dispute',
      explanation: null,
    });
  });
});

// --- Focus (QF04) ----------------------------------------------------------------------------------------------------

describe('QF04 focus stays where the user put it', () => {
  it.each([
    ['a successful refresh', null],
    ['a refresh whose read fails with 503', 503],
    ['a refresh whose read is rate limited (429)', 429],
  ] as const)(
    'QF04 (requirement 6): completion, %s, leaves focus on a field outside the panel',
    async (_label, failure) => {
      let failing: number | null = null;
      serve(
        completionRoutes({
          status: () =>
            failing === null
              ? completionStatus('not_completed')
              : refuse(failing, 'Server text that must not show.', 'completion_read_failed'),
        }),
      );
      const view = render(withOutside(completionMounts(0)));
      await settledCompletion();
      const outside = screen.getByRole('textbox', { name: 'Elsewhere' });
      act(() => outside.focus());
      failing = failure;
      view.rerender(withOutside(completionMounts(1)));
      await settledCompletion();
      if (failure !== null) await screen.findByRole('alert');
      await act(async () => {});
      expectNoServerText();
      expect(document.activeElement).toBe(outside);
    },
  );

  it.each([
    ['a successful refresh', null],
    ['a refresh whose read fails with 503', 503],
    ['a refresh whose read is rate limited (429)', 429],
  ] as const)(
    'QF04 (requirement 6): correction, %s, leaves focus on a field outside the panel',
    async (_label, failure) => {
      let failing: number | null = null;
      serve({
        [CORRECTIONS_PATH(ATT_A)]: () =>
          failing === null
            ? correctionHistory(ATT_A)
            : refuse(failing, 'Server text that must not show.', 'correction_read_failed'),
      });
      const view = render(withOutside(correctionMounts(0)));
      await settledCorrection();
      const outside = screen.getByRole('textbox', { name: 'Elsewhere' });
      act(() => outside.focus());
      failing = failure;
      view.rerender(withOutside(correctionMounts(1)));
      await act(async () => {});
      if (failure !== null) await screen.findByRole('alert');
      await act(async () => {});
      expectNoServerText();
      expect(document.activeElement).toBe(outside);
    },
  );

  it('QF04 (requirement 6): a focused Complete checkbox in a decided review survives a successful refresh', async () => {
    serve(completionRoutes({ status: decidedStatus }));
    const view = render(completionMounts(0));
    const region = await settledCompletion();
    const box = within(region).getByRole('checkbox');
    act(() => box.focus());
    view.rerender(completionMounts(1));
    await settledCompletion();
    await act(async () => {});
    expect(document.activeElement).toBe(box);
    expect(posts()).toEqual([]);
  });
});

// --- Read failures (QF05) --------------------------------------------------------------------------------------------

describe('QF05 read failures never claim a write', () => {
  it.each(STATUS_READ_FAILURES)(
    'QF05 (requirement 14): a completion status read that fails (%s) says the state could not be read and offers no write',
    async (_label, failure) => {
      serve(completionRoutes({ status: failure }));
      render(completionMounts(0));
      const region = await settledCompletion();
      const alert = await within(region).findByRole('alert');
      expect(alert.textContent).toMatch(/could not be read/);
      expectReadFailureOnly(region);
    },
  );

  it.each(READ_FAILURES)(
    'QF05 (requirement 14): a completion review read that fails (%s) says the review could not be read and offers no write',
    async (_label, failure) => {
      serve(
        completionRoutes({
          status: () => completionStatus('not_completed'),
          preflight: failure as (attestationId: string) => unknown,
        }),
      );
      render(completionMounts(0));
      const region = await settledCompletion();
      const alert = await within(region).findByRole('alert');
      expect(alert.textContent).toMatch(/could not be read/);
      expectReadFailureOnly(region);
    },
  );

  it.each(READ_FAILURES)(
    'QF05 (requirement 14): a correction history read that fails (%s) says the history could not be read and offers no write',
    async (_label, failure) => {
      serve({ [CORRECTIONS_PATH(ATT_A)]: failure as () => unknown });
      render(correctionMounts(0));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/could not be read/);
      expectReadFailureOnly(screen.getByRole('region', { name: CORRECTION_COPY.panelTitle }));
    },
  );
});

// --- Reconciliation under ambient pressure (QF06) ----------------------------------------------------------------------

describe('QF06 reconciliation holds under ambient pressure', () => {
  it('QF06 (requirement 13): a lost Record stays in reconciliation through refreshes, window events and a repeated Check again, with one write sent', async () => {
    const user = userEvent.setup();
    let reads = 0;
    serve(
      completionRoutes(
        {
          status: () => {
            reads += 1;
            return reads === 1
              ? completionStatus('not_completed')
              : refuse(503, 'Server text that must not show.', 'completion_read_failed');
          },
        },
        {
          [`POST ${DECISION_PATH}`]: () => {
            throw new TypeError('Failed to fetch');
          },
        },
      ),
    );
    const view = render(completionMounts(0));
    const region = await settledCompletion();
    await user.click(within(region).getByRole('checkbox'));
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
    expect(await within(region).findByText(COMPLETION_RECOVERY_COPY.unavailable)).toBeTruthy();
    expectNoServerText();

    for (const refresh of [1, 2, 3]) {
      view.rerender(completionMounts(refresh));
      await act(async () => {});
    }
    await fireAmbientEvents();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.path).toBe(DECISION_PATH);
    expect(within(region).queryByRole('button', { name: COMPLETION_COPY.recordLabel })).toBeNull();
    expect(within(region).queryByRole('button', { name: COMPLETION_COPY.completeLabel })).toBeNull();

    const before = reads;
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.checkAgain }));
    await act(async () => {});
    expect(reads).toBeGreaterThan(before);
    expect(posts()).toHaveLength(1);
  });

  it('QF06 (requirement 13): a lost correction request stays in reconciliation through refreshes and window events, with one request sent', async () => {
    const user = userEvent.setup();
    let reads = 0;
    serve({
      [CORRECTIONS_PATH(ATT_A)]: () => {
        reads += 1;
        return reads === 1
          ? correctionHistory(ATT_A)
          : refuse(503, 'Server text that must not show.', 'correction_read_failed');
      },
      [`POST ${CORRECTIONS_PATH(ATT_A)}`]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const view = render(correctionMounts(0));
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText(CORRECTION_COPY.reasonLabel), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    expect(await screen.findByText(CORRECTION_RECOVERY_COPY.unavailable)).toBeTruthy();
    expectNoServerText();

    for (const refresh of [1, 2, 3]) {
      view.rerender(correctionMounts(refresh));
      await act(async () => {});
    }
    await fireAmbientEvents();
    expect(posts()).toHaveLength(1);
    for (const name of [
      'Request dispute',
      'Request again',
      'Confirm correction',
      'Decline this request',
      'Dispute this attestation',
      'Withdraw this attestation',
      'Replace with another attestation',
    ])
      expect(screen.queryByRole('button', { name })).toBeNull();

    const before = reads;
    await user.click(screen.getByRole('button', { name: CORRECTION_RECOVERY_COPY.checkAgain }));
    await act(async () => {});
    expect(reads).toBeGreaterThan(before);
    expect(posts()).toHaveLength(1);
  });
});

// --- Recovery through the UI (QF07) ----------------------------------------------------------------------------------

describe('QF07 recovery through the UI', () => {
  it('QF07 (requirement 18): after the first decision is set aside, B is recorded and then completed, and no request names A', async () => {
    const user = userEvent.setup();
    const goal = statefulCompletion(ATT_B, [
      decisionRow(ATT_A, ACTION_A, { eligibility: 'ineligible', correctionStanding: 'disputed' }),
    ]);
    serve(completionRoutes({ status: goal.status }, goal.routes));
    render(<GoalCompletion goalId={GOAL} attestationId={ATT_B} refresh={0} />);
    const region = await settledCompletion();
    expect(within(region).getByText(COMPLETION_COPY.othersSetAside)).toBeTruthy();

    await user.click(within(region).getByRole('checkbox'));
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
    expect(await within(region).findByText(COMPLETION_COPY.recordedNotCompleted)).toBeTruthy();
    await user.click(within(region).getByRole('checkbox'));
    await user.click(within(region).getByRole('button', { name: COMPLETION_COPY.completeLabel }));
    expect(
      await within(region).findByText(
        'Completed on a recorded decision. Changed content matched at the observed merge.',
      ),
    ).toBeTruthy();

    expect(posts().map((call) => call.path)).toEqual([DECISION_PATH, COMPLETION_PATH]);
    expect(posts()[0]?.body).toEqual({
      decision: 'record_completion_decision',
      attestationId: ATT_B,
      acknowledgeContentNotProven: true,
    });
    expect(posts()[0]?.headers['if-match']).toBe(`"${PREFLIGHT_B}"`);
    expect(posts()[1]?.headers['if-match']).toBe(`"${ACTION_B}"`);
    expect(
      calls.some((call) => call.url.includes(ATT_A) || JSON.stringify(call.body ?? null).includes(ATT_A)),
    ).toBe(false);
  });
});

// --- Switching attestation (QF08) ------------------------------------------------------------------------------------

/** The history buttons of the Handoff tab, in list order. */
const attestationRows = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.goal-external-history .goal-version'));

const preflightCallsFor = (attestationId: string) =>
  calls.filter((call) => call.path === PREFLIGHT_PATH && call.url.includes(`attestationId=${attestationId}`))
    .length;

describe('QF08 switching attestation drops authority', () => {
  it('QF08 (requirement 12): choosing another attestation drops its acknowledgement, digest and write target, and a write goes to that attestation only', async () => {
    const user = userEvent.setup();
    serve(
      handoffRoutes(
        [ATT_A, ATT_B],
        completionRoutes(
          { status: () => completionStatus('not_completed') },
          { [`POST ${DECISION_PATH}`]: () => created(recordedDecision(attestationInCall())) },
        ),
      ),
    );
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(await screen.findByRole('tab', { name: 'Handoff' }));
    await waitFor(() => expect(attestationRows()).toHaveLength(2));

    await user.click(attestationRows()[0]!);
    const regionA = await settledCompletion();
    await user.click(within(regionA).getByRole('checkbox'));
    expect(within(regionA).getByRole('checkbox')).toHaveProperty('checked', true);

    const countB = preflightCallsFor(ATT_B);
    await user.click(attestationRows()[1]!);
    await waitFor(() => expect(preflightCallsFor(ATT_B)).toBeGreaterThan(countB));
    const regionB = await settledCompletion();
    expect(within(regionB).getByRole('checkbox')).toHaveProperty('checked', false);
    expect(within(regionB).getByRole('button', { name: COMPLETION_COPY.recordLabel })).toHaveProperty(
      'disabled',
      true,
    );
    expect(posts()).toEqual([]);

    await user.click(within(regionB).getByRole('checkbox'));
    await user.click(within(regionB).getByRole('button', { name: COMPLETION_COPY.recordLabel }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ attestationId: ATT_B });
    expect(posts()[0]?.headers['if-match']).toBe(`"${PREFLIGHT_B}"`);
    expect(posts()[0]?.headers['if-match']).not.toBe(`"${PREFLIGHT_A}"`);

    const countA = preflightCallsFor(ATT_A);
    await user.click(attestationRows()[0]!);
    await waitFor(() => expect(preflightCallsFor(ATT_A)).toBeGreaterThan(countA));
    const backToA = await settledCompletion();
    expect(within(backToA).getByRole('checkbox')).toHaveProperty('checked', false);
    expect(posts()).toHaveLength(1);
  });
});

// --- Standing to class to CSS (QF09) ---------------------------------------------------------------------------------

const COLOUR_CLASSES = ['goal-completion-contested', 'goal-completion-invalid', 'goal-completion-legacy'];

const STANDING_ROWS = [
  {
    label: 'a completed Goal',
    state: 'completed',
    heading: 'Completed on a recorded decision. Changed content matched at the observed merge.',
    desktop: () => completionStatus('completed', { completion: completedRecord(ATT_A) }),
    phone: (): GoalCompletionStanding => standing('v2', 'uncontested', trustedClaim()),
    phoneClass: null,
  },
  {
    label: 'a contested Goal',
    state: 'contested',
    heading: 'Completed earlier; later contested.',
    desktop: () => completionStatus('contested', { qualifier: 'disputed_by_user' }),
    phone: (): GoalCompletionStanding => standing('v2', 'disputed', claim('disputed_by_user')),
    phoneClass: 'goal-completion-contested',
  },
  {
    label: 'a legacy Goal',
    state: 'legacy',
    heading: 'Completed before external attestation existed. Not attested.',
    desktop: () => completionStatus('legacy', { qualifier: 'legacy_not_v2_attested' }),
    phone: (): GoalCompletionStanding =>
      standing('legacy', 'historical_legacy', claim('legacy_not_v2_attested')),
    phoneClass: 'goal-completion-legacy',
  },
  {
    label: 'an invalid Goal',
    state: 'invalid',
    heading: 'Completion records could not be verified.',
    desktop: () => completionStatus('invalid'),
    phone: (): GoalCompletionStanding => standing('invalid', 'invalid_unverified', claim('proof_unverified')),
    phoneClass: 'goal-completion-invalid',
  },
];

/** The declarations of every rule whose selector list names exactly this class. */
function declarationsOf(css: string, selector: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) =>
      match[1]!
        .split(',')
        .map((part) => part.trim())
        .includes(selector),
    )
    .map((match) => match[2]!);
}

describe('QF09 standing state reaches the class and the stylesheet', () => {
  it.each(STANDING_ROWS)(
    'QF09 (requirements 17, 10): $label shows its own heading and state class on desktop and phone',
    async (row) => {
      serve(completionRoutes({ status: row.desktop }));
      const desktop = render(completionMounts(0));
      const region = await settledCompletion();
      const desktopState = region.querySelector('.goal-completion-state');
      expect(desktopState?.textContent).toBe(row.heading);
      expect(desktopState?.classList.contains(`goal-completion-${row.state}`)).toBe(true);
      desktop.unmount();

      setCompact(true);
      serve(compactRoutes([{ id: GOAL, title: 'Ship the importer', goal: standingDetail(row.phone()) }]));
      const user = userEvent.setup();
      render(<GoalsPage />);
      await openGoal(user);
      const section = await screen.findByRole('region', { name: 'Completion standing' });
      const phoneState = section.querySelector('.goal-completion-state');
      expect(phoneState?.textContent).toBe(row.heading);
      for (const colour of COLOUR_CLASSES)
        expect(phoneState?.classList.contains(colour)).toBe(row.phoneClass === colour);
    },
  );

  it('QF09 (requirement 17): the three standing colours are declared, differ, and the completed state has no colour rule', () => {
    const css = readFileSync(resolve(SRC_CLIENT, 'styles/goals.css'), 'utf8');
    const colour = (selector: string) =>
      declarationsOf(css, selector).flatMap((body) =>
        [...body.matchAll(/(?:^|\s)color:\s*([^;]+);/g)].map((match) => match[1]!.trim()),
      );
    const contested = colour('.goal-completion-contested');
    const invalid = colour('.goal-completion-invalid');
    const legacy = colour('.goal-completion-legacy');
    expect(contested).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(legacy).toHaveLength(1);
    expect(new Set([...contested, ...invalid, ...legacy]).size).toBe(3);
    expect(colour('.goal-completion-completed')).toEqual([]);
    expect(new Set(STANDING_ROWS.map((row) => row.heading)).size).toBe(STANDING_ROWS.length);
  });
});

// --- Phone has no write control (QF10) -------------------------------------------------------------------------------

const PHONE_STATES: Array<[string, GoalCompletionStanding | undefined]> = [
  ['no standing', undefined],
  ['a trusted standing', standing('v2', 'uncontested', trustedClaim())],
  ['a disputed standing', standing('v2', 'disputed', claim('disputed_by_user'))],
  ['a withdrawn standing', standing('v2', 'withdrawn', claim('withdrawn_by_user'))],
  ['a legacy standing', standing('legacy', 'historical_legacy', claim('legacy_not_v2_attested'))],
  ['an invalid standing', standing('invalid', 'invalid_unverified', claim('proof_unverified'))],
  ['an unknown kind', standing('v9', 'mystery', claim('none'))],
  ['a not_completed kind', standing('not_completed', null, claim('not_completed'))],
];

const CONTROL_NAME =
  /Complete Goal|Record completion decision|Dispute|Withdraw|Replace with another|Confirm correction|Decline this request|Check again|Refresh review/;
const COMPLETION_REQUEST =
  /(completion|completion-preflight|completion-decision|corrections|attestation-corrections|handoffs)/;

describe('QF10 the phone offers no completion or correction control', () => {
  it.each(PHONE_STATES)(
    'QF10 (requirement 9): the phone Goal with %s has no completion or correction control, and opening it again sends nothing',
    async (_label, value) => {
      setCompact(true);
      serve(compactRoutes([{ id: GOAL, title: 'Ship the importer', goal: standingDetail(value) }]));
      const user = userEvent.setup();
      render(<GoalsPage />);
      await openGoal(user);
      await screen.findByRole('heading', { name: 'Ship the importer' });
      expect(screen.queryAllByRole('checkbox')).toEqual([]);
      expect(screen.queryAllByRole('textbox')).toEqual([]);
      expect(screen.queryAllByRole('combobox')).toEqual([]);
      expect(screen.queryAllByRole('form')).toEqual([]);
      // The Approve and Deny buttons of the approvals list are not asserted either way here (G14, an owner item).
      const controls = [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')];
      expect(
        controls.map((control) => control.textContent ?? '').filter((name) => CONTROL_NAME.test(name)),
      ).toEqual([]);
      expect(document.body.textContent ?? '').not.toMatch(/Complete Goal|Record completion decision/);

      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      await user.click(screen.getByRole('button', { name: 'Grand Projects' }));
      await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
      await screen.findByRole('heading', { name: 'Ship the importer' });
      expect(posts()).toEqual([]);
      expect(calls.some((call) => COMPLETION_REQUEST.test(call.path))).toBe(false);
    },
  );
});

// --- Late phone response (QF11) --------------------------------------------------------------------------------------

describe('QF11 a late phone response cannot reach another Goal', () => {
  it('QF11 (requirement 11): a Goal detail read held across a Goal switch never shows on the other Goal', async () => {
    setCompact(true);
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let firstReads = 0;
    const goalA = standingDetail(standing('v2', 'disputed', claim('disputed_by_user')));
    const goalB = detail({
      id: 'goal-2',
      title: 'Second goal',
      status: 'completed',
      nextAction: { kind: 'completed' },
      completionStanding: standing('v2', 'uncontested', trustedClaim()),
    });
    serve(
      compactRoutes(
        [
          { id: GOAL, title: 'Ship the importer', goal: goalA },
          { id: 'goal-2', title: 'Second goal', goal: goalB },
        ],
        {
          [`/api/goals/${GOAL}`]: () => {
            firstReads += 1;
            return firstReads === 1 ? { goal: goalA } : held;
          },
        },
      ),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    expect(await screen.findByText('Completed earlier; later contested.')).toBeTruthy();

    // Refresh starts a second read of Goal A that is held open.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(firstReads).toBe(2));
    await user.click(screen.getByRole('button', { name: 'Grand Projects' }));
    await user.click(await screen.findByRole('button', { name: /Second goal/ }));
    expect(
      await screen.findByText(
        'Completed on a recorded decision. Changed content matched at the observed merge.',
      ),
    ).toBeTruthy();

    await act(async () => {
      release({ goal: goalA });
    });
    for (let flush = 0; flush < 20; flush += 1) await act(async () => {});

    expect(screen.getByRole('heading', { name: 'Second goal' })).toBeTruthy();
    expect(screen.queryByText('Completed earlier; later contested.')).toBeNull();
    expect(screen.getByRole('region', { name: 'Completion standing' }).textContent).not.toContain(
      'later contested',
    );
    const pill = document.querySelector<HTMLElement>('.goal-mobile-heading [data-goal-status]');
    expect(pill?.className ?? '').toContain('goal-tone-done');
    expect(posts()).toEqual([]);
  });
});

// --- Static: the phone closure, the write closure and the write surface (QF12, QF13, QF14) -----------------------------

const TIMER_OR_DEFERRED = /set(?:Timeout|Interval)|requestAnimationFrame|queueMicrotask/;

/** The relative imports of one module, resolved to .ts or .tsx files that exist. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].flatMap((match) => {
    const base = resolve(dirname(file), match[1]!);
    const found = ['.ts', '.tsx']
      .map((extension) => `${base}${extension}`)
      .find((candidate) => existsSync(candidate));
    return found ? [found] : [];
  });
}

/** Every client module reachable from the entries through relative imports, as paths relative to src/client. Modules outside src/client are not followed. */
function clientClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of importsOf(file)) if (next.startsWith(SRC_CLIENT + sep)) queue.push(next);
  }
  return [...seen].map((path) => relative(SRC_CLIENT, path).split(sep).join('/')).sort();
}

const clientSource = (file: string) => readFileSync(resolve(SRC_CLIENT, file), 'utf8');

describe('QF12 to QF14 static boundaries', () => {
  it('QF12 (requirements 9, 20): the phone closure reaches no completion or correction write module, and no module but the goal client API names a write call', () => {
    const closure = clientClosure([resolve(GOALS_DIR, 'GoalMobileCockpit.tsx')]);
    for (const forbidden of [
      'goals/GoalCompletion.tsx',
      'goals/GoalCorrection.tsx',
      'goals/completionModel.ts',
      'goals/correctionModel.ts',
      'goals/GoalHandoff.tsx',
      'goals/GoalExternalIntegration.tsx',
    ])
      expect(closure).not.toContain(forbidden);
    // Non-vacuous: the closure really contains the standing copy and the goal client API.
    expect(closure).toContain('goals/completionStandingCopy.ts');
    expect(closure).toContain('goals/api.ts');
    const names =
      /recordCompletionDecision|completeGoal|requestCorrection|decideCorrection|completionPreflight|completionStatus|correctionHistory/;
    for (const file of closure) {
      if (file === 'goals/api.ts') continue;
      expect(clientSource(file)).not.toMatch(names);
    }
    expect(clientSource('goals/api.ts')).toMatch(names);
  });

  it('QF13 (requirements 15, 20): no module in the completion and correction write closure uses a timer or deferred run', () => {
    const closure = clientClosure([
      resolve(GOALS_DIR, 'GoalCompletion.tsx'),
      resolve(GOALS_DIR, 'GoalCorrection.tsx'),
    ]);
    for (const required of [
      'goals/completionModel.ts',
      'goals/correctionModel.ts',
      'goals/unknownOutcome.ts',
      'goals/api.ts',
    ])
      expect(closure).toContain(required);
    for (const file of closure) expect(clientSource(file)).not.toMatch(TIMER_OR_DEFERRED);
  });

  it('QF14 (requirements 20, 8): the client write surface is the pinned list, and each panel calls only its own writes', () => {
    const source = readFileSync(resolve(GOALS_DIR, 'api.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const body = source.slice(source.indexOf('export const goalsApi = {'));
    const members = [...body.matchAll(/^  (\w+):/gm)];
    const writers = members
      .flatMap((member, index) => {
        const text = body.slice(member.index ?? 0, members[index + 1]?.index ?? body.length);
        return /\b(?:post|postChecked|put)\s*[<(]/.test(text) ? [member[1]!] : [];
      })
      .sort();
    expect(writers).toEqual([
      'abandon',
      'approveDefinition',
      'beginRevision',
      'completeGoal',
      'confirmExternalIntegration',
      'createGoal',
      'decideApproval',
      'decideCorrection',
      'decideFinding',
      'pause',
      'prepareManualHandoff',
      'recordCompletionDecision',
      'rejectDefinition',
      'requestCorrection',
      'resume',
      'saveDefinition',
      'start',
    ]);
    expect(source).not.toMatch(/method:\s*'(?:DELETE|PATCH)'/);

    const callsOf = (file: string) =>
      // A write is a `.name(` call, whether or not `goalsApi` and the name sit on one line.
      [...readFileSync(resolve(GOALS_DIR, file), 'utf8').matchAll(/\.\s*(\w+)\s*\(/g)]
        .map((match) => match[1]!)
        .filter((name) => writers.includes(name))
        .sort();
    expect(callsOf('GoalCompletion.tsx')).toEqual(['completeGoal', 'recordCompletionDecision']);
    expect(callsOf('GoalCorrection.tsx')).toEqual(['decideCorrection', 'requestCorrection']);

    const external = readFileSync(resolve(GOALS_DIR, 'GoalExternalIntegration.tsx'), 'utf8');
    expect(external).toContain('key={`${goalId}:${selectedAttestationId}`}');
    expect(external).toContain('key={`${goalId}:${selectedAttestationId}:correction`}');
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GoalAttestationCorrectionHistory,
  GoalAttestationCorrectionPendingRequest,
  GoalAttestationCorrectionRequested,
} from '../../shared/goalApi';
import { type CorrectionReplacementOption, GoalCorrection } from './GoalCorrection';
import { calls, posts, refuse, serve, type Routes } from './testKit';

const GOAL = 'goal-1';
const HANDOFF = 'handoff-v2';
const ATT = 'att-1';
const OTHER = 'att-2';
const POS = 'a'.repeat(64);
const DIG = 'b'.repeat(64);
const CORRECTIONS = `/api/goals/${GOAL}/handoffs/${HANDOFF}/external-integration/attestations/${ATT}/corrections`;
const DECISION = `/api/goals/${GOAL}/attestation-corrections/ap1/decision`;
const OPTIONS: CorrectionReplacementOption[] = [
  { attestationId: OTHER, label: '10:00 · ddddd', title: 'd'.repeat(64) },
];

function history(over: Partial<GoalAttestationCorrectionHistory> = {}): GoalAttestationCorrectionHistory {
  return {
    goalId: GOAL,
    handoffId: HANDOFF,
    attestationId: ATT,
    standing: {
      goalId: GOAL,
      attestationId: ATT,
      standing: 'active_uncontested',
      correctionCount: 0,
      tip: null,
      invalidCode: null,
    },
    corrections: [],
    chainPosition: POS,
    pending: [],
    pendingUnreadableCount: 0,
    ...over,
  };
}

function pendingRow(
  over: Partial<GoalAttestationCorrectionPendingRequest> = {},
): GoalAttestationCorrectionPendingRequest {
  return {
    approvalId: 'ap1',
    actionDigest: DIG,
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    sequence: 1,
    previousCorrectionDigest: null,
    replacementAttestationId: null,
    explanationRequired: false,
    requestedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function requested(explanation = false): GoalAttestationCorrectionRequested {
  return {
    approvalId: 'ap1',
    actionDigest: DIG,
    status: 'pending',
    reused: false,
    detail: {
      correctionKind: 'dispute',
      sequence: 1,
      previousCorrectionDigest: null,
      replacementAttestationId: null,
      explanationDigest: explanation ? 'e'.repeat(64) : null,
      reasonCode: 'observation_error',
    },
  };
}

function mount(routes: Routes, props: Partial<{ refresh: number | string }> = {}) {
  serve(routes);
  return render(
    <GoalCorrection
      goalId={GOAL}
      handoffId={HANDOFF}
      attestationId={ATT}
      refresh={props.refresh ?? 0}
      replacementOptions={OPTIONS}
    />,
  );
}

const bodyOf = (index: number) => posts()[index]?.body as Record<string, unknown>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('correction controls: reads and confirmations', () => {
  it('a read on mount issues only GETs and offers the allowed actions', async () => {
    mount({ [CORRECTIONS]: () => history() });

    expect(await screen.findByRole('button', { name: 'Dispute this attestation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw this attestation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace with another attestation' })).toBeTruthy();
    expect(posts()).toHaveLength(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('a refresh and a remount issue no write', async () => {
    const routes = { [CORRECTIONS]: () => history() };
    const first = mount(routes);
    await screen.findByRole('button', { name: 'Dispute this attestation' });
    first.rerender(
      <GoalCorrection
        goalId={GOAL}
        handoffId={HANDOFF}
        attestationId={ATT}
        refresh={1}
        replacementOptions={OPTIONS}
      />,
    );
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2),
    );
    first.unmount();
    mount(routes);
    await screen.findByRole('button', { name: 'Dispute this attestation' });
    expect(posts()).toHaveLength(0);
  });

  it('each action opens its own confirmation with its consequence, and Cancel sends nothing', async () => {
    mount({ [CORRECTIONS]: () => history() });
    const user = userEvent.setup();
    const cases = [
      ['Dispute this attestation', 'Dispute this attestation?', 'standing becomes Disputed'],
      ['Withdraw this attestation', 'Withdraw this attestation?', 'standing becomes Withdrawn'],
      ['Replace with another attestation', 'Replace this attestation?', 'standing becomes Superseded'],
    ] as const;
    for (const [button, title, consequence] of cases) {
      await user.click(await screen.findByRole('button', { name: button }));
      const dialog = screen.getByRole('alertdialog', { name: title });
      expect(dialog).toHaveTextContent(consequence);
      expect(dialog).toHaveTextContent("The Goal's completion is not changed.");
      expect(dialog).toHaveTextContent('Another independent attestation is not affected.');
      expect(dialog).toHaveTextContent(
        'This sends a request for your confirmation. Nothing changes until you confirm on the next step.',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    }
    expect(posts()).toHaveLength(0);
  });

  it('a request sends one POST with the reviewed position in If-Match and exactly the allowed body keys', async () => {
    mount({ [CORRECTIONS]: () => history(), [`POST ${CORRECTIONS}`]: () => requested() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));

    await screen.findByRole('group', { name: 'A correction is waiting for your decision' });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.path).toBe(CORRECTIONS);
    expect(posts()[0]?.headers['if-match']).toBe(`"${POS}"`);
    expect(bodyOf(0)).toEqual({
      correctionKind: 'dispute',
      reasonCode: 'observation_error',
      explanation: null,
      replacementAttestationId: null,
    });
  });

  it('a supersede needs a chosen replacement and the request names it', async () => {
    mount({ [CORRECTIONS]: () => history(), [`POST ${CORRECTIONS}`]: () => requested() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Replace with another attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'wrong_source');
    expect(screen.getByRole('button', { name: 'Request replacement' })).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Attestation that replaces this one'), OTHER);
    await user.click(screen.getByRole('button', { name: 'Request replacement' }));

    await screen.findByRole('group', { name: 'A correction is waiting for your decision' });
    expect(bodyOf(0)).toMatchObject({ correctionKind: 'supersede', replacementAttestationId: OTHER });
  });

  it('a double click sends one request while the first is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount({
      [CORRECTIONS]: () => history(),
      [`POST ${CORRECTIONS}`]: async () => {
        await gate;
        return requested();
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    const request = screen.getByRole('button', { name: 'Request dispute' });
    await user.click(request);
    await user.click(request);
    expect(posts()).toHaveLength(1);
    release();
    await screen.findByRole('group', { name: 'A correction is waiting for your decision' });
    expect(posts()).toHaveLength(1);
  });
});

describe('correction controls: decisions', () => {
  it('a refused request keeps no decision control and shows the refusal', async () => {
    mount({
      [CORRECTIONS]: () => history(),
      [`POST ${CORRECTIONS}`]: () => refuse(409, 'stale', 'correction_chain_changed'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The history changed since you reviewed it. It was reloaded.',
    );
    expect(screen.queryByRole('button', { name: 'Confirm correction' })).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it('confirm sends one decision POST with If-Match set to the returned action digest', async () => {
    let recorded = false;
    mount({
      [CORRECTIONS]: () =>
        history({
          corrections: recorded
            ? [
                {
                  correctionId: 'c1',
                  correctionKind: 'dispute',
                  sequence: 1,
                  correctionDigest: DIG,
                  previousCorrectionDigest: null,
                  actionDigest: DIG,
                  approvalId: 'ap1',
                  reasonCode: 'observation_error',
                  explanation: null,
                  replacementAttestationId: null,
                  replacementRecordDigest: null,
                  decidedAt: '2026-10-01T00:00:00.000Z',
                },
              ]
            : [],
          standing: {
            goalId: GOAL,
            attestationId: ATT,
            standing: recorded ? 'disputed' : 'active_uncontested',
            correctionCount: recorded ? 1 : 0,
            tip: null,
            invalidCode: null,
          },
        }),
      [`POST ${CORRECTIONS}`]: () => requested(),
      [`POST ${DECISION}`]: () => {
        recorded = true;
        return { approvalId: 'ap1', status: 'approved' };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm correction' }));

    await waitFor(() => expect(screen.getByText('The correction is recorded in the history.')).toBeTruthy());
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.path).toBe(DECISION);
    expect(posts()[1]?.headers['if-match']).toBe(`"${DIG}"`);
    expect(bodyOf(1)).toEqual({
      decision: 'approved',
      attestationId: ATT,
      correctionKind: 'dispute',
      explanation: null,
    });
  });

  it('success is not shown when the follow-up read does not record the correction', async () => {
    mount({
      [CORRECTIONS]: () => history(),
      [`POST ${CORRECTIONS}`]: () => requested(),
      [`POST ${DECISION}`]: () => ({ approvalId: 'ap1', status: 'approved' }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm correction' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Turing could not confirm the result.');
    expect(screen.queryByText('The correction is recorded in the history.')).toBeNull();
  });

  it('an out-of-date decision blocks Confirm and still lets the user decline', async () => {
    let pendingNow = false;
    mount({
      [CORRECTIONS]: () => history({ pending: pendingNow ? [pendingRow()] : [] }),
      [`POST ${CORRECTIONS}`]: () => {
        pendingNow = true;
        return requested();
      },
      [`POST ${DECISION}`]: (body) => {
        if ((body as { decision: string }).decision === 'denied') {
          pendingNow = false;
          return { approvalId: 'ap1', status: 'denied' };
        }
        return refuse(409, 'stale', 'correction_chain_changed');
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm correction' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The history changed after you requested this correction, so it can no longer be confirmed.',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm correction' })).toHaveProperty('disabled', true),
    );
    expect(screen.getByRole('button', { name: 'Decline this request' })).toHaveProperty('disabled', false);

    await user.click(screen.getByRole('button', { name: 'Decline this request' }));
    await waitFor(() =>
      expect(screen.getByText('The request was declined. Nothing was changed.')).toBeTruthy(),
    );
    expect(posts()[posts().length - 1]?.headers['if-match']).toBe(`"${DIG}"`);
    expect(bodyOf(posts().length - 1)).toEqual({ decision: 'denied' });
  });

  it('a pending request found on read needs its explanation entered again before Confirm', async () => {
    mount({
      [CORRECTIONS]: () => history({ pending: [pendingRow({ explanationRequired: true })] }),
      [`POST ${DECISION}`]: () => ({ approvalId: 'ap1', status: 'approved' }),
    });
    const user = userEvent.setup();
    expect(
      await screen.findByText(
        'Turing does not keep the explanation you entered. Enter the same explanation exactly to confirm this correction.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm correction' })).toHaveProperty('disabled', true);

    await user.type(screen.getByLabelText('Explanation (optional, up to 1,000 characters)'), 'my words');
    await user.click(screen.getByRole('button', { name: 'Confirm correction' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(0)).toEqual({
      decision: 'approved',
      attestationId: ATT,
      correctionKind: 'dispute',
      explanation: 'my words',
    });
  });

  it('a read that fails says the history could not be read and offers no action', async () => {
    mount({ [CORRECTIONS]: () => refuse(500, 'boom', 'server_error') });
    expect(await screen.findByRole('alert')).toHaveTextContent('The correction history could not be read.');
    expect(screen.queryByRole('button', { name: 'Dispute this attestation' })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('no state shows a raw code or a field name', async () => {
    mount({
      [CORRECTIONS]: () => history({ pendingUnreadableCount: 1 }),
      [`POST ${CORRECTIONS}`]: () => refuse(409, 'stale', 'correction_chain_changed'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    await screen.findByRole('alert');

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(text).not.toMatch(
      /correctionKind|reasonCode|approvalId|chainPosition|actionDigest|replacementAttestationId/,
    );
    expect(text).toContain('A correction request could not be read. It is not shown and it is not acted on.');
  });
});

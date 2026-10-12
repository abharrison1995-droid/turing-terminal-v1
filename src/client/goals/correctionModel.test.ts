import { describe, expect, it } from 'vitest';
import type {
  GoalAttestationCorrectionHistory,
  GoalAttestationCorrectionPendingRequest,
  GoalAttestationCorrectionRequested,
  GoalAttestationCorrectionStandingView,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import {
  allowedCorrectionKinds,
  CORRECTION_ACTIONS,
  CORRECTION_COPY,
  CORRECTION_KIND_LABEL,
  CORRECTION_REASON_LABEL,
  correctionRefusal,
  correctionStandingLabel,
  type CorrectionDraft,
  type CorrectionEffect,
  type CorrectionEvent,
  type CorrectionState,
  initialCorrectionState,
  reduceCorrection,
  UNCONFIRMED_CORRECTION,
} from './correctionModel';

const POS = 'a'.repeat(64);
const DIG = 'b'.repeat(64);
const DIG2 = 'c'.repeat(64);

function standingView(
  over: Partial<GoalAttestationCorrectionStandingView> = {},
): GoalAttestationCorrectionStandingView {
  return {
    goalId: 'g1',
    attestationId: 'att1',
    standing: 'active_uncontested',
    correctionCount: 0,
    tip: null,
    invalidCode: null,
    ...over,
  };
}

function history(over: Partial<GoalAttestationCorrectionHistory> = {}): GoalAttestationCorrectionHistory {
  return {
    goalId: 'g1',
    handoffId: 'h1',
    attestationId: 'att1',
    standing: standingView(),
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

function requested(over: { explanation?: boolean } = {}): GoalAttestationCorrectionRequested {
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
      explanationDigest: over.explanation ? DIG2 : null,
      reasonCode: 'observation_error',
    },
  };
}

const draft = (over: Partial<CorrectionDraft> = {}): CorrectionDraft => ({
  kind: 'dispute',
  reasonCode: 'observation_error',
  explanation: '',
  replacementAttestationId: null,
  ...over,
});

/** Applies events in order and returns the final state and every effect produced. */
function run(start: CorrectionState, events: CorrectionEvent[]) {
  let state = start;
  const effects: CorrectionEffect[] = [];
  for (const event of events) {
    const next = reduceCorrection(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

/** A state with a clean standing loaded and the reviewed kind chosen. */
function reviewing(
  kind: 'dispute' | 'withdraw' | 'supersede' = 'dispute',
  standing?: GoalAttestationCorrectionStandingView,
) {
  return run(initialCorrectionState('att1'), [
    { type: 'loaded', history: history(standing ? { standing } : {}) },
    { type: 'review', kind },
  ]).state;
}

/** A state holding a pending gate reached through a successful request. */
function gated(explanationRequired: boolean, typed: string | null = null) {
  const start = reviewing();
  const body: CorrectionDraft = draft({ explanation: typed ?? '' });
  const after = run(start, [
    { type: 'request', draft: body },
    { type: 'requested', response: requested({ explanation: explanationRequired }) },
  ]);
  return after.state;
}

const WRITE_TYPES = new Set(['request', 'decide']);

describe('copy', () => {
  it('each consequence names the completion, the standing, the permanent history and the independent attestation', () => {
    for (const kind of ['dispute', 'withdraw', 'supersede'] as const) {
      const text = CORRECTION_ACTIONS[kind].consequence;
      expect(text).toContain("The Goal's completion is not changed.");
      expect(text).toContain('stays in the permanent history');
      expect(text).toContain('Another independent attestation is not affected.');
      expect(text).toContain('If the Goal is already completed, it will remain historically completed.');
    }
  });

  it('the dispute copy states the standing and never says it reopens, undoes, cancels or clears the completion', () => {
    const text = CORRECTION_ACTIONS.dispute.consequence;
    expect(text).toContain('standing becomes Disputed and it can no longer support a completion');
    expect(text).not.toMatch(/reopen|undo|cancel|clear/i);
  });

  it('the withdraw and supersede copy name their standing, and supersede names the replacement', () => {
    expect(CORRECTION_ACTIONS.withdraw.consequence).toContain('standing becomes Withdrawn');
    expect(CORRECTION_ACTIONS.supersede.consequence).toContain('standing becomes Superseded');
    expect(CORRECTION_ACTIONS.supersede.consequence).toContain(
      'the attestation you choose is named as its replacement',
    );
    expect(CORRECTION_ACTIONS.supersede.consequence).toContain(
      'Turing does not create a replacement for you.',
    );
  });

  it('no copy string names a code, a field, a digest or a header', () => {
    const copy: string[] = [];
    for (const [key, value] of Object.entries(CORRECTION_COPY)) {
      if (typeof value === 'string') copy.push(value);
      if (key === 'explanationCounter') copy.push(CORRECTION_COPY.explanationCounter(12));
    }
    for (const action of Object.values(CORRECTION_ACTIONS))
      copy.push(action.button, action.title, action.consequence, action.request);
    copy.push(...Object.values(CORRECTION_KIND_LABEL), ...Object.values(CORRECTION_REASON_LABEL));
    for (const standing of ['active_uncontested', 'disputed', 'withdrawn', 'superseded', 'invalid', 'x_raw'])
      copy.push(correctionStandingLabel(standing));
    copy.push(UNCONFIRMED_CORRECTION);
    for (const text of copy) {
      expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(text).not.toMatch(
        /correctionKind|reasonCode|replacementAttestationId|chainPosition|actionDigest|approvalId|explanationDigest|attestationId|previousCorrectionDigest|If-Match/,
      );
    }
  });

  it('an unknown standing value is never printed raw', () => {
    expect(correctionStandingLabel('x_raw')).toBe('Not recognised');
    expect(correctionStandingLabel(null)).toBe('Not available');
    expect(correctionStandingLabel('disputed')).toBe('Disputed by you');
  });

  it('the request-only line says that nothing changes until the next step', () => {
    expect(CORRECTION_COPY.requestOnly).toBe(
      'This sends a request for your confirmation. Nothing changes until you confirm on the next step.',
    );
  });
});

describe('allowed kinds', () => {
  it('offers all three kinds for a clean attestation with no correction', () => {
    expect(allowedCorrectionKinds(standingView())).toEqual(['dispute', 'withdraw', 'supersede']);
  });

  it('offers withdraw and supersede after a dispute, and nothing else', () => {
    const disputed = standingView({
      standing: 'disputed',
      correctionCount: 1,
      tip: {
        correctionId: 'c1',
        kind: 'dispute',
        sequence: 1,
        correctionDigest: DIG,
        replacementAttestationId: null,
      },
    });
    expect(allowedCorrectionKinds(disputed)).toEqual(['withdraw', 'supersede']);
  });

  it('offers nothing after withdrawal, supersession or an invalid record, and nothing without a read', () => {
    expect(allowedCorrectionKinds(standingView({ standing: 'withdrawn' }))).toEqual([]);
    expect(allowedCorrectionKinds(standingView({ standing: 'superseded' }))).toEqual([]);
    expect(allowedCorrectionKinds(standingView({ standing: 'invalid' }))).toEqual([]);
    expect(allowedCorrectionKinds(null)).toEqual([]);
  });
});

describe('refusal mapping', () => {
  const apiError = (status: number, code?: string) =>
    new ApiError('server text that must not show', status, code);

  it('a stale request reloads the history and keeps no form', () => {
    expect(correctionRefusal(apiError(409, 'correction_chain_changed'), 'request')).toEqual({
      message: 'The history changed since you reviewed it. It was reloaded.',
      next: 'reload',
    });
  });

  it('a bad replacement or explanation keeps the form open', () => {
    expect(correctionRefusal(apiError(422, 'replacement_invalid'), 'request').next).toBe('keep');
    expect(correctionRefusal(apiError(400, 'explanation_invalid'), 'request').next).toBe('keep');
  });

  it('a decision on a changed chain is out of date, and an explanation mismatch keeps the gate with the text to re-enter', () => {
    expect(correctionRefusal(apiError(409, 'correction_chain_changed'), 'decide').next).toBe('out_of_date');
    expect(correctionRefusal(apiError(409, 'approval_mismatch'), 'decide').next).toBe('out_of_date');
    expect(correctionRefusal(apiError(400, 'explanation_invalid'), 'decide').next).toBe('keep');
  });

  it('an unknown code on a 4xx is a generic refusal that prints no server text', () => {
    const refusal = correctionRefusal(apiError(409, 'some_new_code'), 'decide');
    expect(refusal).toEqual({ message: 'The request was refused. Nothing was changed.', next: 'keep' });
  });

  it('a request that the server could not record says so and reloads', () => {
    expect(correctionRefusal(apiError(503, 'attestation_correction_unavailable'), 'request')).toEqual({
      message: 'The request could not be recorded safely.',
      next: 'reload',
    });
  });

  it('a decision with a server failure, or no answer at all, is an unknown outcome that reloads', () => {
    expect(correctionRefusal(apiError(503, 'attestation_correction_unavailable'), 'decide')).toEqual({
      message: UNCONFIRMED_CORRECTION,
      next: 'reload',
    });
    expect(correctionRefusal(new Error('network down'), 'request')).toEqual({
      message: UNCONFIRMED_CORRECTION,
      next: 'reload',
    });
  });

  it('no refusal message prints a code', () => {
    const codes = [
      'invalid_request',
      'reviewed_action_precondition_required',
      'reviewed_action_precondition_invalid',
      'goal_not_found',
      'attestation_not_found',
      'attestation_invalid',
      'correction_chain_invalid',
      'replacement_invalid',
      'explanation_invalid',
      'correction_chain_changed',
      'correction_transition_not_allowed',
      'goal_terminal',
      'correction_request_pending',
      'correction_request_already_decided',
      'attestation_correction_unavailable',
      'persistence_failed',
      'approval_mismatch',
      'approval_required',
      'correction_action_mismatch',
      'approval_not_found',
      'already_decided',
      'idempotency_conflict',
    ];
    for (const code of codes)
      for (const operation of ['request', 'decide'] as const) {
        const { message } = correctionRefusal(apiError(409, code), operation);
        expect(message).not.toContain(code);
        expect(message).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      }
  });
});

describe('reducer', () => {
  it('a read never produces a write: no read event yields request or decide', () => {
    const reads: CorrectionEvent[] = [
      { type: 'loaded', history: history() },
      { type: 'load_failed' },
      { type: 'review', kind: 'dispute' },
      { type: 'cancel' },
      { type: 'explanation', value: 'x' },
      { type: 'decided' },
      { type: 'decide_failed', refusal: { message: 'm', next: 'keep' } },
      { type: 'request_failed', refusal: { message: 'm', next: 'keep' } },
      { type: 'requested', response: requested() },
    ];
    const starts = [initialCorrectionState('att1'), reviewing(), gated(true)];
    for (const start of starts)
      for (const event of reads) {
        const { effects } = reduceCorrection(start, event);
        for (const effect of effects) expect(WRITE_TYPES.has(effect.type)).toBe(false);
      }
  });

  it('idle cannot reach deciding: confirm, decline and a decided event change nothing before a gate exists', () => {
    const idle = initialCorrectionState('att1');
    for (const event of [
      { type: 'confirm' } as const,
      { type: 'decline' } as const,
      { type: 'decided' } as const,
    ]) {
      const next = reduceCorrection(idle, event);
      expect(next.state.phase).toBe('idle');
      expect(next.effects).toEqual([]);
    }
    const loadedClean = run(idle, [{ type: 'loaded', history: history() }]).state;
    for (const event of [{ type: 'confirm' } as const, { type: 'decline' } as const]) {
      const next = reduceCorrection(loadedClean, event);
      expect(next.state.phase).toBe('idle');
      expect(next.effects).toEqual([]);
    }
  });

  it('a kind cannot be reviewed before a read, or when the standing does not allow it', () => {
    expect(
      reduceCorrection(initialCorrectionState('att1'), { type: 'review', kind: 'dispute' }).state.phase,
    ).toBe('idle');
    const withdrawn = reviewing('dispute', standingView({ standing: 'withdrawn' }));
    expect(withdrawn.phase).toBe('idle');
    const disputed = reviewing(
      'dispute',
      standingView({
        standing: 'disputed',
        tip: {
          correctionId: 'c1',
          kind: 'dispute',
          sequence: 1,
          correctionDigest: DIG,
          replacementAttestationId: null,
        },
      }),
    );
    expect(run(disputed, [{ type: 'review', kind: 'dispute' }]).state.phase).toBe('idle');
    expect(run(disputed, [{ type: 'review', kind: 'withdraw' }]).state.phase).toBe('reviewing');
  });

  it('cancel before a request sends nothing', () => {
    const next = reduceCorrection(reviewing(), { type: 'cancel' });
    expect(next.state.phase).toBe('idle');
    expect(next.effects).toEqual([]);
  });

  it('a request carries the reviewed position and exactly the allowed body keys', () => {
    const next = reduceCorrection(reviewing(), { type: 'request', draft: draft() });
    expect(next.state.phase).toBe('requesting');
    expect(next.effects).toEqual([
      {
        type: 'request',
        chainPosition: POS,
        body: {
          correctionKind: 'dispute',
          reasonCode: 'observation_error',
          explanation: null,
          replacementAttestationId: null,
        },
      },
    ]);
  });

  it('a supersede without a replacement, or an explanation over the limit, is not sent', () => {
    const start = reviewing('supersede');
    expect(reduceCorrection(start, { type: 'request', draft: draft({ kind: 'supersede' }) }).effects).toEqual(
      [],
    );
    const long = reduceCorrection(reviewing(), {
      type: 'request',
      draft: draft({ explanation: 'x'.repeat(1001) }),
    });
    expect(long.effects).toEqual([]);
    expect(long.state.phase).toBe('reviewing');
  });

  it('a request that is refused keeps no held explanation', () => {
    const sent = run(reviewing(), [{ type: 'request', draft: draft({ explanation: 'my words' }) }]).state;
    expect(sent.heldExplanation).toBe('my words');
    const failed = run(sent, [{ type: 'request_failed', refusal: { message: 'm', next: 'keep' } }]).state;
    expect(failed.phase).toBe('reviewing');
    expect(failed.heldExplanation).toBeNull();
  });

  it('a successful request opens the gate and keeps the typed explanation for the decision', () => {
    const gate = gated(true, 'my words');
    expect(gate.phase).toBe('gate_pending');
    expect(gate.gate?.explanation).toBe('my words');
    const next = reduceCorrection(gate, { type: 'confirm' });
    expect(next.effects).toEqual([
      {
        type: 'decide',
        approvalId: 'ap1',
        actionDigest: DIG,
        decision: 'approved',
        attestationId: 'att1',
        correctionKind: 'dispute',
        explanation: 'my words',
      },
    ]);
  });

  it('a decision sends no explanation when the reviewed action carries none', () => {
    const gate = gated(false);
    expect(reduceCorrection(gate, { type: 'confirm' }).effects[0]).toMatchObject({ explanation: null });
    expect(reduceCorrection(gate, { type: 'decline' }).effects).toEqual([
      {
        type: 'decide',
        approvalId: 'ap1',
        actionDigest: DIG,
        decision: 'denied',
        attestationId: 'att1',
        correctionKind: 'dispute',
        explanation: null,
      },
    ]);
  });

  it('a reloaded pending gate needs the explanation entered again before Confirm', () => {
    const reloaded = run(initialCorrectionState('att1'), [
      { type: 'loaded', history: history({ pending: [pendingRow({ explanationRequired: true })] }) },
    ]).state;
    expect(reloaded.phase).toBe('gate_pending');
    expect(reloaded.gate?.explanation).toBeNull();
    expect(reduceCorrection(reloaded, { type: 'confirm' }).effects).toEqual([]);
    const typed = run(reloaded, [{ type: 'explanation', value: 'my words' }]).state;
    expect(reduceCorrection(typed, { type: 'confirm' }).effects[0]).toMatchObject({
      explanation: 'my words',
    });
  });

  it('a pending request found on load replaces an open review', () => {
    const next = run(reviewing(), [{ type: 'loaded', history: history({ pending: [pendingRow()] }) }]).state;
    expect(next.phase).toBe('gate_pending');
    expect(next.kind).toBeNull();
  });

  it('an out-of-date refusal keeps only Decline and reloads the history', () => {
    const deciding = reduceCorrection(gated(false), { type: 'confirm' }).state;
    const next = reduceCorrection(deciding, {
      type: 'decide_failed',
      refusal: { message: 'm', next: 'out_of_date' },
    });
    expect(next.state.phase).toBe('gate_pending');
    expect(next.state.gate?.outOfDate).toBe(true);
    expect(next.effects).toEqual([{ type: 'reload' }]);
    expect(reduceCorrection(next.state, { type: 'confirm' }).effects).toEqual([]);
    expect(reduceCorrection(next.state, { type: 'decline' }).effects[0]).toMatchObject({
      decision: 'denied',
    });
  });

  it('an unknown outcome drops the gate and reloads', () => {
    const gate = gated(false);
    const next = reduceCorrection(gate, { type: 'confirm' });
    const failed = reduceCorrection(next.state, {
      type: 'decide_failed',
      refusal: { message: UNCONFIRMED_CORRECTION, next: 'reload' },
    });
    expect(failed.state.phase).toBe('idle');
    expect(failed.state.gate).toBeNull();
    expect(failed.effects).toEqual([{ type: 'reload' }]);
  });

  it('success is shown only after a read records the correction', () => {
    const gate = gated(false);
    const confirming = reduceCorrection(gate, { type: 'confirm' }).state;
    const decided = reduceCorrection(confirming, { type: 'decided' });
    expect(decided.state.phase).toBe('verifying');
    expect(decided.state.notice).toBeNull();
    expect(decided.effects).toEqual([{ type: 'reload' }]);

    const unconfirmed = run(decided.state, [{ type: 'loaded', history: history() }]).state;
    expect(unconfirmed.phase).toBe('idle');
    expect(unconfirmed.notice).toBeNull();
    expect(unconfirmed.refusal?.message).toBe(UNCONFIRMED_CORRECTION);

    const recorded = run(decided.state, [
      {
        type: 'loaded',
        history: history({
          corrections: [
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
          ],
        }),
      },
    ]).state;
    expect(recorded.phase).toBe('idle');
    expect(recorded.notice).toBe(CORRECTION_COPY.recordedNote);
    expect(recorded.refusal).toBeNull();
  });

  it('a declined request shows the declined note only once it has left the pending list', () => {
    const gate = gated(false);
    const declining = reduceCorrection(gate, { type: 'decline' }).state;
    const decided = reduceCorrection(declining, { type: 'decided' }).state;
    const done = run(decided, [{ type: 'loaded', history: history() }]).state;
    expect(done.notice).toBe(CORRECTION_COPY.declinedNote);
    expect(done.refusal).toBeNull();
  });

  it('a gate decided or withdrawn elsewhere leaves the screen on the next read', () => {
    const gate = gated(false);
    const next = run(gate, [{ type: 'loaded', history: history({ pending: [] }) }]).state;
    expect(next.phase).toBe('idle');
    expect(next.gate).toBeNull();
  });

  it('a read during a write does not change the write', () => {
    const requesting = run(reviewing(), [{ type: 'request', draft: draft() }]).state;
    expect(
      run(requesting, [{ type: 'loaded', history: history({ pending: [pendingRow()] }) }]).state.phase,
    ).toBe('requesting');
    const confirming = gated(false);
    const deciding = reduceCorrection(confirming, { type: 'confirm' }).state;
    expect(run(deciding, [{ type: 'loaded', history: history() }]).state.phase).toBe('deciding');
  });
});

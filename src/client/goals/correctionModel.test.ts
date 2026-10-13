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
  CORRECTION_RECOVERY_COPY,
  CORRECTION_REASON_LABEL,
  correctionRefusal,
  correctionStandingLabel,
  type CorrectionDraft,
  type CorrectionEffect,
  type CorrectionEvent,
  type CorrectionState,
  initialCorrectionState,
  isUsableCorrectionHistory,
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
    expect(correctionStandingLabel('disputed')).toBe('Disputed');
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

// --- Unknown-outcome recovery (D.4E) -----------------------------------------------------------------------------------

const HELD = {
  kind: 'dispute',
  reasonCode: 'observation_error',
  explanation: 'Held text',
  replacementAttestationId: null,
} as const;
const heldDraft = (): CorrectionDraft => ({ ...HELD });
const heldBody = () => ({
  correctionKind: 'dispute' as const,
  reasonCode: 'observation_error' as const,
  explanation: 'Held text',
  replacementAttestationId: null,
});
const unknownRequestRefusal = () =>
  correctionRefusal(new ApiError('x', 503, 'persistence_failed'), 'request');
const unknownDecideRefusal = () => correctionRefusal(new ApiError('x', 503, 'persistence_failed'), 'decide');
const correctionRow = (approvalId: string) =>
  ({ approvalId }) as unknown as GoalAttestationCorrectionHistory['corrections'][number];

/** A reviewed request on the chain at POS, sent with the held draft. */
function requestingState(): CorrectionState {
  return runC(initialCorrectionState('att1'), [
    { type: 'loaded', history: history() },
    { type: 'review', kind: 'dispute' },
    { type: 'request', draft: heldDraft() },
  ]).state;
}

function runC(start: CorrectionState, events: CorrectionEvent[]) {
  let state = start;
  const effects: CorrectionEffect[] = [];
  for (const event of events) {
    const next = reduceCorrection(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

/** A gate with the explanation held in memory, sent and left unknown by a decision POST. */
function decidingGate(): CorrectionState {
  return runC(initialCorrectionState('att1'), [
    { type: 'loaded', history: history({ pending: [pendingRow({ explanationRequired: true })] }) },
    { type: 'explanation', value: 'Held text' },
    { type: 'confirm' },
  ]).state;
}

describe('unknown outcome of a correction request', () => {
  it('enters reconciling with the held body and chain position, and no write effect', () => {
    const next = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    });
    expect(next.state).toMatchObject({
      phase: 'reconciling',
      unknown: { write: 'request', chainPosition: POS, body: heldBody() },
      notice: CORRECTION_RECOVERY_COPY.reconciling,
      refusal: null,
      gate: null,
    });
    expect(next.effects).toEqual([{ type: 'reload' }]);
  });

  it('a recovery read with the matching pending request adopts it and restores the held explanation', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const after = runC(reconciling, [
      {
        type: 'loaded',
        history: history({ pending: [pendingRow({ explanationRequired: true })] }),
      },
    ]);
    expect(after.state).toMatchObject({
      phase: 'gate_pending',
      unknown: null,
      notice: CORRECTION_RECOVERY_COPY.requestSaved,
      gate: { approvalId: 'ap1', actionDigest: DIG, explanation: 'Held text', explanationRequired: true },
    });
    expect(after.effects).toEqual([]);
  });

  it('a read with the chain moved and nothing pending says the history changed and claims no absence', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const after = runC(reconciling, [{ type: 'loaded', history: history({ chainPosition: DIG2 }) }]).state;
    expect(after).toMatchObject({
      phase: 'idle',
      notice: CORRECTION_RECOVERY_COPY.historyChanged,
      unknown: null,
    });
    expect(after.notice).not.toBe(CORRECTION_RECOVERY_COPY.absent);
  });

  it('absence at the same chain position reopens the held request, which may be sent again only unchanged', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const absent = runC(reconciling, [{ type: 'loaded', history: history() }]).state;
    expect(absent).toMatchObject({
      phase: 'reviewing',
      kind: 'dispute',
      notice: CORRECTION_RECOVERY_COPY.absent,
      unknown: { write: 'request', chainPosition: POS, body: heldBody() },
    });
    const resent = reduceCorrection(absent, { type: 'request', draft: heldDraft() });
    expect(resent.effects).toEqual([{ type: 'request', chainPosition: POS, body: heldBody() }]);
    const changed = reduceCorrection(absent, {
      type: 'request',
      draft: { ...heldDraft(), explanation: 'Other' },
    });
    expect(changed.effects).toEqual([]);
    expect(changed.state.phase).toBe('reviewing');
  });

  it('an unreadable pending row blocks any absence claim and any new request', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const blocked = runC(reconciling, [
      { type: 'loaded', history: history({ pendingUnreadableCount: 1 }) },
    ]).state;
    expect(blocked).toMatchObject({
      phase: 'reconciling',
      refusal: { message: CORRECTION_RECOVERY_COPY.unreadablePending, next: 'keep' },
      unknown: { write: 'request' },
    });
    expect(reduceCorrection(blocked, { type: 'request', draft: heldDraft() }).effects).toEqual([]);
    expect(runC(blocked, [{ type: 'check_again' }]).effects).toEqual([{ type: 'reload' }]);
  });

  it('a failed recovery read keeps the marker, and check again is the only next step', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const failed = runC(reconciling, [{ type: 'load_failed' }]).state;
    expect(failed).toMatchObject({
      phase: 'reconciling',
      refusal: { message: CORRECTION_RECOVERY_COPY.unavailable },
      unknown: { write: 'request' },
    });
    expect(reduceCorrection(failed, { type: 'confirm' }).effects).toEqual([]);
    expect(reduceCorrection(failed, { type: 'decline' }).effects).toEqual([]);
    const again = runC(failed, [{ type: 'check_again' }]);
    expect(again.effects).toEqual([{ type: 'reload' }]);
    expect(again.state.refusal).toBeNull();
  });

  it('check again does nothing unless a read failed or could not settle', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    expect(reduceCorrection(reconciling, { type: 'check_again' })).toEqual({
      state: reconciling,
      effects: [],
    });
  });

  it('a cancelled review drops the held request', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const absent = runC(reconciling, [{ type: 'loaded', history: history() }]).state;
    expect(reduceCorrection(absent, { type: 'cancel' }).state.unknown).toBeNull();
  });
});

describe('unknown outcome of a correction decision', () => {
  it('enters reconciling with the sent approval, digest and explanation, and no write effect', () => {
    const next = reduceCorrection(decidingGate(), {
      type: 'decide_failed',
      refusal: unknownDecideRefusal(),
      unknown: true,
    });
    expect(next.state).toMatchObject({
      phase: 'reconciling',
      gate: null,
      unknown: {
        write: 'decide',
        approvalId: 'ap1',
        actionDigest: DIG,
        decision: 'approved',
        attestationId: 'att1',
        explanation: 'Held text',
      },
      notice: CORRECTION_RECOVERY_COPY.reconciling,
    });
    expect(next.effects).toEqual([{ type: 'reload' }]);
  });

  it('a read showing the approval recorded says so', () => {
    const reconciling = reduceCorrection(decidingGate(), {
      type: 'decide_failed',
      refusal: unknownDecideRefusal(),
      unknown: true,
    }).state;
    const after = runC(reconciling, [
      { type: 'loaded', history: history({ corrections: [correctionRow('ap1')] }) },
    ]).state;
    expect(after).toMatchObject({ phase: 'idle', notice: CORRECTION_COPY.recordedNote, unknown: null });
  });

  it('a read showing the approval still pending returns to the gate with the held explanation', () => {
    const reconciling = reduceCorrection(decidingGate(), {
      type: 'decide_failed',
      refusal: unknownDecideRefusal(),
      unknown: true,
    }).state;
    const after = runC(reconciling, [
      { type: 'loaded', history: history({ pending: [pendingRow({ explanationRequired: true })] }) },
    ]);
    expect(after.state).toMatchObject({
      phase: 'gate_pending',
      notice: CORRECTION_RECOVERY_COPY.stillPending,
      gate: { approvalId: 'ap1', actionDigest: DIG, explanation: 'Held text' },
    });
    const retried = reduceCorrection(after.state, { type: 'confirm' });
    expect(retried.effects).toEqual([
      {
        type: 'decide',
        approvalId: 'ap1',
        actionDigest: DIG,
        decision: 'approved',
        attestationId: 'att1',
        correctionKind: 'dispute',
        explanation: 'Held text',
      },
    ]);
  });

  it('a read showing the approval neither pending nor recorded says the request is closed', () => {
    const reconciling = reduceCorrection(decidingGate(), {
      type: 'decide_failed',
      refusal: unknownDecideRefusal(),
      unknown: true,
    }).state;
    const after = runC(reconciling, [{ type: 'loaded', history: history() }]).state;
    expect(after).toMatchObject({ phase: 'idle', notice: CORRECTION_RECOVERY_COPY.closed, unknown: null });
  });

  it('no request or decision effect is possible while reconciling', () => {
    const reconciling = reduceCorrection(decidingGate(), {
      type: 'decide_failed',
      refusal: unknownDecideRefusal(),
      unknown: true,
    }).state;
    for (const event of [
      { type: 'confirm' },
      { type: 'decline' },
      { type: 'request', draft: heldDraft() },
    ] as CorrectionEvent[]) {
      expect(reduceCorrection(reconciling, event).effects).toEqual([]);
    }
  });
});

describe('correction recovery copy', () => {
  it('never says the earlier attempt failed, succeeded without a read, or was clean', () => {
    for (const text of Object.values(CORRECTION_RECOVERY_COPY)) {
      expect(text).not.toMatch(/Do not assume/);
      expect(text).not.toMatch(/\b(clean|no other|all good)\b/i);
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

// --- A pending request is adopted only when it fits the chain (D.4F.2) -------------------------------------------------

const TIP_DISPUTE = {
  correctionId: 'c0',
  kind: 'dispute' as const,
  sequence: 1,
  correctionDigest: DIG2,
  replacementAttestationId: null,
};

/** A history whose chain has moved on: one dispute is the tip, and the chain position is that dispute's digest. */
const movedHistory = (over: Partial<GoalAttestationCorrectionHistory> = {}) =>
  history({
    standing: standingView({ standing: 'disputed', correctionCount: 1, tip: TIP_DISPUTE }),
    chainPosition: DIG2,
    ...over,
  });

describe('pending requests against the chain (D.4F.2)', () => {
  it('a recovery read whose pending row does not fit the chain adopts it only as out of date, with no saved notice', () => {
    const reconciling = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const after = runC(reconciling, [
      { type: 'loaded', history: movedHistory({ pending: [pendingRow()] }) },
    ]).state;
    expect(after.phase).toBe('gate_pending');
    expect(after.gate?.outOfDate).toBe(true);
    expect(after.notice).not.toBe(CORRECTION_RECOVERY_COPY.requestSaved);
    expect(reduceCorrection(after, { type: 'confirm' }).effects).toEqual([]);
    expect(reduceCorrection(after, { type: 'decline' }).effects).toEqual([
      expect.objectContaining({ type: 'decide', decision: 'denied', approvalId: 'ap1', actionDigest: DIG }),
    ]);
  });

  it('a plain read that finds a pending row which does not fit shows it only as out of date', () => {
    const after = run(initialCorrectionState('att1'), [
      { type: 'loaded', history: movedHistory({ pending: [pendingRow()] }) },
    ]).state;
    expect(after.phase).toBe('gate_pending');
    expect(after.gate?.outOfDate).toBe(true);
    expect(reduceCorrection(after, { type: 'confirm' }).effects).toEqual([]);
  });

  it('a gate already on screen becomes out of date when the chain moves under it', () => {
    const moved = run(gated(false), [
      { type: 'loaded', history: movedHistory({ pending: [pendingRow()] }) },
    ]).state;
    expect(moved.phase).toBe('gate_pending');
    expect(moved.gate?.outOfDate).toBe(true);
    expect(reduceCorrection(moved, { type: 'confirm' }).effects).toEqual([]);
    expect(reduceCorrection(moved, { type: 'decline' }).effects).toHaveLength(1);
  });

  it('a review open on a chain that has since moved is closed, and its draft cannot be sent', () => {
    const moved = run(reviewing('withdraw'), [{ type: 'loaded', history: movedHistory() }]).state;
    expect(moved).toMatchObject({
      phase: 'idle',
      kind: null,
      notice: CORRECTION_RECOVERY_COPY.historyChanged,
    });
    expect(reduceCorrection(moved, { type: 'request', draft: draft({ kind: 'withdraw' }) }).effects).toEqual(
      [],
    );
  });

  it('a pending row that fits a non-empty chain is adopted as actionable, and the default fixture still fits', () => {
    const fitting = pendingRow({ correctionKind: 'withdraw', sequence: 2, previousCorrectionDigest: DIG2 });
    const after = run(initialCorrectionState('att1'), [
      { type: 'loaded', history: movedHistory({ pending: [fitting] }) },
    ]).state;
    expect(after.phase).toBe('gate_pending');
    expect(after.gate?.outOfDate).toBe(false);
    expect(reduceCorrection(after, { type: 'confirm' }).effects).toEqual([
      {
        type: 'decide',
        approvalId: 'ap1',
        actionDigest: DIG,
        decision: 'approved',
        attestationId: 'att1',
        correctionKind: 'withdraw',
        explanation: null,
      },
    ]);
    const defaultFit = run(initialCorrectionState('att1'), [
      { type: 'loaded', history: history({ pending: [pendingRow()] }) },
    ]).state;
    expect(defaultFit.gate?.outOfDate).toBe(false);
  });

  it('no start state reaches a write from any read, whatever the chain shows', () => {
    const reconcilingRequest = reduceCorrection(requestingState(), {
      type: 'request_failed',
      refusal: unknownRequestRefusal(),
      unknown: true,
    }).state;
    const states: CorrectionState[] = [
      initialCorrectionState('att1'),
      reviewing(),
      gated(false),
      requestingState(),
      reduceCorrection(gated(false), { type: 'confirm' }).state,
      reconcilingRequest,
      runC(reconcilingRequest, [{ type: 'loaded', history: history({ pendingUnreadableCount: 1 }) }]).state,
      decidingGate(),
    ];
    const reads = [
      history(),
      history({ pending: [pendingRow()] }),
      movedHistory({ pending: [pendingRow()] }),
      movedHistory(),
      history({ pendingUnreadableCount: 1 }),
    ];
    for (const start of states)
      for (const read of reads) {
        const { effects } = reduceCorrection(start, { type: 'loaded', history: read });
        for (const effect of effects) expect(WRITE_TYPES.has(effect.type)).toBe(false);
      }
  });

  it('the correction standing labels name the standing without attributing it to the user', () => {
    expect(correctionStandingLabel('disputed')).toBe('Disputed');
    expect(correctionStandingLabel('withdrawn')).toBe('Withdrawn');
    expect(correctionStandingLabel('superseded')).toBe('Superseded');
  });
});

describe('isUsableCorrectionHistory (D.4F.4)', () => {
  it('accepts a history with no chain tip and with a moved chain tip', () => {
    expect(isUsableCorrectionHistory(history())).toBe(true);
    expect(isUsableCorrectionHistory(movedHistory())).toBe(true);
  });

  it('rejects an unusable body and any history missing a field the panel or the reducer reads', () => {
    const unusable: unknown[] = [
      {},
      null,
      { ...history(), standing: null },
      { ...history(), standing: { ...standingView(), standing: undefined } },
      { ...history(), standing: { ...standingView(), tip: undefined } },
      { ...history(), corrections: 'none' },
      { ...history(), corrections: [null] },
      { ...history(), pending: undefined },
      { ...history(), pending: [null] },
      { ...history(), chainPosition: undefined },
      { ...history(), pendingUnreadableCount: undefined },
    ];
    for (const value of unusable) expect(isUsableCorrectionHistory(value)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type {
  GoalCompletionStanding,
  GoalCompletionStandingClaim,
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import {
  COMPLETION_COPY,
  COMPLETION_RECOVERY_COPY,
  decisionRelation,
  type CompletionEffect,
  type CompletionEvent,
  type CompletionRefusal,
  type CompletionState,
  completionRefusal,
  contentPreservationCopy,
  initialCompletionState,
  preflightReasonCopy,
  qualifierCopy,
  reduceCompletion,
  standingPresentation,
} from './completionModel';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const ACTION = 'c'.repeat(64);
const ATTESTATION = '11111111-1111-4111-8111-111111111111';

function report(
  overrides: Partial<GoalExternalCompletionPreflightReport> = {},
): GoalExternalCompletionPreflightReport {
  return {
    schemaVersion: 1,
    kind: 'turing_goal_external_completion_preflight',
    goalId: 'goal-1',
    attestationId: ATTESTATION,
    outcome: 'ready',
    reasons: [],
    checks: [],
    facts: {
      goalStatus: 'running',
      definitionVersion: 2,
      definitionHash: 'd'.repeat(64),
      lineageDigest: null,
      mode: 'external_user_attested_v2',
      handoffId: 'handoff-1',
      handoffDigest: 'e'.repeat(64),
      attestationActionDigest: 'f'.repeat(64),
      attestationRecordDigest: '0'.repeat(64),
      correctionStanding: 'active_uncontested',
      correctionSequence: 0,
      destinationRef: 'refs/heads/main',
      attestedCommit: 'a'.repeat(40),
      attestedTree: 'b'.repeat(40),
      freshCommit: 'a'.repeat(40),
      freshTree: 'b'.repeat(40),
      objectFormat: 'sha1',
    },
    actionFields: null,
    proofLimitations: {
      contentPreservation: 'not_proven',
      goalCompletion: 'not_completed_by_preflight',
      destinationPolicy: 'exact_attested_tip',
    },
    authority: { mintsApproval: false, mintsProof: false, mintsTerminalAuthority: false },
    digest: DIGEST_A,
    ...overrides,
  };
}

/** Only the claim is read by the presentation; the rest of the standing is not needed for these copy tests. */
function statusFor(
  state: GoalExternalCompletionStatus['state'],
  qualifier: GoalCompletionStandingClaim['qualifier'] = 'none',
): GoalExternalCompletionStatus {
  const claim: GoalCompletionStandingClaim = {
    unqualifiedSuccessAllowed: true,
    trustedForDownstream: false,
    qualifier,
    contentPreservation: 'not_proven',
  };
  return {
    goalId: 'goal-1',
    state,
    decisions: [],
    completion: null,
    completionStanding: { claim } as unknown as GoalCompletionStanding,
  };
}

const refusal = (status: number, code: string, detail?: string): CompletionRefusal =>
  completionRefusal(new ApiError('server text that must not be shown', status, code, detail));

/** Runs a list of events from a state and returns the final state and every effect that was emitted. */
function run(start: CompletionState, events: CompletionEvent[]) {
  let state = start;
  const effects: CompletionEffect[] = [];
  for (const event of events) {
    const next = reduceCompletion(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const readyLoad = (digest = DIGEST_A): CompletionEvent => ({
  type: 'loaded',
  settled: false,
  decidedActionDigest: null,
  preflight: report({ digest }),
  preflightError: null,
});

const readyState = (): CompletionState => run(initialCompletionState(true), [readyLoad()]).state;

describe('completion reducer: loading and the review', () => {
  it('starts loading with a current attestation and idle without one', () => {
    expect(initialCompletionState(true)).toMatchObject({ phase: 'loading', reading: true });
    expect(initialCompletionState(false)).toMatchObject({ phase: 'idle', reading: false });
  });

  it('a ready preflight enables recording with its digest and an unticked acknowledgement', () => {
    const state = readyState();
    expect(state).toMatchObject({
      phase: 'preflight_ready',
      reading: false,
      preflightDigest: DIGEST_A,
      acknowledgeRecord: false,
      actionDigest: null,
    });
  });

  it('a refused preflight lists plain blockers and never a recording digest', () => {
    const state = run(initialCompletionState(true), [
      {
        type: 'loaded',
        settled: false,
        decidedActionDigest: null,
        preflight: report({
          outcome: 'refused',
          reasons: [{ code: 'attestation_disputed', detail: null }],
          digest: DIGEST_B,
        }),
        preflightError: null,
      },
    ]).state;
    expect(state.phase).toBe('preflight_refused');
    expect(state.preflightDigest).toBeNull();
    expect(state.reasons).toEqual([preflightReasonCopy('attestation_disputed')]);
  });

  it('a recorded decision for this attestation shows the decided state without any preflight', () => {
    const state = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
    ]).state;
    expect(state).toMatchObject({ phase: 'decided', actionDigest: ACTION, preflightDigest: null });
  });

  it('a settled Goal shows no controls at all', () => {
    const state = run(initialCompletionState(true), [
      { type: 'loaded', settled: true, decidedActionDigest: ACTION, preflight: null, preflightError: null },
    ]).state;
    expect(state).toMatchObject({ phase: 'completed', actionDigest: null, preflightDigest: null });
  });

  it('a failed preflight read is a refused preflight with its own refusal', () => {
    const busy = refusal(429, 'completion_busy');
    const state = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: null, preflight: null, preflightError: busy },
    ]).state;
    expect(state.phase).toBe('preflight_refused');
    expect(state.refusal).toEqual(busy);
  });

  it('a failed status read refuses the review and offers a refresh only', () => {
    const state = run(initialCompletionState(true), [
      { type: 'load_failed', refusal: refusal(503, 'external_completion_unavailable') },
    ]).state;
    expect(state.phase).toBe('refused');
    expect(state.refusal?.action).toBe('refresh');
  });

  it('a later successful read clears a refusal that came from a read, but keeps an action refusal', () => {
    const fromLoad = run(initialCompletionState(true), [
      { type: 'load_failed', refusal: refusal(503, 'external_completion_unavailable') },
      readyLoad(),
    ]).state;
    expect(fromLoad.refusal).toBeNull();
    const fromAction = run(readyState(), [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
      { type: 'record_failed', refusal: refusal(409, 'destination_changed') },
      readyLoad(DIGEST_B),
    ]).state;
    expect(fromAction.refusal?.message).toBe(refusal(409, 'destination_changed').message);
  });
});

describe('completion reducer: the acknowledgements and the two writes', () => {
  it('the decision acknowledgement only changes in preflight_ready', () => {
    const idle = reduceCompletion(initialCompletionState(false), {
      type: 'acknowledge_record',
      checked: true,
    });
    expect(idle.state.acknowledgeRecord).toBe(false);
    const ready = reduceCompletion(readyState(), { type: 'acknowledge_record', checked: true });
    expect(ready.state.acknowledgeRecord).toBe(true);
  });

  it('record_requested needs the acknowledgement and a digest and emits exactly one record effect', () => {
    const unticked = reduceCompletion(readyState(), { type: 'record_requested' });
    expect(unticked.effects).toEqual([]);
    expect(unticked.state.phase).toBe('preflight_ready');
    const ticked = run(readyState(), [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
    ]);
    expect(ticked.state.phase).toBe('recording');
    expect(ticked.effects).toEqual([{ type: 'record', preflightDigest: DIGEST_A }]);
  });

  it('a second record_requested while recording is ignored (double-click guard)', () => {
    const { effects } = run(readyState(), [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
      { type: 'record_requested' },
    ]);
    expect(effects).toEqual([{ type: 'record', preflightDigest: DIGEST_A }]);
  });

  it('a successful decision moves to decided with the response digest and re-reads once', () => {
    const { state, effects } = run(readyState(), [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
      { type: 'record_succeeded', actionDigest: ACTION },
    ]);
    expect(state).toMatchObject({
      phase: 'decided',
      actionDigest: ACTION,
      preflightDigest: null,
      acknowledgeComplete: false,
    });
    expect(effects.slice(1)).toEqual([{ type: 'reload' }]);
  });

  it('a failed decision drops the digest and the acknowledgement and re-reads, never resending', () => {
    const { state, effects } = run(readyState(), [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
      { type: 'record_failed', refusal: refusal(412, 'reviewed_preflight_changed') },
    ]);
    expect(state).toMatchObject({
      phase: 'refused',
      preflightDigest: null,
      acknowledgeRecord: false,
      reading: true,
    });
    expect(effects.slice(1)).toEqual([{ type: 'reload' }]);
  });

  it('complete_requested needs a decided state, its own acknowledgement and an action digest', () => {
    const decided = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
    ]).state;
    expect(reduceCompletion(decided, { type: 'complete_requested' }).effects).toEqual([]);
    const ticked = run(decided, [
      { type: 'acknowledge_complete', checked: true },
      { type: 'complete_requested' },
    ]);
    expect(ticked.state.phase).toBe('completing');
    expect(ticked.effects).toEqual([{ type: 'complete', actionDigest: ACTION }]);
  });

  it('a retryable completion refusal keeps the decision and the acknowledgement for a retry', () => {
    const decided = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
      { type: 'acknowledge_complete', checked: true },
      { type: 'complete_requested' },
    ]).state;
    const { state, effects } = run(decided, [
      { type: 'complete_failed', refusal: refusal(429, 'completion_busy') },
    ]);
    expect(state).toMatchObject({ phase: 'decided', actionDigest: ACTION, acknowledgeComplete: true });
    expect(effects).toEqual([]);
  });

  it('a completed Goal settles, and no later read can reopen the completion control on its own', () => {
    const decided = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
      { type: 'acknowledge_complete', checked: true },
      { type: 'complete_requested' },
      { type: 'complete_succeeded' },
    ]);
    expect(decided.state.phase).toBe('completed');
    expect(decided.effects.filter((effect) => effect.type === 'complete')).toHaveLength(1);
    const settled = run(decided.state, [
      { type: 'loaded', settled: true, decidedActionDigest: null, preflight: null, preflightError: null },
    ]).state;
    expect(settled.phase).toBe('completed');
  });

  it('a non-retryable completion refusal re-reads the saved state', () => {
    const decided = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
      { type: 'acknowledge_complete', checked: true },
      { type: 'complete_requested' },
    ]).state;
    const { state, effects } = run(decided, [
      { type: 'complete_failed', refusal: refusal(409, 'completion_conflict') },
    ]);
    expect(state).toMatchObject({ phase: 'refused', actionDigest: null, reading: true });
    expect(effects).toEqual([{ type: 'reload' }]);
  });

  it('a read that lands while a write is in flight is ignored', () => {
    const recording = run(readyState(), [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
      { ...readyLoad(DIGEST_B) },
    ]).state;
    expect(recording.phase).toBe('recording');
    expect(recording.preflightDigest).toBe(DIGEST_A);
  });
});

describe('completion reducer: no transition completes a Goal by itself', () => {
  const everyEvent: CompletionEvent[] = [
    { type: 'refresh' },
    { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
    { type: 'loaded', settled: false, decidedActionDigest: null, preflight: report(), preflightError: null },
    { type: 'load_failed', refusal: refusal(503, 'external_completion_unavailable') },
    { type: 'acknowledge_record', checked: true },
    { type: 'acknowledge_complete', checked: true },
    { type: 'record_requested' },
    { type: 'record_succeeded', actionDigest: ACTION },
    { type: 'record_failed', refusal: refusal(412, 'reviewed_preflight_changed') },
    { type: 'complete_succeeded' },
    { type: 'complete_failed', refusal: refusal(429, 'completion_busy') },
  ];

  it('refresh, reads, SSE-like refreshes and decision writes never emit a completion effect', () => {
    const starts: CompletionState[] = [
      initialCompletionState(false),
      initialCompletionState(true),
      readyState(),
      run(readyState(), [{ type: 'acknowledge_record', checked: true }]).state,
    ];
    for (const start of starts)
      for (const event of everyEvent) {
        const { effects } = reduceCompletion(start, event);
        expect(effects.some((effect) => effect.type === 'complete')).toBe(false);
      }
  });

  it('only complete_requested emits a completion effect, and at most one', () => {
    const decided = run(initialCompletionState(true), [
      { type: 'loaded', settled: false, decidedActionDigest: ACTION, preflight: null, preflightError: null },
      { type: 'acknowledge_complete', checked: true },
    ]).state;
    const emitted = reduceCompletion(decided, { type: 'complete_requested' }).effects;
    expect(emitted.filter((effect) => effect.type === 'complete')).toHaveLength(1);
  });

  it('a refresh alone never produces a request effect', () => {
    const { effects, state } = reduceCompletion(readyState(), { type: 'refresh' });
    expect(effects).toEqual([]);
    expect(state.reading).toBe(true);
  });
});

describe('completion reducer: acknowledgement resets', () => {
  it('a changed preflight digest resets the decision acknowledgement', () => {
    const ticked = run(readyState(), [{ type: 'acknowledge_record', checked: true }]).state;
    const next = reduceCompletion(ticked, readyLoad(DIGEST_B)).state;
    expect(next).toMatchObject({
      phase: 'preflight_ready',
      preflightDigest: DIGEST_B,
      acknowledgeRecord: false,
    });
  });

  it('an unchanged digest keeps the acknowledgement across a refresh', () => {
    const ticked = run(readyState(), [{ type: 'acknowledge_record', checked: true }]).state;
    const next = reduceCompletion(ticked, readyLoad(DIGEST_A)).state;
    expect(next.acknowledgeRecord).toBe(true);
  });
});

describe('copy', () => {
  it('gives every qualifier except none a plain sentence and never prints the token', () => {
    const values = [
      'disputed_by_user',
      'withdrawn_by_user',
      'superseded_by_user',
      'replacement_failed',
      'proof_unverified',
      'legacy_not_v2_attested',
      'not_completed',
    ] as const;
    for (const value of values) {
      const sentence = qualifierCopy(value);
      expect(sentence).toBeTruthy();
      expect(sentence).not.toMatch(/_/);
    }
    expect(qualifierCopy('none')).toBeNull();
  });

  it('prints the content-preservation line in plain words and never invents a value', () => {
    expect(contentPreservationCopy('not_proven')).toBe('Content preservation: not proven.');
    expect(contentPreservationCopy('not_applicable')).toBe('Content preservation: not applicable.');
    expect(contentPreservationCopy('something_else')).toBe(
      'Content preservation: unrecognised value. Treat it as not proven.',
    );
  });

  it('a completed Goal is never headed as success and always carries the content-preservation line', () => {
    const completed = standingPresentation(statusFor('completed'));
    expect(completed.heading).toBe('Completed on your decision');
    expect(completed.contentPreservation).toBe('Content preservation: not proven.');
    const text = [completed.heading, completed.qualifier ?? '', completed.contentPreservation ?? ''].join(
      ' ',
    );
    expect(text).not.toMatch(/success|successfully|all done|\bdone\b|verified|preserved/i);
    expect(text).not.toMatch(/unqualifiedSuccessAllowed|contentPreservation|not_proven/);
  });

  it('a contested Goal carries its qualification and a legacy Goal says it is not attested', () => {
    const contested = standingPresentation(statusFor('contested', 'disputed_by_user'));
    expect(contested.heading).toBe('Completed earlier; later contested.');
    expect(contested.qualifier).toBe(qualifierCopy('disputed_by_user'));
    const legacy = standingPresentation(statusFor('legacy', 'legacy_not_v2_attested'));
    expect(legacy.heading).toBe('Completed before external attestation existed. Not attested.');
    expect(legacy.contentPreservation).toBeNull();
  });

  it('an invalid Goal is never shown as completed', () => {
    const invalid = standingPresentation(statusFor('invalid'));
    expect(invalid.heading).toBe('Completion records could not be verified.');
    expect(invalid.heading).not.toMatch(/Completed/);
  });

  it('the copy constants never say success or verified about the completion', () => {
    const strings: string[] = [
      COMPLETION_COPY.intro,
      COMPLETION_COPY.limitation,
      COMPLETION_COPY.recordHelp,
      COMPLETION_COPY.completeHelp,
      COMPLETION_COPY.recordedNotCompleted,
      COMPLETION_COPY.reviewAvailable,
    ];
    for (const text of strings) expect(text).not.toMatch(/success|successfully|verified|all done/i);
  });
});

describe('refusal map', () => {
  // Each row: the server code, its HTTP status, the detail if any, and the action the UI may offer.
  const rows: Array<[string, number, string | undefined, CompletionRefusal['action'], boolean]> = [
    ['reviewed_action_precondition_required', 428, undefined, 'refresh', false],
    ['reviewed_action_precondition_invalid', 400, undefined, 'refresh', false],
    ['acknowledgement_required', 400, undefined, 'none', false],
    ['reviewed_preflight_changed', 412, undefined, 'refresh', false],
    ['preflight_refused', 409, 'attestation_disputed', 'refresh', false],
    ['preflight_refused', 409, 'verification_busy', 'refresh', false],
    ['preflight_refused', 429, 'verification_busy', 'refresh', false],
    ['preflight_refused', 503, 'git_unavailable', 'refresh', false],
    ['preflight_refused', 409, 'some_unknown_blocker', 'refresh', false],
    ['destination_changed', 409, undefined, 'refresh', false],
    ['completion_conflict', 409, undefined, 'refresh', false],
    ['decision_conflict', 409, undefined, 'refresh', false],
    ['goal_not_running', 409, undefined, 'refresh', false],
    ['goal_work_in_flight', 409, undefined, 'refresh', false],
    ['manual_reconciliation_required', 409, undefined, 'refresh', false],
    ['completion_already_recorded', 409, undefined, 'refresh', false],
    ['competing_decision', 409, undefined, 'refresh', false],
    ['preflight_refused', 409, 'completion_history_invalid', 'refresh', false],
    ['decision_not_found', 404, undefined, 'refresh', false],
    ['decision_corrupt', 422, undefined, 'none', false],
    ['completion_corrupt', 422, undefined, 'none', false],
    ['proof_invalid', 422, undefined, 'none', false],
    ['completion_busy', 429, undefined, 'none', true],
    ['decision_persistence_failed', 503, undefined, 'refresh', false],
    ['external_completion_unavailable', 503, undefined, 'refresh', false],
    ['never_seen_before_code', 418, undefined, 'refresh', false],
  ];

  it.each(rows)(
    '%s (%i) maps to a plain message with action %s',
    (code, status, detail, action, retryable) => {
      const mapped = refusal(status, code, detail);
      expect(mapped.action).toBe(action);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.message.length).toBeGreaterThan(10);
    },
  );

  it.each(rows)('%s never prints the code, the detail or the server text', (code, status, detail) => {
    const { message } = refusal(status, code, detail);
    expect(message).not.toContain(code);
    expect(message).not.toMatch(/_/);
    if (detail) expect(message).not.toContain(detail);
    expect(message).not.toContain('server text that must not be shown');
  });

  it('a disputed attestation says the attestation was corrected and cannot be used', () => {
    expect(refusal(409, 'preflight_refused', 'attestation_disputed').message).toBe(
      'The attestation was corrected, so it cannot be used.',
    );
  });

  it('a network failure or a server fault says the result is unconfirmed and offers a refresh only', () => {
    const network = completionRefusal(new TypeError('Failed to fetch'));
    expect(network.message).toBe(
      'Turing could not confirm the result. Do not assume it failed or succeeded. Refresh to read the saved state.',
    );
    expect(network.action).toBe('refresh');
    expect(refusal(503, 'some_unexpected_code').message).toContain('could not confirm');
  });

  it('an unknown refusal gets a generic sentence and never the raw code', () => {
    const generic = refusal(418, 'some_unexpected_code');
    expect(generic.message).toBe('The request was refused. Nothing was changed.');
  });

  it('every preflight blocker maps to a sentence without its code', () => {
    for (const code of ['attestation_stale', 'destination_not_integrated', 'not_a_real_code']) {
      expect(preflightReasonCopy(code)).not.toMatch(/_/);
    }
  });
});

// --- Unknown-outcome recovery (D.4E) -----------------------------------------------------------------------------------

const unknownRefusal = () => refusal(503, 'decision_persistence_failed');
const recordingState = () =>
  run(readyState(), [{ type: 'acknowledge_record', checked: true }, { type: 'record_requested' }]).state;
const decidedState = (actionDigest = ACTION) =>
  run(readyState(), [
    { type: 'acknowledge_record', checked: true },
    { type: 'record_requested' },
    { type: 'record_succeeded', actionDigest },
    {
      type: 'loaded',
      settled: false,
      decidedActionDigest: actionDigest,
      preflight: null,
      preflightError: null,
    },
    { type: 'acknowledge_complete', checked: true },
  ]).state;
const decidedLoad = (actionDigest: string | null): Extract<CompletionEvent, { type: 'loaded' }> => ({
  type: 'loaded',
  settled: false,
  decidedActionDigest: actionDigest,
  preflight: null,
  preflightError: null,
});

describe('unknown outcome of a decision POST', () => {
  it('enters reconciling with one read and no write effect, and drops the acknowledgement', () => {
    const next = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    });
    expect(next.state).toMatchObject({
      phase: 'reconciling',
      reading: true,
      unknown: { write: 'record', digest: DIGEST_A },
      notice: COMPLETION_RECOVERY_COPY.reconciling,
      refusal: null,
      preflightDigest: null,
      acknowledgeRecord: false,
    });
    expect(next.effects).toEqual([{ type: 'reload' }]);
  });

  it('a definite refusal is unchanged: refused, reload, and no marker', () => {
    const next = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: refusal(409, 'completion_conflict'),
      unknown: false,
    });
    expect(next.state).toMatchObject({ phase: 'refused', unknown: null });
    expect(next.effects).toEqual([{ type: 'reload' }]);
  });

  it('a recovery read that shows the decision says it was saved, and offers Complete for that digest', () => {
    const reconciling = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const after = run(reconciling, [decidedLoad(ACTION)]);
    expect(after.state).toMatchObject({
      phase: 'decided',
      notice: COMPLETION_RECOVERY_COPY.recordSaved,
      unknown: null,
      actionDigest: ACTION,
    });
    expect(after.effects).toEqual([]);
  });

  it('absence with the same review needs a new acknowledgement before the held review is recorded', () => {
    const reconciling = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const afterRead = run(reconciling, [readyLoad(DIGEST_A)]).state;
    expect(afterRead).toMatchObject({
      phase: 'preflight_ready',
      notice: COMPLETION_RECOVERY_COPY.recordAbsent,
      preflightDigest: DIGEST_A,
      acknowledgeRecord: false,
    });
    expect(reduceCompletion(afterRead, { type: 'record_requested' }).effects).toEqual([]);
    const sent = run(afterRead, [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
    ]);
    expect(sent.effects).toEqual([{ type: 'record', preflightDigest: DIGEST_A }]);
  });

  it('absence with a changed review says the review changed and only the new digest can be recorded', () => {
    const reconciling = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const afterRead = run(reconciling, [readyLoad(DIGEST_B)]).state;
    expect(afterRead).toMatchObject({
      phase: 'preflight_ready',
      notice: COMPLETION_RECOVERY_COPY.recordAbsentChanged,
      preflightDigest: DIGEST_B,
    });
    const sent = run(afterRead, [
      { type: 'acknowledge_record', checked: true },
      { type: 'record_requested' },
    ]);
    expect(sent.effects).toEqual([{ type: 'record', preflightDigest: DIGEST_B }]);
  });

  it('a refused review after absence shows its reasons and no digest to record', () => {
    const reconciling = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const refused = report({
      outcome: 'refused',
      digest: null as unknown as string,
      reasons: [
        { code: 'goal_not_running' } as unknown as GoalExternalCompletionPreflightReport['reasons'][number],
      ],
    });
    const afterRead = run(reconciling, [
      { type: 'loaded', settled: false, decidedActionDigest: null, preflight: refused, preflightError: null },
    ]).state;
    expect(afterRead).toMatchObject({
      phase: 'preflight_refused',
      notice: COMPLETION_RECOVERY_COPY.recordAbsent,
      preflightDigest: null,
      reasons: [preflightReasonCopy('goal_not_running')],
    });
  });

  it('a failed recovery read keeps the marker, names no outcome, and offers only another read', () => {
    const reconciling = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const failed = run(reconciling, [
      { type: 'load_failed', refusal: refusal(500, 'completion_read_failed') },
    ]).state;
    expect(failed).toMatchObject({
      phase: 'reconciling',
      reading: false,
      unknown: { write: 'record', digest: DIGEST_A },
      refusal: { message: COMPLETION_RECOVERY_COPY.unavailable, action: 'refresh' },
    });
    expect(reduceCompletion(failed, { type: 'record_requested' }).effects).toEqual([]);
    expect(reduceCompletion(failed, { type: 'complete_requested' }).effects).toEqual([]);
    const again = run(failed, [{ type: 'check_again' }]);
    expect(again.effects).toEqual([{ type: 'reload' }]);
    expect(again.state).toMatchObject({ reading: true, refusal: null });
    expect(run(again.state, [decidedLoad(ACTION)]).state).toMatchObject({
      phase: 'decided',
      notice: COMPLETION_RECOVERY_COPY.recordSaved,
    });
  });

  it('check again does nothing unless a read has failed', () => {
    const reconciling = reduceCompletion(recordingState(), {
      type: 'record_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    expect(reduceCompletion(reconciling, { type: 'check_again' })).toEqual({
      state: reconciling,
      effects: [],
    });
  });
});

describe('unknown outcome of a Goal completion POST', () => {
  const completing = () => run(decidedState(), [{ type: 'complete_requested' }]).state;

  it('enters reconciling with the sent digest kept and no write effect', () => {
    const next = reduceCompletion(completing(), {
      type: 'complete_failed',
      refusal: refusal(503, 'completion_persistence_failed'),
      unknown: true,
    });
    expect(next.state).toMatchObject({
      phase: 'reconciling',
      reading: true,
      unknown: { write: 'complete', digest: ACTION },
      actionDigest: ACTION,
      acknowledgeComplete: true,
      notice: COMPLETION_RECOVERY_COPY.reconciling,
    });
    expect(next.effects).toEqual([{ type: 'reload' }]);
  });

  it('a read showing the Goal completed says so, using the completed flag from the read', () => {
    const reconciling = reduceCompletion(completing(), {
      type: 'complete_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const after = run(reconciling, [{ ...decidedLoad(null), settled: true, completed: true }]).state;
    expect(after).toMatchObject({
      phase: 'completed',
      notice: COMPLETION_RECOVERY_COPY.completeSaved,
      unknown: null,
    });
  });

  it('a settled read that does not say completed makes no completion claim', () => {
    const reconciling = reduceCompletion(completing(), {
      type: 'complete_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const after = run(reconciling, [{ ...decidedLoad(null), settled: true }]).state;
    expect(after.phase).toBe('completed');
    expect(after.notice).toBe(COMPLETION_RECOVERY_COPY.settledNeutral);
    expect(after.notice).not.toBe(COMPLETION_RECOVERY_COPY.completeSaved);
  });

  it('a read still showing the decision keeps Complete on the stored digest only', () => {
    const reconciling = reduceCompletion(completing(), {
      type: 'complete_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const after = run(reconciling, [decidedLoad(ACTION)]).state;
    expect(after).toMatchObject({
      phase: 'decided',
      notice: COMPLETION_COPY.recordedNotCompleted,
      actionDigest: ACTION,
      acknowledgeComplete: true,
    });
    expect(run(after, [{ type: 'complete_requested' }]).effects).toEqual([
      { type: 'complete', actionDigest: ACTION },
    ]);
  });

  it('a read with no decision and no completion says the Goal was not completed when checked', () => {
    const reconciling = reduceCompletion(completing(), {
      type: 'complete_failed',
      refusal: unknownRefusal(),
      unknown: true,
    }).state;
    const after = run(reconciling, [decidedLoad(null)]).state;
    expect(after.notice).toBe(COMPLETION_RECOVERY_COPY.completeAbsent);
    expect(after.unknown).toBeNull();
  });
});

describe('recovery copy', () => {
  it('never says the earlier attempt failed, succeeded without a read, or was clean', () => {
    for (const text of Object.values(COMPLETION_RECOVERY_COPY)) {
      expect(text).not.toMatch(/Do not assume/);
      expect(text).not.toMatch(/\b(clean|no other|all good)\b/i);
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

// --- Decision relation and the copy for corrected and competing decisions (D.4R Slice 3) -------------------------------

function withDecisions(decisions: unknown[]): GoalExternalCompletionStatus {
  return { ...statusFor('not_completed'), decisions: decisions as GoalExternalCompletionStatus['decisions'] };
}

/** One decision row. `eligibility` is passed through unchecked so the fail-closed rules can be exercised. */
function decisionFor(attestationId: string, eligibility: unknown, valid = true) {
  return {
    approvalId: `approval-${attestationId}-${String(eligibility)}-${valid}`,
    actionDigest: 'a'.repeat(64),
    attestationId,
    status: 'approved',
    valid,
    invalidReason: null,
    eligibility,
    correctionStanding: 'active_uncontested',
  };
}

describe('decision relation', () => {
  const ME = 'attestation-me';
  const OTHER = 'attestation-other';
  const THIRD = 'attestation-third';

  it('is none when no valid decision exists, and when the only rows are invalid', () => {
    expect(decisionRelation(withDecisions([]), ME)).toBe('none');
    expect(decisionRelation(withDecisions([decisionFor(ME, 'invalid', false)]), ME)).toBe('none');
  });

  it('is decided_here for exactly one eligible decision of this attestation, even beside an ineligible one', () => {
    expect(decisionRelation(withDecisions([decisionFor(ME, 'eligible')]), ME)).toBe('decided_here');
    expect(
      decisionRelation(withDecisions([decisionFor(ME, 'eligible'), decisionFor(OTHER, 'ineligible')]), ME),
    ).toBe('decided_here');
  });

  it('is blocked_by_other when another attestation has an eligible decision and this one has none', () => {
    expect(decisionRelation(withDecisions([decisionFor(OTHER, 'eligible')]), ME)).toBe('blocked_by_other');
    expect(
      decisionRelation(withDecisions([decisionFor(ME, 'ineligible'), decisionFor(OTHER, 'eligible')]), ME),
    ).toBe('blocked_by_other');
    expect(
      decisionRelation(withDecisions([decisionFor(OTHER, 'eligible'), decisionFor(THIRD, 'eligible')]), ME),
    ).toBe('blocked_by_other');
  });

  it('is own_set_aside when this attestation decision is corrected and no other decision is eligible', () => {
    expect(decisionRelation(withDecisions([decisionFor(ME, 'ineligible')]), ME)).toBe('own_set_aside');
    expect(
      decisionRelation(withDecisions([decisionFor(ME, 'ineligible'), decisionFor(OTHER, 'ineligible')]), ME),
    ).toBe('own_set_aside');
  });

  it('is others_set_aside when only other attestations decisions exist and all are corrected', () => {
    expect(decisionRelation(withDecisions([decisionFor(OTHER, 'ineligible')]), ME)).toBe('others_set_aside');
  });

  it('is competing for two eligible decisions of this attestation, or this attestation beside another', () => {
    expect(
      decisionRelation(withDecisions([decisionFor(ME, 'eligible'), decisionFor(ME, 'eligible')]), ME),
    ).toBe('competing');
    expect(
      decisionRelation(withDecisions([decisionFor(ME, 'eligible'), decisionFor(OTHER, 'eligible')]), ME),
    ).toBe('competing');
  });

  it('fails closed: a missing or non-exact eligibility is not eligible, and an invalid row never counts', () => {
    expect(decisionRelation(withDecisions([decisionFor(ME, undefined)]), ME)).toBe('own_set_aside');
    expect(decisionRelation(withDecisions([decisionFor(ME, 'Eligible')]), ME)).toBe('own_set_aside');
    expect(decisionRelation(withDecisions([decisionFor(OTHER, 'eligible ')]), ME)).toBe('others_set_aside');
    expect(decisionRelation(withDecisions([decisionFor(OTHER, 'eligible', false)]), ME)).toBe('none');
    expect(decisionRelation(withDecisions([decisionFor(ME, 'eligible', false)]), ME)).toBe('none');
  });
});

describe('copy for a competing decision, a history that cannot be verified, and corrected decisions', () => {
  it('names a competing decision as a decision, not as a completion, and never by its code', () => {
    const competing = preflightReasonCopy('completion_already_recorded', 'competing_decision');
    expect(competing).not.toBe(preflightReasonCopy('completion_already_recorded'));
    expect(competing).not.toMatch(/has already been recorded|_|competing_decision/);
    expect(competing).toMatch(/decision/);
    expect(refusal(409, 'competing_decision').message).not.toBe(
      'The request was refused. Nothing was changed.',
    );
  });

  it('gives a history that cannot be verified its own sentence, never the generic one or its detail', () => {
    const history = preflightReasonCopy('completion_history_invalid', 'too_many_decisions');
    expect(history).not.toBe(preflightReasonCopy('some_unknown_blocker'));
    expect(history).not.toMatch(/_|too_many_decisions/);
    const refused = refusal(409, 'preflight_refused', 'completion_history_invalid').message;
    expect(refused).not.toBe(refusal(409, 'preflight_refused', 'some_unknown_blocker').message);
    expect(refused).not.toMatch(/_|completion_history_invalid/);
  });

  it('keeps the proof-exists sentence for a null detail, unchanged', () => {
    expect(preflightReasonCopy('completion_already_recorded')).toBe(
      'A completion has already been recorded for this Goal. Refresh to see it.',
    );
  });

  it('never says a decision is a completion, and never calls a corrected decision completed or verified', () => {
    const copy = [
      COMPLETION_COPY.blockedByEligibleDecision,
      COMPLETION_COPY.ownDecisionSetAside,
      COMPLETION_COPY.othersSetAside,
      COMPLETION_COPY.competingDecisions,
      COMPLETION_COPY.selectAttestation,
      preflightReasonCopy('completion_already_recorded', 'competing_decision'),
    ];
    for (const text of copy) {
      expect(text).not.toMatch(/has already been recorded|completed|verified|proven|\bdone\b|success/i);
      expect(text).not.toMatch(/_/);
    }
    expect(COMPLETION_COPY.ownDecisionSetAside).toMatch(/does not complete the Goal/);
    expect(COMPLETION_COPY.othersSetAside).toMatch(/does not complete the Goal/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, call, UnreadableResponseError } from '../api';
import { goalsApi } from './api';
import { isUnknownOutcome } from './unknownOutcome';

const DIG = 'a'.repeat(64);

/** One stubbed response for the next request; the stub is replaced for each test. */
function respond(status: number, body = '') {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (value: unknown) => JSON.stringify(value);

const decisionRecorded = {
  approvalId: 'approval-completion',
  actionDigest: DIG,
  preflightDigest: DIG,
  status: 'approved',
  reused: false,
};

const requested = {
  approvalId: 'ap1',
  actionDigest: DIG,
  status: 'pending',
  reused: false,
  detail: {
    correctionKind: 'dispute',
    sequence: 1,
    previousCorrectionDigest: null,
    replacementAttestationId: null,
    explanationDigest: null,
    reasonCode: 'observation_error',
  },
};

const requestCorrection = () =>
  goalsApi.requestCorrection('goal-1', 'handoff-1', 'att-1', DIG, {
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    explanation: null,
    replacementAttestationId: null,
  });

afterEach(() => vi.unstubAllGlobals());

describe('isUnknownOutcome', () => {
  it('is true when no response arrived, the server failed, or a success body was unusable', () => {
    expect(isUnknownOutcome(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnknownOutcome(new ApiError('x', 500))).toBe(true);
    expect(isUnknownOutcome(new ApiError('x', 503, 'decision_persistence_failed'))).toBe(true);
    expect(isUnknownOutcome(new UnreadableResponseError(201))).toBe(true);
  });

  it('is false for a definite refusal, which means nothing was written', () => {
    expect(isUnknownOutcome(new ApiError('x', 409, 'correction_chain_changed'))).toBe(false);
    expect(isUnknownOutcome(new ApiError('x', 429, 'completion_busy'))).toBe(false);
    expect(isUnknownOutcome(new ApiError('x', 422, 'decision_corrupt'))).toBe(false);
  });
});

describe('strict response reading', () => {
  it('keeps the existing behaviour when a 2xx body is unreadable and the caller did not ask for strictness', async () => {
    respond(200, 'not json');
    await expect(call('/api/x')).resolves.toEqual({});
  });

  it('throws UnreadableResponseError for an unreadable 2xx body when the caller asks for strictness', async () => {
    respond(200, 'not json');
    await expect(call('/api/x', { method: 'POST' }, { requireBody: true })).rejects.toBeInstanceOf(
      UnreadableResponseError,
    );
  });

  it('a refusal keeps its code and status even when the caller asks for strictness', async () => {
    respond(409, json({ error: 'stale', code: 'correction_chain_changed' }));
    const error = await call('/api/x', { method: 'POST' }, { requireBody: true }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'correction_chain_changed' });
  });
});

describe('write responses are checked before the client reads them', () => {
  it('a completion decision with an empty 201 body is an unknown outcome, not a success', async () => {
    const fetchMock = respond(201, '');
    const error = await goalsApi
      .recordCompletionDecision('goal-1', {
        attestationId: 'att-1',
        preflightDigest: DIG,
        acknowledgeContentNotProven: true,
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableResponseError);
    expect(isUnknownOutcome(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a completion decision with a body that lacks its digests is an unknown outcome', async () => {
    respond(201, json({ approvalId: 'approval-completion', status: 'approved' }));
    await expect(
      goalsApi.recordCompletionDecision('goal-1', {
        attestationId: 'att-1',
        preflightDigest: DIG,
        acknowledgeContentNotProven: true,
      }),
    ).rejects.toBeInstanceOf(UnreadableResponseError);
  });

  it('a completion decision with the expected shape resolves to it', async () => {
    respond(201, json(decisionRecorded));
    await expect(
      goalsApi.recordCompletionDecision('goal-1', {
        attestationId: 'att-1',
        preflightDigest: DIG,
        acknowledgeContentNotProven: true,
      }),
    ).resolves.toEqual(decisionRecorded);
  });

  it('a Goal completion with an empty body is an unknown outcome, and one with the flag resolves', async () => {
    respond(201, '');
    await expect(goalsApi.completeGoal('goal-1', DIG, true)).rejects.toBeInstanceOf(UnreadableResponseError);
    respond(201, json({ reused: false }));
    await expect(goalsApi.completeGoal('goal-1', DIG, true)).resolves.toEqual({ reused: false });
  });

  it('a correction request with an empty 201 body rejects instead of reading a missing detail', async () => {
    respond(201, '');
    const error = await requestCorrection().catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableResponseError);
    expect(isUnknownOutcome(error)).toBe(true);
  });

  it('a correction request whose detail is missing is an unknown outcome', async () => {
    respond(201, json({ ...requested, detail: undefined }));
    await expect(requestCorrection()).rejects.toBeInstanceOf(UnreadableResponseError);
  });

  it('a correction request with the expected shape resolves to it', async () => {
    respond(201, json(requested));
    await expect(requestCorrection()).resolves.toEqual(requested);
  });

  it('a correction decision needs its approval id and outcome', async () => {
    respond(200, json({ status: 'approved' }));
    await expect(
      goalsApi.decideCorrection('goal-1', 'ap1', DIG, { decision: 'denied' }),
    ).rejects.toBeInstanceOf(UnreadableResponseError);
    respond(200, json({ approvalId: 'ap1', status: 'denied' }));
    await expect(goalsApi.decideCorrection('goal-1', 'ap1', DIG, { decision: 'denied' })).resolves.toEqual({
      approvalId: 'ap1',
      status: 'denied',
    });
  });
});

describe('refusals and lost responses reach the recovery path', () => {
  it('a 503 from a write is unknown, with its code kept for the read that follows', async () => {
    respond(503, json({ error: 'x', code: 'persistence_failed' }));
    const error = await requestCorrection().catch((caught) => caught);
    expect(error).toMatchObject({ status: 503, code: 'persistence_failed' });
    expect(isUnknownOutcome(error)).toBe(true);
  });

  it('a 409 from a write is definite', async () => {
    respond(409, json({ error: 'x', code: 'correction_request_pending' }));
    const error = await requestCorrection().catch((caught) => caught);
    expect(isUnknownOutcome(error)).toBe(false);
  });

  it('a dropped connection is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const error = await goalsApi.completeGoal('goal-1', DIG, true).catch((caught) => caught);
    expect(isUnknownOutcome(error)).toBe(true);
  });
});

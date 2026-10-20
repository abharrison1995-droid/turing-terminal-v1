// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GoalAttestationCorrectionHistory,
  GoalAttestationCorrectionPendingRequest,
  GoalAttestationCorrectionRequested,
  GoalCompletionStanding,
  GoalExternalCompletionStatus,
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationObservation,
  GoalExternalIntegrationStoredStatus,
  GoalManualHandoffProjection,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { goalsApi } from './api';
import { GoalsPage } from './GoalsPage';
import { CORRECTION_COPY, CORRECTION_RECOVERY_COPY } from './correctionModel';
import { type CorrectionReplacementOption, GoalCorrection } from './GoalCorrection';
import {
  calls,
  detail,
  detailRoutes,
  item,
  openGoal,
  posts,
  preview,
  refuse,
  serve,
  type Routes,
} from './testKit';
import { clearInflightWritesForTests, type InflightWrite, isInflight } from './inflightWrites';

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
  clearInflightWritesForTests();
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

  it('a 200 response with an unusable body says the history could not be read and does not crash', async () => {
    mount({ [CORRECTIONS]: () => new Response('{}', { status: 200 }) });
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
    expect(text).toContain(
      'A saved correction request could not be read, so Turing cannot confirm whether yours was saved. Do not send it again.',
    );
  });
});

/*
 * The correction controls render inside the desktop Goal page's Handoff tab, so the server-event and switch cases mount
 * the whole page. The fixtures below are the minimum that tab reads; they mirror goalCompletion.test.tsx.
 */

const GOAL_B = 'goal-2';
const HANDOFF_B = 'handoff-goal-b';
const PAGE_COMMIT = '2'.repeat(40);
const PAGE_BASE = '3'.repeat(40);
const PAGE_TREE = '4'.repeat(40);
const PAGE_HANDOFF_DIGEST = '5'.repeat(64);
const GATE_TEXT = 'A correction is waiting for your decision';

function pageHandoff(handoffId: string, goalId: string): GoalManualIntegrationHandoff {
  return {
    schemaVersion: 1,
    kind: 'turing_goal_manual_integration_handoff',
    handoffId,
    goalId,
    definition: {
      version: 2,
      hash: 'e'.repeat(64),
      approvalId: 'definition-approval-2',
      approvalIdentityDigest: 'f'.repeat(64),
    },
    finalAcceptance: { approvalId: 'acceptance-2', identityDigest: '1'.repeat(64) },
    repository: { projectId: 'project-1', identity: '2'.repeat(64), objectFormat: 'sha1', scope: 'src/**' },
    source: { goalRef: `refs/heads/turing/goal/${goalId}`, commit: PAGE_COMMIT, tree: PAGE_TREE },
    target: {
      baseBranch: 'main',
      baseRef: 'refs/heads/main',
      observedBaseCommit: PAGE_BASE,
      observedBaseTree: '6'.repeat(40),
    },
    completion: { identityDigest: '4'.repeat(64), findingsIdentityDigest: '5'.repeat(64) },
    review: {
      finalReviewId: 'review-2',
      reviewIdentityDigest: '6'.repeat(64),
      evidenceIdentityDigest: '7'.repeat(64),
      evidence: [
        {
          evidenceId: 'evidence-2',
          criterionKey: 'build',
          verifierDigest: '8'.repeat(64),
          kind: 'build',
          verdict: 'satisfies',
          identityDigest: '9'.repeat(64),
        },
      ],
      changedPathDigest: 'a'.repeat(64),
      changedPathCount: 1,
      changedPathSummaryDigest: 'b'.repeat(64),
      diffPreviewLimit: 12_000,
      diffStatDigest: 'c'.repeat(64),
      diffStatTruncated: false,
      diffPreviewDigest: 'd'.repeat(64),
      diffPreviewTruncated: false,
    },
    projection: {
      changedPaths: ['src/result.ts'],
      changedPathsTruncated: false,
      diffStat: ' src/result.ts | 1 +',
      diffPreview: '+export const answer = 42;',
      inspectionCommands: [`git show --stat ${PAGE_COMMIT}`],
      manualIntegrationRequired: true,
      warning: 'Turing prepared this result but did not apply it.',
    },
    createdAt: '2026-10-09T12:00:00.000Z',
    handoffDigest: PAGE_HANDOFF_DIGEST,
  };
}

function pageProjection(record: GoalManualIntegrationHandoff): GoalManualHandoffProjection {
  return {
    state: 'current',
    label: 'Ready for manual integration',
    handoff: record,
    reason: null,
    actualApplication: 'not_performed_by_turing',
    goalCompletion: 'not_completed_by_handoff',
  };
}

function pageHistory(handoffId: string) {
  return {
    handoffs: [
      {
        handoffId,
        createdAt: '2026-10-09T12:00:00.000Z',
        definitionVersion: 2,
        sourceCommit: PAGE_COMMIT,
        handoffDigest: PAGE_HANDOFF_DIGEST,
      },
    ],
    limit: 50,
    nextOffset: null,
  };
}

function pageStoredStatus(record: GoalManualIntegrationHandoff): GoalExternalIntegrationStoredStatus {
  return {
    goalId: record.goalId,
    handoffId: record.handoffId,
    hasAttestation: true,
    attestations: [
      {
        attestationId: ATT,
        actionDigest: 'f'.repeat(64),
        recordDigest: 'a'.repeat(64),
        approvalId: 'approval-external',
        observedAt: '2026-10-09T12:30:00.000Z',
        decidedAt: '2026-10-09T12:31:00.000Z',
      },
    ],
    approvals: [],
    limit: 20,
    attestationsHaveMore: false,
    approvalsHaveMore: false,
  };
}

function pageAttestation(record: GoalManualIntegrationHandoff): GoalExternalIntegrationAttestationProjection {
  const observation: GoalExternalIntegrationObservation = {
    schemaVersion: 1,
    kind: 'turing_goal_external_integration_observation',
    goalId: record.goalId,
    completionContractVersion: 2,
    handoff: { id: record.handoffId, digest: record.handoffDigest },
    definition: { version: 2, hash: record.definition.hash, approvalId: record.definition.approvalId },
    review: {
      finalReviewId: record.review.finalReviewId,
      acceptanceApprovalId: record.finalAcceptance.approvalId,
      evidenceIdentityDigest: record.review.evidenceIdentityDigest,
    },
    repository: {
      projectId: record.repository.projectId,
      identity: record.repository.identity,
      scope: record.repository.scope,
      objectFormat: record.repository.objectFormat,
    },
    source: { ref: record.source.goalRef, commit: PAGE_COMMIT, tree: PAGE_TREE },
    destination: {
      ref: record.target.baseRef,
      expectedBaseCommit: PAGE_BASE,
      expectedBaseTree: record.target.observedBaseTree,
      observedCommit: PAGE_COMMIT,
      observedTree: PAGE_TREE,
    },
    proof: {
      mode: 'source_history_observed',
      sourceAncestor: true,
      baseAncestor: true,
      verifierVersion: 1,
      evidenceDigest: 'a'.repeat(64),
    },
    observedAt: '2026-10-09T12:30:00.000Z',
    actionDigest: 'f'.repeat(64),
  };
  return {
    state: 'current',
    record: {
      ...observation,
      kind: 'turing_goal_external_integration_attestation',
      attestationId: ATT,
      approvalId: 'approval-external',
      decision: {
        value: 'confirm_external_integration',
        decidedBy: 'user',
        decidedAt: '2026-10-09T12:31:00.000Z',
      },
      recordDigest: 'a'.repeat(64),
    },
    reason: null,
    claim: 'source_history_observed_at_recorded_time',
    contentPreservation: 'not_proven',
    goalCompletion: 'not_completed_by_attestation',
  } as unknown as GoalExternalIntegrationAttestationProjection;
}

function pageCompletion(goalId: string): GoalExternalCompletionStatus {
  return {
    goalId,
    state: 'not_completed',
    decisions: [],
    completion: null,
    // Only the claim is read by the completion panel's copy.
    completionStanding: {
      claim: {
        unqualifiedSuccessAllowed: true,
        trustedForDownstream: false,
        qualifier: 'none',
        contentPreservation: 'not_proven',
      },
    } as unknown as GoalCompletionStanding,
  };
}

/** A minimal stand-in for the browser's EventSource, so the desktop Goal page's refresh events can be emitted. */
class PageEventSource {
  static instances: PageEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    PageEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close(): void {}

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

/** The Goal page with the Handoff tab serving one current attestation whose correction gate is pending. */
function servePage(extra: Routes = {}) {
  const record = pageHandoff(HANDOFF, GOAL);
  const pendingGate = history({ pending: [pendingRow()] });
  serve(
    detailRoutes(detail(), {
      '/api/goals/goal-1/handoffs': () => pageHistory(HANDOFF),
      [`/api/goals/goal-1/handoffs/${HANDOFF}`]: () => ({ projection: pageProjection(record) }),
      [`/api/goals/goal-1/handoffs/${HANDOFF}/external-integration`]: () => pageStoredStatus(record),
      [`/api/goals/goal-1/handoffs/${HANDOFF}/external-integration/attestations/${ATT}`]: () => ({
        projection: pageAttestation(record),
      }),
      [CORRECTIONS]: () => pendingGate,
      '/api/goals/goal-1/completion': () => pageCompletion(GOAL),
      ...extra,
    }),
  );
}

async function openPageHandoffTab(user: ReturnType<typeof userEvent.setup>) {
  await openGoal(user);
  await user.click(await screen.findByRole('tab', { name: 'Handoff' }));
  // Selection is explicit: the first attestation in the history is chosen by one click, as a user would.
  const heading = await screen.findByRole('heading', { name: 'Attestation history' });
  await user.click(within(heading.parentElement!).getAllByRole('button')[0]!);
  await screen.findByRole('group', { name: GATE_TEXT });
}

describe('correction requests are never sent by server events, tab switches or Goal switches', () => {
  it('a server event for the Goal sends no correction request or decision', async () => {
    PageEventSource.instances = [];
    vi.stubGlobal('EventSource', PageEventSource);
    servePage();
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openPageHandoffTab(user);
    expect(posts()).toHaveLength(0);

    const reads = () => calls.filter((call) => call.path === CORRECTIONS).length;
    const before = reads();
    PageEventSource.instances[PageEventSource.instances.length - 1]!.emit('external_integration_corrected');
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // Let any follow-up work from the refresh settle before counting writes.
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 100)));

    expect(screen.getByRole('group', { name: GATE_TEXT })).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('switching tabs and back sends no correction request or decision', async () => {
    servePage();
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openPageHandoffTab(user);

    const reads = () => calls.filter((call) => call.path === CORRECTIONS).length;
    const before = reads();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    await screen.findByRole('group', { name: GATE_TEXT });

    expect(reads()).toBeGreaterThan(before);
    expect(posts()).toHaveLength(0);
  });

  it('switching to another Goal sends no correction request or decision, during or after the switch', async () => {
    const second = pageHandoff(HANDOFF_B, GOAL_B);
    servePage({
      '/api/goals': () => ({
        goals: [item(), item({ id: GOAL_B, title: 'Second Goal' })],
        total: 2,
        limit: 50,
      }),
      [`/api/goals/${GOAL_B}`]: () => ({ goal: detail({ id: GOAL_B, title: 'Second Goal' }) }),
      [`/api/goals/${GOAL_B}/preview`]: () => ({ preview: { ...preview(), goalId: GOAL_B } }),
      [`/api/goals/${GOAL_B}/handoffs`]: () => pageHistory(HANDOFF_B),
      [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}`]: () => ({ projection: pageProjection(second) }),
      [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}/external-integration`]: () => ({
        ...pageStoredStatus(second),
        goalId: GOAL_B,
      }),
      [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}/external-integration/attestations/${ATT}`]: () => ({
        projection: pageAttestation(second),
      }),
      [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}/external-integration/attestations/${ATT}/corrections`]:
        () => ({
          ...history({ pending: [pendingRow()] }),
          goalId: GOAL_B,
          handoffId: HANDOFF_B,
        }),
      [`/api/goals/${GOAL_B}/completion`]: () => pageCompletion(GOAL_B),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openPageHandoffTab(user);
    expect(posts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Second Goal/ }));
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    const historyHeading = await screen.findByRole('heading', { name: 'Attestation history' });
    await user.click(within(historyHeading.parentElement!).getAllByRole('button')[0]!);
    await screen.findByRole('group', { name: GATE_TEXT });
    expect(posts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    const returnHeading = await screen.findByRole('heading', { name: 'Attestation history' });
    await user.click(within(returnHeading.parentElement!).getAllByRole('button')[0]!);
    await screen.findByRole('group', { name: GATE_TEXT });
    expect(posts()).toHaveLength(0);
  });
});

describe('correction recovery after an ambiguous write (D.4E)', () => {
  const lost = () => new TypeError('Failed to fetch');
  const UNREADABLE =
    'A saved correction request could not be read, so Turing cannot confirm whether yours was saved. Do not send it again.';
  const savedCorrection = () =>
    ({
      approvalId: 'ap1',
      correctionId: 'c1',
      correctionKind: 'dispute',
      reasonCode: 'observation_error',
      decidedAt: '2026-10-01T00:00:00.000Z',
      sequence: 1,
    }) as unknown as GoalAttestationCorrectionHistory['corrections'][number];

  /** Opens the dispute form, chooses a reason and types the explanation. */
  async function fillDispute(user: ReturnType<typeof userEvent.setup>, explanation: string) {
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    if (explanation) await user.type(screen.getByLabelText(/^Explanation/), explanation);
  }

  it('a request whose response was lost is read back as pending, with its explanation restored and no alert', async () => {
    let saved = false;
    mount({
      [CORRECTIONS]: () => history(saved ? { pending: [pendingRow({ explanationRequired: true })] } : {}),
      [`POST ${CORRECTIONS}`]: () => {
        saved = true;
        throw lost();
      },
    });
    const user = userEvent.setup();
    await fillDispute(user, 'Held text');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    expect(
      await screen.findByText('Your correction request was saved. It is waiting for your decision.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText(/^Explanation/) as HTMLTextAreaElement).value).toBe('Held text');
    expect(posts()).toHaveLength(1);
  });

  it('a request lost before it was saved is reported as not saved, and Request again sends the same body and position', async () => {
    let attempts = 0;
    mount({
      [CORRECTIONS]: () => history(),
      [`POST ${CORRECTIONS}`]: () => {
        attempts += 1;
        if (attempts === 1) throw lost();
        return requested();
      },
    });
    const user = userEvent.setup();
    await fillDispute(user, 'Held text');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    expect(await screen.findByText(/Nothing was saved when Turing last checked/)).toBeTruthy();
    expect((screen.getByLabelText(/^Explanation/) as HTMLTextAreaElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Request again' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(posts()[1]!.headers['if-match']).toBe(`"${POS}"`);
  });

  it('a request whose pending state cannot be read names that, offers Check again, and sends nothing', async () => {
    let reads = 0;
    mount({
      [CORRECTIONS]: () => {
        reads += 1;
        return history(reads > 1 ? { pendingUnreadableCount: 1 } : {});
      },
      [`POST ${CORRECTIONS}`]: () => {
        throw lost();
      },
    });
    const user = userEvent.setup();
    await fillDispute(user, '');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    expect((await screen.findByRole('alert')).textContent).toBe(UNREADABLE);
    expect(screen.queryByRole('button', { name: 'Request again' })).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reads).toBeGreaterThan(2));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });

  it('a request answered with an empty success body is read again, not trusted', async () => {
    mount({
      [CORRECTIONS]: () => history(),
      [`POST ${CORRECTIONS}`]: () => new Response('', { status: 201 }),
    });
    const user = userEvent.setup();
    await fillDispute(user, '');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    expect(await screen.findByText(/Nothing was saved when Turing last checked/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it('a decision whose response was lost is read back as recorded, with no alert and no second decision', async () => {
    let recorded = false;
    mount({
      [CORRECTIONS]: () =>
        history(recorded ? { corrections: [savedCorrection()] } : { pending: [pendingRow()] }),
      [`POST ${DECISION}`]: () => {
        recorded = true;
        throw lost();
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Confirm correction' }));
    expect(await screen.findByText('The correction is recorded in the history.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it('a decision lost before it was saved returns to the same gate with the explanation, and confirms on the same digest', async () => {
    let attempts = 0;
    mount({
      [CORRECTIONS]: () =>
        history(
          attempts >= 2
            ? { corrections: [savedCorrection()] }
            : { pending: [pendingRow({ explanationRequired: true })] },
        ),
      [`POST ${DECISION}`]: () => {
        attempts += 1;
        if (attempts === 1) throw lost();
        return { approvalId: 'ap1', status: 'approved' };
      },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Explanation/), 'Held text');
    await user.click(screen.getByRole('button', { name: 'Confirm correction' }));
    expect(
      await screen.findByText('Not recorded yet. The request is still waiting for your decision.'),
    ).toBeTruthy();
    expect((screen.getByLabelText(/^Explanation/) as HTMLTextAreaElement).value).toBe('Held text');
    await user.click(screen.getByRole('button', { name: 'Confirm correction' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map((call) => call.headers['if-match'])).toEqual([`"${DIG}"`, `"${DIG}"`]);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(await screen.findByText('The correction is recorded in the history.')).toBeTruthy();
  });
});

describe('correction panel accessibility (D.4F.1)', () => {
  const gateName = 'A correction is waiting for your decision';

  it('K1: one status region stays mounted through the load and a request in flight', async () => {
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
    const status = screen.getByRole('status');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    expect(status.isConnected).toBe(true);
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    await waitFor(() => expect(status.textContent).toBe('Sending the request…'));
    expect(status.isConnected).toBe(true);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    release();
    await screen.findByRole('group', { name: gateName });
    expect(status.isConnected).toBe(true);
  });

  it('K2: a read that fails moves no focus, so a background read cannot steal it', async () => {
    mount({ [CORRECTIONS]: () => refuse(500, 'boom', 'server_error') });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The correction history could not be read.');
    expect(document.activeElement).not.toBe(alert);
  });

  it('K3: a refused request moves focus to its alert', async () => {
    mount({
      [CORRECTIONS]: () => history(),
      [`POST ${CORRECTIONS}`]: () => refuse(409, 'stale', 'correction_chain_changed'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    const alert = await screen.findByRole('alert');
    expect(document.activeElement).toBe(alert);
  });

  it('K4: Cancel returns focus to the action that opened the review, and sends nothing', async () => {
    mount({ [CORRECTIONS]: () => history() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dispute this attestation' }));
    expect(posts()).toHaveLength(0);
  });

  it.each(['Withdraw this attestation', 'Replace with another attestation'] as const)(
    'K5: Escape in the review opened by "%s" returns focus to that action and sends nothing',
    async (opener) => {
      mount({ [CORRECTIONS]: () => history() });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: opener }));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: opener }));
      expect(posts()).toHaveLength(0);
    },
  );

  it('K6: a history read that moves an open review to the gate moves focus nowhere', async () => {
    let pendingNow = false;
    const view = mount({
      [CORRECTIONS]: () => history({ pending: pendingNow ? [pendingRow()] : [] }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    pendingNow = true;
    view.rerender(
      <GoalCorrection
        goalId={GOAL}
        handoffId={HANDOFF}
        attestationId={ATT}
        refresh={1}
        replacementOptions={OPTIONS}
      />,
    );
    await screen.findByRole('group', { name: gateName });
    expect(document.activeElement).toBe(document.body);
  });

  it('K6b: a request whose response was lost arms no focus, so a later failed read cannot take it', async () => {
    let reads = 0;
    mount({
      [CORRECTIONS]: () => {
        reads += 1;
        return reads === 1 ? history() : refuse(500, 'boom', 'server_error');
      },
      [`POST ${CORRECTIONS}`]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Turing still cannot read the saved history');
    expect(document.activeElement).not.toBe(alert);
  });

  it('K7: every control in the review dialog has a name, and Tab visits them in order inside the dialog', async () => {
    mount({ [CORRECTIONS]: () => history() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispute this attestation?' });
    const reason = within(dialog).getByLabelText('Reason');
    await user.selectOptions(reason, 'observation_error');
    const explanation = within(dialog).getByLabelText(/^Explanation/);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const request = within(dialog).getByRole('button', { name: 'Request dispute' });
    expect(request).toHaveProperty('disabled', false);
    reason.focus();
    const visited: Element[] = [];
    for (let step = 0; step < 3; step += 1) {
      await user.tab();
      visited.push(document.activeElement as Element);
    }
    expect(visited).toEqual([explanation, cancel, request]);
  });

  it('K7 (gate): every gate control has a name, and Tab moves from the explanation to Confirm to Decline', async () => {
    mount({ [CORRECTIONS]: () => history({ pending: [pendingRow({ explanationRequired: true })] }) });
    const group = await screen.findByRole('group', { name: gateName });
    const explanation = within(group).getByLabelText(/^Explanation/);
    const confirm = within(group).getByRole('button', { name: 'Confirm correction' });
    const decline = within(group).getByRole('button', { name: 'Decline this request' });
    const user = userEvent.setup();
    await user.type(explanation, 'Reason text');
    expect(confirm).toHaveProperty('disabled', false);
    explanation.focus();
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(decline);
  });

  it('K8: the review dialog title is a level-5 heading, and the dialog is named by it', async () => {
    mount({ [CORRECTIONS]: () => history() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Dispute this attestation?' });
    const title = within(dialog).getByRole('heading', { level: 5, name: 'Dispute this attestation?' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  });
});

/** A response that stays open until the test releases it. */
function deferredResponse() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
}

const tipDispute = {
  correctionId: 'c0',
  kind: 'dispute' as const,
  sequence: 1,
  correctionDigest: DIG,
  replacementAttestationId: null,
};

/** A history whose chain moved on: one dispute is the tip, and the chain position is that dispute's digest. */
const movedChain = (pending: GoalAttestationCorrectionPendingRequest[]) =>
  history({
    standing: {
      goalId: GOAL,
      attestationId: ATT,
      standing: 'disputed',
      correctionCount: 1,
      tip: tipDispute,
      invalidCode: null,
    },
    chainPosition: DIG,
    pending,
  });

/** The Goal page with the second Goal added, so a switch can be made while a write is still in flight. */
function serveSecondGoal(extra: Routes = {}): Routes {
  const second = pageHandoff(HANDOFF_B, GOAL_B);
  return {
    '/api/goals': () => ({
      goals: [item(), item({ id: GOAL_B, title: 'Second Goal' })],
      total: 2,
      limit: 50,
    }),
    [`/api/goals/${GOAL_B}`]: () => ({ goal: detail({ id: GOAL_B, title: 'Second Goal' }) }),
    [`/api/goals/${GOAL_B}/preview`]: () => ({ preview: { ...preview(), goalId: GOAL_B } }),
    [`/api/goals/${GOAL_B}/handoffs`]: () => pageHistory(HANDOFF_B),
    [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}`]: () => ({ projection: pageProjection(second) }),
    [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}/external-integration`]: () => ({
      ...pageStoredStatus(second),
      goalId: GOAL_B,
    }),
    [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}/external-integration/attestations/${ATT}`]: () => ({
      projection: pageAttestation(second),
    }),
    [`/api/goals/${GOAL_B}/handoffs/${HANDOFF_B}/external-integration/attestations/${ATT}/corrections`]:
      () => ({
        ...history({ pending: [pendingRow()] }),
        goalId: GOAL_B,
        handoffId: HANDOFF_B,
      }),
    [`/api/goals/${GOAL_B}/completion`]: () => pageCompletion(GOAL_B),
    // Goal 2's completion review reads a preflight; a refused one with no reasons keeps that panel quiet here.
    [`/api/goals/${GOAL_B}/completion-preflight`]: () => ({
      preflight: {
        outcome: 'refused',
        reasons: [],
        digest: null,
        proofLimitations: { contentPreservation: 'not_proven' },
      },
    }),
    ...extra,
  };
}

/** Opens the first Goal's attestation and requests a dispute, which is then in flight. */
async function requestDisputeOnFirstGoal(user: ReturnType<typeof userEvent.setup>) {
  await openGoal(user);
  await user.click(await screen.findByRole('tab', { name: 'Handoff' }));
  const heading = await screen.findByRole('heading', { name: 'Attestation history' });
  await user.click(within(heading.parentElement!).getAllByRole('button')[0]!);
  await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
  await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
  await user.click(screen.getByRole('button', { name: 'Request dispute' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
}

/** Switches to the second Goal and opens its attestation; returns its gate group. */
async function openSecondGoalGate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'All Goals' }));
  await user.click(await screen.findByRole('button', { name: /Second Goal/ }));
  await user.click(screen.getByRole('tab', { name: 'Handoff' }));
  const heading = await screen.findByRole('heading', { name: 'Attestation history' });
  await user.click(within(heading.parentElement!).getAllByRole('button')[0]!);
  return screen.findByRole('group', { name: GATE_TEXT });
}

describe('correction gates against the chain, and late responses (D.4F.2)', () => {
  it('F2-C1: a pending request that no longer fits the chain shows out of date, with Confirm disabled and Decline enabled, and sends nothing', async () => {
    mount({ [CORRECTIONS]: () => movedChain([pendingRow()]) });
    const group = await screen.findByRole('group', { name: GATE_TEXT });
    expect(within(group).getByRole('button', { name: 'Confirm correction' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(group).getByRole('button', { name: 'Decline this request' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(within(group).getByText(CORRECTION_COPY.gateOutOfDate)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('F2-C2: a pending request that fits the chain keeps Confirm enabled, and the decision names its own digest', async () => {
    const actionDigest = 'e'.repeat(64);
    const fitting = pendingRow({
      correctionKind: 'withdraw',
      sequence: 2,
      previousCorrectionDigest: DIG,
      actionDigest,
    });
    mount({
      [CORRECTIONS]: () => movedChain([fitting]),
      [DECISION]: () => ({ approvalId: 'ap1', status: 'approved' }),
    });
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: GATE_TEXT });
    expect(within(group).queryByText(CORRECTION_COPY.gateOutOfDate)).toBeNull();
    await user.click(within(group).getByRole('button', { name: 'Confirm correction' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.path).toBe(DECISION);
    expect(posts()[0]?.headers['if-match']).toBe(`"${actionDigest}"`);
    expect(bodyOf(0)).toEqual({
      decision: 'approved',
      attestationId: ATT,
      correctionKind: 'withdraw',
      explanation: null,
    });
  });

  it('L3: a request held for the first Goal and released after a switch leaves the second Goal showing only its own gate', async () => {
    const held = deferredResponse();
    servePage(
      serveSecondGoal({
        [CORRECTIONS]: () => history(),
        [`POST ${CORRECTIONS}`]: async () => {
          await held.gate;
          return requested();
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await requestDisputeOnFirstGoal(user);
    const group = await openSecondGoalGate(user);
    expect(within(group).getByRole('button', { name: 'Confirm correction' })).toHaveProperty(
      'disabled',
      false,
    );
    held.release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(screen.getByRole('group', { name: GATE_TEXT })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dispute this attestation' })).toBeNull();
    expect(posts().map((call) => call.path)).toEqual([CORRECTIONS]);
  });

  it('L3b: a request lost after a switch shows no reconciling notice on the second Goal', async () => {
    const held = deferredResponse();
    servePage(
      serveSecondGoal({
        [CORRECTIONS]: () => history(),
        [`POST ${CORRECTIONS}`]: async () => {
          await held.gate;
          throw new TypeError('Failed to fetch');
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await requestDisputeOnFirstGoal(user);
    await openSecondGoalGate(user);
    held.release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(screen.queryByText(/could not confirm/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('group', { name: GATE_TEXT })).toBeTruthy();
    expect(posts().map((call) => call.path)).toEqual([CORRECTIONS]);
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

/** A response the test settles by hand with a value. Nothing here waits on time. */
function heldValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The request the panel registers for the held chain position and the reviewed body. */
const requestWrite = (): InflightWrite => ({
  goalId: GOAL,
  handoffId: HANDOFF,
  attestationId: ATT,
  kind: 'correction-request',
  identity: POS,
  detail: JSON.stringify({
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    explanation: null,
    replacementAttestationId: null,
  }),
});

/** The decision the panel registers for the pending approval, in the body it sends. */
const decisionWrite = (decision: 'approved' | 'denied'): InflightWrite => ({
  goalId: GOAL,
  handoffId: null,
  attestationId: ATT,
  kind: 'correction-decision',
  identity: 'ap1',
  detail: JSON.stringify({
    actionDigest: DIG,
    body:
      decision === 'approved'
        ? { decision, attestationId: ATT, correctionKind: 'dispute', explanation: null }
        : { decision },
  }),
});

describe('correction launch controls fired twice synchronously in one act()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Request dispute sends exactly one request', async () => {
    const response = heldValue<GoalAttestationCorrectionRequested>();
    mount({ [CORRECTIONS]: () => history(), [`POST ${CORRECTIONS}`]: () => response.promise });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    clickTwiceInOneAct(screen.getByRole('button', { name: 'Request dispute' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
    expect(isInflight(requestWrite())).toBe(true);

    await act(async () => {
      response.resolve(requested());
    });
    await screen.findByRole('group', { name: GATE_TEXT });
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
    expect(isInflight(requestWrite())).toBe(false);
  });

  it('Confirm correction sends exactly one decision', async () => {
    const response = heldValue<unknown>();
    mount({
      [CORRECTIONS]: () => history({ pending: [pendingRow()] }),
      [`POST ${DECISION}`]: () => response.promise,
    });
    clickTwiceInOneAct(await screen.findByRole('button', { name: 'Confirm correction' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
    expect(isInflight(decisionWrite('approved'))).toBe(true);

    await act(async () => {
      response.resolve({ approvalId: 'ap1', status: 'approved' });
    });
    await flushMicrotasks(10);
    expect(posts()).toHaveLength(1);
    expect(isInflight(decisionWrite('approved'))).toBe(false);
  });

  it('Decline this request sends exactly one decision', async () => {
    const response = heldValue<unknown>();
    mount({
      [CORRECTIONS]: () => history({ pending: [pendingRow()] }),
      [`POST ${DECISION}`]: () => response.promise,
    });
    clickTwiceInOneAct(await screen.findByRole('button', { name: 'Decline this request' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await flushMicrotasks();
    expect(posts()).toHaveLength(1);
    expect(isInflight(decisionWrite('denied'))).toBe(true);

    await act(async () => {
      response.resolve({ approvalId: 'ap1', status: 'denied' });
    });
    await flushMicrotasks(10);
    expect(posts()).toHaveLength(1);
    expect(isInflight(decisionWrite('denied'))).toBe(false);
  });
});

describe('synchronous throws from requestCorrection and decideCorrection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a synchronous throw from requestCorrection settles its entry, sends nothing, and shows the saved-history copy', async () => {
    const reread = heldValue<GoalAttestationCorrectionHistory>();
    let reads = 0;
    mount({
      [CORRECTIONS]: () => {
        reads += 1;
        return reads === 1 ? history() : reread.promise;
      },
    });
    const request = vi.spyOn(goalsApi, 'requestCorrection').mockImplementationOnce(() => {
      throw new Error('synchronous failure before the request');
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dispute this attestation' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'observation_error');
    await user.click(screen.getByRole('button', { name: 'Request dispute' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    // The reducer's unknown-outcome branch: the notice is the reconciling copy, and no refusal is set.
    expect(await screen.findByText(CORRECTION_RECOVERY_COPY.reconciling)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(isInflight(requestWrite())).toBe(false);
    expect(posts()).toEqual([]);

    await act(async () => {
      reread.resolve(history());
    });
    // Nothing is saved, so the held body is offered again through the same control, which is enabled.
    expect(await screen.findByText(CORRECTION_RECOVERY_COPY.absent)).toBeTruthy();
    expect(screen.getByRole('button', { name: CORRECTION_RECOVERY_COPY.requestAgain })).toHaveProperty(
      'disabled',
      false,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });

  it('a synchronous throw from decideCorrection settles its entry, sends nothing, and shows the saved-history copy', async () => {
    const reread = heldValue<GoalAttestationCorrectionHistory>();
    let reads = 0;
    mount({
      [CORRECTIONS]: () => {
        reads += 1;
        return reads === 1 ? history({ pending: [pendingRow()] }) : reread.promise;
      },
    });
    const decide = vi.spyOn(goalsApi, 'decideCorrection').mockImplementationOnce(() => {
      throw new Error('synchronous failure before the request');
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Confirm correction' }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(CORRECTION_RECOVERY_COPY.reconciling)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(isInflight(decisionWrite('approved'))).toBe(false);
    expect(posts()).toEqual([]);

    await act(async () => {
      reread.resolve(history({ pending: [pendingRow()] }));
    });
    // The request is still pending, so the gate returns and its Confirm control is enabled again.
    expect(await screen.findByRole('group', { name: GATE_TEXT })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm correction' })).toHaveProperty('disabled', false);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });
});

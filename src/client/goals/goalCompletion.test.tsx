// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GoalCompletionStanding,
  GoalCompletionStandingClaim,
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionStatus,
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationObservation,
  GoalExternalIntegrationStoredStatus,
  GoalManualHandoffProjection,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { COMPLETION_COPY, qualifierCopy } from './completionModel';
import { GoalsPage } from './GoalsPage';
import {
  calls,
  detail,
  detailRoutes,
  item,
  openGoal,
  posts,
  preview,
  refuse,
  type Routes,
  serve,
} from './testKit';

const source = 'a'.repeat(40);
const base = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const handoffDigest = 'd'.repeat(64);
const ATTESTATION = 'attestation-external';
const ACTION = '6'.repeat(64);
const PREFLIGHT_DIGEST = '7'.repeat(64);

function handoff(handoffId = 'handoff-v2'): GoalManualIntegrationHandoff {
  return {
    schemaVersion: 1,
    kind: 'turing_goal_manual_integration_handoff',
    handoffId,
    goalId: 'goal-1',
    definition: {
      version: 2,
      hash: 'e'.repeat(64),
      approvalId: 'definition-approval-2',
      approvalIdentityDigest: 'f'.repeat(64),
    },
    finalAcceptance: { approvalId: 'acceptance-2', identityDigest: '1'.repeat(64) },
    repository: { projectId: 'project-1', identity: '2'.repeat(64), objectFormat: 'sha1', scope: 'src/**' },
    source: { goalRef: 'refs/heads/turing/goal/goal-1', commit: source, tree },
    target: {
      baseBranch: 'main',
      baseRef: 'refs/heads/main',
      observedBaseCommit: base,
      observedBaseTree: '3'.repeat(40),
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
      inspectionCommands: [`git show --stat ${source}`],
      manualIntegrationRequired: true,
      warning: 'Turing prepared this result but did not apply it.',
    },
    createdAt: '2026-10-09T12:00:00.000Z',
    handoffDigest,
  };
}

function handoffProjection(record = handoff()): GoalManualHandoffProjection {
  return {
    state: 'current',
    label: 'Ready for manual integration',
    handoff: record,
    reason: null,
    actualApplication: 'not_performed_by_turing',
    goalCompletion: 'not_completed_by_handoff',
  };
}

function history(handoffId = 'handoff-v2') {
  return {
    handoffs: [
      {
        handoffId,
        createdAt: '2026-10-09T12:00:00.000Z',
        definitionVersion: 2,
        sourceCommit: source,
        handoffDigest,
      },
    ],
    limit: 50,
    nextOffset: null,
  };
}

function observation(record = handoff()): GoalExternalIntegrationObservation {
  return {
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
    source: { ref: record.source.goalRef, commit: source, tree },
    destination: {
      ref: record.target.baseRef,
      expectedBaseCommit: base,
      expectedBaseTree: record.target.observedBaseTree,
      observedCommit: source,
      observedTree: tree,
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
}

function storedStatus(record = handoff()): GoalExternalIntegrationStoredStatus {
  return {
    goalId: 'goal-1',
    handoffId: record.handoffId,
    hasAttestation: true,
    attestations: [
      {
        attestationId: ATTESTATION,
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

function attestationProjection(record = handoff()): GoalExternalIntegrationAttestationProjection {
  return {
    state: 'current',
    record: {
      ...observation(record),
      kind: 'turing_goal_external_integration_attestation',
      attestationId: ATTESTATION,
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

function preflight(
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
      definitionHash: 'e'.repeat(64),
      lineageDigest: null,
      mode: 'external_user_attested_v2',
      handoffId: 'handoff-v2',
      handoffDigest,
      attestationActionDigest: 'f'.repeat(64),
      attestationRecordDigest: 'a'.repeat(64),
      correctionStanding: 'active_uncontested',
      correctionSequence: 0,
      destinationRef: 'refs/heads/main',
      attestedCommit: source,
      attestedTree: tree,
      freshCommit: source,
      freshTree: tree,
      objectFormat: 'sha1',
    },
    actionFields: null,
    proofLimitations: {
      contentPreservation: 'not_proven',
      goalCompletion: 'not_completed_by_preflight',
      destinationPolicy: 'exact_attested_tip',
    },
    authority: { mintsApproval: false, mintsProof: false, mintsTerminalAuthority: false },
    digest: PREFLIGHT_DIGEST,
    ...overrides,
  };
}

function claim(qualifier: GoalCompletionStandingClaim['qualifier'] = 'none'): GoalCompletionStandingClaim {
  return {
    unqualifiedSuccessAllowed: true,
    trustedForDownstream: false,
    qualifier,
    contentPreservation: 'not_proven',
  };
}

function completionStatus(
  state: GoalExternalCompletionStatus['state'],
  options: {
    qualifier?: GoalCompletionStandingClaim['qualifier'];
    decisions?: GoalExternalCompletionStatus['decisions'];
    completion?: GoalExternalCompletionStatus['completion'];
  } = {},
): GoalExternalCompletionStatus {
  return {
    goalId: 'goal-1',
    state,
    decisions: options.decisions ?? [],
    completion: options.completion ?? null,
    // Only the claim is read by the panel's copy; the rest of the standing is not needed here.
    completionStanding: { claim: claim(options.qualifier) } as unknown as GoalCompletionStanding,
  };
}

const decisionRow = {
  approvalId: 'approval-completion',
  actionDigest: ACTION,
  attestationId: ATTESTATION,
  status: 'approved' as const,
  valid: true,
  invalidReason: null,
  eligibility: 'eligible' as const,
  correctionStanding: 'active_uncontested' as const,
};

/** Serves the Handoff tab with one current attestation and the completion routes given. */
function serveHandoff(
  completion: {
    status: GoalExternalCompletionStatus | (() => unknown);
    preflight?: GoalExternalCompletionPreflightReport | (() => unknown);
  },
  extra: Routes = {},
) {
  const record = handoff();
  serve(
    detailRoutes(detail(), {
      ...extra,
      '/api/goals/goal-1/handoffs': () => history(),
      [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({ projection: handoffProjection(record) }),
      [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () => storedStatus(record),
      [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/${ATTESTATION}`]:
        () => ({ projection: attestationProjection(record) }),
      '/api/goals/goal-1/completion':
        typeof completion.status === 'function' ? completion.status : () => completion.status,
      '/api/goals/goal-1/completion-preflight':
        completion.preflight === undefined
          ? () => ({ preflight: preflight() })
          : typeof completion.preflight === 'function'
            ? completion.preflight
            : () => ({ preflight: completion.preflight }),
    }),
  );
}

async function openHandoffTab(user: ReturnType<typeof userEvent.setup>) {
  await openGoal(user);
  await user.click(await screen.findByRole('tab', { name: 'Handoff' }));
  await chooseAttestation(user);
}

/**
 * Chooses the first attestation in the history. Selection is explicit: the Handoff tab no longer selects an attestation by
 * itself, so the completion review and the correction panel mount only after this click.
 */
async function chooseAttestation(user: ReturnType<typeof userEvent.setup>) {
  const heading = await screen.findByRole('heading', { name: 'Attestation history' });
  await user.click(within(heading.parentElement!).getAllByRole('button')[0]!);
}

/** The completion section, once it has finished its reads (aria-busy is false only then). */
async function completionSection() {
  const region = await screen.findByRole('region', { name: 'Completion review' });
  await waitFor(() => expect(region.getAttribute('aria-busy')).toBe('false'));
  return within(region);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('desktop completion review (read-only)', () => {
  it('renders a ready review with exact identities and the limitation, and offers only the record control, disabled until acknowledged', async () => {
    serveHandoff({ status: completionStatus('not_completed') });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await section.findByText(PREFLIGHT_DIGEST);
    expect(section.getByText(handoffDigest)).toBeTruthy();
    expect(section.getByText('handoff-v2')).toBeTruthy();
    expect(section.getByText(ATTESTATION)).toBeTruthy();
    // The attested and the current destination commit are both the source commit in this fixture.
    expect(section.getAllByText(source)).toHaveLength(2);
    expect(section.getAllByText(tree)).toHaveLength(2);
    expect(section.getByText('refs/heads/main')).toBeTruthy();
    expect(
      section.getByText(
        'Content preservation: not proven. Turing observed Git history at the time shown; it did not check that your changes are in the destination files.',
      ),
    ).toBeTruthy();
    expect(section.getByText('Uncontested')).toBeTruthy();
    expect(section.getByText('No blockers in this review.')).toBeTruthy();
    const buttons = section.queryAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Record completion decision']);
    expect(buttons[0]).toHaveProperty('disabled', true);
    expect(posts()).toEqual([]);
  });

  it('a refused preflight lists plain blockers and never prints their codes', async () => {
    serveHandoff({
      status: completionStatus('not_completed'),
      preflight: preflight({
        outcome: 'refused',
        reasons: [{ code: 'attestation_disputed', detail: null }],
        digest: '8'.repeat(64),
      }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const blockers = await section.findByRole('list', { name: 'Blockers' });
    expect(within(blockers).getByText('The attestation was corrected, so it cannot be used.')).toBeTruthy();
    expect(section.queryByText(/attestation_disputed/)).toBeNull();
  });

  it('a completed Goal is never headed as success and always shows the content-preservation line', async () => {
    serveHandoff({
      status: completionStatus('completed', {
        completion: {
          proofId: 'proof-1',
          proofDigest: '9'.repeat(64),
          approvalId: 'approval-completion',
          actionDigest: ACTION,
          attestationId: ATTESTATION,
          observedAt: '2026-10-09T12:30:00.000Z',
          completedAt: '2026-10-09T12:40:00.000Z',
        },
      }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByText('Completed on your decision')).toBeTruthy();
    expect(section.getByText('Content preservation: not proven.')).toBeTruthy();
    const text = (await screen.findByRole('region', { name: 'Completion review' })).textContent ?? '';
    expect(text).not.toMatch(/success|successfully|all done|\bdone\b|verified|preserved/i);
    expect(text).not.toMatch(/unqualifiedSuccessAllowed|contentPreservation|not_proven/);
    expect(screen.queryByRole('heading', { name: /^Goal completed/ })).toBeNull();
    expect(calls.some((call) => call.path === '/api/goals/goal-1/completion-preflight')).toBe(false);
  });

  it.each([
    'disputed_by_user',
    'withdrawn_by_user',
    'superseded_by_user',
    'replacement_failed',
    'proof_unverified',
    'legacy_not_v2_attested',
    'not_completed',
  ] as const)('the %s qualifier shows its sentence and never its token', async (qualifier) => {
    serveHandoff({ status: completionStatus('contested', { qualifier }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const region = await screen.findByRole('region', { name: 'Completion review' });
    await within(region).findByText('Completed earlier; later contested.');
    const sentence = region.querySelector('.goal-completion-qualifier');
    expect(sentence?.textContent?.length ?? 0).toBeGreaterThan(10);
    expect(region.textContent).not.toContain(qualifier);
  });

  it('contested, legacy and invalid Goals each render their own copy, and only a completed Goal says Completed on your decision', async () => {
    serveHandoff({ status: completionStatus('legacy', { qualifier: 'legacy_not_v2_attested' }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    let section = await completionSection();
    expect(
      await section.findByText('Completed before external attestation existed. Not attested.'),
    ).toBeTruthy();
    expect(section.queryByText('Completed on your decision')).toBeNull();
    cleanup();

    serveHandoff({ status: completionStatus('invalid') });
    const again = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(again);
    section = await completionSection();
    expect(await section.findByText('Completion records could not be verified.')).toBeTruthy();
    expect(section.queryByText('Completed on your decision')).toBeNull();
    expect(section.queryByText(/Completed before external attestation/)).toBeNull();
  });

  it('a recorded decision is recovered from the saved status after a remount, with no preflight read', async () => {
    serveHandoff({ status: completionStatus('decided', { decisions: [decisionRow] }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(
      await section.findByText('Your completion decision is recorded. The Goal is not completed yet.'),
    ).toBeTruthy();
    expect(section.getByText(ACTION)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    expect((await completionSection()).getByText(ACTION)).toBeTruthy();
    expect(calls.filter((call) => call.path === '/api/goals/goal-1/completion-preflight')).toHaveLength(0);
    expect(posts()).toEqual([]);
  });

  it('an unreadable status shows a neutral message with no raw code or server text', async () => {
    serveHandoff({ status: () => refuse(500, 'Server text that must not show.', 'completion_read_failed') });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByRole('alert')).toHaveTextContent(
      'The saved completion state could not be read.',
    );
    expect(section.queryByText(/completion_read_failed/)).toBeNull();
    expect(section.queryByText(/Server text/)).toBeNull();
  });
});

const created = (body: unknown) => new Response(JSON.stringify(body), { status: 201 });

const decisionRecorded = () => ({
  approvalId: 'approval-completion',
  actionDigest: ACTION,
  preflightDigest: PREFLIGHT_DIGEST,
  status: 'approved',
  reused: false,
});

const completedRecord = {
  proofId: 'proof-1',
  proofDigest: '9'.repeat(64),
  approvalId: 'approval-completion',
  actionDigest: ACTION,
  attestationId: ATTESTATION,
  observedAt: '2026-10-09T12:30:00.000Z',
  completedAt: '2026-10-09T12:40:00.000Z',
};

/** A Goal whose saved status moves only when an accepted write lands, as the server does. */
function statefulGoal() {
  const goal = { phase: 'open' as 'open' | 'decided' | 'completed' };
  const routes: Routes = {
    'POST /api/goals/goal-1/completion-decision': () => {
      goal.phase = 'decided';
      return created(decisionRecorded());
    },
    'POST /api/goals/goal-1/completion': () => {
      goal.phase = 'completed';
      return created({ reused: false });
    },
  };
  const status = () =>
    goal.phase === 'open'
      ? completionStatus('not_completed')
      : goal.phase === 'decided'
        ? completionStatus('decided', { decisions: [decisionRow] })
        : completionStatus('completed', { completion: completedRecord });
  return { routes, status };
}

const decisionWrites = () => posts().filter((call) => call.path === '/api/goals/goal-1/completion-decision');
const completionWrites = () => posts().filter((call) => call.path === '/api/goals/goal-1/completion');

describe('desktop completion controls', () => {
  it('keeps Complete Goal out of the review until a decision is recorded', async () => {
    serveHandoff({ status: completionStatus('not_completed') });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByRole('button', { name: 'Record completion decision' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(section.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('records a decision only after its acknowledgement, with the reviewed digest as If-Match and no completion request', async () => {
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const record = await section.findByRole('button', { name: 'Record completion decision' });
    expect(record).toHaveProperty('disabled', true);
    await user.click(section.getByRole('checkbox'));
    expect(record).toHaveProperty('disabled', false);
    await user.click(record);
    await section.findByRole('button', { name: 'Complete Goal' });
    expect(posts()).toHaveLength(1);
    const [sent] = posts();
    expect(sent?.path).toBe('/api/goals/goal-1/completion-decision');
    expect(sent?.headers['if-match']).toBe(`"${PREFLIGHT_DIGEST}"`);
    expect(sent?.body).toEqual({
      decision: 'record_completion_decision',
      attestationId: ATTESTATION,
      acknowledgeContentNotProven: true,
    });
  });

  it('completes only after its own acknowledgement, with the recorded action digest, and then shows the saved state', async () => {
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    let section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    const complete = await section.findByRole('button', { name: 'Complete Goal' });
    await waitFor(() => expect(section.getByRole('checkbox')).toHaveProperty('disabled', false));
    expect(complete).toHaveProperty('disabled', true);
    await user.click(section.getByRole('checkbox'));
    expect(complete).toHaveProperty('disabled', false);
    await user.click(complete);
    expect(await section.findByText('Completed on your decision')).toBeTruthy();
    section = await completionSection();
    expect(section.getByText('Content preservation: not proven.')).toBeTruthy();
    expect(section.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(posts().map((call) => call.path)).toEqual([
      '/api/goals/goal-1/completion-decision',
      '/api/goals/goal-1/completion',
    ]);
    expect(completionWrites()[0]?.headers['if-match']).toBe(`"${ACTION}"`);
    expect(completionWrites()[0]?.body).toEqual({
      decision: 'complete_goal',
      acknowledgeContentNotProven: true,
    });
  });

  it('a double click on either control sends one request', async () => {
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    let section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.dblClick(section.getByRole('button', { name: 'Record completion decision' }));
    await section.findByRole('button', { name: 'Complete Goal' });
    await waitFor(() => expect(section.getByRole('checkbox')).toHaveProperty('disabled', false));
    expect(decisionWrites()).toHaveLength(1);
    section = await completionSection();
    await user.click(section.getByRole('checkbox'));
    await user.dblClick(section.getByRole('button', { name: 'Complete Goal' }));
    await waitFor(() => expect(completionWrites()).toHaveLength(1));
    expect(decisionWrites()).toHaveLength(1);
  });

  it('a review that changed after a refused record resets the acknowledgement, and the next record sends the new digest', async () => {
    const digests = [PREFLIGHT_DIGEST, '8'.repeat(64)];
    let reads = 0;
    let writes = 0;
    serveHandoff(
      {
        status: completionStatus('not_completed'),
        preflight: () => ({
          preflight: preflight({ digest: digests[Math.min(reads++, digests.length - 1)] }),
        }),
      },
      {
        'POST /api/goals/goal-1/completion-decision': () =>
          writes++ === 0
            ? refuse(412, 'Server text that must not show.', 'reviewed_preflight_changed')
            : created(decisionRecorded()),
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    expect((await section.findByRole('alert')).textContent).toBe(
      'The destination or Goal changed since you reviewed it. Nothing was recorded. Review the refreshed summary.',
    );
    await section.findByText('8'.repeat(64));
    expect(section.getByRole('checkbox')).not.toHaveProperty('checked', true);
    expect(section.getByRole('button', { name: 'Record completion decision' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(decisionWrites()).toHaveLength(1);

    await user.click(section.getByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await waitFor(() => expect(decisionWrites()).toHaveLength(2));
    expect(decisionWrites().map((call) => call.headers['if-match'])).toEqual([
      `"${PREFLIGHT_DIGEST}"`,
      `"${'8'.repeat(64)}"`,
    ]);
  });

  it.each([
    [
      'reviewed_action_precondition_required',
      428,
      'Turing did not send a reviewed digest, so nothing was recorded. Refresh and review again.',
      true,
    ],
    ['acknowledgement_required', 400, 'Tick the acknowledgement first.', false],
    [
      'destination_changed',
      409,
      'The destination branch moved since your review. Nothing was recorded. Review again.',
      true,
    ],
    [
      'completion_conflict',
      409,
      'A different completion decision already exists for this Goal. Refresh to see it.',
      true,
    ],
    ['decision_not_found', 404, 'No recorded decision matches. Record the completion decision again.', true],
    ['proof_invalid', 422, 'Stored completion records failed a check. Nothing was changed.', false],
    ['completion_busy', 429, 'Another completion request is in progress. Try again shortly.', false],
  ] as const)(
    'a refused record shows its plain message and never the raw code (%s)',
    async (code, status, message, offersRefresh) => {
      serveHandoff(
        { status: completionStatus('not_completed') },
        {
          'POST /api/goals/goal-1/completion-decision': () =>
            refuse(status, 'Server text that must not show.', code),
        },
      );
      const user = userEvent.setup();
      render(<GoalsPage />);
      await openHandoffTab(user);
      const section = await completionSection();
      await user.click(await section.findByRole('checkbox'));
      await user.click(section.getByRole('button', { name: 'Record completion decision' }));
      expect((await section.findByRole('alert')).textContent).toBe(message);
      expect(section.queryByText(new RegExp(code))).toBeNull();
      expect(section.queryByText(/Server text/)).toBeNull();
      expect(section.queryByRole('button', { name: 'Refresh review' }) !== null).toBe(offersRefresh);
      expect(decisionWrites()).toHaveLength(1);
    },
  );
});

/** A minimal stand-in for the browser's EventSource, so the desktop cockpit's refresh events can be emitted. */
class MinimalEventSource {
  static instances: MinimalEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    MinimalEventSource.instances.push(this);
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

describe('completion is never sent without a click', () => {
  it('sends no completion request through mount, refresh events, tab switches and a recorded decision', async () => {
    MinimalEventSource.instances = [];
    vi.stubGlobal('EventSource', MinimalEventSource);
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    await (await completionSection()).findByRole('button', { name: 'Record completion decision' });
    expect(completionWrites()).toHaveLength(0);
    expect(decisionWrites()).toHaveLength(0);

    const statusReads = () => calls.filter((call) => call.path === '/api/goals/goal-1/completion').length;
    const before = statusReads();
    MinimalEventSource.instances[MinimalEventSource.instances.length - 1]!.emit('state_changed');
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    expect(completionWrites()).toHaveLength(0);

    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    let section = await completionSection();
    expect(completionWrites()).toHaveLength(0);
    expect(decisionWrites()).toHaveLength(0);

    await user.click(section.getByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await section.findByRole('button', { name: 'Complete Goal' });
    expect(decisionWrites()).toHaveLength(1);
    expect(completionWrites()).toHaveLength(0);

    section = await completionSection();
    await waitFor(() => expect(section.getByRole('checkbox')).toHaveProperty('disabled', false));
    await user.click(section.getByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    await waitFor(() => expect(completionWrites()).toHaveLength(1));
    expect(decisionWrites()).toHaveLength(1);
  });

  it('a 5-second timer advance with a recorded decision does not complete the Goal', async () => {
    serveHandoff(
      { status: completionStatus('decided', { decisions: [decisionRow] }) },
      {
        'POST /api/goals/goal-1/completion': () => created({ reused: false }),
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await section.findByRole('button', { name: 'Complete Goal' });
    expect(completionWrites()).toHaveLength(0);

    // Only the timer advance runs on the fake clock. The clicks run on real timers, because the testing library's
    // user-event wrapper waits on a setTimeout that a fake clock never fires.
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.useRealTimers();
    expect(completionWrites()).toHaveLength(0);
    expect(section.getByRole('checkbox')).toHaveProperty('checked', false);

    await user.click(section.getByRole('checkbox'));
    expect(section.getByRole('button', { name: 'Complete Goal' })).toHaveProperty('disabled', false);
    expect(completionWrites()).toHaveLength(0);
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    await waitFor(() => expect(completionWrites()).toHaveLength(1));
    expect(decisionWrites()).toHaveLength(0);
  });

  it('switching to another Goal does not complete the Goal, during or after the switch', async () => {
    const second = { ...handoff('handoff-goal-b'), goalId: 'goal-2' };
    serveHandoff(
      { status: completionStatus('decided', { decisions: [decisionRow] }) },
      {
        '/api/goals': () => ({
          goals: [item(), item({ id: 'goal-2', title: 'Second Goal' })],
          total: 2,
          limit: 50,
        }),
        '/api/goals/goal-2': () => ({ goal: detail({ id: 'goal-2', title: 'Second Goal' }) }),
        '/api/goals/goal-2/preview': () => ({ preview: { ...preview(), goalId: 'goal-2' } }),
        '/api/goals/goal-2/handoffs': () => history(second.handoffId),
        [`/api/goals/goal-2/handoffs/${second.handoffId}`]: () => ({ projection: handoffProjection(second) }),
        [`/api/goals/goal-2/handoffs/${second.handoffId}/external-integration`]: () => ({
          ...storedStatus(second),
          goalId: 'goal-2',
        }),
        [`/api/goals/goal-2/handoffs/${second.handoffId}/external-integration/attestations/${ATTESTATION}`]:
          () => ({ projection: attestationProjection(second) }),
        '/api/goals/goal-2/completion': () => completionStatus('not_completed'),
        '/api/goals/goal-2/completion-preflight': () => ({ preflight: preflight() }),
        'POST /api/goals/goal-1/completion': () => created({ reused: false }),
        'POST /api/goals/goal-2/completion': () => created({ reused: false }),
      },
    );
    const anyCompletionPosts = () => posts().filter((call) => call.path.endsWith('/completion'));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    let section = await completionSection();
    await section.findByRole('button', { name: 'Complete Goal' });
    expect(anyCompletionPosts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Second Goal/ }));
    expect(anyCompletionPosts()).toHaveLength(0);
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    await chooseAttestation(user);
    section = await completionSection();
    await section.findByRole('button', { name: 'Record completion decision' });
    expect(anyCompletionPosts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    await chooseAttestation(user);
    section = await completionSection();
    await section.findByRole('button', { name: 'Complete Goal' });
    expect(anyCompletionPosts()).toHaveLength(0);
    expect(decisionWrites()).toHaveLength(0);
  });

  it('a decision already recorded before the page loads does not complete the Goal on mount', async () => {
    serveHandoff(
      { status: completionStatus('decided', { decisions: [decisionRow] }) },
      {
        'POST /api/goals/goal-1/completion': () => created({ reused: false }),
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByRole('button', { name: 'Complete Goal' })).toHaveProperty('disabled', true);
    expect(section.getByRole('checkbox')).toHaveProperty('checked', false);
    expect(section.queryByRole('button', { name: 'Record completion decision' })).toBeNull();
    expect(completionWrites()).toHaveLength(0);
    expect(posts()).toEqual([]);
  });
});

describe('completion recovery after an ambiguous write (D.4E)', () => {
  const decisionPath = '/api/goals/goal-1/completion-decision';
  const completePath = '/api/goals/goal-1/completion';
  const lost = () => new TypeError('Failed to fetch');
  const UNAVAILABLE =
    'Turing still cannot read the saved state, so it cannot confirm the result. Check again before doing anything else.';

  it('a decision whose response was lost is read back as saved, once, with no unconfirmed alert', async () => {
    const goal = statefulGoal();
    const savedDecision = goal.routes[`POST ${decisionPath}`]!;
    serveHandoff(
      { status: goal.status },
      {
        ...goal.routes,
        [`POST ${decisionPath}`]: () => {
          savedDecision();
          throw lost();
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    expect(await section.findByText('Your decision was saved.')).toBeTruthy();
    expect(section.queryByRole('alert')).toBeNull();
    expect(section.queryByText(/Do not assume/)).toBeNull();
    expect(section.queryByText(/decision_persistence_failed/)).toBeNull();
    expect(section.getByRole('button', { name: 'Complete Goal' })).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });

  it('a decision lost before it was saved is reported as not saved, and needs a new acknowledgement', async () => {
    let attempts = 0;
    serveHandoff(
      { status: completionStatus('not_completed') },
      {
        [`POST ${decisionPath}`]: () => {
          attempts += 1;
          if (attempts === 1) throw lost();
          return created(decisionRecorded());
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    expect(await section.findByText(/Nothing was saved when Turing last checked/)).toBeTruthy();
    expect((section.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(decisionWrites()).toHaveLength(1);
    await user.click(section.getByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await waitFor(() => expect(decisionWrites()).toHaveLength(2));
    expect(decisionWrites().map((call) => call.headers['if-match'])).toEqual([
      `"${PREFLIGHT_DIGEST}"`,
      `"${PREFLIGHT_DIGEST}"`,
    ]);
  });

  it('a Goal completion whose response was lost is read back as completed', async () => {
    const goal = { completed: false };
    serveHandoff(
      {
        status: () =>
          goal.completed
            ? completionStatus('completed', { completion: completedRecord })
            : completionStatus('decided', { decisions: [decisionRow] }),
      },
      {
        [`POST ${completePath}`]: () => {
          goal.completed = true;
          throw lost();
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    expect(await section.findByText('The Goal was completed. This is the saved result.')).toBeTruthy();
    expect(section.getByText('Completed on your decision')).toBeTruthy();
    expect(section.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(completionWrites()).toHaveLength(1);
  });

  it('an unreadable Goal completion is read again, and Complete again sends only the stored digest', async () => {
    let completes = 0;
    serveHandoff(
      { status: () => completionStatus('decided', { decisions: [decisionRow] }) },
      {
        [`POST ${completePath}`]: () => {
          completes += 1;
          return completes === 1 ? new Response('', { status: 201 }) : created({ reused: true });
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    await waitFor(() =>
      expect(section.getByRole('status').textContent).toBe(
        'Your completion decision is recorded. The Goal is not completed yet.',
      ),
    );
    expect(section.queryByRole('alert')).toBeNull();
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    await waitFor(() => expect(completionWrites()).toHaveLength(2));
    expect(completionWrites().map((call) => call.headers['if-match'])).toEqual([
      `"${ACTION}"`,
      `"${ACTION}"`,
    ]);
  });

  it('when the recovery read fails, the only action is Check again, which reads and writes nothing', async () => {
    let failing = false;
    serveHandoff(
      {
        status: () => {
          if (failing) throw lost();
          return completionStatus('not_completed');
        },
      },
      {
        [`POST ${decisionPath}`]: () => {
          failing = true;
          throw lost();
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    expect((await section.findByRole('alert')).textContent).toBe(UNAVAILABLE);
    expect(section.queryByRole('button', { name: 'Refresh review' })).toBeNull();
    failing = false;
    await user.click(section.getByRole('button', { name: 'Check again' }));
    expect(await section.findByText(/Nothing was saved when Turing last checked/)).toBeTruthy();
    expect(decisionWrites()).toHaveLength(1);
  });

  it('a decision recorded for another attestation hides Record and points to that attestation', async () => {
    serveHandoff({
      status: completionStatus('decided', {
        decisions: [{ ...decisionRow, attestationId: 'attestation-other' }],
      }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(
      await section.findByText(
        'A completion decision for a different attestation of this Goal can still complete it, so no decision can be recorded here. Open that attestation to complete the Goal, or correct it (dispute, withdraw or supersede it) to set it aside.',
      ),
    ).toBeTruthy();
    expect(section.queryByRole('checkbox')).toBeNull();
    expect(section.queryByRole('button', { name: 'Record completion decision' })).toBeNull();
    expect(section.queryByText(/already been recorded/)).toBeNull();
    expect(calls.some((call) => call.path.endsWith('/completion-preflight'))).toBe(false);
  });

  it('a v2 standing with cut-off other attestations says so, and the Goal claim is unchanged', async () => {
    const status = {
      ...completionStatus('not_completed'),
      completionStanding: {
        kind: 'v2',
        claim: claim(),
        otherAttestations: [],
        otherAttestationsTruncated: true,
      } as unknown as GoalCompletionStanding,
    };
    serveHandoff({ status: () => status });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(
      await section.findByText(
        'Only the first 20 other attestations are listed. Others may exist and were not checked here.',
      ),
    ).toBeTruthy();
    expect(
      section.getByText('Not completed. No completion decision is recorded for this Goal.'),
    ).toBeTruthy();
  });

  it('a fresh mount reads the stored decision and Complete sends its digest', async () => {
    serveHandoff({ status: () => completionStatus('decided', { decisions: [decisionRow] }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    await waitFor(() => expect(completionWrites()).toHaveLength(1));
    expect(completionWrites()[0]!.headers['if-match']).toBe(`"${ACTION}"`);
  });
});

describe('completion relation to other and corrected decisions (D.4R Slice 3)', () => {
  const preflightReads = () => calls.filter((call) => call.path === '/api/goals/goal-1/completion-preflight');
  const corrected = (attestationId: string) =>
    ({
      ...decisionRow,
      attestationId,
      eligibility: 'ineligible' as const,
      correctionStanding: 'disputed' as const,
    }) as const;

  it('another attestation corrected: this attestation is still reviewed, Record is offered, and the note says the other decision no longer counts', async () => {
    serveHandoff({
      status: completionStatus('not_completed', { decisions: [corrected('attestation-other')] }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByRole('checkbox')).toBeTruthy();
    expect(section.getByText(COMPLETION_COPY.othersSetAside)).toBeTruthy();
    expect(section.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(preflightReads()).toHaveLength(1);
    expect(posts()).toEqual([]);
  });

  it('this attestation corrected: the set-aside note shows, no Record or Complete control is offered, and no review is read', async () => {
    serveHandoff({ status: completionStatus('not_completed', { decisions: [corrected(ATTESTATION)] }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByText(COMPLETION_COPY.ownDecisionSetAside)).toBeTruthy();
    expect(section.queryByRole('checkbox')).toBeNull();
    expect(section.queryByRole('button', { name: 'Record completion decision' })).toBeNull();
    expect(section.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(preflightReads()).toHaveLength(0);
    expect(posts()).toEqual([]);
  });

  it('two eligible decisions, one of them this attestation: the competing note shows and Complete is not offered', async () => {
    serveHandoff({
      status: completionStatus('decided', {
        decisions: [
          decisionRow,
          { ...decisionRow, approvalId: 'approval-second', attestationId: 'attestation-other' },
        ],
      }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByText(COMPLETION_COPY.competingDecisions)).toBeTruthy();
    expect(section.queryByRole('button', { name: 'Complete Goal' })).toBeNull();
    expect(section.queryByRole('checkbox')).toBeNull();
    expect(preflightReads()).toHaveLength(0);
    expect(posts()).toEqual([]);
  });

  it('a refused review that names a competing decision says so as a decision, never as a completion', async () => {
    serveHandoff({
      status: completionStatus('not_completed'),
      preflight: preflight({
        outcome: 'refused',
        reasons: [{ code: 'completion_already_recorded', detail: 'competing_decision' }],
        digest: '8'.repeat(64),
      }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const blockers = await section.findByRole('list', { name: 'Blockers' });
    expect(blockers.textContent).toMatch(/can already complete this Goal/);
    expect(section.queryByText(/has already been recorded/)).toBeNull();
    expect(section.queryByRole('checkbox')).toBeNull();
  });

  it('a refused review whose history cannot be verified shows its own sentence and never prints the code or the detail', async () => {
    serveHandoff({
      status: completionStatus('not_completed'),
      preflight: preflight({
        outcome: 'refused',
        reasons: [{ code: 'completion_history_invalid', detail: 'attestation_not_found' }],
        digest: '8'.repeat(64),
      }),
    });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const blockers = await section.findByRole('list', { name: 'Blockers' });
    expect(blockers.textContent).toMatch(/could not be verified, so no decision can be recorded here/);
    expect(section.queryByText(/completion_history_invalid|attestation_not_found/)).toBeNull();
    expect(section.queryByRole('checkbox')).toBeNull();
  });
});

describe('completion panel accessibility (D.4F.1)', () => {
  const decisionPath = '/api/goals/goal-1/completion-decision';
  const lostResponse = () => new TypeError('Failed to fetch');

  it('C1: one status region is mounted from the first render and is the same node after the load', async () => {
    serveHandoff({ status: completionStatus('not_completed') });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const region = await screen.findByRole('region', { name: 'Completion review' });
    const status = within(region).getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    const section = await completionSection();
    expect(status.isConnected).toBe(true);
    expect(section.getAllByRole('status')).toHaveLength(1);
  });

  it('C2: while a decision is being recorded, the same status node says so and there is still one status', async () => {
    const goal = statefulGoal();
    const savedDecision = goal.routes[`POST ${decisionPath}`]!;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveHandoff(
      { status: goal.status },
      {
        ...goal.routes,
        [`POST ${decisionPath}`]: async () => {
          await gate;
          return savedDecision();
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const status = section.getByRole('status');
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await waitFor(() => expect(status.textContent).toBe('Recording your decision…'));
    expect(section.getAllByRole('status')).toHaveLength(1);
    release();
    await section.findByRole('button', { name: 'Complete Goal' });
    expect(status.isConnected).toBe(true);
    expect(decisionWrites()).toHaveLength(1);
  });

  it('C3: a lost decision response read back as saved lands in the same status node, with no alert', async () => {
    const goal = statefulGoal();
    const savedDecision = goal.routes[`POST ${decisionPath}`]!;
    serveHandoff(
      { status: goal.status },
      {
        ...goal.routes,
        [`POST ${decisionPath}`]: () => {
          savedDecision();
          throw lostResponse();
        },
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const status = section.getByRole('status');
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await waitFor(() => expect(status.textContent).toBe('Your decision was saved.'));
    expect(status.isConnected).toBe(true);
    expect(section.getAllByRole('status')).toHaveLength(1);
    expect(section.queryByRole('alert')).toBeNull();
    expect(decisionWrites()).toHaveLength(1);
  });

  it('C4: a refused record moves focus to its alert, and the alert sits outside the status region', async () => {
    serveHandoff(
      { status: completionStatus('not_completed') },
      {
        [`POST ${decisionPath}`]: () => refuse(422, 'Server text that must not show.', 'proof_invalid'),
      },
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    const alert = await section.findByRole('alert');
    expect(alert.textContent).toBe('Stored completion records failed a check. Nothing was changed.');
    expect(alert.closest('[role="status"]')).toBeNull();
    expect(document.activeElement).toBe(alert);
  });

  it('C5: a failed status read shows its alert and does not move focus to it', async () => {
    serveHandoff({ status: () => refuse(500, 'Server text that must not show.', 'completion_read_failed') });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const alert = await section.findByRole('alert');
    expect(alert.textContent).toBe('The saved completion state could not be read.');
    expect(document.activeElement).not.toBe(alert);
  });

  it('C6: after a successful record, focus lands on the Complete checkbox once it is enabled', async () => {
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await section.findByRole('button', { name: 'Complete Goal' });
    await waitFor(() => expect(section.getByRole('checkbox')).toHaveProperty('disabled', false));
    expect(document.activeElement).toBe(section.getByRole('checkbox'));
  });

  it('C7: a keyboard-only walk records once on Enter, then completes once on Enter, and sends nothing on Space or Tab', async () => {
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    section.getByRole('checkbox').focus();
    await user.keyboard(' ');
    expect(section.getByRole('checkbox')).toHaveProperty('checked', true);
    await user.tab();
    const record = section.getByRole('button', { name: 'Record completion decision' });
    expect(document.activeElement).toBe(record);
    expect(posts()).toEqual([]);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(decisionWrites()).toHaveLength(1));
    expect(completionWrites()).toHaveLength(0);
    await waitFor(() => expect(section.getByRole('checkbox')).toHaveProperty('disabled', false));
    expect(document.activeElement).toBe(section.getByRole('checkbox'));

    await user.keyboard(' ');
    expect(section.getByRole('checkbox')).toHaveProperty('checked', true);
    await user.tab();
    expect(document.activeElement).toBe(section.getByRole('button', { name: 'Complete Goal' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(completionWrites()).toHaveLength(1));
    expect(posts().map((call) => call.path)).toEqual([decisionPath, '/api/goals/goal-1/completion']);
    expect(decisionWrites()[0]?.headers['if-match']).toBe(`"${PREFLIGHT_DIGEST}"`);
    expect(completionWrites()[0]?.headers['if-match']).toBe(`"${ACTION}"`);
  });

  it('C8: after a user-driven Complete succeeds, focus moves to the panel heading', async () => {
    const goal = statefulGoal();
    serveHandoff({ status: goal.status }, goal.routes);
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    await user.click(await section.findByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Record completion decision' }));
    await waitFor(() => expect(section.getByRole('checkbox')).toHaveProperty('disabled', false));
    await user.click(section.getByRole('checkbox'));
    await user.click(section.getByRole('button', { name: 'Complete Goal' }));
    expect(await section.findByText('Completed on your decision')).toBeTruthy();
    expect(document.activeElement).toBe(section.getByRole('heading', { name: 'Completion review' }));
  });

  it('C8 (read only): a panel that mounts already completed moves no focus into the panel', async () => {
    serveHandoff({ status: completionStatus('completed', { completion: completedRecord }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    expect(await section.findByText('Completed on your decision')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Completion review' }).contains(document.activeElement)).toBe(
      false,
    );
  });

  it.each([
    ['completed', 'none', 'Completed on your decision', true],
    ['contested', 'disputed_by_user', 'Completed earlier; later contested.', true],
    ['contested', 'superseded_by_user', 'Completed earlier; later contested.', true],
    [
      'legacy',
      'legacy_not_v2_attested',
      'Completed before external attestation existed. Not attested.',
      false,
    ],
    ['invalid', 'none', 'Completion records could not be verified.', false],
  ] as const)(
    'C9: the %s standing (qualifier %s) is one named group whose description carries only its own lines',
    async (state, qualifier, heading, carriesNotProven) => {
      serveHandoff({
        status: completionStatus(state, {
          qualifier,
          ...(state === 'completed' || state === 'contested' ? { completion: completedRecord } : {}),
        }),
      });
      const user = userEvent.setup();
      render(<GoalsPage />);
      await openHandoffTab(user);
      const section = await completionSection();
      const group = section.getByRole('group', { name: heading });
      expect(document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(heading);
      const description = (group.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      const sentence = qualifierCopy(qualifier);
      if (sentence !== null) expect(description).toContain(sentence);
      if (carriesNotProven) expect(description).toContain('Content preservation: not proven.');
      else expect(description).not.toMatch(/not proven/);
      if (state !== 'invalid') expect(heading).not.toMatch(/\b(succeeded|successfully|verified|safe)\b/i);
    },
  );

  it('C10: the Record controls are one named group, separate from the Complete controls', async () => {
    serveHandoff({ status: completionStatus('not_completed') });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const recording = section.getByRole('group', { name: 'Decision recording' });
    expect(within(recording).getByRole('checkbox')).toBeTruthy();
    expect(within(recording).getByRole('button', { name: 'Record completion decision' })).toBeTruthy();
    expect(section.queryByRole('group', { name: 'Goal completion' })).toBeNull();
  });

  it('C10 (decided): the Complete controls are one named group, with no Decision recording group', async () => {
    serveHandoff({ status: completionStatus('decided', { decisions: [decisionRow] }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoffTab(user);
    const section = await completionSection();
    const completion = section.getByRole('group', { name: 'Goal completion' });
    expect(within(completion).getByRole('checkbox')).toBeTruthy();
    expect(within(completion).getByRole('button', { name: 'Complete Goal' })).toBeTruthy();
    expect(section.queryByRole('group', { name: 'Decision recording' })).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationObservation,
  GoalExternalIntegrationStoredStatus,
  GoalManualHandoffProjection,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { GOAL_EVENT_TYPES } from '../../shared/goals';
import { GoalExternalIntegration } from './GoalExternalIntegration';
import { GoalsPage } from './GoalsPage';
import { calls, detail, detailRoutes, item, openGoal, posts, refuse, serve } from './testKit';

const source = 'a'.repeat(40);
const base = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const digest = 'd'.repeat(64);

function handoff(
  version = 2,
  handoffId = `handoff-v${version}`,
  goalId = 'goal-1',
): GoalManualIntegrationHandoff {
  return {
    schemaVersion: 1,
    kind: 'turing_goal_manual_integration_handoff',
    handoffId,
    goalId,
    definition: {
      version,
      hash: 'e'.repeat(64),
      approvalId: `definition-approval-${version}`,
      approvalIdentityDigest: 'f'.repeat(64),
    },
    finalAcceptance: { approvalId: `acceptance-${version}`, identityDigest: '1'.repeat(64) },
    repository: { projectId: 'project-1', identity: '2'.repeat(64), objectFormat: 'sha1', scope: 'src/**' },
    source: { goalRef: `refs/heads/turing/goal/${goalId}`, commit: source, tree },
    target: {
      baseBranch: 'main',
      baseRef: 'refs/heads/main',
      observedBaseCommit: base,
      observedBaseTree: '3'.repeat(40),
    },
    completion: { identityDigest: '4'.repeat(64), findingsIdentityDigest: '5'.repeat(64) },
    review: {
      finalReviewId: `review-${version}`,
      reviewIdentityDigest: '6'.repeat(64),
      evidenceIdentityDigest: '7'.repeat(64),
      evidence: [
        {
          evidenceId: `evidence-${version}`,
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
      diffStat: ' src/result.ts | 1 +\n 1 file changed, 1 insertion(+)',
      diffPreview: 'diff --git a/src/result.ts b/src/result.ts\n+export const answer = 42;\n',
      inspectionCommands: [
        `git show --stat ${source}`,
        `git diff --stat ${base} ${source}`,
        `git diff ${base} ${source}`,
      ],
      manualIntegrationRequired: true,
      warning: 'Turing prepared this result but did not apply it.',
    },
    createdAt: '2026-10-09T12:00:00.000Z',
    handoffDigest: digest,
  };
}

function projection(
  state: GoalManualHandoffProjection['state'] = 'current',
  record = handoff(),
): GoalManualHandoffProjection {
  const labels = {
    current: 'Ready for manual integration',
    stale: 'Handoff stale',
    unavailable: 'Handoff unavailable',
    invalid: 'Handoff invalid',
  } as const;
  return {
    state,
    label: labels[state],
    handoff: record,
    reason:
      state === 'current'
        ? null
        : { code: state === 'stale' ? 'base_diverged' : state, message: 'The observed state needs review.' },
    actualApplication: 'not_performed_by_turing',
    goalCompletion: 'not_completed_by_handoff',
  };
}

function history(
  ...rows: Array<{
    handoffId: string;
    definitionVersion: number;
    sourceCommit?: string;
    handoffDigest?: string;
  }>
) {
  return {
    handoffs: rows.map((row, index) => ({
      handoffId: row.handoffId,
      createdAt: `2026-10-0${index + 1}T12:00:00.000Z`,
      definitionVersion: row.definitionVersion,
      sourceCommit: row.sourceCommit ?? source,
      handoffDigest: row.handoffDigest ?? digest,
    })),
    limit: 50,
    nextOffset: null,
  };
}

function observation(record = handoff(), actionDigest = 'f'.repeat(64)): GoalExternalIntegrationObservation {
  return {
    schemaVersion: 1,
    kind: 'turing_goal_external_integration_observation',
    goalId: record.goalId,
    completionContractVersion: 2,
    handoff: { id: record.handoffId, digest: record.handoffDigest },
    definition: {
      version: record.definition.version,
      hash: record.definition.hash,
      approvalId: record.definition.approvalId,
    },
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
    source: { ref: record.source.goalRef, commit: record.source.commit, tree: record.source.tree },
    destination: {
      ref: record.target.baseRef,
      expectedBaseCommit: record.target.observedBaseCommit,
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
    actionDigest,
  };
}

function storedExternalStatus(
  record = handoff(),
  options: {
    attestationId?: string;
    actionDigest?: string;
    approvalStatus?: 'pending' | 'approved' | 'denied';
    approvalAttestationId?: string;
    attestationsHaveMore?: boolean;
    approvalsHaveMore?: boolean;
  } = {},
): GoalExternalIntegrationStoredStatus {
  const attestationId = options.attestationId;
  const actionDigest = options.actionDigest ?? 'f'.repeat(64);
  return {
    goalId: record.goalId,
    handoffId: record.handoffId,
    hasAttestation: Boolean(attestationId),
    attestations: attestationId
      ? [
          {
            attestationId,
            actionDigest,
            recordDigest: 'a'.repeat(64),
            approvalId: 'approval-external',
            observedAt: '2026-10-09T12:30:00.000Z',
            decidedAt: '2026-10-09T12:31:00.000Z',
          },
        ]
      : [],
    approvals: options.approvalStatus
      ? [
          {
            approvalId: 'approval-external',
            actionDigest,
            status: options.approvalStatus,
            decidedBy: options.approvalStatus === 'pending' ? null : 'user',
            createdAt: '2026-10-09T12:30:00.000Z',
            respondedAt: options.approvalStatus === 'pending' ? null : '2026-10-09T12:31:00.000Z',
            attestationId: options.approvalAttestationId ?? attestationId ?? null,
          },
        ]
      : [],
    limit: 20,
    attestationsHaveMore: options.attestationsHaveMore ?? false,
    approvalsHaveMore: options.approvalsHaveMore ?? false,
  };
}

function attestationProjection(
  record = handoff(),
  action = observation(record),
): GoalExternalIntegrationAttestationProjection {
  return {
    state: 'current',
    record: {
      ...action,
      kind: 'turing_goal_external_integration_attestation',
      attestationId: 'attestation-external',
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
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function openHandoff(user: ReturnType<typeof userEvent.setup>) {
  await openGoal(user);
  await user.click(await screen.findByRole('tab', { name: 'Handoff' }));
}

let originalClipboard: PropertyDescriptor | undefined;
let originalWindowClipboard: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalWindowClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalWindowClipboard) Object.defineProperty(window.navigator, 'clipboard', originalWindowClipboard);
  else Reflect.deleteProperty(window.navigator, 'clipboard');
});

describe('desktop manual handoff review', () => {
  it('does no handoff request until the tab is opened and cancellation sends no POST', async () => {
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => history(),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    expect(calls.some((call) => call.path.endsWith('/handoffs'))).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    expect(await screen.findByText('No handoffs have been prepared for this Goal.')).toBeInTheDocument();
    expect(posts()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Prepare an immutable handoff?' });
    expect(dialog).toHaveTextContent('does not change a Git ref');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts()).toEqual([]);
  });

  it('prepares once after confirmation, reloads currentness, and displays exact identities without applying', async () => {
    const record = handoff();
    let persisted = false;
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () =>
          persisted ? history({ handoffId: record.handoffId, definitionVersion: 2 }) : history(),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        'POST /api/goals/goal-1/handoffs': () => {
          persisted = true;
          return { handoffId: record.handoffId, handoffDigest: record.handoffDigest, reused: false };
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm preparation' });
    await user.dblClick(confirm);
    expect(await screen.findByRole('heading', { name: 'Ready for manual integration' })).toBeInTheDocument();
    expect(screen.getAllByText(record.source.commit).length).toBeGreaterThan(0);
    expect(screen.getByText(record.target.observedBaseTree)).toBeInTheDocument();
    expect(screen.getByText(/base application: not performed/)).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({});
  });

  it('announces an idempotently reused handoff after the server confirms it', async () => {
    const record = handoff();
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        'POST /api/goals/goal-1/handoffs': () => ({
          handoffId: record.handoffId,
          handoffDigest: record.handoffDigest,
          reused: true,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(
      await screen.findByText('The identical immutable handoff already existed and was reused.'),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });

  it.each(['stale', 'unavailable', 'invalid'] as const)(
    'shows the %s state and disables current-only commands',
    async (state) => {
      const record = handoff();
      serve(
        detailRoutes(detail(), {
          '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
          [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
            projection: projection(state, record),
          }),
        }),
      );
      const user = userEvent.setup();
      render(<GoalsPage />);
      await openHandoff(user);
      const messages = {
        stale: 'Handoff stale — review the updated Goal before preparing another',
        unavailable: 'Currentness cannot be verified',
        invalid: 'Handoff record could not be validated',
      };
      expect(await screen.findByRole('heading', { name: messages[state] })).toBeInTheDocument();
      expect(
        (screen.getByRole('button', { name: 'Copy read-only commands' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(posts()).toEqual([]);
    },
  );

  it('shows bounded truncation warnings and renders hostile filenames and diff bytes as inert text', async () => {
    const record = handoff();
    record.review.changedPathCount = 1_348;
    record.projection.changedPathsTruncated = true;
    record.projection.changedPaths = ['<img src=x onerror=alert(1)>'];
    record.review.diffPreviewTruncated = true;
    record.projection.diffPreview = '<script>alert(1)</script>\n';
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    expect(await screen.findByRole('heading', { name: 'Ready for manual integration' })).toBeInTheDocument();
    expect(screen.getByText('Showing the first 1 of 1,348 changed paths.')).toBeInTheDocument();
    expect(screen.getByText(/preview is truncated/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('region', { name: 'alert(1)' })).toBeNull();
    expect(screen.getByLabelText('Bounded diff preview')).toHaveTextContent('<script>alert(1)</script>');
  });

  it('selects historical v1/v2 handoffs and ignores an older validation response', async () => {
    const v2 = handoff(2, 'handoff-v2');
    const v1 = handoff(1, 'handoff-v1');
    let releaseV2: (value: { projection: GoalManualHandoffProjection }) => void = () => undefined;
    const heldV2 = new Promise<{ projection: GoalManualHandoffProjection }>((resolve) => {
      releaseV2 = resolve;
    });
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () =>
          history(
            { handoffId: v2.handoffId, definitionVersion: 2 },
            { handoffId: v1.handoffId, definitionVersion: 1 },
          ),
        [`/api/goals/goal-1/handoffs/${v2.handoffId}`]: () => heldV2,
        [`/api/goals/goal-1/handoffs/${v1.handoffId}`]: () => ({ projection: projection('stale', v1) }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    const v1Button = await screen.findByRole('button', { name: /v1/ });
    await user.click(v1Button);
    expect(
      await screen.findByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();
    releaseV2({ projection: projection('current', v2) });
    expect(
      screen.getByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Version 1 · ' + v1.definition.hash)).toBeInTheDocument();
  });

  it('does not let a previous Goal validation populate the next Goal', async () => {
    const first = handoff(1, 'handoff-first-goal');
    const second = handoff(2, 'handoff-second-goal', 'goal-2');
    let releaseFirst: (value: { projection: GoalManualHandoffProjection }) => void = () => undefined;
    const heldFirst = new Promise<{ projection: GoalManualHandoffProjection }>((resolve) => {
      releaseFirst = resolve;
    });
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals': () => ({
          goals: [item(), item({ id: 'goal-2', title: 'Second Goal' })],
          total: 2,
          limit: 50,
        }),
        '/api/goals/goal-2': () => ({ goal: detail({ id: 'goal-2', title: 'Second Goal' }) }),
        '/api/goals/goal-2/preview': () => ({ preview: { ...detail(), goalId: 'goal-2' } }),
        '/api/goals/goal-1/handoffs': () => history({ handoffId: first.handoffId, definitionVersion: 1 }),
        '/api/goals/goal-2/handoffs': () => history({ handoffId: second.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${first.handoffId}`]: () => heldFirst,
        [`/api/goals/goal-2/handoffs/${second.handoffId}`]: () => ({
          projection: projection('current', second),
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    await screen.findByRole('button', { name: /v1/ });
    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Second Goal/ }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    expect(await screen.findByRole('heading', { name: 'Ready for manual integration' })).toBeInTheDocument();
    expect(await screen.findByText(second.finalAcceptance.approvalId)).toBeInTheDocument();
    releaseFirst({ projection: projection('stale', first) });
    expect(screen.getByText(second.finalAcceptance.approvalId)).toBeInTheDocument();
    expect(screen.queryByText(first.finalAcceptance.approvalId)).toBeNull();
  });

  it('copies only validated read-only commands on a click and provides a selectable fallback', async () => {
    const record = handoff();
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
      }),
    );
    const user = userEvent.setup();
    const clipboardWrite = vi.fn(async () => {
      throw new Error('Clipboard unavailable');
    });
    const clipboard = { writeText: clipboardWrite };
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByRole('heading', { name: 'Ready for manual integration' });
    const copyButton = screen.getByRole('button', { name: 'Copy read-only commands' }) as HTMLButtonElement;
    expect(copyButton.disabled).toBe(false);
    fireEvent.click(copyButton);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull());
    const fallback = document.querySelector('textarea')!;
    expect(fallback.value).toBe(record.projection.inspectionCommands.join('\n'));
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('keeps preparation disabled when a failed POST cannot be reconciled with a fresh list read', async () => {
    let listReads = 0;
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => {
          listReads += 1;
          if (listReads > 1) throw new Error('network disconnected');
          return history();
        },
        'POST /api/goals/goal-1/handoffs': () => {
          throw new Error('connection closed after request');
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByText('No handoffs have been prepared for this Goal.');
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(await screen.findByText(/could not verify the outcome/)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(posts()).toHaveLength(1);
  });

  it('does not clear an unknown preparation outcome when refresh reconciliation fails repeatedly', async () => {
    let listReads = 0;
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => {
          listReads += 1;
          if (listReads === 1) return history();
          throw new Error(`network disconnected on read ${listReads}`);
        },
        'POST /api/goals/goal-1/handoffs': () => {
          throw new Error('connection closed after request');
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByText('No handoffs have been prepared for this Goal.');
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(await screen.findByText(/Preparation remains paused because/)).toBeInTheDocument();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const previousReadCount = listReads;
      await user.click(screen.getByRole('button', { name: 'Refresh currentness' }));
      await waitFor(() => expect(listReads).toBeGreaterThan(previousReadCount));
      await waitFor(() =>
        expect(screen.getAllByText(/Preparation remains paused/).length).toBeGreaterThan(0),
      );
      expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    expect(posts()).toHaveLength(1);
  });

  it('clears uncertainty only after a complete fresh paginated history read', async () => {
    let initialRead = true;
    const pageOffsets: number[] = [];
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => {
          const request = calls.at(-1);
          const offset = Number(request?.url.match(/[?&]offset=(\d+)/)?.[1] ?? 0);
          pageOffsets.push(offset);
          if (initialRead) {
            initialRead = false;
            return history();
          }
          if (offset === 0) return { handoffs: [], limit: 50, nextOffset: 50 };
          return history();
        },
        'POST /api/goals/goal-1/handoffs': () => {
          throw new Error('connection closed after request');
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByText('No handoffs have been prepared for this Goal.');
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(
      await screen.findByText(/bounded saved-handoff history was freshly read across all pages/i),
    ).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(pageOffsets).toContain(0);
    expect(pageOffsets).toContain(50);
    expect(posts()).toHaveLength(1);
  });

  it('does not treat an ordinary history refresh as reconciliation, then unlocks after a fresh complete read', async () => {
    let listReads = 0;
    const existing = handoff(1, 'handoff-v1');
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => {
          listReads += 1;
          if (listReads === 2) throw new Error('automatic reconciliation failed');
          return history({ handoffId: existing.handoffId, definitionVersion: 1 });
        },
        [`/api/goals/goal-1/handoffs/${existing.handoffId}`]: () => ({
          projection: projection('current', existing),
        }),
        'POST /api/goals/goal-1/handoffs': () => {
          throw new Error('connection closed after request');
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByRole('heading', { name: 'Ready for manual integration' });
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(await screen.findByText(/could not verify the outcome/)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Refresh list' }));
    await waitFor(() => expect(listReads).toBe(3));
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Refresh currentness' }));
    expect(
      await screen.findByText(/bounded saved-handoff history was freshly read across all pages/i),
    ).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(posts()).toHaveLength(1);
  });

  it('keeps an in-flight preparation uncertain across tab and Goal unmounts without leaking to another Goal', async () => {
    let rejectPreparation: (reason: Error) => void = () => undefined;
    const pendingPreparation = new Promise<never>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals': () => ({
          goals: [item(), item({ id: 'goal-2', title: 'Second Goal' })],
          total: 2,
          limit: 50,
        }),
        '/api/goals/goal-2': () => ({ goal: detail({ id: 'goal-2', title: 'Second Goal' }) }),
        '/api/goals/goal-2/preview': () => ({ preview: { ...detail(), goalId: 'goal-2' } }),
        '/api/goals/goal-1/handoffs': () => history(),
        '/api/goals/goal-2/handoffs': () => history(),
        'POST /api/goals/goal-1/handoffs': () => pendingPreparation,
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    await screen.findByText('No handoffs have been prepared for this Goal.');
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    await waitFor(() => expect(posts()).toHaveLength(1));

    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Second Goal/ }));
    rejectPreparation(new Error('connection closed after request'));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    expect(screen.queryByText(/Preparation is paused until a fresh/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare handoff' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'All Goals' }));
    await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
    await user.click(screen.getByRole('tab', { name: 'Handoff' }));
    expect(await screen.findByText(/Preparation is paused until a fresh/)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(posts()).toHaveLength(1);
  });

  it('keeps the exact newly prepared v2 handoff selected while v1 history is cached and refreshed', async () => {
    const v1 = handoff(1, 'handoff-v1');
    const v2 = handoff(2, 'handoff-v2');
    let listReads = 0;
    let releaseV2Projection: (value: { projection: GoalManualHandoffProjection }) => void = () => undefined;
    const heldV2Projection = new Promise<{ projection: GoalManualHandoffProjection }>((resolve) => {
      releaseV2Projection = resolve;
    });
    let releaseUpdatedHistory: (value: ReturnType<typeof history>) => void = () => undefined;
    const updatedHistory = new Promise<ReturnType<typeof history>>((resolve) => {
      releaseUpdatedHistory = resolve;
    });
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => {
          listReads += 1;
          if (listReads === 1) return history({ handoffId: v1.handoffId, definitionVersion: 1 });
          return updatedHistory;
        },
        [`/api/goals/goal-1/handoffs/${v1.handoffId}`]: () => ({
          projection: projection('stale', v1),
        }),
        [`/api/goals/goal-1/handoffs/${v2.handoffId}`]: () => heldV2Projection,
        'POST /api/goals/goal-1/handoffs': () => ({
          handoffId: v2.handoffId,
          handoffDigest: v2.handoffDigest,
          reused: false,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    expect(
      await screen.findByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(await screen.findByText(/Handoff handoff-v2 is selected\. Checking it/)).toBeInTheDocument();
    expect(await screen.findByText('Handoff record saved. Checking currentness now.')).toBeInTheDocument();
    expect(screen.queryByText(v1.finalAcceptance.approvalId)).toBeNull();
    releaseV2Projection({ projection: projection('current', v2) });
    expect(await screen.findByText(v2.finalAcceptance.approvalId)).toBeInTheDocument();
    expect(screen.getByText(`Version 2 · ${v2.definition.hash}`)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: /v1/ }) as HTMLButtonElement).getAttribute('aria-pressed'),
    ).toBe('false');

    releaseUpdatedHistory(
      history(
        { handoffId: v2.handoffId, definitionVersion: 2 },
        { handoffId: v1.handoffId, definitionVersion: 1 },
      ),
    );
    await waitFor(() => expect(screen.getByText(v2.finalAcceptance.approvalId)).toBeInTheDocument());
    expect(
      (screen.getByRole('button', { name: /v2/ }) as HTMLButtonElement).getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(screen.getByRole('button', { name: /v1/ }));
    expect(
      await screen.findByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText(v1.finalAcceptance.approvalId)).toBeInTheDocument();
  });

  it('keeps a prepared ID selected after projection failure and reports its later stale projection', async () => {
    const v1 = handoff(1, 'handoff-v1');
    const v2 = handoff(2, 'handoff-v2');
    let v2Reads = 0;
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: v1.handoffId, definitionVersion: 1 }),
        [`/api/goals/goal-1/handoffs/${v1.handoffId}`]: () => ({
          projection: projection('stale', v1),
        }),
        [`/api/goals/goal-1/handoffs/${v2.handoffId}`]: () => {
          v2Reads += 1;
          if (v2Reads === 1) throw new Error('projection read unavailable');
          return { projection: projection('stale', v2) };
        },
        'POST /api/goals/goal-1/handoffs': () => ({
          handoffId: v2.handoffId,
          handoffDigest: v2.handoffDigest,
          reused: false,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByRole('heading', {
      name: 'Handoff stale — review the updated Goal before preparing another',
    });
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(
      await screen.findByText(/Handoff handoff-v2 remains selected, but currentness could not be verified/),
    ).toBeInTheDocument();
    expect(screen.queryByText(v1.finalAcceptance.approvalId)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry currentness check' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry currentness check' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText(v2.finalAcceptance.approvalId)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ready for manual integration' })).toBeNull();
  });

  it('keeps a prepared handoff selected when preparation starts from an older history page', async () => {
    const v1 = handoff(1, 'handoff-v1');
    const v2 = handoff(2, 'handoff-v2');
    const newer = handoff(3, 'handoff-v3');
    serve(
      detailRoutes(detail({ nextAction: { kind: 'final_apply' } }), {
        '/api/goals/goal-1/handoffs': () => {
          const offset = Number(calls.at(-1)?.url.match(/[?&]offset=(\d+)/)?.[1] ?? 0);
          if (offset === 0) {
            return {
              ...history({ handoffId: newer.handoffId, definitionVersion: 3 }),
              nextOffset: 50,
            };
          }
          return history({ handoffId: v1.handoffId, definitionVersion: 1 });
        },
        [`/api/goals/goal-1/handoffs/${newer.handoffId}`]: () => ({
          projection: projection('current', newer),
        }),
        [`/api/goals/goal-1/handoffs/${v1.handoffId}`]: () => ({
          projection: projection('stale', v1),
        }),
        [`/api/goals/goal-1/handoffs/${v2.handoffId}`]: () => ({
          projection: projection('current', v2),
        }),
        'POST /api/goals/goal-1/handoffs': () => ({
          handoffId: v2.handoffId,
          handoffDigest: v2.handoffDigest,
          reused: false,
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Older handoffs' }));
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    expect(
      await screen.findByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await user.click(screen.getByRole('button', { name: 'Confirm preparation' }));
    expect(await screen.findByText(v2.finalAcceptance.approvalId)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newer handoffs' })).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: /v1/ }) as HTMLButtonElement).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('does not show accepted-result wording when the current Goal is not eligible', async () => {
    serve(
      detailRoutes(detail({ nextAction: { kind: 'wait_for_turing' } }), {
        '/api/goals/goal-1/handoffs': () => history(),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    expect(await screen.findByText(/A manual handoff is a durable review record/)).toBeInTheDocument();
    expect(screen.queryByText(/Your Goal result has been verified and accepted/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare handoff' })).toBeNull();
  });

  it('revalidates on SSE and refresh without preparing a handoff', async () => {
    class EventSourceFixture {
      static current: EventSourceFixture | null = null;
      listeners: Array<() => void> = [];
      constructor() {
        EventSourceFixture.current = this;
      }
      addEventListener(_name: string, listener: () => void) {
        this.listeners.push(listener);
      }
      close() {}
      emit() {
        for (const listener of this.listeners) listener();
      }
    }
    const source = EventSourceFixture;
    vi.stubGlobal('EventSource', source);
    const record = handoff();
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await screen.findByRole('heading', { name: 'Ready for manual integration' });
    const before = calls.filter((call) => call.url.includes('/handoffs')).length;
    EventSourceFixture.current?.emit();
    await waitFor(() =>
      expect(calls.filter((call) => call.url.includes('/handoffs')).length).toBeGreaterThan(before),
    );
    const beforeButtonRefresh = calls.filter((call) => call.url.includes('/handoffs')).length;
    await user.click(screen.getByRole('button', { name: 'Refresh currentness' }));
    await waitFor(() =>
      expect(calls.filter((call) => call.url.includes('/handoffs')).length).toBeGreaterThan(
        beforeButtonRefresh,
      ),
    );
    expect(posts()).toEqual([]);
    expect(GOAL_EVENT_TYPES).toContain('state_changed');
  });
});

describe('desktop external integration confirmation', () => {
  it('keeps pending digests scoped to their Goal and handoff across component remounts', async () => {
    const first = handoff(2, 'handoff-switch-a', 'goal-1');
    const second = handoff(2, 'handoff-switch-b', 'goal-2');
    const pending = '3'.repeat(64);
    const firstKey = `turing.goalExternalIntegration.v1:${first.goalId}:${first.handoffId}`;
    const secondKey = `turing.goalExternalIntegration.v1:${second.goalId}:${second.handoffId}`;
    sessionStorage.setItem(firstKey, pending);
    serve({
      [`/api/goals/${first.goalId}/handoffs/${first.handoffId}/external-integration`]: () =>
        storedExternalStatus(first),
      [`/api/goals/${second.goalId}/handoffs/${second.handoffId}/external-integration`]: () =>
        storedExternalStatus(second),
    });
    const viewFor = (record: GoalManualIntegrationHandoff) => (
      <GoalExternalIntegration
        key={`${record.goalId}:${record.handoffId}`}
        goalId={record.goalId}
        goalTitle={record.goalId}
        handoff={record}
      />
    );
    const { rerender } = render(viewFor(first));
    expect(await screen.findByText(pending)).toBeInTheDocument();

    rerender(viewFor(second));
    expect(screen.queryByText(pending)).toBeNull();
    expect(sessionStorage.getItem(firstKey)).toBe(pending);
    expect(sessionStorage.getItem(secondKey)).toBeNull();

    rerender(viewFor(first));
    expect(await screen.findByText(pending)).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  it('retains the recovery identity across remount when session storage writes are unavailable', async () => {
    const record = handoff(2, 'handoff-storage-unavailable', 'goal-1');
    const action = observation(record);
    const key = `turing.goalExternalIntegration.v1:${record.goalId}:${record.handoffId}`;
    let postStarted = false;
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      name,
      value,
    ) {
      if (name === key) throw new Error('session storage is unavailable');
      originalSetItem.call(this, name, value);
    });
    serve({
      [`/api/goals/${record.goalId}/handoffs/${record.handoffId}/external-integration`]: () => {
        if (postStarted) throw new Error('reconciliation unavailable');
        return storedExternalStatus(record);
      },
      [`/api/goals/${record.goalId}/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
        verification: {
          state: 'verified',
          observation: action,
          proofLimitations: {
            sourceHistory: 'observed',
            contentPreservation: 'not_proven',
            goalCompletion: 'not_completed_by_attestation',
          },
          reason: null,
        },
      }),
      [`POST /api/goals/${record.goalId}/handoffs/${record.handoffId}/external-integration/attest`]: () => {
        postStarted = true;
        return refuse(503, 'The response outcome is unknown.', 'external_integration_unavailable');
      },
    });
    const view = (keySuffix = 'mount-1') => (
      <GoalExternalIntegration
        key={keySuffix}
        goalId={record.goalId}
        goalTitle="Storage test"
        handoff={record}
      />
    );
    const user = userEvent.setup();
    const rendered = render(view());
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(action.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm external integration' }),
    );
    expect(await screen.findByText(/Saved status could not be read/)).toBeInTheDocument();
    expect(setItem).toHaveBeenCalledWith(key, action.actionDigest);
    expect(sessionStorage.getItem(key)).toBeNull();

    rendered.rerender(view('mount-2'));
    expect(await screen.findByText(action.actionDigest)).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmation recovery')).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    setItem.mockRestore();
  });

  it('keeps the pending lock when the saved attestation projection names a different approval', async () => {
    const record = handoff();
    const actionA = observation(record, 'f'.repeat(64));
    const actionB = observation(record, '0'.repeat(64));
    const key = `turing.goalExternalIntegration.v1:${record.goalId}:${record.handoffId}`;
    sessionStorage.setItem(key, actionA.actionDigest);
    serve({
      [`/api/goals/${record.goalId}/handoffs/${record.handoffId}/external-integration`]: () =>
        storedExternalStatus(record, {
          attestationId: 'attestation-external',
          actionDigest: actionA.actionDigest,
          approvalStatus: 'approved',
        }),
      [`/api/goals/${record.goalId}/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
        verification: {
          state: 'verified',
          observation: actionB,
          proofLimitations: {
            sourceHistory: 'observed',
            contentPreservation: 'not_proven',
            goalCompletion: 'not_completed_by_attestation',
          },
          reason: null,
        },
      }),
      [`/api/goals/${record.goalId}/handoffs/${record.handoffId}/external-integration/attestations/attestation-external`]:
        () => ({
          projection: {
            ...attestationProjection(record, actionA),
            record: {
              ...attestationProjection(record, actionA).record,
              approvalId: 'different-approval',
            },
          },
        }),
    });
    const user = userEvent.setup();
    render(
      <GoalExternalIntegration
        goalId={record.goalId}
        goalTitle="Projection identity test"
        handoff={record}
      />,
    );

    expect(
      await screen.findByText(/did not match the exact pending attestation and approval/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify external integration' }));
    expect(await screen.findByText(actionB.actionDigest)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: 'Confirm external integration' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(sessionStorage.getItem(key)).toBe(actionA.actionDigest);
    expect(posts()).toEqual([]);
  });

  it('offers read-only external verification when ordinary handoff currentness is stale', async () => {
    const record = handoff();
    const action = observation(record);
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('stale', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(record),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);

    expect(
      await screen.findByRole('heading', {
        name: 'Handoff stale — review the updated Goal before preparing another',
      }),
    ).toBeInTheDocument();
    const verify = screen.getByRole('button', { name: 'Verify external integration' });
    expect((verify as HTMLButtonElement).disabled).toBe(false);
    await user.click(verify);
    expect(await screen.findByText(action.actionDigest)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: 'Confirm external integration' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(posts()).toEqual([]);
  });

  it('keeps digest A locked after failed reconciliation when a later observation B is verified', async () => {
    const record = handoff();
    const actionA = observation(record, 'f'.repeat(64));
    const actionB = observation(record, '0'.repeat(64));
    let postCount = 0;
    let recoveryAvailable = false;
    let verificationReads = 0;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () => {
          if (postCount > 0 && !recoveryAvailable) throw new Error('reconciliation unavailable');
          if (postCount === 1 && recoveryAvailable)
            return storedExternalStatus(record, {
              attestationId: 'attestation-a',
              actionDigest: actionA.actionDigest,
              approvalStatus: 'approved',
            });
          if (postCount > 1)
            return storedExternalStatus(record, {
              attestationId: 'attestation-b',
              actionDigest: actionB.actionDigest,
              approvalStatus: 'approved',
            });
          return storedExternalStatus(record);
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: verificationReads++ === 0 ? actionA : actionB,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () => {
          postCount += 1;
          if (postCount === 1)
            return refuse(503, 'The response outcome is unknown.', 'external_integration_unavailable');
          return {
            attestationId: 'attestation-b',
            approvalId: 'approval-external',
            actionDigest: actionB.actionDigest,
            reusedAttestation: false,
            reusedApproval: false,
          };
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/attestation-a`]:
          () => ({
            projection: {
              ...attestationProjection(record, actionA),
              record: {
                ...attestationProjection(record, actionA).record,
                attestationId: 'attestation-a',
              },
            },
          }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/attestation-b`]:
          () => ({
            projection: {
              ...attestationProjection(record, actionB),
              record: {
                ...attestationProjection(record, actionB).record,
                attestationId: 'attestation-b',
              },
            },
          }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    expect(await screen.findByText(actionA.actionDigest)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm external integration' }),
    );

    expect(await screen.findByText(/Saved status could not be read/)).toBeInTheDocument();
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBe(
      actionA.actionDigest,
    );
    expect(actionA.actionDigest).not.toBe(actionB.actionDigest);

    await user.click(screen.getByRole('button', { name: 'Verify external integration' }));
    expect(await screen.findByText(actionB.actionDigest)).toBeInTheDocument();
    const confirmB = screen.getByRole('button', { name: 'Confirm external integration' });
    expect((confirmB as HTMLButtonElement).disabled).toBe(true);
    await user.click(confirmB);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBe(
      actionA.actionDigest,
    );

    await user.click(screen.getByRole('button', { name: 'Reconcile pending confirmation' }));
    expect(await screen.findByText(/Saved status could not be read/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify external integration' }));
    await waitFor(() => expect(verificationReads).toBe(3));
    expect(
      (screen.getByRole('button', { name: 'Confirm external integration' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Refresh saved status' }));
    await screen.findByRole('alert');
    expect(posts()).toHaveLength(1);
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBe(
      actionA.actionDigest,
    );

    recoveryAvailable = true;
    await user.click(screen.getByRole('button', { name: 'Reconcile pending confirmation' }));
    expect(await screen.findByText('User confirmed — source history observed')).toBeInTheDocument();
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verify external integration' }));
    expect(await screen.findByText(actionB.actionDigest)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    const confirmationB = screen.getByRole('alertdialog', { name: 'Confirm your manual integration?' });
    expect(confirmationB).toHaveTextContent(actionB.actionDigest);
    await user.click(within(confirmationB).getByRole('button', { name: 'Confirm external integration' }));
    await screen.findByText(/Your confirmation was recorded/);
    expect(posts()).toHaveLength(2);
    expect(posts().map((post) => post.headers['if-match'])).toEqual([
      `"${actionA.actionDigest}"`,
      `"${actionB.actionDigest}"`,
    ]);
  });

  it.each([
    ['not_integrated', 'The recorded source is not present in the destination history'],
    ['stale', 'The handoff or reviewed Git identity has changed'],
    ['unavailable', 'Current Git evidence cannot be verified'],
    ['invalid', 'The stored handoff or Git evidence is invalid'],
  ] as const)(
    'shows the typed %s verification state without offering a confirmation',
    async (state, label) => {
      const record = handoff();
      serve(
        detailRoutes(detail(), {
          '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
          [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
            projection: projection('current', record),
          }),
          [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
            storedExternalStatus(record),
          [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
            verification: {
              state,
              observation: null,
              proofLimitations: {
                contentPreservation: 'not_proven',
                goalCompletion: 'not_completed_by_attestation',
              },
              reason: { code: state, message: `Safe ${state} explanation.` },
            },
          }),
        }),
      );
      const user = userEvent.setup();
      render(<GoalsPage />);
      await openHandoff(user);
      await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
      expect(await screen.findByRole('heading', { name: label })).toBeInTheDocument();
      expect(screen.getByText(`Safe ${state} explanation. (${state})`)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Confirm external integration' })).toBeNull();
      expect(posts()).toEqual([]);
    },
  );

  it('shows exact proof and limitations, then sends one exact-digest POST only after explicit confirmation', async () => {
    const record = handoff();
    const action = observation(record);
    let persisted = false;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(
            record,
            persisted
              ? {
                  actionDigest: action.actionDigest,
                  approvalStatus: 'approved',
                  approvalAttestationId: 'attestation-external',
                  attestationsHaveMore: true,
                }
              : {},
          ),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: (body) => {
          persisted = true;
          expect(body).toEqual({ decision: 'confirm_external_integration' });
          return {
            attestationId: 'attestation-external',
            approvalId: 'approval-external',
            actionDigest: action.actionDigest,
            reusedAttestation: false,
            reusedApproval: false,
          };
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/attestation-external`]:
          () => ({
            projection: attestationProjection(record, action),
          }),
      }),
    );
    const user = userEvent.setup();
    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    render(<GoalsPage />);
    await openHandoff(user);
    expect(
      await screen.findByText('Request a fresh read-only check after you integrate the source commit.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/verification'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Verify external integration' }));
    expect(
      await screen.findByRole('heading', { name: 'Source history verified at this observation' }),
    ).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Source history verified at this observation' });
    expect(screen.getAllByText(record.source.commit).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not prove that every accepted file change survived/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy exact Git identities' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    expect(clipboardWrite).toHaveBeenCalledWith(
      expect.stringContaining(`Repository identity: ${record.repository.identity}`),
    );
    expect(posts()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm your manual integration?' });
    expect(dialog).toHaveTextContent('manually integrated this handoff');
    expect(dialog).toHaveTextContent(record.target.baseRef);
    expect(dialog).toHaveTextContent(record.repository.identity);
    expect(dialog).toHaveTextContent(action.destination.observedCommit);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    const confirmation = screen.getByRole('alertdialog', { name: 'Confirm your manual integration?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm external integration' }));
    expect(
      await screen.findByText(
        /Git history was observed; Git was not changed and the Goal remains incomplete/,
      ),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({ decision: 'confirm_external_integration' });
    expect(posts()[0]?.headers['if-match']).toBe(`"${action.actionDigest}"`);
    expect(await screen.findByText('User confirmed — source history observed')).toBeInTheDocument();
    expect(screen.queryByText(/^not_proven$/)).toBeNull();
  });

  it('refreshes changed evidence after a precondition refusal without approving or retrying it', async () => {
    const record = handoff();
    const reviewed = observation(record, 'f'.repeat(64));
    const changed = observation(record, '0'.repeat(64));
    let verifications = 0;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(record),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: verifications++ === 0 ? reviewed : changed,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () =>
          refuse(412, 'The reviewed evidence changed.', 'reviewed_observation_changed'),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(reviewed.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    const exactConfirmation = screen.getByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^Refresh$/ }));
    expect(await screen.findByText(changed.actionDigest)).toBeInTheDocument();
    expect(within(exactConfirmation).getByText(reviewed.actionDigest)).toBeInTheDocument();
    await user.click(within(exactConfirmation).getByRole('button', { name: 'Confirm external integration' }));
    expect(await screen.findByText(/evidence changed since review/)).toBeInTheDocument();
    expect(await screen.findByText(changed.actionDigest)).toBeInTheDocument();
    expect(verifications).toBe(3);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.headers['if-match']).toBe(`"${reviewed.actionDigest}"`);
  });

  it('keeps the newest verification when an older GET resolves later', async () => {
    const record = handoff();
    const oldObservation = observation(record, 'f'.repeat(64));
    const newerObservation = observation(record, '0'.repeat(64));
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let verifications = 0;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(record),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => {
          verifications += 1;
          return verifications === 1 ? first.promise : second.promise;
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await waitFor(() => expect(verifications).toBe(1));
    await user.click(screen.getByRole('button', { name: /^Refresh$/ }));
    await waitFor(() => expect(verifications).toBe(2));
    const response = (value: GoalExternalIntegrationObservation) => ({
      verification: {
        state: 'verified',
        observation: value,
        proofLimitations: {
          sourceHistory: 'observed',
          contentPreservation: 'not_proven',
          goalCompletion: 'not_completed_by_attestation',
        },
        reason: null,
      },
    });
    await act(async () => {
      second.resolve(response(newerObservation));
      await second.promise;
    });
    expect(await screen.findByText(newerObservation.actionDigest)).toBeInTheDocument();
    await act(async () => {
      first.resolve(response(oldObservation));
      await first.promise;
    });
    expect(screen.getByText(newerObservation.actionDigest)).toBeInTheDocument();
    expect(screen.queryByText(oldObservation.actionDigest)).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('locks an uncertain request, checks persisted state, and never retries POST automatically', async () => {
    const record = handoff();
    const action = observation(record);
    let statusReads = 0;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () => {
          statusReads += 1;
          return storedExternalStatus(record);
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () =>
          refuse(503, 'The response was lost.', 'external_integration_unavailable'),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(action.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm external integration' }),
    );
    expect(
      await screen.findByText(
        /No matching approval or attestation is stored as of this complete status read/,
      ),
    ).toBeInTheDocument();
    expect(statusReads).toBeGreaterThanOrEqual(2);
    expect(posts()).toHaveLength(1);
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm external integration' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verify external integration' }));
    expect(await screen.findByText(action.actionDigest)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: 'Confirm external integration' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it('prevents duplicate confirmation while the exact POST is still pending', async () => {
    const record = handoff();
    const action = observation(record);
    const pendingPost = deferred<unknown>();
    let persisted = false;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(
            record,
            persisted
              ? {
                  actionDigest: action.actionDigest,
                  approvalStatus: 'approved',
                  approvalAttestationId: 'attestation-external',
                  attestationsHaveMore: true,
                }
              : {},
          ),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () => {
          persisted = true;
          return pendingPost.promise;
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/attestation-external`]:
          () => ({
            projection: attestationProjection(record, action),
          }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(action.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    const dialog = screen.getByRole('alertdialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Confirm external integration' });
    await user.dblClick(confirmButton);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(
      (within(dialog).getByRole('button', { name: 'Recording confirmation…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      pendingPost.resolve({
        attestationId: 'attestation-external',
        approvalId: 'approval-external',
        actionDigest: action.actionDigest,
        reusedAttestation: false,
        reusedApproval: false,
      });
      await pendingPost.promise;
    });
    expect(await screen.findByText('User confirmed — source history observed')).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });

  it('shows a denied exact digest as non-retryable', async () => {
    const record = handoff();
    const action = observation(record);
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(record, { actionDigest: action.actionDigest, approvalStatus: 'denied' }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    expect(
      await screen.findByText('This exact action was denied and cannot be confirmed again.'),
    ).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: 'This action was denied' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(posts()).toEqual([]);
  });

  it('recovers a persisted immutable attestation after the POST response is lost', async () => {
    const record = handoff();
    const action = observation(record);
    let persisted = false;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(
            record,
            persisted
              ? {
                  actionDigest: action.actionDigest,
                  approvalStatus: 'approved',
                  approvalAttestationId: 'attestation-external',
                  attestationsHaveMore: true,
                }
              : {},
          ),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () => {
          persisted = true;
          return refuse(503, 'Connection ended after persistence.', 'external_integration_unavailable');
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/attestation-external`]:
          () => ({
            projection: attestationProjection(record, action),
          }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(action.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm external integration' }),
    );
    expect(await screen.findByText('User confirmed — source history observed')).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    await waitFor(() =>
      expect(
        sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`),
      ).toBeNull(),
    );
  });

  it('requires a deliberate confirmation to resume an approved orphan without replaying POST automatically', async () => {
    const record = handoff();
    const action = observation(record);
    let orphanedApproval = false;
    let persisted = false;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(
            record,
            persisted
              ? {
                  attestationId: 'attestation-external',
                  actionDigest: action.actionDigest,
                  approvalStatus: 'approved',
                }
              : orphanedApproval
                ? { actionDigest: action.actionDigest, approvalStatus: 'approved' }
                : {},
          ),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () => {
          if (!orphanedApproval) {
            orphanedApproval = true;
            return refuse(503, 'The response was lost after approval.', 'external_integration_unavailable');
          }
          persisted = true;
          return {
            attestationId: 'attestation-external',
            approvalId: 'approval-external',
            actionDigest: action.actionDigest,
            reusedAttestation: false,
            reusedApproval: true,
          };
        },
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attestations/attestation-external`]:
          () => ({ projection: attestationProjection(record, action) }),
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(action.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm external integration' }),
    );

    // The default 1000 ms wait flaked at about 1.1 s under full-suite load (one failing run, 2362-test suite).
    expect(
      await screen.findByText(/A matching approval exists without an attestation/, undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBe(
      action.actionDigest,
    );

    await user.click(screen.getByRole('button', { name: 'Resume attestation recording' }));
    const resume = screen.getByRole('alertdialog', { name: 'Confirm your manual integration?' });
    await user.click(within(resume).getByRole('button', { name: 'Confirm external integration' }));
    expect(await screen.findByText('User confirmed — source history observed')).toBeInTheDocument();
    expect(posts()).toHaveLength(2);
    expect(posts().map((post) => post.headers['if-match'])).toEqual([
      `"${action.actionDigest}"`,
      `"${action.actionDigest}"`,
    ]);
  });

  it('keeps an uncertain action locked when bounded recovery history may omit the digest', async () => {
    const record = handoff();
    const action = observation(record);
    let ambiguous = false;
    serve(
      detailRoutes(detail(), {
        '/api/goals/goal-1/handoffs': () => history({ handoffId: record.handoffId, definitionVersion: 2 }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}`]: () => ({
          projection: projection('current', record),
        }),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration`]: () =>
          storedExternalStatus(record, ambiguous ? { approvalsHaveMore: true } : {}),
        [`/api/goals/goal-1/handoffs/${record.handoffId}/external-integration/verification`]: () => ({
          verification: {
            state: 'verified',
            observation: action,
            proofLimitations: {
              sourceHistory: 'observed',
              contentPreservation: 'not_proven',
              goalCompletion: 'not_completed_by_attestation',
            },
            reason: null,
          },
        }),
        [`POST /api/goals/goal-1/handoffs/${record.handoffId}/external-integration/attest`]: () => {
          ambiguous = true;
          return refuse(503, 'The response outcome is unknown.', 'external_integration_unavailable');
        },
      }),
    );
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openHandoff(user);
    await user.click(await screen.findByRole('button', { name: 'Verify external integration' }));
    await screen.findByText(action.actionDigest);
    await user.click(screen.getByRole('button', { name: 'Confirm external integration' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm external integration' }),
    );

    expect(
      await screen.findByText(/history is truncated and may omit this exact action/),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBe(
      action.actionDigest,
    );
    expect(
      (screen.getByRole('button', { name: 'Confirm external integration' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Refresh saved status' }));
    await screen.findByText(/history is truncated and may omit this exact action/);
    expect(posts()).toHaveLength(1);
    expect(sessionStorage.getItem(`turing.goalExternalIntegration.v1:goal-1:${record.handoffId}`)).toBe(
      action.actionDigest,
    );
  });
});

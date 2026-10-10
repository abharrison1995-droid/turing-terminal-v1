// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalManualHandoffProjection, GoalManualIntegrationHandoff } from '../../shared/goalApi';
import { GOAL_EVENT_TYPES } from '../../shared/goals';
import { GoalsPage } from './GoalsPage';
import { calls, detail, detailRoutes, item, openGoal, posts, serve } from './testKit';

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
    expect(await screen.findByText(record.source.commit)).toBeInTheDocument();
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

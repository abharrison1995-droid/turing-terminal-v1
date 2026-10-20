// @vitest-environment jsdom

/*
 * UI.3 GUARD characterization of the Goal cockpit's structure (UI3_SCOPE section 5, matrix G10 and G11). These tests record
 * today's headings, tabs, button inventories, approval sections and copy, so a styling change that drops, duplicates or
 * reorders a control fails here. They prove DOM and copy in jsdom only. They do not prove layout or screen-reader output.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalCompletionStanding, GoalCompletionStandingClaim, GoalDetail } from '../../shared/goalApi';
import { phoneStandingView } from './completionStandingCopy';
import { GoalsPage } from './GoalsPage';
import { calls, detail, detailRoutes, openGoal, serve } from './testKit';

const NOW = '2026-01-01T00:00:00.000Z';

/** Named by the cockpit's own copy. Any of these on a compact screen would be a completion, correction or apply control. */
const COMPLETION_CONTROL =
  /Complete Goal|Record completion decision|Dispute|Withdraw|Replace with another|Confirm correction|Decline this request|Apply|Attest|Approve definition/i;
const COMPLETION_PATH =
  /(completion|completion-preflight|completion-decision|corrections|attestation-corrections|handoffs)/;

const TAB_LABELS = [
  'Overview',
  'Cycles',
  'Reviews',
  'Findings',
  'Evidence',
  'Definitions',
  'Usage',
  'Handoff',
];

const claimWith = (qualifier: GoalCompletionStandingClaim['qualifier']): GoalCompletionStandingClaim => ({
  unqualifiedSuccessAllowed: false,
  trustedForDownstream: false,
  qualifier,
  contentPreservation: 'not_proven',
});

const contestedStanding = (
  value: string,
  qualifier: GoalCompletionStandingClaim['qualifier'],
): GoalCompletionStanding =>
  ({
    schemaVersion: 1,
    goalId: 'goal-1',
    status: { goalStatus: 'completed', completedAt: NOW, reasonCode: null },
    kind: 'v2',
    standing: value,
    claim: claimWith(qualifier),
  }) as unknown as GoalCompletionStanding;

class TestMediaQuery {
  constructor(readonly matches: boolean) {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function setCompact(matches: boolean): void {
  vi.stubGlobal('matchMedia', (_media: string) => new TestMediaQuery(matches));
}

/** Accessible-ish names of every button in the document, in DOM order. */
const buttonNames = () => screen.getAllByRole('button').map((button) => button.textContent?.trim() ?? '');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('desktop Grand Projects list (G10)', () => {
  it('[GUARD] the list holds one row per Goal, and the page buttons outside it are New Grand Project and Refresh', async () => {
    setCompact(false);
    serve(detailRoutes(detail()));
    render(<GoalsPage />);

    const list = await screen.findByRole('list', { name: 'Grand Projects' });
    expect(screen.getByRole('heading', { level: 1, name: 'Grand Projects' })).toBeTruthy();
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).getAllByRole('button')[0]!.className).toContain('goal-row');
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => !button.closest('.goal-list'))
        .map((button) => button.textContent?.trim()),
    ).toEqual(['New Grand Project', 'Refresh']);
  });
});

describe('desktop Goal cockpit (G10)', () => {
  it('[GUARD] the cockpit has the Goal heading, the eight tabs in order, one approvals section, and All Goals and Refresh', async () => {
    setCompact(false);
    serve(detailRoutes(detail()));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);

    expect(await screen.findByRole('heading', { level: 2, name: 'Ship the importer' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual(TAB_LABELS);
    expect(document.querySelectorAll('[aria-label="Approvals for this Goal"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'All Goals' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});

describe('compact Goal cockpit (G11)', () => {
  it('[GUARD] a completed Goal with a contested standing shows no completion, correction, attestation or apply control and fetches no completion path', async () => {
    setCompact(true);
    const goal: GoalDetail = detail({
      status: 'completed',
      nextAction: { kind: 'completed' },
      completionStanding: contestedStanding('disputed', 'disputed_by_user'),
    });
    serve(detailRoutes(goal));
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await screen.findByRole('heading', { name: 'Ship the importer' });

    expect(screen.getByRole('region', { name: 'Completion standing' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Completion review' })).toBeNull();
    expect(buttonNames()).toEqual(['Grand Projects', 'Refresh']);
    expect(buttonNames().filter((name) => COMPLETION_CONTROL.test(name))).toEqual([]);
    expect(document.querySelectorAll('[aria-label="Approvals for this Goal"]')).toHaveLength(1);
    expect(calls.some((call) => COMPLETION_PATH.test(call.path))).toBe(false);
  });
});

describe('contested copy stays qualified (section 5)', () => {
  it.each([
    ['disputed', 'disputed_by_user'],
    ['withdrawn', 'withdrawn_by_user'],
    ['superseded', 'superseded_by_user'],
    ['reconciliation_required', 'replacement_failed'],
  ] as const)(
    '[GUARD] a %s standing is named contested and its copy never states an unqualified complete',
    (value, qualifier) => {
      const view = phoneStandingView(
        detail({ status: 'completed', completionStanding: contestedStanding(value, qualifier) }),
      );
      expect(view?.state).toBe('contested');
      const text = [
        view!.heading,
        view!.detail,
        view!.qualifier,
        view!.contentPreservation,
        view!.nextLabel,
        view!.nextSummary,
      ]
        .filter(Boolean)
        .join(' ');

      expect(view!.heading).toMatch(/contested/i);
      expect(text).not.toMatch(/\bcomplete\b|\bverified\b|\bsucceeded\b|\bconfirmed\b/i);
    },
  );
});

// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CompletionStandingBrief,
  GoalCompletionStanding,
  GoalCompletionStandingClaim,
  GoalListItem,
} from '../../shared/goalApi';
import { GoalsPage } from './GoalsPage';
import { calls, detail, detailRoutes, item, openGoal, posts, serve } from './testKit';

/*
 * The completed-Goal label in the list, the Overview card and the cockpit header. They prove text and attributes in
 * jsdom only. Every completed Goal must avoid a bare "Completed" unless its standing is the trusted one.
 */

const NOW = '2026-01-01T00:00:00.000Z';
const NOT_PROVEN = 'Turing has not proven content preservation.';
const BARE_DONE = 'This Goal is complete.';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TRUSTED: CompletionStandingBrief = {
  state: 'ready',
  standing: 'uncontested',
  qualifier: 'none',
  trusted: true,
  contentPreservation: 'not_proven',
};
type ReadyBrief = Extract<CompletionStandingBrief, { state: 'ready' }>;
const contested = (
  standing: 'disputed' | 'withdrawn' | 'superseded',
  qualifier: 'disputed_by_user' | 'withdrawn_by_user' | 'superseded_by_user',
): ReadyBrief => ({
  state: 'ready',
  standing,
  qualifier,
  trusted: false,
  contentPreservation: 'not_proven',
});

const completedItem = (id: string, brief?: CompletionStandingBrief | 'absent'): GoalListItem => {
  const base = item({ id, title: `Goal ${id}`, status: 'completed', nextAction: { kind: 'completed' } });
  if (brief === 'absent') return base;
  return { ...base, completionStandingBrief: brief ?? { state: 'unreadable' } };
};

async function renderList(goals: GoalListItem[]) {
  serve({ '/api/goals': () => ({ goals, total: goals.length, limit: 50 }) });
  render(<GoalsPage />);
  const list = await screen.findByRole('list', { name: 'Grand Projects' });
  return within(list).getAllByRole('button');
}

const pillOf = (row: HTMLElement) => row.querySelector('[data-goal-status]') as HTMLElement;
const nextOf = (row: HTMLElement) => row.querySelector('.goal-row-next') as HTMLElement;

describe('Goal list: a completed row never reads as a bare Completed unless its standing is trusted', () => {
  it('L-1 a trusted brief shows Completed with the content-not-proven detail', async () => {
    const [row] = await renderList([completedItem('goal-1', TRUSTED)]);
    expect(pillOf(row!).textContent).toBe('Completed');
    expect(nextOf(row!).textContent).toContain('Completed');
    expect(nextOf(row!).textContent).toContain(NOT_PROVEN);
    expect(row!.textContent).not.toContain(BARE_DONE);
  });

  it.each([
    [
      'disputed',
      'disputed_by_user',
      'A dispute was recorded against the attestation this completion relies on.',
    ],
    ['withdrawn', 'withdrawn_by_user', 'The attestation this completion relies on was withdrawn.'],
    [
      'superseded',
      'superseded_by_user',
      'The attestation this completion relies on was replaced by another.',
    ],
  ] as const)(
    'L-2 a %s brief shows the contested label and its qualifier, never the bare Completed',
    async (standing, qualifier, qualifierCopy) => {
      const [row] = await renderList([completedItem('goal-1', contested(standing, qualifier))]);
      expect(pillOf(row!).textContent).toBe('Completion contested');
      expect(nextOf(row!).textContent).toContain('Completion contested');
      expect(nextOf(row!).textContent).toContain(qualifierCopy);
      expect(nextOf(row!).textContent).not.toContain(NOT_PROVEN);
      expect(row!.textContent).not.toContain(BARE_DONE);
      expect(pillOf(row!).textContent).not.toBe('Completed');
    },
  );

  it('L-3 a completed row with no brief fails closed to the unavailable label', async () => {
    const [row] = await renderList([completedItem('goal-1', 'absent')]);
    expect(pillOf(row!).textContent).toBe('Standing could not be read');
    expect(nextOf(row!).textContent).toContain('Standing could not be read');
    expect(row!.textContent).not.toContain(BARE_DONE);
    expect(pillOf(row!).textContent).not.toBe('Completed');
  });

  it('L-4 an unreadable brief on a completed row fails closed to the unavailable label', async () => {
    const [row] = await renderList([completedItem('goal-1', { state: 'unreadable' })]);
    expect(pillOf(row!).textContent).toBe('Standing could not be read');
    expect(nextOf(row!).textContent).not.toBe('Completed');
  });

  it('L-5 a ready brief whose trusted flag disagrees with its standing fails closed', async () => {
    const [row] = await renderList([
      completedItem('goal-1', { ...contested('disputed', 'disputed_by_user'), trusted: true }),
    ]);
    expect(pillOf(row!).textContent).not.toBe('Completed');
    expect(row!.textContent).not.toContain(BARE_DONE);
  });

  it.each([
    ['not_applicable', 'not_applicable' as const],
    ['null', null],
  ])(
    'L-5b a trusted brief whose contentPreservation is %s fails closed to the not-recognised label',
    async (_label, value) => {
      const brief = { ...TRUSTED, contentPreservation: value } as unknown as CompletionStandingBrief;
      const [row] = await renderList([completedItem('goal-1', brief)]);
      expect(pillOf(row!).textContent).toBe('Standing not recognised');
      expect(nextOf(row!).textContent).not.toBe('Completed');
      expect(row!.textContent).not.toContain(BARE_DONE);
    },
  );

  it('L-6 a non-completed row keeps its status label and has no standing copy', async () => {
    const [row] = await renderList([
      item({ id: 'goal-1', status: 'running', nextAction: { kind: 'wait_for_turing' } }),
    ]);
    expect(pillOf(row!).textContent).toBe('Running');
    expect(row!.textContent).not.toContain('Standing could not be read');
    expect(row!.textContent).not.toContain('Completion contested');
  });

  it('L-7 rendering the list issues only its existing GET and no request for any standing', async () => {
    await renderList([
      completedItem('goal-1', TRUSTED),
      completedItem('goal-2', contested('disputed', 'disputed_by_user')),
    ]);
    expect(posts()).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual(['/api/goals']);
  });
});

/** A v2 standing as the detail route carries it, for the Overview and the cockpit header. */
function standing(value: string, claim: GoalCompletionStandingClaim): GoalCompletionStanding {
  return {
    schemaVersion: 1,
    goalId: 'goal-1',
    status: { goalStatus: 'completed', completedAt: NOW, reasonCode: null },
    kind: value === 'historical_legacy' ? 'legacy' : 'v2',
    standing: value,
    claim,
  } as unknown as GoalCompletionStanding;
}
const TRUSTED_CLAIM: GoalCompletionStandingClaim = {
  unqualifiedSuccessAllowed: true,
  trustedForDownstream: true,
  qualifier: 'none',
  contentPreservation: 'not_proven',
};
const DISPUTED_CLAIM: GoalCompletionStandingClaim = {
  unqualifiedSuccessAllowed: false,
  trustedForDownstream: false,
  qualifier: 'disputed_by_user',
  contentPreservation: 'not_proven',
};

async function openCompleted(completionStanding?: GoalCompletionStanding) {
  serve(detailRoutes(detail({ status: 'completed', nextAction: { kind: 'completed' }, completionStanding })));
  const user = userEvent.setup();
  render(<GoalsPage />);
  await openGoal(user);
  return screen.findByLabelText('Next action');
}

describe('Goal Overview and cockpit header: a completed Goal uses its saved standing', () => {
  it('L-8 the Overview card of a trusted completed Goal says Completed with the not-proven summary', async () => {
    const card = await openCompleted(standing('uncontested', TRUSTED_CLAIM));
    expect(card.querySelector('strong')?.textContent).toBe('Completed');
    expect(card.textContent).toContain(NOT_PROVEN);
    expect(card.textContent).not.toContain(BARE_DONE);
  });

  it('L-9 the Overview card of a disputed completed Goal uses the contested copy, never Completed', async () => {
    const card = await openCompleted(standing('disputed', DISPUTED_CLAIM));
    expect(card.querySelector('strong')?.textContent).toBe('Completion contested');
    expect(card.textContent).not.toContain(BARE_DONE);
  });

  it('L-10 the Overview card of a completed Goal with no saved standing fails closed', async () => {
    const card = await openCompleted(undefined);
    expect(card.querySelector('strong')?.textContent).toBe('Standing could not be read');
    expect(card.textContent).not.toContain(BARE_DONE);
  });

  it('L-11 the cockpit header pill of a disputed completed Goal shows the contested label, never Completed', async () => {
    await openCompleted(standing('disputed', DISPUTED_CLAIM));
    const header = document.querySelector('.goal-cockpit-head [data-goal-status]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.textContent).toBe('Completion contested');
  });

  it('L-12 the cockpit header pill of a trusted completed Goal says Completed', async () => {
    await openCompleted(standing('uncontested', TRUSTED_CLAIM));
    const header = document.querySelector('.goal-cockpit-head [data-goal-status]') as HTMLElement;
    expect(header.textContent).toBe('Completed');
  });
});

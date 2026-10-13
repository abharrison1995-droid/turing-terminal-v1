// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalCompletionStanding, GoalCompletionStandingClaim, GoalDetail } from '../../shared/goalApi';
import { GoalsPage } from './GoalsPage';
import { calls, detail, detailRoutes, openGoal, posts, serve } from './testKit';

/*
 * Compact-view tests for the Completion standing section. They prove text, roles and classes in jsdom only. They do not
 * prove layout, wrapping at narrow widths or screen-reader output.
 */

const NOW = '2026-01-01T00:00:00.000Z';
const STANDING_NOTE =
  'This view only shows the saved standing. It has no control to complete a Goal or to correct a completion.';
const COMPLETION_PATH =
  /(completion|completion-preflight|completion-decision|corrections|attestation-corrections|handoffs)/;
const ACTION_BUTTON =
  /Complete Goal|Record completion decision|Dispute|Withdraw|Replace with another|Confirm correction|Decline this request/;
/** The positive-claim words the section must not use. Negations are removed first. */
const BANNED =
  /\b(success\w*|succeeded|verified|confirmed|proven|preserved|prevent\w*|block\w*|unable|cannot call|enforc\w*|only on|phone|mobile|desktop|api)\b/i;

const CLAIM_TRUSTED: GoalCompletionStandingClaim = {
  unqualifiedSuccessAllowed: true,
  trustedForDownstream: true,
  qualifier: 'none',
  contentPreservation: 'not_proven',
};

const claimWith = (
  qualifier: GoalCompletionStandingClaim['qualifier'],
  contentPreservation: GoalCompletionStandingClaim['contentPreservation'] = 'not_proven',
): GoalCompletionStandingClaim => ({
  unqualifiedSuccessAllowed: false,
  trustedForDownstream: false,
  qualifier,
  contentPreservation,
});

function standing(
  kind: string,
  value: string | null,
  claim: GoalCompletionStandingClaim,
): GoalCompletionStanding {
  return {
    schemaVersion: 1,
    goalId: 'goal-1',
    status: { goalStatus: 'completed', completedAt: NOW, reasonCode: null },
    kind,
    standing: value,
    claim,
  } as unknown as GoalCompletionStanding;
}

const trustedStanding = () => standing('v2', 'uncontested', CLAIM_TRUSTED);
const contestedStanding = (value: string, qualifier: GoalCompletionStandingClaim['qualifier']) =>
  standing('v2', value, claimWith(qualifier));

const standingDetail = (completionStanding?: GoalCompletionStanding): GoalDetail =>
  detail({ status: 'completed', nextAction: { kind: 'completed' }, completionStanding });

class TestMediaQuery {
  constructor(readonly matches: boolean) {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function setCompact(matches: boolean): void {
  vi.stubGlobal('matchMedia', (_media: string) => new TestMediaQuery(matches));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderGoal(goal: GoalDetail) {
  setCompact(true);
  serve(detailRoutes(goal));
  const user = userEvent.setup();
  render(<GoalsPage />);
  await openGoal(user);
  await screen.findByRole('heading', { name: 'Ship the importer' });
  return user;
}

const region = () => screen.getByRole('region', { name: 'Completion standing' });
const card = () => screen.getByLabelText('Next action');
const pill = () => document.querySelector('.goal-mobile-heading [data-goal-status]') as HTMLElement;

/** Text of the region with the allowed negations removed, so the positive-claim scan sees only what is asserted. */
const positiveText = (element: HTMLElement) =>
  (element.textContent ?? '').replace(/not proven|could not be verified|not attested|not confirmed/gi, '');

// --- PIN tests: green at HEAD, guard the current compact view ------------------------------------------------------

describe('compact Goal standing: pins at HEAD', () => {
  it('M-P1 a completed Goal with no standing offers no completion or correction control and posts nothing', async () => {
    await renderGoal(standingDetail(undefined));
    await screen.findByLabelText('Next action');
    expect(screen.queryByRole('button', { name: ACTION_BUTTON })).toBeNull();
    expect(posts()).toEqual([]);
    expect(calls.some((call) => COMPLETION_PATH.test(call.path))).toBe(false);
  });

  it('M-P2 a running Goal shows no standing section and no unreadable line', async () => {
    await renderGoal(detail({ status: 'running', nextAction: { kind: 'wait_for_turing' } }));
    await screen.findByLabelText('Next action');
    expect(screen.queryByRole('region', { name: 'Completion standing' })).toBeNull();
    expect(screen.queryByText('Standing could not be read')).toBeNull();
  });

  it.each([
    ['no standing', undefined],
    ['a trusted standing', trustedStanding()],
    ['a contested standing', contestedStanding('disputed', 'disputed_by_user')],
  ])('M-P3 the pill of a completed Goal keeps the text and status with %s', async (_label, value) => {
    await renderGoal(standingDetail(value));
    await screen.findByLabelText('Next action');
    expect(pill()).toHaveAttribute('data-goal-status', 'completed');
    expect(pill()).toHaveTextContent('Completed');
  });

  it.each([
    ['no standing', undefined],
    ['a trusted standing', trustedStanding()],
    ['a contested standing', contestedStanding('disputed', 'disputed_by_user')],
  ])('M-P4 the cockpit buttons are exactly Grand Projects and Refresh with %s', async (_label, value) => {
    await renderGoal(standingDetail(value));
    await screen.findByLabelText('Next action');
    const cockpit = document.querySelector('.goal-mobile-cockpit') as HTMLElement;
    expect(
      within(cockpit)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim()),
    ).toEqual(['Grand Projects', 'Refresh']);
  });

  it('M-P5 Refresh re-reads the Goal with GET only and posts nothing', async () => {
    await renderGoal(standingDetail(trustedStanding()));
    await screen.findByLabelText('Next action');
    const before = calls.filter((call) => call.path === '/api/goals/goal-1').length;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === '/api/goals/goal-1').length).toBeGreaterThan(before),
    );
    expect(posts()).toEqual([]);
  });
});

// --- RED tests: fail at HEAD (no code reads the standing on the compact view) ----------------------------------------

describe('compact Goal standing: contested, legacy, invalid and trusted copy', () => {
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
    [
      'reconciliation_required',
      'replacement_failed',
      'The replacement attestation did not restore this completion.',
    ],
  ])(
    'M-R1 %s shows the contested heading and the card no longer says the Goal is complete',
    async (value, qualifier, line) => {
      await renderGoal(
        standingDetail(contestedStanding(value, qualifier as GoalCompletionStandingClaim['qualifier'])),
      );
      const section = await screen.findByRole('region', { name: 'Completion standing' });
      expect(within(section).getByText('Completed earlier; later contested.')).toBeTruthy();
      expect(within(section).getByText(line)).toBeTruthy();
      expect(within(section).getByText('Content preservation: not proven.')).toBeTruthy();
      expect(card().textContent).not.toContain('This Goal is complete.');
      expect(card().querySelector('strong')?.textContent).not.toBe('Completed');
      expect(card().className).not.toContain('goal-tone-done');
    },
  );

  it('M-R2 a trusted standing shows the trusted heading, and the card does not say This Goal is complete', async () => {
    await renderGoal(standingDetail(trustedStanding()));
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(
      within(section).getByText(
        'Completed on a recorded decision. Turing has not proven content preservation.',
      ),
    ).toBeTruthy();
    expect(within(section).getByText('Content preservation: not proven.')).toBeTruthy();
    expect(card().textContent).not.toContain('This Goal is complete.');
  });

  it('M-R3 a legacy standing shows the not-attested heading with no preservation line', async () => {
    await renderGoal(
      standingDetail(
        standing('legacy', 'historical_legacy', claimWith('legacy_not_v2_attested', 'not_applicable')),
      ),
    );
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(
      within(section).getByText('Completed before external attestation existed. Not attested.'),
    ).toBeTruthy();
    expect(
      within(section).getByText('This completion was recorded before external attestation existed.'),
    ).toBeTruthy();
    expect(within(section).queryByText(/Content preservation/)).toBeNull();
    expect(within(section).queryByText(/Completed on a recorded decision/)).toBeNull();
  });

  it('M-R4 an invalid standing shows the could-not-be-verified heading and never the trusted heading', async () => {
    await renderGoal(
      standingDetail(
        standing('invalid', 'invalid_unverified', claimWith('proof_unverified', 'not_applicable')),
      ),
    );
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(within(section).getByText('Completion records could not be verified.')).toBeTruthy();
    expect(within(section).queryByText(/Completed on a recorded decision/)).toBeNull();
    expect(card().textContent).not.toContain('This Goal is complete.');
  });

  it('M-R5 an absent standing on a completed Goal shows the unreadable heading and never says the Goal is complete', async () => {
    await renderGoal(standingDetail(undefined));
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(within(section).getByText('Standing could not be read')).toBeTruthy();
    expect(within(section).queryByText(/Completed on a recorded decision/)).toBeNull();
    expect(card().textContent).not.toContain('This Goal is complete.');
  });

  it('M-R8 a not_completed kind on a completed Goal says no completion record was found', async () => {
    await renderGoal(
      standingDetail(standing('not_completed', null, claimWith('not_completed', 'not_applicable'))),
    );
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(within(section).getByText('No completion record was found.')).toBeTruthy();
    expect(card().textContent).not.toContain('This Goal is complete.');
  });
});

describe('compact Goal standing: fail closed', () => {
  it.each([
    ['unqualifiedSuccessAllowed false', { ...CLAIM_TRUSTED, unqualifiedSuccessAllowed: false }],
    ['qualifier proof_unverified', { ...CLAIM_TRUSTED, qualifier: 'proof_unverified' as const }],
    [
      'contentPreservation not_applicable',
      { ...CLAIM_TRUSTED, contentPreservation: 'not_applicable' as const },
    ],
  ])('M-R6 an uncontested standing with %s is not recognised', async (_label, claim) => {
    await renderGoal(standingDetail(standing('v2', 'uncontested', claim)));
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(within(section).getByText('Standing not recognised.')).toBeTruthy();
    expect(within(section).queryByText(/Completed on a recorded decision/)).toBeNull();
  });

  it('M-R6d a disputed standing stays contested even when its claim says success', async () => {
    await renderGoal(
      standingDetail(standing('v2', 'disputed', { ...CLAIM_TRUSTED, qualifier: 'disputed_by_user' })),
    );
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(within(section).getByText('Completed earlier; later contested.')).toBeTruthy();
    expect(within(section).queryByText(/Completed on a recorded decision/)).toBeNull();
  });

  it.each([
    ['an unknown kind', standing('v3', 'uncontested', CLAIM_TRUSTED)],
    ['an unknown standing value', standing('v2', 'weird', claimWith('disputed_by_user'))],
  ])('M-R7 %s is not recognised and its raw value is never printed', async (_label, value) => {
    await renderGoal(standingDetail(value));
    const section = await screen.findByRole('region', { name: 'Completion standing' });
    expect(within(section).getByText('Standing not recognised.')).toBeTruthy();
    expect(section.textContent).not.toContain('v3');
    expect(section.textContent).not.toContain('weird');
  });
});

describe('compact Goal standing: read-only section and pill tone', () => {
  it.each([
    ['no standing', undefined],
    ['a trusted standing', trustedStanding()],
    ['a disputed standing', contestedStanding('disputed', 'disputed_by_user')],
    [
      'a legacy standing',
      standing('legacy', 'historical_legacy', claimWith('legacy_not_v2_attested', 'not_applicable')),
    ],
    [
      'an invalid standing',
      standing('invalid', 'invalid_unverified', claimWith('proof_unverified', 'not_applicable')),
    ],
    ['an unknown kind', standing('v3', 'uncontested', CLAIM_TRUSTED)],
  ])(
    'M-R9 with %s the section has the note, no button, no alert and no banned claim',
    async (_label, value) => {
      await renderGoal(standingDetail(value));
      const section = await screen.findByRole('region', { name: 'Completion standing' });
      expect(within(section).getByText(STANDING_NOTE)).toBeTruthy();
      expect(within(section).queryAllByRole('button')).toEqual([]);
      expect(within(section).queryByRole('alert')).toBeNull();
      expect(positiveText(section)).not.toMatch(BANNED);
    },
  );

  it('M-R10 only the trusted standing keeps the done tone on the pill; the text stays Completed', async () => {
    await renderGoal(standingDetail(trustedStanding()));
    await screen.findByRole('region', { name: 'Completion standing' });
    expect(pill().className).toContain('goal-tone-done');
    expect(pill()).toHaveTextContent('Completed');
    expect(pill()).toHaveAttribute('data-goal-status', 'completed');
  });

  it.each([
    ['a contested standing', contestedStanding('disputed', 'disputed_by_user')],
    [
      'an invalid standing',
      standing('invalid', 'invalid_unverified', claimWith('proof_unverified', 'not_applicable')),
    ],
    ['no standing', undefined],
  ])('M-R10 %s does not keep the done tone on the pill', async (_label, value) => {
    await renderGoal(standingDetail(value));
    await screen.findByLabelText('Next action');
    expect(pill().className).not.toContain('goal-tone-done');
    expect(pill()).toHaveTextContent('Completed');
    expect(pill()).toHaveAttribute('data-goal-status', 'completed');
  });

  it('M-R11 a standing that changes between two reads shows the new one after Refresh, with no POST and no completion read', async () => {
    let current = standingDetail(contestedStanding('disputed', 'disputed_by_user'));
    setCompact(true);
    serve({ ...detailRoutes(current), '/api/goals/goal-1': () => ({ goal: current }) });
    const user = userEvent.setup();
    render(<GoalsPage />);
    await openGoal(user);
    await screen.findByRole('heading', { name: 'Ship the importer' });
    expect(
      within(region()).getByText('A dispute was recorded against the attestation this completion relies on.'),
    ).toBeTruthy();

    current = standingDetail(contestedStanding('withdrawn', 'withdrawn_by_user'));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(
        within(region()).getByText('The attestation this completion relies on was withdrawn.'),
      ).toBeTruthy(),
    );
    expect(posts()).toEqual([]);
    expect(calls.some((call) => COMPLETION_PATH.test(call.path))).toBe(false);
  });

  it.each([
    ['no standing', undefined],
    ['a trusted standing', trustedStanding()],
    ['a contested standing', contestedStanding('disputed', 'disputed_by_user')],
  ])('M-R12 the Corrections row still says Made on the desktop interface with %s', async (_label, value) => {
    await renderGoal(standingDetail(value));
    expect(screen.getByLabelText('Current progress')).toHaveTextContent('Made on the desktop interface.');
  });
});

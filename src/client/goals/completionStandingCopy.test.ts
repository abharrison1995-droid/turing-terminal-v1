import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  GoalCompletionStanding,
  GoalCompletionStandingClaim,
  GoalDetail,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi';
import { contentPreservationCopy, qualifierCopy, standingPresentation } from './completionModel';
import {
  STANDING_READ_ONLY_NOTE,
  STANDING_SECTION_TITLE,
  phoneStandingView,
  type PhoneStandingView,
} from './completionStandingCopy';

const NOW = '2026-01-01T00:00:00.000Z';
const TIMER_PATTERN = /set(Timeout|Interval)\b/;

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

/** A standing as the detail route sends it. Only the fields the phone view reads are meaningful. */
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

const TRUSTED = standing('v2', 'uncontested', CLAIM_TRUSTED);

const view = (status: GoalDetail['status'], completionStanding?: GoalCompletionStanding) =>
  phoneStandingView({ status, completionStanding });

/** The fields a reader sees. The state, tone and icon keys are machine identifiers, never copy, so they are not scanned. */
const DISPLAYED = [
  'heading',
  'detail',
  'qualifier',
  'contentPreservation',
  'nextLabel',
  'nextSummary',
] as const;

const allStrings = (value: PhoneStandingView): string[] =>
  DISPLAYED.map((field) => value[field]).filter((text): text is string => typeof text === 'string');

/** Strips the negations the copy is allowed to use, so the banned-claims scan sees only positive wording. */
const withoutNegations = (text: string) =>
  text
    .replace(/not proven|could not be verified|not verified|not attested|not confirmed/gi, '')
    .replace(/not a successful-delivery claim|must never be treated as successful delivery/gi, '');

const BANNED =
  /\b(success\w*|succeeded|verified|confirmed|proven|preserved|safe\w*|prevent\w*|blocked|block|unable|cannot call|enforc\w*|only on|phone|mobile|desktop|api)\b/i;

const REPRESENTATIVE_STANDINGS: Array<GoalCompletionStanding | undefined> = [
  TRUSTED,
  standing('v2', 'uncontested', claimWith('content_mismatch_disclosed', 'mismatch')),
  standing('v2', 'disputed', claimWith('disputed_by_user')),
  standing('v2', 'withdrawn', claimWith('withdrawn_by_user')),
  standing('v2', 'superseded', claimWith('superseded_by_user')),
  standing('v2', 'reconciliation_required', claimWith('replacement_failed')),
  standing('legacy', 'historical_legacy', claimWith('legacy_not_v2_attested', 'not_applicable')),
  standing('invalid', 'invalid_unverified', claimWith('proof_unverified', 'not_applicable')),
  standing('not_completed', null, claimWith('not_completed', 'not_applicable')),
  standing('v3', 'uncontested', CLAIM_TRUSTED),
  undefined,
];

// --- U1: the exact copy of each state -------------------------------------------------------------------------------

const ROWS: Array<{
  name: string;
  standing: GoalCompletionStanding | undefined;
  expected: PhoneStandingView;
}> = [
  {
    name: 'content mismatch',
    standing: standing('v2', 'uncontested', claimWith('content_mismatch_disclosed', 'mismatch')),
    expected: {
      state: 'mismatch',
      heading: 'A content mismatch was disclosed. This is not a successful-delivery claim.',
      detail: null,
      qualifier: 'A content mismatch was explicitly disclosed. This is not a successful-delivery claim.',
      contentPreservation: 'Content mismatch disclosed. This is not a successful-delivery claim.',
      tone: 'danger',
      icon: 'invalid',
      nextLabel: 'Content mismatch disclosed',
      nextSummary:
        'This completion is recorded under Policy B and must never be treated as successful delivery.',
    },
  },
  {
    name: 'trusted',
    standing: TRUSTED,
    expected: {
      state: 'trusted',
      heading: 'Historical completion on a recorded decision. Content was not verified.',
      detail: null,
      qualifier: null,
      contentPreservation: 'Content preservation: not proven.',
      tone: 'done',
      icon: 'done',
      nextLabel: 'Completed',
      nextSummary: 'This historical completion records Git ancestry only; changed content was not checked.',
    },
  },
  {
    name: 'disputed',
    standing: standing('v2', 'disputed', claimWith('disputed_by_user')),
    expected: {
      state: 'contested',
      heading: 'Completed earlier; later contested.',
      detail: null,
      qualifier: 'A dispute was recorded against the attestation this completion relies on.',
      contentPreservation: 'Content preservation: not proven.',
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Completion contested',
      nextSummary: 'This completion was later contested. See the completion standing for what was recorded.',
    },
  },
  {
    name: 'withdrawn',
    standing: standing('v2', 'withdrawn', claimWith('withdrawn_by_user')),
    expected: {
      state: 'contested',
      heading: 'Completed earlier; later contested.',
      detail: null,
      qualifier: 'The attestation this completion relies on was withdrawn.',
      contentPreservation: 'Content preservation: not proven.',
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Completion contested',
      nextSummary: 'This completion was later contested. See the completion standing for what was recorded.',
    },
  },
  {
    name: 'superseded',
    standing: standing('v2', 'superseded', claimWith('superseded_by_user')),
    expected: {
      state: 'contested',
      heading: 'Completed earlier; later contested.',
      detail: null,
      qualifier: 'The attestation this completion relies on was replaced by another.',
      contentPreservation: 'Content preservation: not proven.',
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Completion contested',
      nextSummary: 'This completion was later contested. See the completion standing for what was recorded.',
    },
  },
  {
    name: 'reconciliation_required',
    standing: standing('v2', 'reconciliation_required', claimWith('replacement_failed')),
    expected: {
      state: 'contested',
      heading: 'Completed earlier; later contested.',
      detail: null,
      qualifier: 'The replacement attestation did not restore this completion.',
      contentPreservation: 'Content preservation: not proven.',
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Completion contested',
      nextSummary: 'This completion was later contested. See the completion standing for what was recorded.',
    },
  },
  {
    name: 'legacy',
    standing: standing('legacy', 'historical_legacy', claimWith('legacy_not_v2_attested', 'not_applicable')),
    expected: {
      state: 'legacy',
      heading: 'Completed before external attestation existed. Not attested.',
      detail: null,
      qualifier: 'This completion was recorded before external attestation existed.',
      contentPreservation: null,
      tone: 'neutral',
      icon: 'warning',
      nextLabel: 'Completed before attestation existed',
      nextSummary: 'This completion is not attested. See the completion standing for what was recorded.',
    },
  },
  {
    name: 'invalid',
    standing: standing('invalid', 'invalid_unverified', claimWith('proof_unverified', 'not_applicable')),
    expected: {
      state: 'invalid',
      heading: 'Completion records could not be verified.',
      detail: null,
      qualifier: null,
      contentPreservation: null,
      tone: 'danger',
      icon: 'invalid',
      nextLabel: 'Completion could not be verified',
      nextSummary:
        'The saved completion records could not be checked. Treat this Goal as not confirmed complete.',
    },
  },
  {
    name: 'absent standing on a completed Goal',
    standing: undefined,
    expected: {
      state: 'unreadable',
      heading: 'Standing could not be read',
      detail:
        'The Goal status says completed, but its saved completion standing was not available. Turing cannot say whether this completion is contested. Refresh to read it again.',
      qualifier: null,
      contentPreservation: null,
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Standing could not be read',
      nextSummary: 'The Goal status says completed. Its completion standing was not available.',
    },
  },
  {
    name: 'not_completed kind on a completed Goal',
    standing: standing('not_completed', null, claimWith('not_completed', 'not_applicable')),
    expected: {
      state: 'not_recorded',
      heading: 'No completion record was found.',
      detail: 'The Goal status says completed, but no saved completion backs it. Treat it as not confirmed.',
      qualifier: null,
      contentPreservation: null,
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'No completion record found',
      nextSummary:
        'The Goal status says completed, but no saved completion backs it. Treat it as not confirmed.',
    },
  },
  {
    name: 'unknown kind',
    standing: standing('v3', 'uncontested', CLAIM_TRUSTED),
    expected: {
      state: 'unrecognised',
      heading: 'Standing not recognised.',
      detail: 'This view does not recognise the saved completion standing, so it makes no completion claim.',
      qualifier: null,
      contentPreservation: null,
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Standing not recognised',
      nextSummary:
        'This view does not recognise the saved completion standing, so it makes no completion claim.',
    },
  },
];

describe('phone standing copy by state (U1)', () => {
  it.each(ROWS)('U1 $name gives the exact state, copy, tone and icon', ({ standing: value, expected }) => {
    expect(view('completed', value)).toEqual(expected);
  });
});

// --- U2: parity with the desktop copy -------------------------------------------------------------------------------

const external = (
  state: GoalExternalCompletionStatus['state'],
  value: GoalCompletionStanding,
): GoalExternalCompletionStatus => ({
  goalId: 'goal-1',
  state,
  decisions: [],
  completion: null,
  completionStanding: value,
});

describe('phone standing copy matches the desktop copy (U2)', () => {
  it.each([
    ['completed', 'trusted', TRUSTED],
    ['contested', 'contested', standing('v2', 'disputed', claimWith('disputed_by_user'))],
    [
      'legacy',
      'legacy',
      standing('legacy', 'historical_legacy', claimWith('legacy_not_v2_attested', 'not_applicable')),
    ],
    [
      'invalid',
      'invalid',
      standing('invalid', 'invalid_unverified', claimWith('proof_unverified', 'not_applicable')),
    ],
  ] as const)(
    'the %s state (phone %s) has the desktop heading, qualifier and preservation',
    (desktopState, phoneState, value) => {
      const desktop = standingPresentation(external(desktopState, value));
      const phone = view('completed', value);
      expect(phone?.state).toBe(phoneState);
      expect(phone?.heading).toBe(desktop.heading);
      expect(phone?.qualifier).toBe(desktop.qualifier);
      expect(phone?.contentPreservation).toBe(desktop.contentPreservation);
    },
  );

  it.each([
    'none',
    'disputed_by_user',
    'withdrawn_by_user',
    'superseded_by_user',
    'replacement_failed',
    'proof_unverified',
    'legacy_not_v2_attested',
    'not_completed',
  ] as const)('the qualifier %s equals qualifierCopy', (qualifier) => {
    const value = standing('v2', 'disputed', claimWith(qualifier));
    expect(view('completed', value)?.qualifier).toBe(qualifierCopy(qualifier));
  });

  it.each(['mismatch', 'not_proven', 'not_applicable', 'mystery_value'])(
    'the content-preservation value %s equals contentPreservationCopy',
    (value) => {
      const claim = claimWith(
        'disputed_by_user',
        value as GoalCompletionStandingClaim['contentPreservation'],
      );
      expect(view('completed', standing('v2', 'disputed', claim))?.contentPreservation).toBe(
        contentPreservationCopy(value),
      );
    },
  );
});

// --- U3: absence and non-completed statuses -------------------------------------------------------------------------

describe('when there is no standing view (U3)', () => {
  it('an absent standing on a completed Goal is unreadable, never trusted', () => {
    expect(view('completed', undefined)?.state).toBe('unreadable');
  });

  it('an absent standing on a non-completed Goal returns null', () => {
    expect(view('running', undefined)).toBeNull();
  });

  it('a not_completed kind on a non-completed Goal returns null', () => {
    expect(
      view('running', standing('not_completed', null, claimWith('not_completed', 'not_applicable'))),
    ).toBeNull();
  });

  it('a trusted-looking standing on a non-completed Goal returns null', () => {
    expect(view('running', TRUSTED)).toBeNull();
  });
});

// --- U4: the trusted predicate needs every signal -------------------------------------------------------------------

describe('the trusted state needs every signal (U4)', () => {
  const mutate = (patch: (raw: Record<string, unknown>) => void): GoalCompletionStanding => {
    const raw = JSON.parse(JSON.stringify(TRUSTED)) as Record<string, unknown>;
    patch(raw);
    return raw as unknown as GoalCompletionStanding;
  };
  const claimOf = (raw: Record<string, unknown>) => raw.claim as Record<string, unknown>;

  it.each([
    ['kind', (raw: Record<string, unknown>) => void (raw.kind = 'legacy')],
    ['standing', (raw: Record<string, unknown>) => void (raw.standing = 'disputed')],
    [
      'unqualifiedSuccessAllowed',
      (raw: Record<string, unknown>) => void (claimOf(raw).unqualifiedSuccessAllowed = false),
    ],
    [
      'trustedForDownstream',
      (raw: Record<string, unknown>) => void (claimOf(raw).trustedForDownstream = false),
    ],
    ['qualifier', (raw: Record<string, unknown>) => void (claimOf(raw).qualifier = 'proof_unverified')],
    [
      'contentPreservation',
      (raw: Record<string, unknown>) => void (claimOf(raw).contentPreservation = 'not_applicable'),
    ],
  ])('flipping %s is never trusted', (_field, patch) => {
    expect(view('completed', mutate(patch))?.state).not.toBe('trusted');
  });

  it('the untouched fixture is trusted, so the mutations above change a real trusted case', () => {
    expect(view('completed', TRUSTED)?.state).toBe('trusted');
  });
});

// --- U5: trusted only from kind v2 ----------------------------------------------------------------------------------

describe('only a version-2 standing can be trusted (U5)', () => {
  it.each([
    ['not_completed', standing('not_completed', 'uncontested', CLAIM_TRUSTED)],
    ['legacy', standing('legacy', 'uncontested', CLAIM_TRUSTED)],
    ['invalid', standing('invalid', 'uncontested', CLAIM_TRUSTED)],
  ])('kind %s with an all-true claim is never trusted', (_kind, value) => {
    expect(view('completed', value)?.state).not.toBe('trusted');
  });
});

// --- U6: no raw enum, no undefined, no object text ------------------------------------------------------------------

describe('returned text is never raw (U6)', () => {
  it('no string has an underscore between letters, the word undefined, or object text', () => {
    for (const value of REPRESENTATIVE_STANDINGS) {
      const result = view('completed', value);
      if (!result) continue;
      for (const text of allStrings(result)) {
        expect(text).not.toMatch(/[A-Za-z]_[A-Za-z]/);
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('[object');
      }
    }
  });
});

// --- U7: banned-claims scan -----------------------------------------------------------------------------------------

describe('banned-claims scan (U7)', () => {
  it('no exported string and no view field makes a success, verification, preservation or enforcement claim', () => {
    const texts = [STANDING_SECTION_TITLE, STANDING_READ_ONLY_NOTE];
    for (const value of REPRESENTATIVE_STANDINGS) {
      const result = view('completed', value);
      if (result) texts.push(...allStrings(result));
    }
    for (const text of texts) {
      expect(withoutNegations(text)).not.toMatch(BANNED);
    }
  });
});

// --- U8: the read-only note states only what the view contains ------------------------------------------------------

describe('the read-only note (U8)', () => {
  it('says what the view contains and never mentions the phone, the API, or a block', () => {
    expect(STANDING_READ_ONLY_NOTE).toBe(
      'This view only shows the saved standing. It has no control to complete a Goal or to correct a completion.',
    );
    expect(STANDING_READ_ONLY_NOTE).not.toMatch(
      /phone|mobile|desktop|prevent|block|unable|cannot call|enforce|api/i,
    );
  });
});

// --- U9 and U10: static scans of the changed files ------------------------------------------------------------------

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

describe('static rules for the new leaf module (U9)', () => {
  it('has no timer, no fetch, and only type-only imports', () => {
    const text = source('completionStandingCopy.ts');
    expect(text).not.toMatch(TIMER_PATTERN);
    expect(text).not.toMatch(/\bfetch\(/);
    const importLines = text.split('\n').filter((line) => /^import\s/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) expect(line).toMatch(/^import type\s/);
  });
});

describe('static rules for the changed components (U10)', () => {
  it.each(['GoalMobileCockpit.tsx', 'NextAction.tsx', 'parts.tsx'])(
    '%s has no timer and no write path, and imports no completion or correction module',
    (file) => {
      const text = source(file);
      expect(text).not.toMatch(TIMER_PATTERN);
      expect(text).not.toMatch(/goalsApi|\bfetch\(/);
      expect(text).not.toMatch(
        /from '\.\/(GoalCompletion|GoalCorrection|completionModel|correctionModel|api)'/,
      );
    },
  );
});

// --- U11: the shared presentation signature is unchanged -------------------------------------------------------------

describe('describeNextAction keeps its single parameter (U11)', () => {
  it('is declared with exactly one parameter, so Array.map cannot pass it an index', () => {
    expect(source('presentation.ts')).toContain(
      'export function describeNextAction(action: GoalNextAction): NextActionPresentation {',
    );
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyCompletionStanding,
  COMPLETION_STANDING_VALUES,
  completionStandingAllowsUnqualifiedSuccess,
  completionStandingTrustedForDownstream,
  type CompletionStandingFacts,
  type GoalCompletionClaim,
} from './completionStanding.js';

/**
 * Tests of the pure completion-standing vocabulary and classifier. Every expectation is an exact value. The module has
 * no database, so these tests use hand-built facts only.
 */

interface Row {
  name: string;
  facts: CompletionStandingFacts;
  claim: GoalCompletionClaim;
}

const NOT_TRUSTED_NOT_APPLICABLE = { unqualifiedSuccessAllowed: false, trustedForDownstream: false };

/** Every standing, plus not_completed, with the exact claim each one must produce. */
const ROWS: Row[] = [
  {
    name: 'uncontested (v2)',
    facts: { kind: 'v2', standing: 'uncontested' },
    claim: {
      unqualifiedSuccessAllowed: true,
      trustedForDownstream: true,
      qualifier: 'none',
      contentPreservation: 'not_proven',
    },
  },
  {
    name: 'disputed (v2)',
    facts: { kind: 'v2', standing: 'disputed' },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'disputed_by_user',
      contentPreservation: 'not_proven',
    },
  },
  {
    name: 'withdrawn (v2)',
    facts: { kind: 'v2', standing: 'withdrawn' },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'withdrawn_by_user',
      contentPreservation: 'not_proven',
    },
  },
  {
    name: 'superseded (v2)',
    facts: { kind: 'v2', standing: 'superseded' },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'superseded_by_user',
      contentPreservation: 'not_proven',
    },
  },
  {
    name: 'reconciliation_required (v2)',
    facts: { kind: 'v2', standing: 'reconciliation_required' },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'replacement_failed',
      contentPreservation: 'not_proven',
    },
  },
  {
    name: 'invalid_unverified (invalid)',
    facts: { kind: 'invalid', standing: 'invalid_unverified' },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'proof_unverified',
      contentPreservation: 'not_applicable',
    },
  },
  {
    name: 'historical_legacy (legacy)',
    facts: { kind: 'legacy', standing: 'historical_legacy' },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'legacy_not_v2_attested',
      contentPreservation: 'not_applicable',
    },
  },
  {
    name: 'not_completed',
    facts: { kind: 'not_completed', standing: null },
    claim: {
      ...NOT_TRUSTED_NOT_APPLICABLE,
      qualifier: 'not_completed',
      contentPreservation: 'not_applicable',
    },
  },
];

describe('completion standing: P1 vocabulary', () => {
  it('P1: COMPLETION_STANDING_VALUES is exactly the seven values, in order, with no duplicates', () => {
    expect(COMPLETION_STANDING_VALUES).toEqual([
      'uncontested',
      'disputed',
      'withdrawn',
      'superseded',
      'reconciliation_required',
      'invalid_unverified',
      'historical_legacy',
    ]);
    expect(new Set(COMPLETION_STANDING_VALUES).size).toBe(7);
  });
});

describe('completion standing: P2 to P5 pure classifier', () => {
  it('P2: every standing, legacy and not_completed map to the exact claim, and only uncontested is trusted', () => {
    for (const row of ROWS) {
      expect(classifyCompletionStanding(row.facts), row.name).toEqual(row.claim);
    }
    const standings = ROWS.map((row) => row.facts.standing).filter((value) => value !== null);
    expect([...standings].sort()).toEqual([...COMPLETION_STANDING_VALUES].sort());
  });

  it('P3: not_completed facts give no standing, no unqualified success, and the not_completed qualifier', () => {
    const facts: CompletionStandingFacts = { kind: 'not_completed', standing: null };
    expect(facts.standing).toBeNull();
    const claim = classifyCompletionStanding(facts);
    expect(claim.unqualifiedSuccessAllowed).toBe(false);
    expect(claim.trustedForDownstream).toBe(false);
    expect(claim.qualifier).toBe('not_completed');
  });

  it('P4: only uncontested has the none qualifier and not_proven content; other v2 standings are qualified', () => {
    for (const row of ROWS) {
      const claim = classifyCompletionStanding(row.facts);
      if (row.facts.kind === 'v2' && row.facts.standing !== 'uncontested') {
        expect(claim.qualifier, row.name).not.toBe('none');
      }
    }
    const uncontested = classifyCompletionStanding({ kind: 'v2', standing: 'uncontested' });
    expect(uncontested.qualifier).toBe('none');
    expect(uncontested.contentPreservation).toBe('not_proven');
  });

  it('P5: the two predicates agree on every input, and both equal the claim field', () => {
    for (const row of ROWS) {
      const model = { claim: classifyCompletionStanding(row.facts) };
      const allowed = completionStandingAllowsUnqualifiedSuccess(model);
      const trusted = completionStandingTrustedForDownstream(model);
      expect(allowed, row.name).toBe(trusted);
      expect(allowed, row.name).toBe(model.claim.unqualifiedSuccessAllowed);
      expect(trusted, row.name).toBe(model.claim.trustedForDownstream);
      expect(allowed, row.name).toBe(row.name === 'uncontested (v2)');
    }
  });
});

describe('completion standing: P6 static source check', () => {
  const SOURCE = readFileSync(new URL('./completionStanding.ts', import.meta.url), 'utf8');
  /** Writes, goal transitions, goal creation, raw prepared statements, and any import of the database or read model. */
  const FORBIDDEN_PATTERN = String.raw`\b(?:insert|update|delete)\b|\bwriteGoalEvent\b|\brequestGoalApproval\b|\btransitionGoal\b|\bcreateGoal\b|\bdb\s*\.\s*prepare\b|from\s+["'][^"']*(?:\/db|readModel)\.js["']`;

  it('P6: completionStanding.ts contains no write SQL, goal mutator, prepared statement, or database import', () => {
    expect(SOURCE.match(new RegExp(FORBIDDEN_PATTERN, 'gi'))).toBeNull();
  });

  it('P6 negative control: the same pattern catches each seeded violation', () => {
    const seeded = [
      "db.prepare('INSERT INTO goals (id) VALUES (?)');",
      'db . prepare("update   goals set status = ?");',
      'writeGoalEvent(db, event);',
      'await requestGoalApproval(db, input);',
      'transitionGoal(db, goalId, to);',
      'const goal = createGoal(db, input);',
      "import { readGoal } from './readModel.js';",
      "import type { Db } from '../db.js';",
      'DELETE FROM goal_events WHERE id = ?',
    ];
    const pattern = new RegExp(FORBIDDEN_PATTERN, 'i');
    for (const source of seeded) expect(pattern.test(source), source).toBe(true);
  });
});

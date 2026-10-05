import { describe, expect, it } from 'vitest';
import { canonicalizeGoalDefinition, hashGoalDefinition } from './definitionHash.js';
import { validDefinition } from './testKit.js';

/** Rebuilds an object with its keys in reverse order, recursively, to prove key order is irrelevant. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

describe('canonical Goal definition hash', () => {
  it('is a stable SHA-256 hex digest', () => {
    const hash = hashGoalDefinition(validDefinition());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGoalDefinition(validDefinition())).toBe(hash);
  });

  it('ignores object key ordering at every depth', () => {
    const definition = validDefinition();
    const shuffled = reverseKeys(definition) as typeof definition;
    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(definition)[0]);
    expect(canonicalizeGoalDefinition(shuffled)).toBe(canonicalizeGoalDefinition(definition));
    expect(hashGoalDefinition(shuffled)).toBe(hashGoalDefinition(definition));
  });

  it('changes when the content changes', () => {
    const base = hashGoalDefinition(validDefinition());
    const edits: Array<(d: ReturnType<typeof validDefinition>) => void> = [
      (d) => (d.contract.outcome = 'Something else'),
      (d) => (d.limits.maxExecutionCycles += 1),
      (d) => (d.milestones[0]!.objective += '!'),
      (d) => (d.routing.pools[0]!.selection = 'round_robin'),
      (d) => (d.review.final = false),
    ];
    const hashes = edits.map((edit) => {
      const definition = validDefinition();
      edit(definition);
      return hashGoalDefinition(definition);
    });
    for (const hash of hashes) expect(hash).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('treats array order as significant', () => {
    const base = hashGoalDefinition(validDefinition());
    const reorderedMilestones = validDefinition();
    reorderedMilestones.milestones.reverse();
    expect(hashGoalDefinition(reorderedMilestones)).not.toBe(base);
    const reorderedMembers = validDefinition();
    reorderedMembers.routing.pools[0]!.members.reverse();
    expect(hashGoalDefinition(reorderedMembers)).not.toBe(base);
  });

  it('covers exactly the five definition parts', () => {
    const base = hashGoalDefinition(validDefinition());
    const withExtras = { ...validDefinition(), id: 'x', createdAt: 'now', approvedBy: 'user', counters: 5 };
    expect(hashGoalDefinition(withExtras as never)).toBe(base);
    expect(Object.keys(JSON.parse(canonicalizeGoalDefinition(validDefinition())))).toEqual([
      'contract',
      'limits',
      'milestones',
      'review',
      'routing',
    ]);
  });

  it('omits undefined members like JSON and rejects non-finite numbers', () => {
    const a = validDefinition();
    const b = validDefinition();
    (b.contract as unknown as Record<string, unknown>).extra = undefined;
    expect(hashGoalDefinition(b)).toBe(hashGoalDefinition(a));
    a.limits.maxExecutionCycles = Infinity;
    expect(() => hashGoalDefinition(a)).toThrow(/non-finite/);
  });
});

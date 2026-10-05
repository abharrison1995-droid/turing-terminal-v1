import { createHash } from 'node:crypto';
import type { GoalDefinition } from '../../shared/goals.js';

/**
 * Canonical Goal definition serialisation. The hash covers exactly the five definition parts (contract, milestones,
 * routing, review policy, limits): never timestamps, database ids, runtime counters or approval metadata.
 *
 * Objects are serialised with recursively sorted keys; arrays keep their order, because array order is semantically
 * significant everywhere in a definition (criterion/verifier order, pool member order for `ordered` selection,
 * milestone order). `undefined` members are omitted exactly as JSON does. Non-finite numbers are rejected rather than
 * silently becoming `null`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('A canonical definition cannot contain a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`A canonical definition cannot contain a ${typeof value}.`);
}

export function canonicalizeGoalDefinition(definition: GoalDefinition): string {
  return canonicalJson({
    contract: definition.contract,
    milestones: definition.milestones,
    routing: definition.routing,
    review: definition.review,
    limits: definition.limits,
  });
}

export function hashGoalDefinition(definition: GoalDefinition): string {
  return createHash('sha256').update(canonicalizeGoalDefinition(definition)).digest('hex');
}

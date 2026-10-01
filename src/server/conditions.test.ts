import { describe, expect, it } from 'vitest';
import type { WorkflowCondition } from '../shared/types.js';
import { evaluateCondition, validateCondition } from './conditions.js';

describe('structured workflow conditions', () => {
  it('evaluates boolean and numeric conditions without parsing prose', () => {
    expect(evaluateCondition({ path: 'build.success', operator: 'equals', value: true }, true)).toBe(true);
    expect(evaluateCondition({ path: 'tests.failed', operator: 'greaterThan', value: 0 }, 2)).toBe(true);
    expect(evaluateCondition({ path: 'review.openHigh', operator: 'equals', value: 0 }, 1)).toBe(false);
    expect(
      evaluateCondition({ path: 'finalGate.status', operator: 'notEquals', value: 'PASS' }, 'FAIL'),
    ).toBe(true);
  });

  it('rejects values and comparisons with incompatible types', () => {
    expect(
      validateCondition({ path: 'build.success', operator: 'equals', value: 1 } as WorkflowCondition),
    ).toContain('boolean');
    expect(validateCondition({ path: 'finalGate.status', operator: 'greaterThan', value: 'PASS' })).toContain(
      'equals or notEquals',
    );
    expect(
      validateCondition({
        path: 'review.openCritical',
        operator: 'equals',
        value: 'none',
      } as WorkflowCondition),
    ).toContain('numeric');
  });
});

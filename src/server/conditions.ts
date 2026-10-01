import type { WorkflowCondition } from '../shared/types.js';

export function validateCondition(condition: WorkflowCondition): string | null {
  if (condition.path === 'build.success' && typeof condition.value !== 'boolean')
    return 'build.success conditions require a boolean value.';
  if (
    ['tests.failed', 'review.openCritical', 'review.openHigh'].includes(condition.path) &&
    (typeof condition.value !== 'number' || !Number.isFinite(condition.value))
  )
    return `${condition.path} conditions require a numeric value.`;
  if (
    condition.path === 'finalGate.status' &&
    (typeof condition.value !== 'string' || !['PASS', 'FAIL'].includes(condition.value))
  )
    return 'finalGate.status conditions require PASS or FAIL.';
  if (condition.path === 'finalGate.status' && !['equals', 'notEquals'].includes(condition.operator))
    return 'finalGate.status supports equals or notEquals comparisons only.';
  return null;
}

export function evaluateCondition(condition: WorkflowCondition, actual: unknown): boolean {
  switch (condition.operator) {
    case 'equals':
      return actual === condition.value;
    case 'notEquals':
      return actual !== condition.value;
    case 'greaterThan':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'lessThan':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
  }
}

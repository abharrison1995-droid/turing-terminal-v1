import type { WorkflowStage } from './types.js';

/** The stages that call a model. The launcher, the engine and the Goal run-plan verifier all use this one set. */
export const MODEL_BACKED_STAGE_KINDS: ReadonlySet<WorkflowStage['kind']> = new Set<WorkflowStage['kind']>([
  'planner',
  'promptRefinement',
  'implementer',
  'reviewer',
  'parallelReview',
  'consolidate',
  'orchestrator',
  'remediation',
  'finalGate',
]);

export const isModelBackedStage = (kind: WorkflowStage['kind']): boolean =>
  MODEL_BACKED_STAGE_KINDS.has(kind);

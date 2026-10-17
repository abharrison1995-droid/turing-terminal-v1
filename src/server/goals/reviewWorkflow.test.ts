import { describe, expect, it } from 'vitest';
import { goalBuiltinById, GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import { simpleDefinition } from './repoKit.js';
import { materializeReviewWorkflow, REVIEW_STAGE_INSTRUCTIONS, reviewerCountFor } from './reviewWorkflow.js';
import { canonicalNonRouteWorkflow } from './turingExecutor.js';

const registered = (): WorkflowDefinition =>
  ({
    ...structuredClone(goalBuiltinById(GOAL_WORKFLOW_IDS.review)!),
    createdAt: 'a',
    updatedAt: 'b',
  }) as WorkflowDefinition;

describe('reviewerCountFor', () => {
  it('uses the periodic policy for a periodic review and the workflow count otherwise', () => {
    const definition = simpleDefinition();
    definition.review.periodic = { everyNExecutionCycles: 2, reviewerCount: 1, scope: 'full_diff' };
    definition.limits.maxParallelAgents = 3;
    expect(reviewerCountFor(definition, registered(), 'periodic')).toBe(1);
    expect(reviewerCountFor(definition, registered(), 'final')).toBe(2);
    expect(reviewerCountFor(definition, registered(), 'milestone')).toBe(2);
  });

  it('clamps by the workflow and by the Goal parallelism, and is at least one', () => {
    const definition = simpleDefinition();
    definition.review.periodic = { everyNExecutionCycles: 2, reviewerCount: 3, scope: 'full_diff' };
    definition.limits.maxParallelAgents = 3;
    expect(reviewerCountFor(definition, registered(), 'periodic')).toBe(2);
    definition.limits.maxParallelAgents = 1;
    expect(reviewerCountFor(definition, registered(), 'final')).toBe(1);
    expect(reviewerCountFor(definition, registered(), 'periodic')).toBe(1);
  });
});

describe('materializeReviewWorkflow', () => {
  it('changes only parallelReview.parallelism and the customInstructions of the three review stages', () => {
    const workflow = registered();
    const before = structuredClone(workflow);
    const result = materializeReviewWorkflow(workflow, { reviewerCount: 1 });
    // The saved workflow object is not mutated.
    expect(workflow).toEqual(before);
    const strip = (value: WorkflowDefinition): WorkflowDefinition => ({
      ...value,
      stages: value.stages.map((stage) => {
        const { customInstructions: _c, ...rest } = stage;
        void _c;
        return stage.kind === 'parallelReview' ? { ...rest, parallelism: 0 } : rest;
      }),
    });
    expect(canonicalNonRouteWorkflow(strip(result))).toBe(canonicalNonRouteWorkflow(strip(workflow)));
    const stages = Object.fromEntries(result.stages.map((stage) => [stage.kind, stage]));
    expect(stages.parallelReview!.parallelism).toBe(1);
    expect(stages.parallelReview!.customInstructions).toBe(REVIEW_STAGE_INSTRUCTIONS.parallelReview);
    expect(stages.consolidate!.customInstructions).toBe(REVIEW_STAGE_INSTRUCTIONS.consolidate);
    expect(stages.finalGate!.customInstructions).toBe(REVIEW_STAGE_INSTRUCTIONS.finalGate);
    expect(result.stages.map((stage) => [stage.id, stage.kind])).toEqual(
      workflow.stages.map((stage) => [stage.id, stage.kind]),
    );
    expect(result.permissionMode).toBe(workflow.permissionMode);
    expect(result.retryPolicy).toEqual(workflow.retryPolicy);
    expect(result.contextPolicy).toEqual(workflow.contextPolicy);
  });

  it('never exceeds the workflow parallelism and keeps existing instructions first', () => {
    const workflow = registered();
    workflow.stages[0] = { ...workflow.stages[0]!, customInstructions: 'Prefer security.' };
    const result = materializeReviewWorkflow(workflow, { reviewerCount: 8 });
    expect(result.stages[0]!.parallelism).toBe(2);
    expect(result.stages[0]!.customInstructions!.startsWith('Prefer security.')).toBe(true);
  });

  it('the finalGate instruction is a transport check that a negative verdict must not fail', () => {
    expect(REVIEW_STAGE_INSTRUCTIONS.finalGate).toMatch(/NOT a failure/);
    expect(REVIEW_STAGE_INSTRUCTIONS.consolidate).toMatch(/goalReviewReport/);
  });
});

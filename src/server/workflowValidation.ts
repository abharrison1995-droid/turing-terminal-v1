import type { ExecutionProfile, WorkflowDefinition, WorkflowStage } from '../shared/types.js';
import { validateCondition } from './conditions.js';
import { isSafeProjectCommand } from './commandPolicy.js';
import { validateDecisionGate } from '../shared/decisions.js';

const stageKinds = new Set<WorkflowStage['kind']>([
  'planner',
  'promptRefinement',
  'implementer',
  'build',
  'test',
  'reviewer',
  'parallelReview',
  'consolidate',
  'orchestrator',
  'remediation',
  'finalGate',
  'gitCheckpoint',
  'gitCommit',
  'gitPush',
  'gitMerge',
  'gitRollback',
  'conditionalBranch',
  'shellCommand',
  'notification',
  'humanApproval',
  'decisionGate',
]);

export function validateWorkflow(
  workflow: Pick<WorkflowDefinition, 'stages' | 'maxParallelAgents' | 'maxRemediationRounds'> &
    Partial<Pick<WorkflowDefinition, 'isolatedWorktree' | 'promptRefinementDefault'>>,
): string[] {
  const errors: string[] = [];
  if (
    !Number.isInteger(workflow.maxParallelAgents) ||
    workflow.maxParallelAgents < 1 ||
    workflow.maxParallelAgents > 8
  )
    errors.push('Maximum parallel agents must be between 1 and 8.');
  if (
    !Number.isInteger(workflow.maxRemediationRounds) ||
    workflow.maxRemediationRounds < 0 ||
    workflow.maxRemediationRounds > 5
  )
    errors.push('Maximum remediation rounds must be between 0 and 5.');
  if (!workflow.stages.length) errors.push('A workflow needs at least one stage.');
  const refinementStages = workflow.stages.filter((stage) => stage.kind === 'promptRefinement');
  if (refinementStages.length > 1) errors.push('A workflow can have at most one prompt refinement stage.');
  if (workflow.promptRefinementDefault && !refinementStages.some((stage) => stage.enabled !== false))
    errors.push('Enable a configured prompt refinement stage to use it by default.');
  const refinementIndex = workflow.stages.findIndex(
    (stage) => stage.kind === 'promptRefinement' && stage.enabled !== false,
  );
  if (
    refinementIndex > 0 &&
    workflow.stages.slice(0, refinementIndex).some((stage) => stage.enabled !== false)
  )
    errors.push('Prompt refinement must be the first enabled workflow stage.');
  const gitStages = workflow.stages.filter((stage) =>
    ['gitCheckpoint', 'gitCommit', 'gitPush', 'gitMerge', 'gitRollback'].includes(stage.kind),
  );
  if (gitStages.length && !workflow.isolatedWorktree)
    errors.push('Git operation stages require isolated worktree execution.');
  const ids = new Set<string>();
  for (const [index, stage] of workflow.stages.entries()) {
    if (!stage.id.trim()) errors.push('Every stage needs an ID.');
    if (ids.has(stage.id)) errors.push(`Stage ID “${stage.id}” is duplicated.`);
    ids.add(stage.id);
    if (!stageKinds.has(stage.kind)) errors.push(`Stage “${stage.label}” has an unsupported type.`);
    if (stage.kind === 'parallelReview') {
      const parallelism = stage.parallelism ?? 1;
      if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > workflow.maxParallelAgents)
        errors.push(`Parallel review “${stage.label}” exceeds the workflow concurrency limit.`);
    }
    if (stage.kind === 'conditionalBranch') {
      if (!stage.condition) errors.push(`Conditional branch “${stage.label}” needs a structured condition.`);
      else {
        const conditionError = validateCondition(stage.condition);
        if (conditionError) errors.push(`Conditional branch “${stage.label}”: ${conditionError}`);
      }
      if (new Set(stage.skipStageIds ?? []).size !== (stage.skipStageIds ?? []).length)
        errors.push(`Conditional branch “${stage.label}” has duplicate skip targets.`);
      for (const targetId of stage.skipStageIds ?? []) {
        const targetIndex = workflow.stages.findIndex((candidate) => candidate.id === targetId);
        if (targetIndex < 0) errors.push(`Conditional branch “${stage.label}” references an unknown stage.`);
        else if (targetIndex <= index)
          errors.push(
            `Conditional branch “${stage.label}” can only skip later stages; backward branches are not allowed.`,
          );
      }
    }
    const laterStageIds = workflow.stages.slice(index + 1).map((candidate) => candidate.id);
    if (stage.kind === 'decisionGate')
      errors.push(...validateDecisionGate(stage.decision, stage.label, laterStageIds));
    if (stage.orchestration) {
      if (stage.kind !== 'orchestrator')
        errors.push(`Stage “${stage.label}” can define branches only as an AI Orchestrator.`);
      const branchIds = stage.orchestration.branches.map((branch) => branch.id);
      if (new Set(branchIds).size !== branchIds.length)
        errors.push(`Orchestrator “${stage.label}” has duplicate branch IDs.`);
      if (!branchIds.includes(stage.orchestration.defaultBranchId))
        errors.push(`Orchestrator “${stage.label}” needs a default branch from its configured branches.`);
      for (const branch of stage.orchestration.branches)
        for (const target of branch.skipStageIds)
          if (!laterStageIds.includes(target))
            errors.push(`Orchestrator “${stage.label}” branch “${branch.label}” can only skip later stages.`);
    }
    if (stage.kind === 'shellCommand' && !isSafeProjectCommand(stage.command ?? []))
      errors.push(
        `Shell command stage “${stage.label}” must use an allowed package build, test, or lint script.`,
      );
    if (
      stage.kind === 'gitPush' &&
      stage.pushRemote &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(stage.pushRemote)
    )
      errors.push(`Git push stage “${stage.label}” has an invalid remote name.`);
    if (stage.kind === 'gitPush' && stage.pushBranch && !isSafeBranch(stage.pushBranch))
      errors.push(`Git push stage “${stage.label}” has an invalid destination branch.`);
    if (stage.kind === 'gitCommit' && stage.commitMessage && stage.commitMessage.length > 120)
      errors.push(`Git commit stage “${stage.label}” commit message must be at most 120 characters.`);
    if (stage.allowNoChanges !== undefined && stage.kind !== 'gitCommit')
      errors.push(`Stage “${stage.label}” can allow no changes only as a Git commit stage.`);
    if (stage.kind === 'gitRollback' && stage.rollbackTarget === 'latestCheckpoint') {
      const hasCheckpoint = workflow.stages
        .slice(0, index)
        .some((candidate) => candidate.kind === 'gitCheckpoint' && candidate.enabled !== false);
      if (!hasCheckpoint)
        errors.push(`Rollback stage “${stage.label}” needs an earlier enabled Git checkpoint.`);
    }
    if (stage.kind === 'gitMerge' || stage.kind === 'gitPush') {
      const hasEarlierCommit = workflow.stages
        .slice(0, index)
        .some((candidate) => candidate.kind === 'gitCommit' && candidate.enabled !== false);
      if (!hasEarlierCommit)
        errors.push(
          `Git ${stage.kind === 'gitMerge' ? 'merge' : 'push'} stage “${stage.label}” needs an earlier enabled commit stage.`,
        );
    }
    if (stage.continueOnFailure && !['build', 'test', 'shellCommand'].includes(stage.kind))
      errors.push(`Stage “${stage.label}” cannot continue after a failure of this type.`);
  }
  for (const [index, stage] of workflow.stages.entries()) {
    if (stage.kind !== 'conditionalBranch' || !stage.condition) continue;
    const requiredKind =
      stage.condition.path === 'build.success'
        ? 'build'
        : stage.condition.path === 'tests.failed'
          ? 'test'
          : stage.condition.path === 'finalGate.status'
            ? 'finalGate'
            : null;
    const requiresReviewer = ['review.openCritical', 'review.openHigh'].includes(stage.condition.path);
    const sourceExists = workflow.stages
      .slice(0, index)
      .some(
        (candidate) =>
          candidate.enabled !== false &&
          (requiredKind
            ? candidate.kind === requiredKind
            : requiresReviewer && ['reviewer', 'parallelReview'].includes(candidate.kind)),
      );
    if (!sourceExists)
      errors.push(
        `Conditional branch “${stage.label}” requires an earlier enabled stage that produces ${stage.condition.path}.`,
      );
  }
  if (workflow.stages.some((stage) => stage.kind === 'remediation' && stage.enabled !== false)) {
    if (workflow.maxRemediationRounds < 1)
      errors.push('An enabled remediation stage needs at least one remediation round.');
    if (
      !workflow.stages.some(
        (stage) => stage.enabled !== false && ['reviewer', 'parallelReview'].includes(stage.kind),
      )
    )
      errors.push('An enabled remediation stage needs an enabled reviewer stage to verify each pass.');
  }
  return errors;
}

function isSafeBranch(value: string): boolean {
  return (
    value.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  );
}

export function applyExecutionProfile(
  stages: WorkflowStage[],
  profile: ExecutionProfile,
  maxParallelAgents: number,
): WorkflowStage[] {
  return stages.map((stage) => {
    if (stage.kind !== 'parallelReview') return { ...stage };
    const configured = Math.min(stage.parallelism ?? 1, maxParallelAgents);
    const parallelism =
      profile === 'economy' ? 1 : profile === 'balanced' ? Math.min(configured, 2) : configured;
    return { ...stage, parallelism };
  });
}

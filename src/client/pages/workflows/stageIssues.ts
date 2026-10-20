import {
  billingLaneLabel,
  evaluateBillingLane,
  resolveBillingMode,
  routeMatchesBillingLane,
} from '../../../shared/billing';
import { decisionEngineInfo, validateDecisionGate } from '../../../shared/decisions';
import {
  decisionPrerequisites,
  type PrerequisiteProfile,
  unmetPrerequisites,
} from '../../../shared/decisionPrerequisites';
import { providerServiceForRoute } from '../../../shared/providerServices';
import type {
  ConnectionProfile,
  ProviderStatus,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';
import { isAiStage } from '../shared/stageMeta';
import { modelCompatibility, resolveAssignment } from './assignment';

export type IssueSeverity = 'blocking' | 'attention';

export interface StageIssue {
  severity: IssueSeverity;
  message: string;
  /** Which part of the editor resolves it. */
  fix: 'connection' | 'model' | 'decision' | 'none';
}

export interface IssueContext {
  workflow: WorkflowDefinition;
  providers: readonly ProviderStatus[];
  connections: ReadonlyArray<ConnectionProfile & { credentials?: PrerequisiteProfile['credentials'] }>;
}

export function decisionPrerequisitesFor(
  stage: WorkflowStage,
  context: IssueContext,
  route: 'primary' | 'escalation' = 'primary',
) {
  const config = stage.decision;
  if (!config) return [];
  const target = route === 'primary' ? config : config.escalation;
  if (!target) return [];
  const workflow = context.workflow;
  return decisionPrerequisites({
    engine: target.engine,
    modelId: target.modelId,
    connectionProfileId: target.connectionProfileId,
    profiles: context.connections,
    openRouter: context.providers.find((provider) => provider.id === 'openrouter'),
    billingMode: resolveBillingMode(workflow),
    perRunUsd: workflow.meteredBudget?.perRunUsd ?? null,
    customAllowedLanes: workflow.customAllowedLanes,
    externalDataPolicy: workflow.externalDecisionDataPolicy ?? 'ask-first',
  });
}

/** Configuration problems for one stage, most serious first. A disabled stage reports none: it will not run. */
export function stageIssues(stage: WorkflowStage, index: number, context: IssueContext): StageIssue[] {
  if (stage.enabled === false) return [];
  const issues: StageIssue[] = [];
  const { workflow, providers, connections } = context;
  if (stage.kind === 'decisionGate') {
    const later = workflow.stages.slice(index + 1).map((item) => item.id);
    const errors = stage.decision ? validateDecisionGate(stage.decision, stage.label, later) : [];
    const gateErrors = errors.filter(
      (message) => !/select an OpenRouter connection|choose an exact OpenRouter model/.test(message),
    );
    for (const message of gateErrors.slice(0, 2))
      issues.push({
        severity: 'blocking',
        message: message.replace(/^Decision Gate “[^”]*”:? ?/, ''),
        fix: 'decision',
      });
    if (stage.decision && decisionEngineInfo(stage.decision.engine).external) {
      const unmet = [
        ...unmetPrerequisites(decisionPrerequisitesFor(stage, context)),
        ...unmetPrerequisites(decisionPrerequisitesFor(stage, context, 'escalation')),
      ];
      if (unmet.length)
        issues.push({
          severity: 'blocking',
          message: `${unmet.length} setup ${unmet.length === 1 ? 'item' : 'items'} missing: ${unmet
            .map((item) => item.label.toLowerCase())
            .join(', ')}.`,
          fix: 'decision',
        });
    }
    return issues;
  }
  if (!isAiStage(stage.kind)) return issues;

  const { configuration } = resolveAssignment(workflow, stage);
  const connection = configuration.connectionProfileId
    ? connections.find((item) => item.id === configuration.connectionProfileId)
    : undefined;
  if (configuration.connectionProfileId && !connection)
    issues.push({
      severity: 'blocking',
      message: 'The selected connection no longer exists. Choose another.',
      fix: 'connection',
    });
  if (!configuration.backendId || !configuration.providerId)
    issues.push({ severity: 'blocking', message: 'Choose a connection.', fix: 'connection' });
  else {
    if (
      configuration.billingLane &&
      !routeMatchesBillingLane(configuration.backendId, configuration.providerId, configuration.billingLane)
    )
      issues.push({
        severity: 'blocking',
        message: `${configuration.backendId} · ${configuration.providerId} cannot bill through ${billingLaneLabel(configuration.billingLane)}.`,
        fix: 'connection',
      });
    if (configuration.billingLane) {
      const decision = evaluateBillingLane({
        mode: resolveBillingMode(workflow),
        lane: configuration.billingLane,
        workload: 'generative',
        customAllowedLanes: workflow.customAllowedLanes,
      });
      if (!decision.allowed && decision.reason)
        issues.push({ severity: 'blocking', message: decision.reason, fix: 'connection' });
    }
    const backend = providers.find((item) => item.id === configuration.backendId);
    if (backend && !backend.detected)
      issues.push({
        severity: 'attention',
        message: `${backend.name} was not detected on the Desktop Master.`,
        fix: 'connection',
      });
  }
  if (!configuration.modelId) issues.push({ severity: 'blocking', message: 'Choose a model.', fix: 'model' });
  else if (
    modelCompatibility(
      providers,
      configuration.backendId,
      configuration.providerId,
      configuration.modelId,
    ) === 'not-listed'
  )
    issues.push({
      severity: 'attention',
      message: `${configuration.modelId} is not in the current catalogue for this connection.`,
      fix: 'model',
    });
  if (stage.modelSnapshot?.status === 'unavailable')
    issues.push({
      severity: 'attention',
      message: 'The saved model is no longer available. Choose a current one; Turing will not migrate it.',
      fix: 'model',
    });
  return issues.sort((a, b) => Number(a.severity === 'attention') - Number(b.severity === 'attention'));
}

export interface AssignmentSummary {
  connection: string;
  model: string;
}

/** The connection and model a row shows. A route with no saved connection is shown as a route, not as a connection. */
export function describeAssignment(
  stage: WorkflowStage,
  workflow: Pick<WorkflowDefinition, 'defaultModelConfiguration' | 'stageDefaults'>,
  connections: readonly ConnectionProfile[],
): AssignmentSummary {
  const { configuration } = resolveAssignment(workflow, stage);
  const connection = configuration.connectionProfileId
    ? connections.find((item) => item.id === configuration.connectionProfileId)
    : undefined;
  const service = providerServiceForRoute(
    configuration.backendId,
    configuration.providerId,
    configuration.billingLane,
  );
  const connectionText = connection
    ? connection.name
    : configuration.backendId && configuration.providerId
      ? `${service?.label ?? configuration.backendId} · no saved connection`
      : 'No connection';
  return {
    connection: connectionText,
    model: configuration.modelDisplayName ?? configuration.modelId ?? 'No model',
  };
}

export interface WorkflowProblem {
  message: string;
}

/** Cross-stage problems the Desktop Master would reject on save, shown before the person presses Save. */
export function workflowProblems(workflow: WorkflowDefinition): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  if (!workflow.stages.length) problems.push({ message: 'A workflow needs at least one stage.' });
  const refinement = workflow.stages.filter((stage) => stage.kind === 'promptRefinement');
  if (refinement.length > 1) problems.push({ message: 'Only one Prompt refinement stage is allowed.' });
  const firstEnabled = workflow.stages.findIndex((stage) => stage.enabled !== false);
  const refinementIndex = workflow.stages.findIndex(
    (stage) => stage.kind === 'promptRefinement' && stage.enabled !== false,
  );
  if (refinementIndex > 0 && refinementIndex !== firstEnabled)
    problems.push({ message: 'Prompt refinement must be the first enabled stage.' });
  if (
    workflow.stages.some((stage) =>
      ['gitCheckpoint', 'gitCommit', 'gitPush', 'gitMerge', 'gitRollback'].includes(stage.kind),
    ) &&
    !workflow.isolatedWorktree
  )
    problems.push({ message: 'Git stages need worktree isolation. Turn it on under Safety and billing.' });
  return problems;
}

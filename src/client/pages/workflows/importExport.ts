import type {
  ConnectionProfile,
  ModelConfiguration,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';

/**
 * Turns an exported workflow file into a new workflow body. Exports carry a route reference ("backend:provider:lane")
 * instead of a connection ID, and never any credential. Importing matches that reference to a saved local connection
 * where one exists and leaves the stage without a connection otherwise, so an imported workflow never inherits another
 * machine's account and shows its missing assignments instead of hiding them.
 */
export function prepareImportedWorkflow(
  parsed: { workflows?: WorkflowDefinition[]; workflow?: WorkflowDefinition },
  connections: readonly ConnectionProfile[],
): WorkflowDefinition {
  const workflow = parsed.workflows?.[0] ?? parsed.workflow;
  if (!workflow?.name || !Array.isArray(workflow.stages))
    throw new Error('The selected file does not contain a workflow definition.');
  const remapConnection = <T extends { connectionProfileId?: string }>(
    configuration: (T & { connectionReference?: string }) | undefined,
  ) => {
    if (!configuration) return configuration;
    const { connectionReference, ...cleanConfiguration } = configuration;
    const match = connectionReference
      ? connections.find(
          (connection) =>
            `${connection.backendId}:${connection.providerId}:${connection.billingLane}` ===
            connectionReference,
        )
      : undefined;
    return { ...cleanConfiguration, connectionProfileId: match?.id };
  };
  const remapDecisionRoute = <T extends { connectionProfileId?: string; judge?: ModelConfiguration }>(
    route: T | undefined,
  ): T | undefined =>
    route
      ? ({
          ...remapConnection(route as T & { connectionReference?: string }),
          judge: remapConnection(
            route.judge as (ModelConfiguration & { connectionReference?: string }) | undefined,
          ),
        } as T)
      : route;
  const stages = workflow.stages.map((stage) => {
    const remapped = remapConnection(
      stage as WorkflowStage & { connectionReference?: string },
    ) as WorkflowStage;
    return remapped.decision
      ? {
          ...remapped,
          decision: {
            ...remapDecisionRoute(remapped.decision)!,
            escalation: remapDecisionRoute(remapped.decision.escalation),
          },
        }
      : remapped;
  });
  const stageDefaults = workflow.stageDefaults
    ? (Object.fromEntries(
        Object.entries(workflow.stageDefaults).map(([kind, configuration]) => [
          kind,
          remapConnection(configuration as typeof configuration & { connectionReference?: string }),
        ]),
      ) as WorkflowDefinition['stageDefaults'])
    : undefined;
  return {
    ...workflow,
    defaultModelConfiguration: remapConnection(
      workflow.defaultModelConfiguration as typeof workflow.defaultModelConfiguration & {
        connectionReference?: string;
      },
    ),
    stageDefaults,
    stages,
    id: '',
    version: 1,
    isDefault: false,
    createdAt: '',
    updatedAt: '',
  };
}

export function downloadWorkflowJson(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

import { billingLaneLabel } from '../../../shared/billing';
import { pruneModelSettings } from '../../../shared/modelSettings';
import type {
  ConnectionProfile,
  ModelConfiguration,
  ModelOption,
  ProviderStatus,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';

/**
 * Pure rules behind the stage assignment editor: where each value comes from, which models a route can offer, and what
 * changing a connection would affect. The editor only displays these results. Nothing here changes a provider, a model
 * or a billing lane on its own.
 */
export const ROUTE_FIELDS = ['connectionProfileId', 'backendId', 'providerId', 'billingLane'] as const;
export const MODEL_FIELDS = [
  'modelId',
  'modelDisplayName',
  'variantId',
  'reasoning',
  'nativeSettings',
  'modelSnapshot',
] as const;

export type ValueSource = 'stage' | 'stage-default' | 'workflow-default' | 'unset';

export interface ResolvedAssignment {
  configuration: ModelConfiguration;
  /** Where each shown value comes from. A stage override beats a stage-type default, which beats the workflow default. */
  sources: Record<'connection' | 'model' | 'reasoning' | 'variant', ValueSource>;
}

const present = (value: unknown) => value !== undefined && value !== null && value !== '';

/** Mirrors the run launcher's inheritance, including its rule that a changed route does not inherit a connection. */
export function resolveAssignment(
  workflow: Pick<WorkflowDefinition, 'defaultModelConfiguration' | 'stageDefaults'>,
  stage: WorkflowStage,
): ResolvedAssignment {
  const workflowDefault = workflow.defaultModelConfiguration ?? {};
  const stageDefault = workflow.stageDefaults?.[stage.kind] ?? {};
  const defaults: ModelConfiguration = { ...workflowDefault, ...stageDefault };
  const sourceOf = (field: keyof ModelConfiguration): ValueSource => {
    if (present(stage[field as keyof WorkflowStage])) return 'stage';
    if (present(stageDefault[field])) return 'stage-default';
    if (present(workflowDefault[field])) return 'workflow-default';
    return 'unset';
  };
  const merge = <K extends keyof ModelConfiguration>(field: K): ModelConfiguration[K] =>
    (present(stage[field as keyof WorkflowStage])
      ? stage[field as keyof WorkflowStage]
      : defaults[field]) as ModelConfiguration[K];
  const routeChanged = Boolean(
    (stage.backendId && defaults.backendId && stage.backendId !== defaults.backendId) ||
    (stage.providerId && defaults.providerId && stage.providerId !== defaults.providerId) ||
    (stage.billingLane && defaults.billingLane && stage.billingLane !== defaults.billingLane),
  );
  const connectionProfileId = present(stage.connectionProfileId)
    ? stage.connectionProfileId
    : routeChanged
      ? undefined
      : defaults.connectionProfileId;
  return {
    configuration: {
      backendId: merge('backendId'),
      connectionProfileId,
      providerId: merge('providerId'),
      billingLane: merge('billingLane'),
      modelId: merge('modelId'),
      modelDisplayName: merge('modelDisplayName'),
      variantId: merge('variantId'),
      reasoning: merge('reasoning'),
      nativeSettings: merge('nativeSettings'),
    },
    sources: {
      connection: present(stage.connectionProfileId)
        ? 'stage'
        : routeChanged
          ? 'unset'
          : sourceOf('connectionProfileId'),
      model: sourceOf('modelId'),
      reasoning: sourceOf('reasoning'),
      variant: sourceOf('variantId'),
    },
  };
}

export function sourceLabel(source: ValueSource): string {
  return source === 'stage'
    ? 'Stage override'
    : source === 'stage-default'
      ? 'Stage-type default'
      : source === 'workflow-default'
        ? 'Workflow default'
        : 'Not set';
}

/** Clears this stage's own route and model so it follows the workflow and stage-type defaults again. */
export function inheritPatch(): Partial<WorkflowStage> {
  return {
    connectionProfileId: undefined,
    backendId: undefined,
    providerId: undefined,
    billingLane: undefined,
    modelId: undefined,
    modelDisplayName: undefined,
    variantId: undefined,
    reasoning: undefined,
    nativeSettings: undefined,
    modelSnapshot: undefined,
  };
}

export function hasStageOverride(stage: WorkflowStage): boolean {
  return [...ROUTE_FIELDS, ...MODEL_FIELDS].some((field) => present(stage[field]));
}

export type ModelCompatibility = 'listed' | 'not-listed' | 'unverifiable';

/** The models a route can offer from the backend's own catalogue. OpenCode lists models for many providers, so it is filtered. */
export function modelsForRoute(
  providers: readonly ProviderStatus[],
  backendId: string | undefined,
  providerId: string | undefined,
): { backend: ProviderStatus | undefined; models: ModelOption[]; discovery: boolean } {
  const backend = providers.find((provider) => provider.id === backendId);
  if (!backend) return { backend, models: [], discovery: false };
  const discovery = backend.capabilities.modelDiscovery && backend.models.length > 0;
  const models =
    backendId === 'opencode' && providerId
      ? backend.models.filter(
          (model) => model.providerId === providerId || model.id.startsWith(`${providerId}/`),
        )
      : backend.models;
  return { backend, models, discovery };
}

export function modelCompatibility(
  providers: readonly ProviderStatus[],
  backendId: string | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelCompatibility {
  if (!modelId) return 'unverifiable';
  const { models, discovery } = modelsForRoute(providers, backendId, providerId);
  if (!discovery) return 'unverifiable';
  return models.some((model) => model.id === modelId) ? 'listed' : 'not-listed';
}

/** The stage patch for choosing a model from a catalogue: exact ID, snapshot, and only the settings the model supports. */
export function modelSelectionPatch(
  model: ModelOption,
  current: ModelConfiguration,
  backend: ProviderStatus | undefined,
  now: () => string = () => new Date().toISOString(),
): Partial<WorkflowStage> {
  return {
    modelId: model.id,
    modelDisplayName: model.name,
    providerId: model.providerId,
    modelSnapshot: {
      providerId: model.providerId,
      modelId: model.id,
      displayName: model.name,
      ...(current.variantId ? { variantId: current.variantId } : {}),
      capabilities: {
        ...(model.capabilities ?? {}),
        ...(model.reasoningLevels ? { reasoningLevels: model.reasoningLevels } : {}),
        ...(model.variantIds ? { variants: model.variantIds } : {}),
        supportsTools:
          model.supportsTools ?? (model.capabilities as { tools?: boolean } | undefined)?.tools ?? null,
      },
      discoveredAt: model.discoveredAt ?? backend?.checkedAt ?? now(),
      adapterVersion: model.adapterVersion ?? backend?.version ?? null,
      status: 'current',
    },
    ...pruneModelSettings({
      backendId: current.backendId,
      model,
      reasoning: current.reasoning,
      variantId: current.variantId,
      nativeSettings: current.nativeSettings,
    }),
  };
}

/** The patch for a model ID typed by hand: no snapshot is invented, and settings the model may not support are cleared. */
export function manualModelPatch(modelId: string): Partial<WorkflowStage> {
  return {
    modelId: modelId.trim() || undefined,
    modelDisplayName: undefined,
    modelSnapshot: undefined,
    reasoning: undefined,
    variantId: undefined,
    nativeSettings: undefined,
  };
}

export function connectionPatch(connection: ConnectionProfile): Partial<WorkflowStage> {
  return {
    connectionProfileId: connection.id,
    backendId: connection.backendId,
    providerId: connection.providerId,
    billingLane: connection.billingLane,
  };
}

export interface ConnectionChangeImpact {
  routeChanged: boolean;
  /** True when the current model, reasoning or variant would not carry over and the person must decide. */
  needsDecision: boolean;
  /** False when the new route lists its models and the current one is not among them. */
  canKeepModel: boolean;
  lines: string[];
  /** Settings removed even when the person keeps the model ID, because they may not apply to the new route. */
  clearsWhenKept: Array<(typeof MODEL_FIELDS)[number]>;
}

function routeLabel(configuration: ModelConfiguration, connection?: ConnectionProfile): string {
  const lane = configuration.billingLane ? billingLaneLabel(configuration.billingLane) : 'no billing lane';
  return `${connection?.name ?? configuration.backendId ?? 'no backend'} · ${configuration.providerId ?? 'no provider'} · ${lane}`;
}

/**
 * What would change if a stage moved to another connection. The route fields always change with the connection. The
 * model is kept only when the new route can still offer it or cannot be checked; a model the new route lists as
 * unavailable is reported, never swapped for another.
 */
export function connectionChangeImpact(
  current: ModelConfiguration,
  next: ConnectionProfile,
  providers: readonly ProviderStatus[],
  currentConnection?: ConnectionProfile,
): ConnectionChangeImpact {
  const routeChanged =
    current.backendId !== next.backendId ||
    current.providerId !== next.providerId ||
    current.billingLane !== next.billingLane;
  const lines: string[] = [];
  const clearsWhenKept: ConnectionChangeImpact['clearsWhenKept'] = [];
  let needsDecision = false;
  let canKeepModel = true;
  if (routeChanged && (current.backendId || current.providerId || current.billingLane))
    lines.push(`Route changes from ${routeLabel(current, currentConnection)} to ${routeLabel(next, next)}.`);
  if (current.modelId && routeChanged) {
    const compatibility = modelCompatibility(providers, next.backendId, next.providerId, current.modelId);
    needsDecision = true;
    if (compatibility === 'not-listed') {
      canKeepModel = false;
      lines.push(
        `${current.modelId} is not in the ${next.backendId} catalogue for ${next.providerId}. Turing will not pick another model for you.`,
      );
    } else if (compatibility === 'unverifiable') {
      clearsWhenKept.push('modelSnapshot', 'variantId', 'reasoning', 'nativeSettings');
      lines.push(
        `${next.backendId} reports no catalogue for this route, so ${current.modelId} cannot be checked. Keeping it sends the ID exactly as typed; the saved catalogue snapshot, reasoning and variant are cleared because they may not apply.`,
      );
    } else {
      needsDecision = false;
      lines.push(`${current.modelId} is listed for the new route and is kept.`);
    }
  }
  if (!needsDecision && routeChanged && (current.reasoning || current.variantId))
    lines.push('Reasoning and variant are re-checked against the model after the change.');
  return { routeChanged, needsDecision, canKeepModel, lines, clearsWhenKept };
}

/**
 * The patch that applies a connection. “keep” removes only what the impact lists; “clear-model” also removes the model
 * so the person chooses a new one. Neither ever fills in a replacement model.
 */
export function applyConnectionPatch(
  connection: ConnectionProfile,
  impact: ConnectionChangeImpact | null,
  mode: 'keep' | 'clear-model' = 'keep',
): Partial<WorkflowStage> {
  const patch: Partial<WorkflowStage> = connectionPatch(connection);
  const cleared = mode === 'clear-model' ? MODEL_FIELDS : (impact?.clearsWhenKept ?? []);
  for (const field of cleared) (patch as Record<string, unknown>)[field] = undefined;
  return patch;
}

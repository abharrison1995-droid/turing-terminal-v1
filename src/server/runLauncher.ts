import { randomUUID } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BillingLane, WorkflowDefinition, WorkflowStage } from '../shared/types.js';
import {
  ALL_BILLING_LANES,
  billingLaneLabel,
  evaluateBillingLane,
  inferBillingLane,
  isMeteredLane,
  isSubscriptionLane,
  PROVIDER_FALLBACK_UNVERIFIABLE,
  providerSideFallbackStatus,
  resolveBillingMode,
  routeMatchesBillingLane,
  SUBSCRIPTION_LANES,
} from '../shared/billing.js';
import {
  classifyModelIdentity,
  reasoningControlFor,
  validateModelSettings,
} from '../shared/modelSettings.js';
import { decisionEngineInfo, validateDecisionGate } from '../shared/decisions.js';
import { allProviders } from './modelCatalog.js';
import { SecretStore, secretRef } from './secretStore.js';
import { getBudgetSettings } from './meteredBudget.js';
import { decisionConfigHash } from './decisionEngines.js';
import { applyExecutionProfile } from './workflowValidation.js';
import type { Db } from './db.js';
import { getRunRow, localMachine, toConnectionProfile, toProject, toRun, toWorkflow } from './serialize.js';
import type { RunEngine } from './runEngine.js';
import { resolveEffectiveRules } from './rules.js';

const execFile = promisify(callbackExecFile);

/** Validated run-creation input (mirrors the HTTP `runInputSchema`). */
export interface RunInput {
  task: string;
  projectId: string;
  workflowId: string;
  profile?: 'economy' | 'balanced' | 'maximum';
  permissionMode?: 'supervised' | 'normal' | 'yolo' | 'enigma';
  enigmaConfirmed?: boolean;
  refinePrompt?: boolean;
  subscriptionOnly?: boolean;
  billingMode?: 'subscriptions-only' | 'subscriptions-plus-decision-budget' | 'custom';
  lockProviders?: boolean;
}

export type RunPreview = NonNullable<Awaited<ReturnType<typeof buildPreview>>>;

export interface QueueRunOptions {
  rulesSnapshot?: unknown;
  eventType?: string;
  eventDetails?: Record<string, unknown>;
}

const AI_KINDS = new Set<WorkflowStage['kind']>([
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

export function queueRun(db: Db, preview: RunPreview, options: QueueRunOptions = {}): { runId: string } {
  const id = randomUUID();
  const now = new Date().toISOString();
  const workflowSnapshot = preview.workflow;
  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, refinement_requested, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      id,
      preview.machine.id,
      preview.project.id,
      preview.workflow.id,
      JSON.stringify(workflowSnapshot),
      preview.task,
      preview.profile,
      preview.permissionMode,
      Number(preview.refinePrompt),
      now,
    );
    db.prepare('UPDATE runs SET rules_snapshot_json = ? WHERE id = ?').run(
      JSON.stringify(options.rulesSnapshot ?? preview.effectiveRules),
      id,
    );
    const insert = db.prepare(`INSERT INTO stages
      (id, run_id, stage_key, kind, title, sequence, backend_id, provider_id, model_id, connection_profile_id, billing_lane, variant_id, model_snapshot_json, status, input_json, logs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`);
    workflowSnapshot.stages.forEach((stage, sequence) =>
      insert.run(
        randomUUID(),
        id,
        stage.id,
        stage.kind,
        stage.label,
        sequence,
        stage.backendId ?? null,
        stage.providerId ?? null,
        stage.modelId ?? null,
        stage.connectionProfileId ?? null,
        stage.billingLane ?? null,
        stage.variantId ?? null,
        stage.modelSnapshot ? JSON.stringify(stage.modelSnapshot) : null,
        stage.enabled === false || (stage.kind === 'promptRefinement' && !preview.refinePrompt)
          ? 'skipped'
          : 'pending',
        JSON.stringify({
          role: stage.role ?? null,
          reasoning: stage.reasoning ?? null,
          variantId: stage.variantId ?? null,
          nativeSettings: stage.nativeSettings ?? {},
          billingLane: stage.billingLane ?? null,
          connectionProfileId: stage.connectionProfileId ?? null,
        }),
      ),
    );
    db.prepare(
      'INSERT INTO run_events (id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      id,
      options.eventType ?? 'run_queued',
      JSON.stringify({
        projectId: preview.project.id,
        workflowId: preview.workflow.id,
        machineId: preview.machine.id,
        refinePrompt: preview.refinePrompt,
        subscriptionOnly: preview.subscriptionOnly,
        billingMode: preview.billingMode,
        meteredCapUsd: preview.routingSummary.runMeteredCapUsd,
        lockProviders: preview.lockProviders,
        ...options.eventDetails,
      }),
      now,
    );
  });
  create();
  return { runId: id };
}

/** Starts execution of a run that queueRun has already persisted. */
export function startQueuedRun(engine: RunEngine, runId: string): void {
  engine.start(runId);
}

/** Ordinary run path: persist the queued run, then start it immediately. */
export function createRun(db: Db, engine: RunEngine, preview: RunPreview, options: QueueRunOptions = {}) {
  const { runId } = queueRun(db, preview, options);
  startQueuedRun(engine, runId);
  return toRun(db, getRunRow(db, runId)!);
}

export async function buildPreview(db: Db, input: RunInput, workflowOverride?: WorkflowDefinition) {
  let projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as
    Record<string, unknown> | undefined;
  const workflowRow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(input.workflowId) as
    Record<string, unknown> | undefined;
  if (!projectRow || !workflowRow) return null;
  if (typeof projectRow.git_root === 'string') {
    try {
      const status = await execFile('git', ['status', '--porcelain'], {
        cwd: String(projectRow.path),
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 250_000,
      });
      const branch = await execFile('git', ['branch', '--show-current'], {
        cwd: String(projectRow.path),
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 250_000,
      });
      db.prepare('UPDATE projects SET dirty = ?, branch = ? WHERE id = ?').run(
        Number(status.stdout.trim().length > 0),
        branch.stdout.trim() || null,
        projectRow.id,
      );
    } catch {
      db.prepare('UPDATE projects SET dirty = NULL WHERE id = ?').run(projectRow.id);
    }
    projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as Record<
      string,
      unknown
    >;
  }
  const project = toProject(projectRow);
  const source = workflowOverride ?? toWorkflow(workflowRow);
  const profile = input.profile ?? source.executionProfile;
  const permissionMode = input.permissionMode ?? source.permissionMode;
  const refinePrompt = input.refinePrompt ?? source.promptRefinementDefault;
  const billingMode = resolveBillingMode(source, {
    billingMode: input.billingMode,
    subscriptionOnly: input.subscriptionOnly,
  });
  const workflow: WorkflowDefinition = {
    ...source,
    executionProfile: profile,
    permissionMode,
    billingMode,
    subscriptionOnly: billingMode !== 'custom',
    meteredBudget: source.meteredBudget ?? { perRunUsd: null, unknownCostPolicy: 'block' },
    externalDecisionDataPolicy: source.externalDecisionDataPolicy ?? 'ask-first',
    lockProviders: input.lockProviders ?? source.lockProviders,
    stages: applyExecutionProfile(
      source.stages.map((stage) => inheritStageConfiguration(source, stage)),
      profile,
      source.maxParallelAgents,
    ),
  };
  const effectiveRules = resolveEffectiveRules(db, project.id);
  const providers = await allProviders(db);
  const connections = (
    db.prepare('SELECT * FROM connection_profiles').all() as Array<Record<string, unknown>>
  ).map(toConnectionProfile);
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const secrets = SecretStore.forDatabase(db);
  const budgetSettings = getBudgetSettings(db);
  const profileMismatch = new Set<string>();
  workflow.stages = workflow.stages.map((stage) => {
    if (!AI_KINDS.has(stage.kind)) return stage;
    const connection = stage.connectionProfileId ? connectionById.get(stage.connectionProfileId) : undefined;
    if (stage.connectionProfileId && !connection) profileMismatch.add(stage.id);
    if (!connection)
      return {
        ...stage,
        billingLane: stage.billingLane ?? inferBillingLane(stage.backendId, stage.providerId),
      };
    return {
      ...stage,
      backendId: connection.backendId,
      providerId: connection.providerId,
      billingLane: connection.billingLane,
    };
  });
  const activeStages = workflow.stages.filter(
    (stage) => stage.enabled !== false && (stage.kind !== 'promptRefinement' || refinePrompt),
  );
  const routeStatus = (route: {
    stageId: string;
    backendId?: string;
    providerId?: string;
    modelId?: string;
    billingLane?: BillingLane;
    variantId?: string;
    reasoning?: string;
    nativeSettings?: WorkflowStage['nativeSettings'];
    connectionProfileId?: string;
    workload: 'generative' | 'decision';
    family?: 'generative' | 'decision';
  }) => {
    const provider = providers.find((candidate) => candidate.id === route.backendId);
    const selectedModel = provider?.models.find((model) => model.id === route.modelId);
    const modelCatalogAvailable = Boolean(
      provider?.capabilities.modelDiscovery && provider.models.length && provider.catalogSource !== 'cache',
    );
    const modelExists = modelCatalogAvailable
      ? Boolean(selectedModel)
      : Boolean(route.modelId?.trim()) && (route.backendId !== 'openrouter' || Boolean(selectedModel));
    const billingLane = route.billingLane ?? inferBillingLane(route.backendId, route.providerId);
    const billingLaneMatchesRoute = routeMatchesBillingLane(route.backendId, route.providerId, billingLane);
    const catalogStatus = selectedModel
      ? selectedModel.status === 'deprecated'
        ? ('deprecated' as const)
        : selectedModel.status === 'last-known' || provider?.catalogSource === 'cache'
          ? ('last-known' as const)
          : ('current' as const)
      : modelCatalogAvailable
        ? ('unavailable' as const)
        : ('last-known' as const);
    const connection = route.connectionProfileId ? connectionById.get(route.connectionProfileId) : undefined;
    const openRouterReady =
      route.backendId !== 'openrouter' ||
      Boolean(
        connection &&
        connection.backendId === 'openrouter' &&
        secrets.has(secretRef(connection.id, 'inference')),
      );
    const subscriptionReady =
      provider?.id === 'claude-code'
        ? provider.subscriptionAuthenticated === true
        : provider?.id === 'codex-cli'
          ? provider.subscriptionAuthenticated === true && selectedModel?.subscriptionBacked === true
          : provider?.id === 'opencode'
            ? selectedModel
              ? isSubscriptionLane(billingLane)
                ? selectedModel.subscriptionBacked === true
                : selectedModel.subscriptionBacked === false
              : false
            : provider?.id === 'cline'
              ? ['openai-codex', 'cline-pass'].includes(route.providerId ?? '') ||
                ['cline-usage-billing', 'openai-api', 'anthropic-api'].includes(billingLane)
              : provider?.id === 'openrouter'
                ? openRouterReady &&
                  (!route.family || !selectedModel?.family || selectedModel.family === route.family)
                : false;
    const billing = evaluateBillingLane({
      mode: billingMode,
      lane: billingLane,
      workload: route.workload,
      customAllowedLanes: workflow.customAllowedLanes,
    });
    const settingErrors = validateModelSettings({
      backendId: route.backendId,
      model: selectedModel,
      catalogAvailable: modelCatalogAvailable,
      reasoning: route.reasoning,
      variantId: route.variantId,
      nativeSettings: route.nativeSettings,
    });
    const ready = Boolean(
      provider?.detected &&
      provider.capabilities.toolMediation &&
      subscriptionReady &&
      billingLaneMatchesRoute &&
      route.providerId?.trim() &&
      route.modelId?.trim() &&
      modelExists &&
      billing.allowed &&
      !profileMismatch.has(route.stageId) &&
      !settingErrors.length,
    );
    return {
      provider,
      selectedModel,
      billingLane,
      catalogStatus,
      connection,
      billing,
      settingErrors,
      ready,
      openRouterReady,
    };
  };
  const warnings: string[] = [];
  const providerAssignments: RunPreviewAssignment[] = [];
  for (const stage of activeStages) {
    if (AI_KINDS.has(stage.kind)) {
      const status = routeStatus({
        ...stage,
        stageId: stage.id,
        workload: 'generative',
        family: 'generative',
      });
      const modelSnapshot = {
        providerId: stage.providerId ?? '',
        modelId: stage.modelId ?? '',
        displayName: stage.modelDisplayName ?? status.selectedModel?.name ?? stage.modelId ?? '',
        connectionProfileName: status.connection?.name ?? stage.modelSnapshot?.connectionProfileName ?? null,
        billingLane: status.billingLane,
        ...(stage.variantId ? { variantId: stage.variantId } : {}),
        capabilities: {
          ...(status.selectedModel?.capabilities ?? {}),
          ...(status.selectedModel?.reasoningLevels
            ? { reasoningLevels: status.selectedModel.reasoningLevels }
            : {}),
          ...(status.selectedModel?.variantIds ? { variants: status.selectedModel.variantIds } : {}),
          ...(status.selectedModel?.pricing ? { pricing: status.selectedModel.pricing } : {}),
          supportsTools:
            status.selectedModel?.supportsTools ?? status.selectedModel?.capabilities?.tools ?? null,
        },
        discoveredAt: status.selectedModel
          ? (status.selectedModel.discoveredAt ?? status.provider?.checkedAt ?? null)
          : (stage.modelSnapshot?.discoveredAt ?? null),
        adapterVersion: status.provider?.version ?? stage.modelSnapshot?.adapterVersion ?? null,
        status: status.catalogStatus,
        identity: classifyModelIdentity(stage.backendId, stage.modelId),
        reasoningControl: reasoningControlFor(stage.backendId, status.selectedModel),
      };
      stage.modelSnapshot = modelSnapshot;
      if (stage.backendId === 'openrouter' && !status.openRouterReady)
        warnings.push(`${stage.label}: select an OpenRouter connection with a stored inference key.`);
      for (const error of status.settingErrors) warnings.push(`${stage.label}: ${error}`);
      if (!status.billing.allowed && status.billing.reason)
        warnings.push(`${stage.label}: ${status.billing.reason}`);
      providerAssignments.push({
        stage: stage.label,
        stageId: stage.id,
        kind: stage.kind,
        role: stage.role ?? null,
        workload: 'generative',
        identity: modelSnapshot.identity,
        billingAllowed: status.billing.allowed,
        billingReason: status.billing.reason,
        backendId: stage.backendId ?? null,
        providerId: stage.providerId ?? null,
        modelId: stage.modelId ?? null,
        modelDisplayName: modelSnapshot.displayName,
        variantId: stage.variantId ?? null,
        connectionProfileName: status.connection?.name ?? null,
        billingLane: status.billingLane,
        reasoning: stage.reasoning ?? null,
        nativeSettings: stage.nativeSettings ?? {},
        catalogStatus: status.catalogStatus,
        context: estimateStageContext(input.task, stage, effectiveRules, workflow.contextPolicy),
        ready: status.ready,
      });
      continue;
    }
    if (stage.kind !== 'decisionGate') continue;
    const config = stage.decision;
    const engine = config?.engine ?? 'deterministic-rules';
    const info = decisionEngineInfo(engine);
    const laterIds = workflow.stages.slice(workflow.stages.indexOf(stage) + 1).map((item) => item.id);
    const configErrors = validateDecisionGate(config, stage.label, laterIds);
    const routes = config ? [config, ...(config.escalation ? [config.escalation] : [])] : [];
    let ready = configErrors.length === 0;
    let billingLane: BillingLane | undefined;
    let backendId: string | null = 'turing-local';
    let providerId: string | null = null;
    let modelId: string | null = null;
    let billingAllowed = true;
    let billingReason: string | null = null;
    for (const [index, route] of routes.entries()) {
      if (route.engine === 'deterministic-rules') continue;
      const judge = route.engine === 'subscription-llm-judge' ? route.judge : undefined;
      const routeInput = judge
        ? { ...judge, billingLane: judge.billingLane ?? inferBillingLane(judge.backendId, judge.providerId) }
        : {
            backendId: 'openrouter',
            providerId: 'openrouter',
            billingLane: 'openrouter-metered' as const,
            modelId: route.modelId,
            connectionProfileId: route.connectionProfileId,
          };
      const status = routeStatus({
        ...routeInput,
        stageId: stage.id,
        workload: 'decision',
        family: route.engine === 'jev-openrouter' ? 'decision' : 'generative',
      });
      if (index === 0) {
        billingLane = status.billingLane;
        backendId = routeInput.backendId ?? null;
        providerId = routeInput.providerId ?? null;
        modelId = routeInput.modelId ?? null;
        billingAllowed = status.billing.allowed;
        billingReason = status.billing.reason;
      }
      if (!status.ready) {
        ready = false;
        warnings.push(
          `${stage.label}: ${index === 0 ? 'Decision Engine' : 'escalation engine'} route is not ready${status.billing.reason ? ` — ${status.billing.reason}` : route.engine !== 'subscription-llm-judge' && !status.openRouterReady ? ' — select an OpenRouter connection with a stored inference key' : ''}.`,
        );
      }
      if (
        isMeteredLane(status.billingLane) &&
        billingMode === 'subscriptions-plus-decision-budget' &&
        workflow.meteredBudget.perRunUsd === null
      ) {
        ready = false;
        warnings.push(
          `${stage.label}: set a per-run metered cap; Subscriptions + Decision Budget requires one.`,
        );
      }
    }
    const external = routes.some((route) => decisionEngineInfo(route.engine).external);
    if (external && workflow.externalDecisionDataPolicy === 'block') {
      ready = false;
      warnings.push(`${stage.label}: external decision data is blocked for this workflow.`);
    }
    for (const error of configErrors) warnings.push(error);
    const maxStateChars = config?.maxStateChars ?? 24_000;
    providerAssignments.push({
      stage: stage.label,
      stageId: stage.id,
      kind: stage.kind,
      role: 'decision-gate',
      workload: engine === 'deterministic-rules' ? 'deterministic' : 'decision',
      identity: classifyModelIdentity(backendId ?? undefined, modelId ?? undefined),
      billingAllowed,
      billingReason,
      decision: config
        ? {
            engine,
            questionType: config.questionType,
            question: config.question,
            routingField: config.routing.field,
            inputs: config.inputs,
            external,
            externalDataPolicy: workflow.externalDecisionDataPolicy,
            configHash: decisionConfigHash(config),
            escalation: config.escalation?.engine ?? null,
          }
        : undefined,
      backendId,
      providerId,
      modelId,
      modelDisplayName: modelId ?? info.label,
      variantId: null,
      connectionProfileName: config?.connectionProfileId
        ? (connectionById.get(config.connectionProfileId)?.name ?? null)
        : null,
      billingLane,
      reasoning: null,
      nativeSettings: {},
      catalogStatus: undefined,
      context: {
        label: `Decision state: ${(config?.inputs ?? []).join(', ') || 'structured rule only'}`,
        estimatedInputTokens: engine === 'deterministic-rules' ? 0 : Math.ceil(maxStateChars / 4),
        maxEstimatedTokens: Math.ceil(maxStateChars / 4),
        maxFiles: 0,
        maxFileBytes: 0,
        onLimitExceeded: 'compact',
        estimateOnly: true,
      },
      ready,
    });
  }
  const hasPromptRefinementStage = workflow.stages.some(
    (stage) => stage.kind === 'promptRefinement' && stage.enabled !== false,
  );
  if (refinePrompt && !hasPromptRefinementStage)
    warnings.push('Prompt refinement is enabled, but this workflow has no enabled prompt refinement stage.');
  if (!input.task.trim()) warnings.push('Enter a task description.');
  if (project.dirty && workflow.isolatedWorktree)
    warnings.push('Project has uncommitted changes; commit or stash before isolated execution.');
  if (project.gitRoot && project.dirty === null && workflow.isolatedWorktree)
    warnings.push(
      'Git status could not be verified; isolated execution is blocked until the project refresh succeeds.',
    );
  if (!project.gitRoot && workflow.isolatedWorktree)
    warnings.push('This folder is not a Git repository; execution will use the project folder directly.');
  if (providerAssignments.some((assignment) => assignment.backendId && !assignment.ready))
    warnings.push(
      'One or more execution backends are missing, have no explicit provider/model, or no longer report the configured model.',
    );
  for (const assignment of providerAssignments) {
    if (
      assignment.workload === 'generative' &&
      assignment.backendId &&
      assignment.providerId &&
      !routeMatchesBillingLane(
        assignment.backendId,
        assignment.providerId,
        assignment.billingLane ?? 'unknown',
      )
    )
      warnings.push(
        `${assignment.stage}: provider ${assignment.providerId} does not match the configured ${billingLaneLabel(assignment.billingLane ?? 'unknown')} billing lane.`,
      );
    if (profileMismatch.has(assignment.stageId ?? ''))
      warnings.push(
        `Connection profile for “${assignment.stage}” no longer exists. Select a local profile or remove the saved reference.`,
      );
    if (
      assignment.billingLane &&
      isSubscriptionLane(assignment.billingLane) &&
      !warnings.includes(PROVIDER_FALLBACK_UNVERIFIABLE)
    )
      warnings.push(PROVIDER_FALLBACK_UNVERIFIABLE);
    if (assignment.identity === 'floating')
      warnings.push(
        `${assignment.stage}: ${assignment.modelId} is a floating/routed model alias; history records the resolved model where telemetry reports it, so reruns may not be identical.`,
      );
    if (assignment.context.estimatedInputTokens > assignment.context.maxEstimatedTokens)
      warnings.push(
        `${assignment.stage} context estimate exceeds its configured budget; ${assignment.context.onLimitExceeded} policy applies before provider execution.`,
      );
  }
  const billingGroups = new Map<string, string[]>();
  for (const assignment of providerAssignments) {
    if (assignment.workload === 'deterministic') continue;
    const lane = assignment.billingLane ?? 'unknown';
    billingGroups.set(lane, [...(billingGroups.get(lane) ?? []), assignment.stage]);
  }
  const usedLanes = [...billingGroups.entries()].map(([lane, stages]) => ({
    billingLane: lane as BillingLane,
    stages,
  }));
  const billingSummary = [
    ...usedLanes,
    ...ALL_BILLING_LANES.filter((lane) => lane !== 'unknown' && !billingGroups.has(lane)).map(
      (billingLane) => ({ billingLane, stages: [] as string[] }),
    ),
  ];
  const meteredAssignments = providerAssignments.filter(
    (assignment) => assignment.billingLane && isMeteredLane(assignment.billingLane),
  );
  const routingSummary = {
    subscriptions: SUBSCRIPTION_LANES.map((lane) => ({
      billingLane: lane,
      label: billingLaneLabel(lane),
      stages: providerAssignments
        .filter((assignment) => assignment.billingLane === lane)
        .map((assignment) => assignment.stage),
    })),
    metered: [...new Set(meteredAssignments.map((assignment) => assignment.billingLane!))].map((lane) => ({
      billingLane: lane,
      label: billingLaneLabel(lane),
      generativeStages: meteredAssignments
        .filter((item) => item.billingLane === lane && item.workload === 'generative')
        .map((item) => item.stage),
      decisionStages: meteredAssignments
        .filter((item) => item.billingLane === lane && item.workload === 'decision')
        .map((item) => item.stage),
    })),
    meteredNone: meteredAssignments.length === 0,
    runMeteredCapUsd: workflow.meteredBudget.perRunUsd,
    dailyBudgetUsd: budgetSettings.dailyUsd,
    monthlyBudgetUsd: budgetSettings.monthlyUsd,
    unknownCostPolicy: workflow.meteredBudget.unknownCostPolicy,
    // Turing has no automatic API/PAYG fallback path. Metered lanes appear only when explicitly configured.
    paygFallback: 'none' as const,
    externalDecisionDataPolicy: workflow.externalDecisionDataPolicy,
  };
  const providerFallbackStatus = usedLanes.flatMap((item) => {
    const status = providerSideFallbackStatus(item.billingLane);
    if (!status) return [];
    const backend =
      providerAssignments.find((assignment) => assignment.billingLane === item.billingLane)?.backendId ??
      'unknown';
    return [{ backendId: backend, billingLane: item.billingLane, ...status }];
  });
  const contextWarnings = providerAssignments
    .filter((assignment) => assignment.context.estimatedInputTokens > assignment.context.maxEstimatedTokens)
    .map(
      (assignment) =>
        `${assignment.stage}: estimated initial context ~${assignment.context.estimatedInputTokens.toLocaleString()} tokens exceeds the configured limit.`,
    );
  const machineRow = localMachine(db);
  const machine = {
    id: String(machineRow.id),
    name: String(machineRow.name),
    hostname: hostname(),
    os: platform(),
    status: 'online' as const,
    lastSeenAt: new Date().toISOString(),
  };
  const hasRunnableStage = workflow.stages.some((stage) => stage.enabled !== false);
  const contextBudgetBlocked = providerAssignments.some(
    (assignment) =>
      assignment.context.estimatedInputTokens > assignment.context.maxEstimatedTokens &&
      assignment.context.onLimitExceeded !== 'compact',
  );
  return {
    project,
    workflow,
    machine,
    task: input.task,
    profile,
    permissionMode,
    refinePrompt,
    subscriptionOnly: workflow.subscriptionOnly,
    billingMode,
    lockProviders: workflow.lockProviders,
    effectiveRules,
    branchStrategy:
      workflow.isolatedWorktree && project.gitRoot ? ('worktree' as const) : ('current-branch' as const),
    expectedAiStages: providerAssignments.filter(
      (assignment) => assignment.ready && assignment.workload === 'generative',
    ).length,
    canStart:
      Boolean(input.task.trim()) &&
      hasRunnableStage &&
      (!refinePrompt || hasPromptRefinementStage) &&
      providerAssignments.every((assignment) => assignment.ready) &&
      !contextBudgetBlocked &&
      !(workflow.isolatedWorktree && project.gitRoot && project.dirty !== false),
    warnings,
    providerAssignments,
    billingSummary,
    routingSummary,
    providerFallbackStatus,
    contextWarnings,
  };
}

type RunPreviewAssignment = import('../shared/types.js').RunPreview['providerAssignments'][number];

function inheritStageConfiguration(workflow: WorkflowDefinition, stage: WorkflowStage): WorkflowStage {
  if (!AI_KINDS.has(stage.kind)) return { ...stage };
  const defaults = {
    ...(workflow.defaultModelConfiguration ?? {}),
    ...(workflow.stageDefaults?.[stage.kind] ?? {}),
  };
  const inherited = {
    ...defaults,
    ...stage,
  };
  const nodeChangedConnection = Boolean(
    (stage.backendId && defaults.backendId && stage.backendId !== defaults.backendId) ||
    (stage.providerId && defaults.providerId && stage.providerId !== defaults.providerId) ||
    (stage.billingLane && defaults.billingLane && stage.billingLane !== defaults.billingLane),
  );
  return {
    ...stage,
    backendId: inherited.backendId,
    connectionProfileId:
      stage.connectionProfileId ?? (nodeChangedConnection ? undefined : defaults.connectionProfileId),
    providerId: inherited.providerId,
    billingLane: inherited.billingLane,
    modelId: inherited.modelId,
    modelDisplayName: inherited.modelDisplayName,
    variantId: inherited.variantId,
    reasoning: inherited.reasoning,
    nativeSettings: inherited.nativeSettings,
  };
}

function estimateStageContext(
  task: string,
  stage: WorkflowStage,
  rules: import('../shared/types.js').TuringRule[],
  workflowPolicy: WorkflowDefinition['contextPolicy'],
) {
  const policy = { ...workflowPolicy, ...(stage.contextPolicy ?? {}) };
  const reviewKinds = ['reviewer', 'parallelReview', 'finalGate', 'consolidate'];
  const includeCurrentDiff =
    stage.contextPolicy?.includeCurrentDiff ??
    (reviewKinds.includes(stage.kind) && workflowPolicy.includeCurrentDiff);
  const includePreviousTranscript =
    stage.contextPolicy?.includePreviousTranscript ?? workflowPolicy.includePreviousTranscript;
  const applicableRules = rules.filter(
    (rule) => !rule.appliesTo.length || rule.appliesTo.includes(stage.kind),
  );
  const instructions = stage.customInstructions?.length ?? 0;
  const ruleChars = applicableRules.reduce(
    (total, rule) => total + rule.content.length + rule.name.length + 80,
    0,
  );
  const transcriptAllowance = includePreviousTranscript ? 16_000 : 0;
  const estimatedInputTokens = Math.ceil(
    (task.length +
      instructions +
      ruleChars +
      (includeCurrentDiff ? 2_000 : 0) +
      transcriptAllowance +
      1_600) /
      4,
  );
  const label =
    policy.strategy === 'changed-files'
      ? 'Changed Files + Selected Artifacts'
      : policy.strategy === 'artifacts-only'
        ? 'Structured Artifacts + Explicit Files'
        : policy.strategy === 'full-project'
          ? 'Broad Project Context'
          : 'Focused Context';
  return {
    label,
    estimatedInputTokens,
    maxEstimatedTokens: policy.maxEstimatedTokens,
    maxFiles: policy.maxFiles,
    maxFileBytes: policy.maxFileBytes,
    onLimitExceeded: policy.onLimitExceeded,
    estimateOnly: true as const,
  };
}

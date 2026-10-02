import { randomUUID } from 'node:crypto';
import type { BillingLane, UsageProvenance, UsageReconciliationState, WorkloadType } from '../shared/types.js';
import type { Db } from './db.js';

/**
 * Canonical usage events. One external inference/decision call is exactly one row, created before
 * the call (PENDING, with any local estimate) and updated in place as better telemetry arrives.
 * Headline columns always carry the highest-precedence observation; every observation is kept in
 * observations_json for audit. Nothing here ever inserts a second billable row for the same call.
 */

export const PROVENANCE_RANK: Record<UsageProvenance, number> = {
  provider_measured: 5,
  locally_measured: 4,
  user_configured: 3,
  estimated: 2,
  unavailable: 1,
};

export function normalizeProvenance(value: string | null | undefined): UsageProvenance {
  if (value === 'provider_reported' || value === 'provider_measured') return 'provider_measured';
  if (value === 'locally_measured' || value === 'user_configured' || value === 'estimated') return value;
  return 'unavailable';
}

export interface UsageEventInit {
  requestId?: string;
  runId: string | null;
  stageId: string | null;
  projectId?: string | null;
  workflowId?: string | null;
  machineId?: string | null;
  role: string | null;
  workloadType: WorkloadType;
  backend: string | null;
  connectionProfileId: string | null;
  billingLane: BillingLane | null;
  providerId: string | null;
  modelId: string | null;
  modelDisplayName?: string | null;
  variantId: string | null;
  reasoning?: string | null;
  contextStrategy?: string | null;
  decisionEngine?: string | null;
  decisionType?: string | null;
  batchId?: string | null;
  estimatedInputTokens?: number | null;
  estimatedOutputTokens?: number | null;
  estimatedCostUsd?: number | null;
  occurredAt?: string;
}

export interface UsageObservation {
  source: string;
  provenance: UsageProvenance;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  actualCostUsd?: number | null;
  costProvenance?: UsageProvenance;
  providerRequestId?: string | null;
  upstreamProvider?: string | null;
  resolvedModelId?: string | null;
  finishReason?: string | null;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'pending';
  durationMs?: number;
  latencyMs?: number | null;
  decisionOutcome?: string | null;
  observedAt?: string;
}

/** Create the canonical event. Runs/projects/workflows/machine are filled from the run when present. */
export function createUsageEvent(db: Db, init: UsageEventInit): string {
  const id = randomUUID();
  const run = init.runId
    ? (db.prepare('SELECT project_id, workflow_id, machine_id FROM runs WHERE id = ?').get(init.runId) as
        | { project_id: string; workflow_id: string; machine_id: string }
        | undefined)
    : undefined;
  const occurredAt = init.occurredAt ?? new Date().toISOString();
  const hasEstimate = init.estimatedInputTokens != null || init.estimatedOutputTokens != null || init.estimatedCostUsd != null;
  const estimateObservation = hasEstimate
    ? [{ source: 'turing-preflight-estimate', provenance: 'estimated', inputTokens: init.estimatedInputTokens ?? null, outputTokens: init.estimatedOutputTokens ?? null, actualCostUsd: null, estimatedCostUsd: init.estimatedCostUsd ?? null, observedAt: occurredAt }]
    : [];
  db.prepare(
    `INSERT INTO usage_events (id, request_id, occurred_at, provider_id, model_id, backend, project_id, run_id, stage_id, role,
      input_tokens, output_tokens, duration_ms, request_count, provenance, equivalent_cost_usd, connection_profile_id, billing_lane, variant_id,
      machine_id, workflow_id, workload_type, model_display_name, reasoning, context_strategy, decision_engine, decision_type, batch_id,
      status, actual_cost_provenance, reconciliation_state, estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
      observations_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unavailable', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    init.requestId ?? randomUUID(),
    occurredAt,
    init.providerId,
    init.modelId,
    init.backend,
    init.projectId ?? run?.project_id ?? null,
    init.runId,
    init.stageId,
    init.role,
    hasEstimate ? (init.estimatedInputTokens ?? null) : null,
    hasEstimate ? (init.estimatedOutputTokens ?? null) : null,
    hasEstimate ? 'estimated' : 'unavailable',
    init.connectionProfileId,
    init.billingLane,
    init.variantId,
    init.machineId ?? run?.machine_id ?? localMachineId(db),
    init.workflowId ?? run?.workflow_id ?? null,
    init.workloadType,
    init.modelDisplayName ?? null,
    init.reasoning ?? null,
    init.contextStrategy ?? null,
    init.decisionEngine ?? null,
    init.decisionType ?? null,
    init.batchId ?? null,
    hasEstimate ? 'locally_estimated' : 'pending',
    init.estimatedInputTokens ?? null,
    init.estimatedOutputTokens ?? null,
    init.estimatedCostUsd ?? null,
    JSON.stringify(estimateObservation),
    occurredAt,
  );
  return id;
}

function localMachineId(db: Db): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

interface StoredRow {
  provenance: string;
  actual_cost_provenance: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  actual_cost_usd: number | null;
  observations_json: string;
  status: string;
}

/**
 * Apply an observation to the canonical row. A more authoritative (or equal) observation replaces
 * the headline token/cost dimensions it reports; a weaker one is only appended to the audit trail.
 */
export function reconcileUsageEvent(db: Db, eventId: string, observation: UsageObservation): void {
  const apply = db.transaction(() => {
    const row = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(eventId) as StoredRow | undefined;
    if (!row) throw new Error('Usage event was not found.');
    const observedAt = observation.observedAt ?? new Date().toISOString();
    const currentTokenRank = PROVENANCE_RANK[normalizeProvenance(row.provenance)];
    const incomingRank = PROVENANCE_RANK[observation.provenance];
    const tokenUpdate = incomingRank >= currentTokenRank;
    const pick = <K extends keyof UsageObservation>(key: K, current: number | null) =>
      tokenUpdate && observation[key] !== undefined ? (observation[key] as number | null) : current;
    const inputTokens = pick('inputTokens', row.input_tokens);
    const outputTokens = pick('outputTokens', row.output_tokens);
    const cachedInputTokens = pick('cachedInputTokens', row.cached_input_tokens);
    const cacheWriteTokens = pick('cacheWriteTokens', row.cache_write_tokens);
    const reasoningTokens = pick('reasoningTokens', row.reasoning_tokens);
    const reportedTotal = pick('totalTokens', row.total_tokens);
    const totalTokens =
      tokenUpdate && observation.totalTokens != null
        ? observation.totalTokens
        : inputTokens !== null && outputTokens !== null
          ? inputTokens + outputTokens
          : reportedTotal;
    const tokenProvenance = tokenUpdate && hasTokenData(observation) ? observation.provenance : normalizeProvenance(row.provenance);
    const costProvenance = observation.costProvenance ?? observation.provenance;
    const costUpdate =
      observation.actualCostUsd !== undefined &&
      PROVENANCE_RANK[costProvenance] >= PROVENANCE_RANK[normalizeProvenance(row.actual_cost_provenance)];
    const actualCost = costUpdate ? (observation.actualCostUsd ?? null) : row.actual_cost_usd;
    const actualCostProvenance = costUpdate && observation.actualCostUsd != null ? costProvenance : normalizeProvenance(row.actual_cost_provenance);
    const audit = parseObservations(row.observations_json);
    audit.push({
      source: observation.source,
      provenance: observation.provenance,
      inputTokens: observation.inputTokens ?? null,
      cachedInputTokens: observation.cachedInputTokens ?? null,
      cacheWriteTokens: observation.cacheWriteTokens ?? null,
      reasoningTokens: observation.reasoningTokens ?? null,
      outputTokens: observation.outputTokens ?? null,
      actualCostUsd: observation.actualCostUsd ?? null,
      observedAt,
    });
    const state: UsageReconciliationState =
      tokenProvenance === 'provider_measured' || actualCostProvenance === 'provider_measured'
        ? 'provider_reconciled'
        : tokenProvenance === 'estimated'
          ? 'locally_estimated'
          : 'final';
    db.prepare(
      `UPDATE usage_events SET input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?,
        total_tokens = ?, provenance = ?, actual_cost_usd = ?, actual_cost_provenance = ?, reconciliation_state = ?,
        provider_request_id = COALESCE(?, provider_request_id), upstream_provider = COALESCE(?, upstream_provider),
        resolved_model_id = COALESCE(?, resolved_model_id), finish_reason = COALESCE(?, finish_reason),
        status = COALESCE(?, status), duration_ms = COALESCE(?, duration_ms), latency_ms = COALESCE(?, latency_ms),
        decision_outcome = COALESCE(?, decision_outcome), observations_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
      tokenProvenance,
      actualCost,
      actualCostProvenance,
      state,
      observation.providerRequestId ?? null,
      observation.upstreamProvider ?? null,
      observation.resolvedModelId ?? null,
      observation.finishReason ?? null,
      observation.status ?? null,
      observation.durationMs ?? null,
      observation.latencyMs ?? null,
      observation.decisionOutcome ?? null,
      JSON.stringify(audit.slice(-20)),
      observedAt,
      eventId,
    );
  });
  apply();
}

function hasTokenData(observation: UsageObservation): boolean {
  return [observation.inputTokens, observation.outputTokens, observation.cachedInputTokens, observation.reasoningTokens, observation.totalTokens].some(
    (value) => typeof value === 'number',
  );
}

function parseObservations(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/** Convenience for local (non-metered) process calls that have one final observation. */
export function recordCompletedUsage(db: Db, init: UsageEventInit, observation: UsageObservation): string {
  const id = createUsageEvent(db, init);
  reconcileUsageEvent(db, id, observation);
  return id;
}

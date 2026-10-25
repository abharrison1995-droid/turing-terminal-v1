import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ModelOption,
  ModelOpportunityObservation,
  ModelPricingEvidence,
  ProviderStatus,
} from '../shared/types.js';
import {
  buildModelPricingEvidence,
  classifyOpportunityCost,
  modelPricingEvidenceSchema,
} from '../shared/opportunityCost.js';
import { canonicalJson } from './goals/definitionHash.js';
import type { Db } from './db.js';

export const MODEL_OBSERVATION_PAYLOAD_MAX_BYTES = 8_192;
export const MODEL_OBSERVATION_RETENTION_DAYS = 90;
const MAX_RETENTION_DELETE = 5_000;

const timeSchema = z.string().datetime();
const idSchema = z.string().uuid();
const payloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  claimKind: z.enum(['provider-advertised', 'locally-discovered']),
  sourceClass: z.enum(['live', 'cache', 'adapter']),
  refreshOutcome: z.enum(['success', 'empty', 'failed']),
  backendId: z.string().min(1).max(80),
  providerId: z.string().min(1).max(80),
  modelId: z.string().min(1).max(180),
  displayName: z.string().min(1).max(180),
  adapterVersion: z.string().max(120).nullable(),
  observedAt: timeSchema,
  cacheObservedAt: timeSchema.nullable(),
  capabilityFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  pricingEvidence: modelPricingEvidenceSchema,
});

export type ModelObservationPayload = z.infer<typeof payloadSchema>;
export type ObservationClaimKind = ModelObservationPayload['claimKind'];
export type ObservationSourceClass = ModelObservationPayload['sourceClass'];
export type ObservationRefreshOutcome = ModelObservationPayload['refreshOutcome'];

export interface ModelObservationInput {
  id: string;
  backendId: string;
  providerId: string;
  modelId: string;
  claimKind: ObservationClaimKind;
  sourceClass: ObservationSourceClass;
  refreshOutcome: ObservationRefreshOutcome;
  payload: ModelObservationPayload;
  observedAt: string;
}

export interface ModelObservationRefreshInput {
  id: string;
  backendId: string;
  providerId: string;
  sourceClass: 'live' | 'cache' | 'adapter' | 'none';
  outcome: ObservationRefreshOutcome;
  startedAt: string;
  checkedAt: string;
  finishedAt: string;
  errorCode: 'catalog_unavailable' | 'catalog_empty' | 'provider_not_configured' | null;
  cacheObservedAt: string | null;
  observations: ModelObservationInput[];
}

export class ModelObservationError extends Error {
  constructor(
    readonly code: 'observation_payload_invalid' | 'observation_payload_oversize' | 'observation_collision',
  ) {
    super(code);
    this.name = 'ModelObservationError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function capabilityFingerprint(model: ModelOption): string | null {
  if (!model.capabilities || typeof model.capabilities !== 'object') return null;
  return digest(model.capabilities);
}

function pricingEvidence(model: ModelOption): ModelPricingEvidence {
  const current = model.pricing?.pricingEvidence;
  if (current && modelPricingEvidenceSchema.safeParse(current).success) return current;
  if (!model.pricing) return buildModelPricingEvidence({});
  const base = {
    ...(model.pricing.promptUsdPerToken !== null ? { prompt: model.pricing.promptUsdPerToken } : {}),
    ...(model.pricing.completionUsdPerToken !== null
      ? { completion: model.pricing.completionUsdPerToken }
      : {}),
    ...(model.pricing.requestUsd !== null ? { request: model.pricing.requestUsd } : {}),
    ...(model.pricing.cacheReadUsdPerToken !== null ? { cacheRead: model.pricing.cacheReadUsdPerToken } : {}),
  };
  const legacyMaximums = {
    ...(model.pricing.maxPromptUsdPerToken !== null ? { prompt: model.pricing.maxPromptUsdPerToken } : {}),
    ...(model.pricing.maxCompletionUsdPerToken !== null
      ? { completion: model.pricing.maxCompletionUsdPerToken }
      : {}),
  };
  return buildModelPricingEvidence(base, Object.keys(legacyMaximums).length ? [legacyMaximums] : undefined);
}

function observationClass(provider: ProviderStatus, model: ModelOption): ObservationSourceClass | null {
  if (!model.discoveredAt) return null; // excludes static placeholders such as Jev fallback metadata
  if (model.status === 'last-known') return 'cache';
  if (provider.id === 'openrouter' && provider.catalogSource === 'cache') return 'cache';
  if (provider.id === 'openrouter' && provider.catalogSource === 'live') return 'live';
  if (
    provider.catalogSource === 'adapter' ||
    provider.catalogSource === 'live' ||
    provider.catalogSource === 'cache'
  )
    return 'adapter';
  return null;
}

function refreshOutcome(
  provider: ProviderStatus,
  sourceClass: ModelObservationRefreshInput['sourceClass'],
  observationCount: number,
): { outcome: ObservationRefreshOutcome; errorCode: ModelObservationRefreshInput['errorCode'] } {
  if (provider.catalogOutcome === 'failed') return { outcome: 'failed', errorCode: 'catalog_unavailable' };
  if (provider.catalogOutcome === 'empty')
    return {
      outcome: 'empty',
      errorCode:
        provider.id === 'openrouter' && !provider.detected ? 'provider_not_configured' : 'catalog_empty',
    };
  if (sourceClass === 'live' || sourceClass === 'adapter')
    return observationCount > 0
      ? { outcome: 'success', errorCode: null }
      : { outcome: 'empty', errorCode: 'catalog_empty' };
  if (sourceClass === 'cache') return { outcome: 'failed', errorCode: 'catalog_unavailable' };
  if (provider.id === 'openrouter' && !provider.detected)
    return { outcome: 'empty', errorCode: 'provider_not_configured' };
  return provider.detected
    ? { outcome: 'empty', errorCode: 'catalog_empty' }
    : { outcome: 'failed', errorCode: 'catalog_unavailable' };
}

/** Convert one explicit provider refresh response into per-provider, per-model provenance records. */
export function modelObservationRefreshesFromProviders(
  providers: ProviderStatus[],
  startedAt = new Date().toISOString(),
): ModelObservationRefreshInput[] {
  return providers.flatMap((provider) => {
    const checkedAt = provider.checkedAt;
    const sourceClass: ModelObservationRefreshInput['sourceClass'] =
      provider.catalogSource === 'live'
        ? provider.id === 'openrouter'
          ? 'live'
          : 'adapter'
        : provider.catalogSource === 'cache'
          ? 'cache'
          : provider.catalogSource === 'adapter'
            ? 'adapter'
            : 'none';
    const grouped = new Map<string, ModelObservationInput[]>();
    for (const model of provider.models) {
      const modelSource = observationClass(provider, model);
      if (!modelSource) continue;
      const observedAt = modelSource === 'cache' && model.discoveredAt ? model.discoveredAt : checkedAt;
      const parentOutcome = refreshOutcome(provider, sourceClass, provider.models.length).outcome;
      const payload: ModelObservationPayload = {
        schemaVersion: 1,
        claimKind: provider.id === 'openrouter' ? 'provider-advertised' : 'locally-discovered',
        sourceClass: modelSource,
        refreshOutcome: parentOutcome,
        backendId: provider.id,
        providerId: model.providerId,
        modelId: model.id,
        displayName: model.name,
        adapterVersion: model.adapterVersion ?? provider.version,
        observedAt,
        cacheObservedAt: modelSource === 'cache' ? observedAt : null,
        capabilityFingerprint: capabilityFingerprint(model),
        pricingEvidence: pricingEvidence(model),
      };
      const entry: ModelObservationInput = {
        id: randomUUID(),
        backendId: provider.id,
        providerId: model.providerId,
        modelId: model.id,
        claimKind: payload.claimKind,
        sourceClass: modelSource,
        refreshOutcome: payload.refreshOutcome,
        payload,
        observedAt,
      };
      const group = grouped.get(model.providerId) ?? [];
      group.push(entry);
      grouped.set(model.providerId, group);
    }
    const groups = grouped.size
      ? [...grouped.entries()]
      : [[provider.id, [] as ModelObservationInput[]] as const];
    return groups.map(([providerId, candidates]) => {
      const groupSource: ModelObservationRefreshInput['sourceClass'] = candidates.length
        ? candidates.some((item) => item.sourceClass === 'live')
          ? 'live'
          : candidates.some((item) => item.sourceClass === 'adapter')
            ? 'adapter'
            : 'cache'
        : sourceClass;
      const terminal = refreshOutcome(provider, groupSource, candidates.length);
      return {
        id: randomUUID(),
        backendId: provider.id,
        providerId,
        sourceClass: groupSource,
        outcome: terminal.outcome,
        startedAt,
        checkedAt,
        finishedAt: checkedAt,
        errorCode: terminal.errorCode,
        cacheObservedAt:
          groupSource === 'cache'
            ? (provider.catalogRefreshedAt ??
              candidates
                .map((item) => item.observedAt)
                .sort()
                .at(-1) ??
              null)
            : null,
        observations: candidates,
      };
    });
  });
}

/** Writes one explicit refresh atomically; exact replay is idempotent and changed replay aborts the transaction. */
export function persistModelObservationRefreshes(db: Db, refreshes: ModelObservationRefreshInput[]): void {
  const persist = db.transaction(() => {
    for (const refresh of refreshes) {
      idSchema.parse(refresh.id);
      for (const value of [refresh.startedAt, refresh.checkedAt, refresh.finishedAt]) timeSchema.parse(value);
      if (
        new Date(refresh.startedAt) > new Date(refresh.checkedAt) ||
        new Date(refresh.checkedAt) > new Date(refresh.finishedAt)
      )
        throw new ModelObservationError('observation_payload_invalid');
      const existingRefresh = db
        .prepare('SELECT * FROM model_observation_refreshes WHERE id = ?')
        .get(refresh.id) as Record<string, unknown> | undefined;
      if (existingRefresh) {
        const existing = db
          .prepare(
            'SELECT model_id, payload_digest FROM model_observations WHERE refresh_id = ? ORDER BY model_id',
          )
          .all(refresh.id) as Array<{ model_id: string; payload_digest: string }>;
        const expected = refresh.observations
          .map((item) => ({
            model_id: item.modelId,
            payload_digest: digest(payloadSchema.parse(item.payload)),
          }))
          .sort((a, b) => a.model_id.localeCompare(b.model_id));
        if (
          existingRefresh.backend_id !== refresh.backendId ||
          existingRefresh.provider_id !== refresh.providerId ||
          existingRefresh.source_class !== refresh.sourceClass ||
          existingRefresh.refresh_outcome !== refresh.outcome ||
          existingRefresh.started_at !== refresh.startedAt ||
          existingRefresh.checked_at !== refresh.checkedAt ||
          existingRefresh.finished_at !== refresh.finishedAt ||
          existingRefresh.error_code !== refresh.errorCode ||
          existingRefresh.cache_observed_at !== refresh.cacheObservedAt ||
          canonicalJson(existing) !== canonicalJson(expected)
        )
          throw new ModelObservationError('observation_collision');
        continue;
      }
      db.prepare(
        `INSERT INTO model_observation_refreshes
        (id, backend_id, provider_id, source_class, refresh_outcome, started_at, checked_at, finished_at, error_code, cache_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        refresh.id,
        refresh.backendId,
        refresh.providerId,
        refresh.sourceClass,
        refresh.outcome,
        refresh.startedAt,
        refresh.checkedAt,
        refresh.finishedAt,
        refresh.errorCode,
        refresh.cacheObservedAt,
      );
      for (const observation of refresh.observations) {
        idSchema.parse(observation.id);
        const payload = payloadSchema.safeParse(observation.payload);
        if (!payload.success) throw new ModelObservationError('observation_payload_invalid');
        const payloadJson = canonicalJson(payload.data);
        if (Buffer.byteLength(payloadJson, 'utf8') > MODEL_OBSERVATION_PAYLOAD_MAX_BYTES)
          throw new ModelObservationError('observation_payload_oversize');
        if (
          observation.backendId !== refresh.backendId ||
          observation.claimKind !== payload.data.claimKind ||
          observation.sourceClass !== payload.data.sourceClass ||
          observation.refreshOutcome !== payload.data.refreshOutcome ||
          observation.providerId !== payload.data.providerId ||
          observation.modelId !== payload.data.modelId ||
          observation.observedAt !== payload.data.observedAt
        )
          throw new ModelObservationError('observation_payload_invalid');
        const payloadDigest = digest(payload.data);
        const existingModel = db
          .prepare(
            `SELECT payload_digest FROM model_observations
          WHERE refresh_id = ? AND backend_id = ? AND provider_id = ? AND model_id = ?`,
          )
          .get(refresh.id, observation.backendId, observation.providerId, observation.modelId) as
          { payload_digest: string } | undefined;
        if (existingModel) {
          if (existingModel.payload_digest !== payloadDigest)
            throw new ModelObservationError('observation_collision');
          continue;
        }
        db.prepare(
          `INSERT INTO model_observations
          (id, refresh_id, backend_id, provider_id, model_id, claim_kind, source_class, refresh_outcome,
           payload_json, payload_digest, observed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          observation.id,
          refresh.id,
          observation.backendId,
          observation.providerId,
          observation.modelId,
          observation.claimKind,
          observation.sourceClass,
          observation.refreshOutcome,
          payloadJson,
          payloadDigest,
          observation.observedAt,
          refresh.finishedAt,
        );
      }
    }
  });
  try {
    persist();
  } catch (error) {
    if (error instanceof ModelObservationError) throw error;
    if (String(error).includes('identity already exists'))
      throw new ModelObservationError('observation_collision');
    throw error;
  }
}

export function listModelOpportunityObservations(db: Db, limit = 200): ModelOpportunityObservation[] {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = db
    .prepare(
      `SELECT obs.*, refresh.checked_at, refresh.backend_id AS parent_backend_id,
        refresh.provider_id AS parent_provider_id, refresh.source_class AS parent_source_class,
        refresh.refresh_outcome AS parent_refresh_outcome
    FROM model_observations obs
    JOIN model_observation_refreshes refresh ON refresh.id = obs.refresh_id
    ORDER BY obs.observed_at DESC, obs.created_at DESC LIMIT ?`,
    )
    .all(boundedLimit) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const verified = verifiedObservationFromRow(row);
    const payload = verified?.payload ?? null;
    return {
      id: String(row.id),
      refreshId: String(row.refresh_id),
      backendId: String(row.backend_id),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      claimKind: row.claim_kind as ObservationClaimKind,
      sourceClass: row.source_class as ObservationSourceClass,
      refreshOutcome: row.refresh_outcome as ObservationRefreshOutcome,
      observedAt: String(row.observed_at),
      checkedAt: String(row.checked_at),
      payloadDigest: String(row.payload_digest),
      displayName: payload?.displayName ?? 'Observation integrity could not be verified',
      adapterVersion: payload?.adapterVersion ?? null,
      costClass: payload ? classifyOpportunityPricingEvidence(payload.pricingEvidence) : 'unknown',
      valid: payload !== null,
    };
  });
}

export interface VerifiedModelObservation {
  id: string;
  refreshId: string;
  backendId: string;
  providerId: string;
  modelId: string;
  claimKind: ObservationClaimKind;
  sourceClass: ObservationSourceClass;
  refreshOutcome: ObservationRefreshOutcome;
  observedAt: string;
  checkedAt: string;
  payloadDigest: string;
  payload: ModelObservationPayload;
}

function verifiedObservationFromRow(row: Record<string, unknown>): VerifiedModelObservation | null {
  try {
    const payload = payloadSchema.parse(JSON.parse(String(row.payload_json)));
    if (
      canonicalJson(payload) !== row.payload_json ||
      digest(payload) !== row.payload_digest ||
      row.backend_id !== row.parent_backend_id ||
      row.provider_id !== row.parent_provider_id ||
      payload.backendId !== row.backend_id ||
      payload.providerId !== row.provider_id ||
      payload.modelId !== row.model_id ||
      payload.claimKind !== row.claim_kind ||
      payload.sourceClass !== row.source_class ||
      payload.refreshOutcome !== row.refresh_outcome ||
      payload.observedAt !== row.observed_at ||
      row.source_class !== row.parent_source_class ||
      row.refresh_outcome !== row.parent_refresh_outcome
    )
      return null;
    return {
      id: String(row.id),
      refreshId: String(row.refresh_id),
      backendId: String(row.backend_id),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      claimKind: row.claim_kind as ObservationClaimKind,
      sourceClass: row.source_class as ObservationSourceClass,
      refreshOutcome: row.refresh_outcome as ObservationRefreshOutcome,
      observedAt: String(row.observed_at),
      checkedAt: String(row.checked_at),
      payloadDigest: String(row.payload_digest),
      payload,
    };
  } catch {
    return null;
  }
}

export function readVerifiedModelObservation(db: Db, id: string): VerifiedModelObservation | null {
  const row = db
    .prepare(
      `SELECT obs.*, refresh.checked_at, refresh.backend_id AS parent_backend_id,
      refresh.provider_id AS parent_provider_id, refresh.source_class AS parent_source_class,
      refresh.refresh_outcome AS parent_refresh_outcome
    FROM model_observations obs JOIN model_observation_refreshes refresh ON refresh.id = obs.refresh_id
    WHERE obs.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? verifiedObservationFromRow(row) : null;
}

export function classifyOpportunityPricingEvidence(
  evidence: ModelPricingEvidence,
): 'free' | 'metered' | 'unknown' {
  return classifyOpportunityCost({
    promptUsdPerToken: evidence.base.prompt.value,
    completionUsdPerToken: evidence.base.completion.value,
    requestUsd: evidence.base.request.value,
    cacheReadUsdPerToken: evidence.base.cacheRead.value,
    maxPromptUsdPerToken: evidence.overrides.prompt.maxValidValue,
    maxCompletionUsdPerToken: evidence.overrides.completion.maxValidValue,
    pricingEvidence: evidence,
    source: 'observation',
    observedAt: new Date(0).toISOString(),
  });
}

export interface ModelObservationRetentionResult {
  jobId: string;
  cutoffAt: string;
  deletedObservations: number;
  deletedRefreshes: number;
  deletedAdmissionReferences: number;
  deletedAdmissionProofs: number;
}

/** Explicit, auditable 90-day cleanup. Completed admission proofs live elsewhere and are never changed here. */
export function runModelObservationRetention(db: Db, now = new Date()): ModelObservationRetentionResult {
  const startedAt = now.toISOString();
  const cutoffAt = new Date(now.getTime() - MODEL_OBSERVATION_RETENTION_DAYS * 86_400_000).toISOString();
  const jobId = randomUUID();
  const run = db.transaction((): ModelObservationRetentionResult => {
    db.prepare(
      `INSERT INTO model_observation_retention_jobs (id, cutoff_at, started_at)
      VALUES (?, ?, ?)`,
    ).run(jobId, cutoffAt, startedAt);
    const expiredReferences = db
      .prepare(
        `SELECT ref.admission_id, ref.observation_id
      FROM model_observation_admission_refs ref
      WHERE ref.expires_at <= ? OR EXISTS (
        SELECT 1 FROM goal_definition_versions definition
        WHERE definition.goal_id = ref.goal_id AND definition.version = ref.definition_version
          AND definition.status = 'superseded'
      ) ORDER BY ref.created_at, ref.admission_id, ref.observation_id LIMIT ?`,
      )
      .all(startedAt, MAX_RETENTION_DELETE) as Array<{ admission_id: string; observation_id: string }>;
    const deleteReference = db.prepare(`DELETE FROM model_observation_admission_refs
      WHERE admission_id = ? AND observation_id = ?`);
    for (const reference of expiredReferences)
      deleteReference.run(reference.admission_id, reference.observation_id);
    const supersededProofs = db
      .prepare(
        `SELECT proof.approval_id
      FROM model_opportunity_admission_proofs proof
      JOIN goal_definition_versions definition
        ON definition.goal_id = proof.goal_id AND definition.version = proof.definition_version
      WHERE definition.status = 'superseded'
      ORDER BY proof.accepted_at, proof.approval_id LIMIT ?`,
      )
      .all(MAX_RETENTION_DELETE) as Array<{ approval_id: string }>;
    const deleteProof = db.prepare('DELETE FROM model_opportunity_admission_proofs WHERE approval_id = ?');
    for (const proof of supersededProofs) deleteProof.run(proof.approval_id);
    const oldObservations = db
      .prepare(
        `SELECT obs.id FROM model_observations obs
      WHERE obs.observed_at < ?
        AND NOT EXISTS (SELECT 1 FROM model_observation_admission_refs ref WHERE ref.observation_id = obs.id)
      ORDER BY obs.observed_at LIMIT ?`,
      )
      .all(cutoffAt, MAX_RETENTION_DELETE) as Array<{ id: string }>;
    const deleteObservation = db.prepare('DELETE FROM model_observations WHERE id = ?');
    for (const row of oldObservations) deleteObservation.run(row.id);
    const oldRefreshes = db
      .prepare(
        `SELECT refresh.id FROM model_observation_refreshes refresh
      WHERE refresh.finished_at < ?
        AND NOT EXISTS (SELECT 1 FROM model_observations obs WHERE obs.refresh_id = refresh.id)
      ORDER BY refresh.finished_at LIMIT ?`,
      )
      .all(cutoffAt, MAX_RETENTION_DELETE) as Array<{ id: string }>;
    const deleteRefresh = db.prepare('DELETE FROM model_observation_refreshes WHERE id = ?');
    for (const row of oldRefreshes) deleteRefresh.run(row.id);
    db.prepare(
      `UPDATE model_observation_retention_jobs
      SET finished_at = ?, deleted_observations = ?, deleted_refreshes = ?,
        deleted_admission_refs = ?, deleted_admission_proofs = ? WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      oldObservations.length,
      oldRefreshes.length,
      expiredReferences.length,
      supersededProofs.length,
      jobId,
    );
    return {
      jobId,
      cutoffAt,
      deletedObservations: oldObservations.length,
      deletedRefreshes: oldRefreshes.length,
      deletedAdmissionReferences: expiredReferences.length,
      deletedAdmissionProofs: supersededProofs.length,
    };
  });
  return run();
}

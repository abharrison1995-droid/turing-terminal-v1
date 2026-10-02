import type { BillingLane, BillingMode, UnknownCostPolicy, WorkloadType } from '../shared/types.js';
import { evaluateBillingLane } from '../shared/billing.js';
import type { Db } from './db.js';
import { attachReservationUsage, reconcileReservation, releaseReservation, reserveMetered } from './meteredBudget.js';
import type { MeteringHooks } from './openrouter.js';
import { redactSecrets } from './security.js';
import { createUsageEvent, reconcileUsageEvent } from './usageEvents.js';

/** A billing-policy or budget refusal. It is a deliberate outcome, so it is never retried. */
export class MeteringBlockedError extends Error {}

export interface MeteringOptions {
  /** Run that owns the usage event (null outside a run, e.g. Decision Gate test mode). */
  usageRunId: string | null;
  /** Scope for the per-run cap; may be a synthetic test scope. */
  reservationScopeId: string | null;
  stageId: string | null;
  billingMode: BillingMode;
  customAllowedLanes?: BillingLane[];
  perRunUsd: number | null;
  unknownCostPolicy: UnknownCostPolicy;
  workload: WorkloadType;
  connectionProfileId: string | null;
  role: string;
  modelId: string;
  modelDisplayName: string | null;
  reasoning: string | null;
  contextStrategy: string | null;
  decisionEngine: string | null;
  decisionType: string | null;
  batchId?: string | null;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** Ask policy: ask a person before an unbounded request. Absent = treated as denied. */
  approveUnbounded?: (label: string) => Promise<boolean>;
}

/**
 * Metering for one metered OpenRouter request: billing gate → atomic reservation (with the
 * unknown-cost policy) → canonical usage event; then reconcile to provider-measured cost or release.
 */
export function createMeteringHooks(db: Db, options: MeteringOptions): MeteringHooks {
  const lane: BillingLane = 'openrouter-metered';
  return {
    begin: async (estimate) => {
      const billing = evaluateBillingLane({ mode: options.billingMode, lane, workload: options.workload, customAllowedLanes: options.customAllowedLanes });
      if (!billing.allowed) throw new MeteringBlockedError(billing.reason ?? 'Metered spending is blocked by the run billing mode.');
      const base = {
        runId: options.reservationScopeId,
        stageId: options.stageId,
        billingLane: lane,
        connectionProfileId: options.connectionProfileId,
        workload: options.workload,
        billingMode: options.billingMode,
        amountUsd: estimate.estimateUsd,
        perRunUsd: options.perRunUsd,
        unknownCostPolicy: options.unknownCostPolicy,
        reason: estimate.label,
      };
      let reservation = reserveMetered(db, base);
      if (!reservation.ok && reservation.code === 'unknown_cost_needs_approval') {
        const approved = options.approveUnbounded ? await options.approveUnbounded(estimate.label) : false;
        reservation = approved
          ? reserveMetered(db, { ...base, unboundedApproved: true })
          : { ok: false, code: 'unknown_cost_blocked', reason: 'The unbounded metered request was not approved.' };
      }
      if (!reservation.ok) {
        options.onEvent?.('metered_request_blocked', { stageId: options.stageId, code: reservation.code, reason: reservation.reason });
        throw new MeteringBlockedError(reservation.reason);
      }
      for (const warning of reservation.warnings) options.onEvent?.('metered_budget_warning', { stageId: options.stageId, warning });
      const usageEventId = createUsageEvent(db, {
        runId: options.usageRunId,
        stageId: options.stageId,
        role: options.role,
        workloadType: options.workload,
        backend: 'openrouter',
        connectionProfileId: options.connectionProfileId,
        billingLane: lane,
        providerId: 'openrouter',
        modelId: options.modelId,
        modelDisplayName: options.modelDisplayName,
        variantId: null,
        reasoning: options.reasoning,
        contextStrategy: options.contextStrategy,
        decisionEngine: options.decisionEngine,
        decisionType: options.decisionType,
        batchId: options.batchId ?? null,
        estimatedInputTokens: estimate.estimatedInputTokens,
        estimatedOutputTokens: estimate.estimatedOutputTokens,
        estimatedCostUsd: estimate.estimateUsd,
      });
      attachReservationUsage(db, reservation.reservationId, usageEventId);
      return { usageEventId, reservationId: reservation.reservationId };
    },
    complete: (handle, observation) => {
      reconcileUsageEvent(db, handle.usageEventId, observation);
      if (!handle.reservationId) return;
      // Without a provider-reported charge the reservation stays committed in full (conservative).
      const { overrunUsd } =
        observation.actualCostUsd != null
          ? reconcileReservation(db, handle.reservationId, observation.actualCostUsd, 'provider_measured')
          : reconcileReservation(db, handle.reservationId, null, 'estimated');
      if (overrunUsd > 0) options.onEvent?.('metered_reservation_overrun', { stageId: options.stageId, overrunUsd });
    },
    fail: (handle, message, observation) => {
      reconcileUsageEvent(db, handle.usageEventId, { source: 'openrouter-error', provenance: 'unavailable', ...observation, status: 'failed' });
      if (!handle.reservationId) return;
      if (observation?.actualCostUsd != null) reconcileReservation(db, handle.reservationId, observation.actualCostUsd, 'provider_measured');
      else releaseReservation(db, handle.reservationId, redactSecrets(message).slice(0, 120));
    },
  };
}

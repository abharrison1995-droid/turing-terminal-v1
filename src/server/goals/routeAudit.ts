import { z } from 'zod';
import { GOAL_ROLES, type GoalRole } from '../../shared/goals.js';
import type { ModelConfiguration } from '../../shared/types.js';
import type { IndependenceResult } from './independence.js';
import type { ProfileValidationState } from './routeValidation.js';
import type { EffectiveIdentityKind } from './routeIdentity.js';

/**
 * The bounded, credential-free audit of one role's route resolution (design section 12). It is what is persisted in
 * `goal_cycles.route_resolution_json`; every field is a finite code, an id, a hash or a short declared value, never a
 * provider catalog, note or output.
 */

export type MemberReason =
  | 'route_incomplete'
  | 'provider_missing'
  | 'provider_not_detected'
  | 'provider_execution_unsupported'
  | 'provider_disconnected'
  | 'subscription_auth_unverified'
  | 'billing_lane_mismatch'
  | 'profile_missing'
  | 'profile_mismatch'
  | 'profile_not_ready'
  | 'billing_lane_blocked'
  | 'pool_lane_blocked'
  | 'catalog_not_authoritative'
  | 'model_not_found'
  | 'model_not_current'
  | 'validation_missing'
  | 'validation_failed'
  | 'validation_expired'
  | 'validation_identity_changed'
  | 'first_use_required'
  | 'first_use_pending'
  | 'first_use_denied'
  | 'floating_independence'
  | 'independence_conflict';

export type FirstUseState = 'not_required' | 'required' | 'pending' | 'approved' | 'denied';

export type RouteConfigurationAudit = Pick<
  ModelConfiguration,
  | 'backendId'
  | 'providerId'
  | 'billingLane'
  | 'modelId'
  | 'connectionProfileId'
  | 'variantId'
  | 'reasoning'
  | 'nativeSettings'
>;

export interface MemberEvaluation {
  memberIndex: number;
  identityHash: string | null;
  memberConfigHash: string;
  configuration: RouteConfigurationAudit;
  identityKind: EffectiveIdentityKind;
  /** Passes every check except an outstanding first-use approval. */
  technicallyEligible: boolean;
  /** Usable for execution now: technically eligible and first use cleared. */
  eligible: boolean;
  readiness: { ok: boolean };
  billing: { ok: boolean };
  liveCatalog: { available: boolean; catalogSource: string | null; modelStatus: string | null };
  validation: { available: boolean; profiles: ProfileValidationState[] };
  firstUse: { state: FirstUseState; approvalId: string | null };
  independence: { reasonCode: string; conflict: boolean } | null;
  reasons: MemberReason[];
}

export type RouteSelection = 'pinned' | 'ordered' | 'round_robin';

export interface RoleResolution {
  schema: 1;
  definitionVersion: number;
  definitionHash: string;
  role: GoalRole;
  routeKind: 'pinned' | 'pool';
  poolId: string | null;
  selection: RouteSelection;
  selectedIndex: number;
  selected: {
    configuration: RouteConfigurationAudit;
    identityHash: string;
    memberConfigHash: string;
    identityKind: EffectiveIdentityKind;
  };
  evaluatedMembers: MemberEvaluation[];
  /** Validation records the selected member's eligibility relied on. */
  validationRecordIds: string[];
  catalog: {
    backendId: string;
    source: string | null;
    refreshedAt: string | null;
    modelStatus: string | null;
  };
  approval: {
    state: 'not_required' | 'approved';
    approvalId: string | null;
    poolId: string | null;
    memberIdentityHash: string | null;
  };
  independence: IndependenceResult | null;
}

export type RefusalCode =
  | 'route_unavailable'
  | 'approval_required'
  | 'approval_pending'
  | 'independence_unestablished'
  | 'route_not_defined'
  | 'persisted_resolution_invalid';

export interface RoleRefusal {
  status: 'refused';
  role: GoalRole;
  code: RefusalCode;
  definitionVersion: number;
  definitionHash: string;
  routeKind: 'pinned' | 'pool' | null;
  poolId: string | null;
  evaluatedMembers: MemberEvaluation[];
  /** The deterministic member that would be selected, for `approval_required` / `approval_pending`. */
  candidate?: {
    poolId: string;
    memberIdentityHash: string;
    memberIndex: number;
    configuration: RouteConfigurationAudit;
    approvalId: string | null;
  };
  independence?: IndependenceResult | null;
}

export type RoleOutcome =
  { status: 'resolved'; source: 'computed' | 'persisted'; resolution: RoleResolution } | RoleRefusal;

export interface RoutingResult {
  /** True only when every requested role resolved. */
  ok: boolean;
  roles: Partial<Record<GoalRole, RoleOutcome>>;
}

// --- Structural validation of stored audits ------------------------------------------------------------------------

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const kind = z.enum(['pinned', 'floating', 'unknown']);
const configuration = z
  .object({
    backendId: z.string().optional(),
    providerId: z.string().optional(),
    billingLane: z.string().optional(),
    modelId: z.string().optional(),
    connectionProfileId: z.string().optional(),
    variantId: z.string().optional(),
    reasoning: z.string().optional(),
    nativeSettings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

const storedResolution = z
  .object({
    schema: z.literal(1),
    definitionVersion: z.number().int().positive(),
    definitionHash: hex64,
    role: z.enum(GOAL_ROLES as [GoalRole, ...GoalRole[]]),
    routeKind: z.enum(['pinned', 'pool']),
    poolId: z.string().nullable(),
    selection: z.enum(['pinned', 'ordered', 'round_robin']),
    selectedIndex: z.number().int().min(0),
    selected: z
      .object({ configuration, identityHash: hex64, memberConfigHash: hex64, identityKind: kind })
      .strict(),
    evaluatedMembers: z.array(z.unknown()),
    validationRecordIds: z.array(z.string()),
    catalog: z.object({}).passthrough(),
    approval: z.object({}).passthrough(),
    independence: z.object({}).passthrough().nullable(),
  })
  .strict();

/** Returns the audit when it is structurally trustworthy, else null. A malformed record establishes nothing. */
export function parseRoleResolution(value: unknown): RoleResolution | null {
  const parsed = storedResolution.safeParse(value);
  return parsed.success ? (parsed.data as unknown as RoleResolution) : null;
}

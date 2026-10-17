import { z } from 'zod';
import {
  GOAL_ROLES,
  VALIDATION_PROFILES,
  type GoalRole,
  type ValidationProfile,
} from '../../shared/goals.js';
import type { ModelConfiguration } from '../../shared/types.js';
import { INDEPENDENCE_REASONS, type IndependenceReason, type IndependenceResult } from './independence.js';
import type { ProfileValidationState } from './routeValidation.js';
import type { EffectiveIdentityKind } from './routeIdentity.js';

/**
 * The bounded, credential-free audit of one role's route resolution (design section 12). It is what is persisted in
 * `goal_cycles.route_resolution_json`; every field is a finite code, an id, a hash or a short declared value, never a
 * provider catalog, note or output.
 */

export const MEMBER_REASONS = [
  'route_incomplete',
  'provider_missing',
  'provider_not_detected',
  'provider_execution_unsupported',
  'provider_disconnected',
  'subscription_auth_unverified',
  'billing_lane_mismatch',
  'profile_missing',
  'profile_mismatch',
  'profile_not_ready',
  'billing_lane_blocked',
  'pool_lane_blocked',
  'catalog_not_authoritative',
  'model_not_found',
  'model_not_current',
  'validation_missing',
  'validation_failed',
  'validation_expired',
  'validation_identity_changed',
  'first_use_required',
  'first_use_pending',
  'first_use_denied',
  'floating_independence',
  'independence_conflict',
  'independence_unestablished',
] as const;
export type MemberReason = (typeof MEMBER_REASONS)[number];

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
  /**
   * Final-review independence of this candidate. `uncertainAllowed` marks the one explicit exception: a floating or
   * unknown candidate the definition authorised through `allowFloatingFinalReviewer`.
   */
  independence: {
    reasonCode: IndependenceReason;
    conflict: boolean;
    established: boolean;
    uncertainAllowed: boolean;
  } | null;
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
//
// Persisted audit is route authority, so every part has a bounded schema of finite codes, ids, hashes and short
// declared values. Nothing here can carry provider output, credentials or free text.

/**
 * Total persisted audit size for one cycle. If a resolution cannot fit it is refused, never trimmed. This single cap is
 * the effective bound on everything below: the Goal-definition validator imposes no smaller limit on route strings,
 * `nativeSettings`, pool size or the authority set, so no per-field schema bound may be tighter than the cap itself
 * (a definition the validator accepted must never be rejected by this strict schema for an undocumented smaller limit).
 */
export const MAX_ROUTE_RESOLUTION_JSON = 64_000;
const AUDIT_BOUND = MAX_ROUTE_RESOLUTION_JSON;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const idText = z.string().min(1).max(AUDIT_BOUND);
const iso = z.string().min(1).max(40);
const kind = z.enum(['pinned', 'floating', 'unknown']);
const settingsValue = z.union([z.string().max(AUDIT_BOUND), z.number(), z.boolean(), z.null()]);
const configuration = z
  .object({
    backendId: idText.optional(),
    providerId: idText.optional(),
    billingLane: idText.optional(),
    modelId: idText.optional(),
    connectionProfileId: idText.optional(),
    variantId: idText.optional(),
    reasoning: idText.optional(),
    nativeSettings: z.record(z.string().max(AUDIT_BOUND), settingsValue).optional(),
  })
  .strict();
const catalogSource = z.enum(['live', 'cache', 'adapter', 'none']);
const modelStatus = z.enum(['current', 'last-known', 'unavailable', 'deprecated']);
const firstUseState = z.enum(['not_required', 'required', 'pending', 'approved', 'denied']);

const profileState = z
  .object({
    profile: z.enum(VALIDATION_PROFILES as unknown as [ValidationProfile, ...ValidationProfile[]]),
    state: z.enum([
      'pass',
      'validation_missing',
      'validation_failed',
      'validation_expired',
      'validation_identity_changed',
    ]),
    recordId: idText.nullable(),
    testedAt: iso.nullable(),
    effectiveExpiresAt: iso.nullable(),
  })
  .strict();

const subject = z
  .object({
    configuredKey: idText.nullable(),
    resolvedKey: idText.nullable(),
    familyKey: idText.nullable(),
    identityKind: kind,
  })
  .strict();

const independenceResult = z
  .object({
    established: z.boolean(),
    required: z.boolean(),
    policy: z.enum(['none', 'different-model', 'different-family']),
    candidate: subject,
    comparedAgainst: z
      .array(subject.extend({ role: z.enum(['orchestrator', 'implementer', 'remediation']) }).strict())
      .max(AUDIT_BOUND),
    reasonCode: z.enum(INDEPENDENCE_REASONS),
    conflict: z.boolean(),
  })
  .strict();

const memberEvaluation = z
  .object({
    memberIndex: z.number().int().min(0).max(AUDIT_BOUND),
    identityHash: hex64.nullable(),
    memberConfigHash: hex64,
    configuration,
    identityKind: kind,
    technicallyEligible: z.boolean(),
    eligible: z.boolean(),
    readiness: z.object({ ok: z.boolean() }).strict(),
    billing: z.object({ ok: z.boolean() }).strict(),
    liveCatalog: z
      .object({
        available: z.boolean(),
        catalogSource: catalogSource.nullable(),
        modelStatus: modelStatus.nullable(),
      })
      .strict(),
    validation: z.object({ available: z.boolean(), profiles: z.array(profileState).max(8) }).strict(),
    firstUse: z.object({ state: firstUseState, approvalId: idText.nullable() }).strict(),
    independence: z
      .object({
        reasonCode: z.enum(INDEPENDENCE_REASONS),
        conflict: z.boolean(),
        established: z.boolean(),
        uncertainAllowed: z.boolean(),
      })
      .strict()
      .nullable(),
    reasons: z.array(z.enum(MEMBER_REASONS)).max(32),
  })
  .strict();

const storedResolution = z
  .object({
    schema: z.literal(1),
    definitionVersion: z.number().int().positive(),
    definitionHash: hex64,
    role: z.enum(GOAL_ROLES as [GoalRole, ...GoalRole[]]),
    routeKind: z.enum(['pinned', 'pool']),
    poolId: idText.nullable(),
    selection: z.enum(['pinned', 'ordered', 'round_robin']),
    selectedIndex: z.number().int().min(0).max(AUDIT_BOUND),
    selected: z
      .object({ configuration, identityHash: hex64, memberConfigHash: hex64, identityKind: kind })
      .strict(),
    evaluatedMembers: z.array(memberEvaluation).min(1).max(AUDIT_BOUND),
    validationRecordIds: z.array(idText).max(8),
    catalog: z
      .object({
        backendId: z.string().max(AUDIT_BOUND),
        source: catalogSource.nullable(),
        refreshedAt: iso.nullable(),
        modelStatus: modelStatus.nullable(),
      })
      .strict(),
    approval: z
      .object({
        state: z.enum(['not_required', 'approved']),
        approvalId: idText.nullable(),
        poolId: idText.nullable(),
        memberIdentityHash: hex64.nullable(),
      })
      .strict(),
    independence: independenceResult.nullable(),
  })
  .strict();

/** Returns the audit when it is structurally trustworthy, else null. A malformed record establishes nothing. */
export function parseRoleResolution(value: unknown): RoleResolution | null {
  const parsed = storedResolution.safeParse(value);
  return parsed.success ? (parsed.data as unknown as RoleResolution) : null;
}

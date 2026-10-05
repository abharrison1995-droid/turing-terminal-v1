import {
  GOAL_ROLES,
  type GoalApproval,
  type GoalLimits,
  type GoalRole,
  type GoalRoutingPolicy,
  type RouteAvailability,
  type RouteMember,
  type RoutePool,
  type RouteValidationRecord,
} from '../../shared/goals.js';
import { evaluateBillingLane, isSubscriptionLane, routeMatchesBillingLane } from '../../shared/billing.js';
import type { BillingLane, BillingMode } from '../../shared/types.js';
import { evaluateIndependence, type AuthorityModel, type IndependenceResult } from './independence.js';
import type {
  FirstUseState,
  MemberEvaluation,
  MemberReason,
  RefusalCode,
  RoleOutcome,
  RoleRefusal,
  RoleResolution,
  RouteConfigurationAudit,
  RouteSelection,
  RoutingResult,
} from './routeAudit.js';
import {
  computeRouteIdentity,
  memberConfigHashOf,
  type ProfileObservation,
  type RouteIdentity,
} from './routeIdentity.js';
import { freshValidationSet } from './routeValidation.js';
import type { ProviderStatus } from '../../shared/types.js';

/**
 * Deterministic routing authority (design sections 12 and 13). `resolveRoutes` is a pure function of its inputs:
 * no SQLite, no network, no clock but `environment.now`, no provider discovery, no approval request, no validation.
 * Given an approved definition and an immutable snapshot it either names the exact eligible route for each role or
 * refuses with an auditable reason. It never substitutes a model, lane, provider or pool member on its own.
 */

/** A previously recorded role resolution for the same Goal; the sole source of round-robin position. */
export interface PriorRouteResolution {
  cycleSequence: number;
  role: GoalRole;
  poolId: string | null;
  selectedIdentityHash: string;
  /** Environment-independent hash of the selected declared member, to locate its slot after a version bump. */
  memberConfigHash: string | null;
}

/** Everything the decision may depend on. No credentials, keys or tokens: only boolean observations. */
export interface RoutingEnvironment {
  /** The one clock: ISO-8601. */
  now: string;
  providers: readonly ProviderStatus[];
  profiles: readonly ProfileObservation[];
  validations: readonly RouteValidationRecord[];
  firstUseApprovals: readonly GoalApproval[];
  priorResolutions: readonly PriorRouteResolution[];
}

export interface RoutingRequest {
  definitionVersion: number;
  definitionHash: string;
  routingPolicy: GoalRoutingPolicy;
  limits: GoalLimits;
  roles: readonly GoalRole[];
  environment: RoutingEnvironment;
  /** Models the final reviewer must be independent of (see `independence.ts`). */
  independenceContext?: { authority: readonly AuthorityModel[] };
  /** Resolutions already persisted for the current cycle: re-proven and returned, never recomputed. */
  persistedResolutions?: Partial<Record<GoalRole, RoleResolution>>;
  /** Allowed lanes of a `custom` billing mode. */
  customAllowedLanes?: readonly BillingLane[];
  /** A stricter effective workflow billing restriction, applied in addition to the Goal's. */
  workflowBilling?: { mode?: BillingMode; customAllowedLanes?: readonly BillingLane[] };
}

interface RouteTerms {
  availability: RouteAvailability;
  requireRoleValidation: boolean;
}

interface MemberInput {
  role: GoalRole;
  member: RouteMember;
  index: number;
  poolId: string | null;
  laneClass: RoutePool['laneClass'] | null;
  terms: RouteTerms;
}

const bounded = (member: RouteMember): RouteConfigurationAudit => {
  const {
    backendId,
    providerId,
    billingLane,
    modelId,
    connectionProfileId,
    variantId,
    reasoning,
    nativeSettings,
  } = member.configuration;
  const audit: RouteConfigurationAudit = {};
  if (backendId !== undefined) audit.backendId = backendId;
  if (providerId !== undefined) audit.providerId = providerId;
  if (billingLane !== undefined) audit.billingLane = billingLane;
  if (modelId !== undefined) audit.modelId = modelId;
  if (connectionProfileId !== undefined) audit.connectionProfileId = connectionProfileId;
  if (variantId !== undefined) audit.variantId = variantId;
  if (reasoning !== undefined) audit.reasoning = reasoning;
  if (nativeSettings !== undefined) audit.nativeSettings = { ...nativeSettings };
  return audit;
};

/** The latest first-use decision for exactly this pool member identity. Version- and role-independent. */
function firstUseOf(
  approvals: readonly GoalApproval[],
  poolId: string,
  memberIdentityHash: string,
): { state: FirstUseState; approvalId: string | null } {
  const matching = approvals.filter(
    (approval) =>
      approval.gate === 'pool_route_first_use' &&
      approval.detail.poolId === poolId &&
      approval.detail.memberIdentityHash === memberIdentityHash &&
      // Only an explicit user approval qualifies; an approved row not decided by the user is not an approval.
      (approval.status !== 'approved' || approval.decidedBy === 'user'),
  );
  let latest: GoalApproval | undefined;
  for (const approval of matching) {
    if (
      !latest ||
      Date.parse(approval.createdAt) > Date.parse(latest.createdAt) ||
      (approval.createdAt === latest.createdAt && approval.id > latest.id)
    )
      latest = approval;
  }
  if (!latest) return { state: 'required', approvalId: null };
  return { state: latest.status, approvalId: latest.id };
}

function evaluateMember(
  input: MemberInput,
  request: RoutingRequest,
  resolved: RouteIdentity | null,
): MemberEvaluation {
  const { member, role, poolId } = input;
  const environment = request.environment;
  const reasons: MemberReason[] = [];
  const configuration = member.configuration;
  const base = {
    memberIndex: input.index,
    memberConfigHash: memberConfigHashOf(configuration),
    configuration: bounded(member),
  };
  if (!resolved) {
    return {
      ...base,
      identityHash: null,
      identityKind: member.identityKind ?? 'unknown',
      technicallyEligible: false,
      eligible: false,
      readiness: { ok: false },
      billing: { ok: false },
      liveCatalog: { available: false, catalogSource: null, modelStatus: null },
      validation: { available: false, profiles: [] },
      firstUse: { state: 'not_required', approvalId: null },
      independence: null,
      reasons: ['route_incomplete'],
    };
  }

  // --- Provider and profile readiness ---
  const provider = resolved.provider;
  const readiness: MemberReason[] = [];
  if (!provider) readiness.push('provider_missing');
  else {
    if (!provider.detected) readiness.push('provider_not_detected');
    if (!provider.capabilities.execution) readiness.push('provider_execution_unsupported');
    if (provider.authentication === 'disconnected') readiness.push('provider_disconnected');
    // Generic "connected" never stands in for the verified subscription authentication of these backends.
    if (
      (configuration.backendId === 'codex-cli' || configuration.backendId === 'claude-code') &&
      provider.subscriptionAuthenticated !== true
    )
      readiness.push('subscription_auth_unverified');
  }
  if (!routeMatchesBillingLane(configuration.backendId, configuration.providerId, configuration.billingLane))
    readiness.push('billing_lane_mismatch');
  if (configuration.connectionProfileId) {
    if (resolved.issues.includes('profile_missing')) readiness.push('profile_missing');
    else if (resolved.issues.includes('profile_mismatch')) readiness.push('profile_mismatch');
    else if (!resolved.profile?.credentialReady) readiness.push('profile_not_ready');
  }

  // --- Billing: the shared evaluator, generative workload, no lane substitution ---
  const billing: MemberReason[] = [];
  const lane = configuration.billingLane;
  const goalDecision = evaluateBillingLane({
    mode: request.limits.billingMode,
    lane,
    workload: 'generative',
    customAllowedLanes: request.customAllowedLanes,
  });
  if (!goalDecision.allowed) billing.push('billing_lane_blocked');
  if (request.workflowBilling?.mode) {
    const workflowDecision = evaluateBillingLane({
      mode: request.workflowBilling.mode,
      lane,
      workload: 'generative',
      customAllowedLanes: request.workflowBilling.customAllowedLanes,
    });
    if (!workflowDecision.allowed && !billing.includes('billing_lane_blocked'))
      billing.push('billing_lane_blocked');
  }
  if (input.laneClass === 'subscription' && !isSubscriptionLane(lane)) billing.push('pool_lane_blocked');

  // --- Live catalog ---
  const model = resolved.model;
  const catalogSource = provider?.catalogSource ?? null;
  const live: MemberReason[] = [];
  if (!provider?.capabilities.modelDiscovery || catalogSource !== 'live')
    live.push('catalog_not_authoritative');
  else if (!model) live.push('model_not_found');
  else if (model.status !== 'current') live.push('model_not_current');
  const liveAvailable = live.length === 0;

  // --- Fresh role validation ---
  const validation = freshValidationSet({
    records: environment.validations,
    identityHash: resolved.identityHash,
    identity: resolved.identity,
    role,
    freshnessClass: member.freshnessClass,
    now: environment.now,
  });
  const validationReasons = validation.profiles
    .map((entry) => entry.state)
    .filter((state): state is Exclude<typeof state, 'pass'> => state !== 'pass');

  const availability = input.terms.availability;
  if (availability === 'live-catalog') reasons.push(...live);
  else if (availability === 'fresh-validation') reasons.push(...validationReasons);
  else if (!liveAvailable && !validation.available) reasons.push(...live, ...validationReasons);
  // `requireRoleValidation` demands role validation even when the live catalog already passed.
  if (input.terms.requireRoleValidation && !validation.available) reasons.push(...validationReasons);
  reasons.unshift(...readiness, ...billing);

  // --- Final-review independence ---
  let independence: MemberEvaluation['independence'] = null;
  const policy = request.routingPolicy.independence;
  if (role === 'final_reviewer' && policy.finalReview !== 'none') {
    if (resolved.identityKind !== 'pinned' && !policy.allowFloatingFinalReviewer)
      reasons.push('floating_independence');
    if (request.independenceContext) {
      const result = evaluateIndependence({
        policy: policy.finalReview,
        against: policy.against,
        candidate: {
          configuredModelId: configuration.modelId ?? '',
          identityKind: resolved.identityKind,
        },
        authority: request.independenceContext.authority,
      });
      independence = { reasonCode: result.reasonCode, conflict: result.conflict };
      if (result.conflict) reasons.push('independence_conflict');
    }
  }

  // --- First use (pool members only, bound to pool id + exact member identity) ---
  let firstUse: MemberEvaluation['firstUse'] = { state: 'not_required', approvalId: null };
  if (poolId !== null && request.limits.humanGates.poolRouteFirstUse)
    firstUse = firstUseOf(environment.firstUseApprovals, poolId, resolved.identityHash);

  const unique = [...new Set(reasons)];
  const technicallyEligible = unique.length === 0 && firstUse.state !== 'denied';
  if (firstUse.state === 'denied') unique.push('first_use_denied');
  else if (unique.length === 0 && firstUse.state === 'pending') unique.push('first_use_pending');
  else if (unique.length === 0 && firstUse.state === 'required') unique.push('first_use_required');
  return {
    ...base,
    identityHash: resolved.identityHash,
    identityKind: resolved.identityKind,
    technicallyEligible,
    eligible: technicallyEligible && (firstUse.state === 'not_required' || firstUse.state === 'approved'),
    readiness: { ok: readiness.length === 0 },
    billing: { ok: billing.length === 0 },
    liveCatalog: { available: liveAvailable, catalogSource, modelStatus: model?.status ?? null },
    validation,
    firstUse,
    independence,
    reasons: unique,
  };
}

/** Evidence for the selected member's resolution: which records it relied on and the catalog it saw. */
function selectedDetail(
  evaluation: MemberEvaluation,
  resolved: RouteIdentity,
  terms: RouteTerms,
): Pick<RoleResolution, 'validationRecordIds' | 'catalog'> {
  const usesValidation =
    terms.requireRoleValidation ||
    terms.availability === 'fresh-validation' ||
    (terms.availability === 'live-catalog-or-fresh-validation' && !evaluation.liveCatalog.available);
  return {
    validationRecordIds: usesValidation
      ? evaluation.validation.profiles.flatMap((entry) => (entry.recordId ? [entry.recordId] : []))
      : [],
    catalog: {
      backendId: resolved.provider?.id ?? evaluation.configuration.backendId ?? '',
      source: evaluation.liveCatalog.catalogSource,
      refreshedAt: resolved.provider?.catalogRefreshedAt ?? null,
      modelStatus: evaluation.liveCatalog.modelStatus,
    },
  };
}

function independenceFor(
  role: GoalRole,
  evaluation: MemberEvaluation,
  request: RoutingRequest,
): IndependenceResult | null {
  if (role !== 'final_reviewer') return null;
  const policy = request.routingPolicy.independence;
  return evaluateIndependence({
    policy: policy.finalReview,
    against: policy.against,
    candidate: {
      configuredModelId: evaluation.configuration.modelId ?? '',
      identityKind: evaluation.identityKind,
    },
    authority: request.independenceContext?.authority ?? [],
  });
}

function routeMembersOf(
  request: RoutingRequest,
  role: GoalRole,
):
  | { kind: 'pinned'; members: MemberInput[] }
  | { kind: 'pool'; pool: RoutePool; members: MemberInput[] }
  | { kind: 'undefined' } {
  const route = request.routingPolicy.roles[role];
  if (!route) return { kind: 'undefined' };
  if (route.kind === 'pinned')
    return {
      kind: 'pinned',
      members: [
        {
          role,
          member: route.member,
          index: 0,
          poolId: null,
          laneClass: null,
          terms: { availability: route.availability, requireRoleValidation: route.requireRoleValidation },
        },
      ],
    };
  const pool = request.routingPolicy.pools.find((candidate) => candidate.id === route.poolId);
  if (!pool) return { kind: 'undefined' };
  return {
    kind: 'pool',
    pool,
    members: pool.members.map((member, index) => ({
      role,
      member,
      index,
      poolId: pool.id,
      laneClass: pool.laneClass,
      terms: { availability: pool.availability, requireRoleValidation: pool.requireRoleValidation },
    })),
  };
}

/** Re-proves a persisted resolution against the approved definition; null when it no longer matches (corruption). */
function reprovePersisted(
  request: RoutingRequest,
  role: GoalRole,
  persisted: RoleResolution,
): RoleResolution | null {
  if (
    persisted.definitionVersion !== request.definitionVersion ||
    persisted.definitionHash !== request.definitionHash ||
    persisted.role !== role
  )
    return null;
  const route = routeMembersOf(request, role);
  if (route.kind === 'undefined') return null;
  if (persisted.routeKind !== route.kind) return null;
  if (route.kind === 'pool' && persisted.poolId !== route.pool.id) return null;
  if (route.kind === 'pinned' && persisted.poolId !== null) return null;
  const slot = route.members[persisted.selectedIndex];
  if (!slot || memberConfigHashOf(slot.member.configuration) !== persisted.selected.memberConfigHash)
    return null;
  return persisted;
}

function refusal(
  request: RoutingRequest,
  role: GoalRole,
  code: RefusalCode,
  extra: Partial<RoleRefusal> = {},
): RoleRefusal {
  return {
    status: 'refused',
    role,
    code,
    definitionVersion: request.definitionVersion,
    definitionHash: request.definitionHash,
    routeKind: null,
    poolId: null,
    evaluatedMembers: [],
    ...extra,
  };
}

function resolveRole(request: RoutingRequest, role: GoalRole): RoleOutcome {
  const persisted = request.persistedResolutions?.[role];
  if (persisted) {
    const proven = reprovePersisted(request, role, persisted);
    return proven
      ? { status: 'resolved', source: 'persisted', resolution: proven }
      : refusal(request, role, 'persisted_resolution_invalid');
  }
  const route = routeMembersOf(request, role);
  if (route.kind === 'undefined') return refusal(request, role, 'route_not_defined');

  const snapshot = { providers: request.environment.providers, profiles: request.environment.profiles };
  const identities = route.members.map((input) => {
    const result = computeRouteIdentity(input.member, snapshot);
    return result.ok ? result.value : null;
  });
  const evaluations = route.members.map((input, index) => evaluateMember(input, request, identities[index]!));
  const common = {
    routeKind: route.kind,
    poolId: route.kind === 'pool' ? route.pool.id : null,
    evaluatedMembers: evaluations,
  };

  // Selection order: declared order, or (round robin) rotated to start after the last recorded selection.
  let order = evaluations.map((_, index) => index);
  const selection: RouteSelection = route.kind === 'pinned' ? 'pinned' : route.pool.selection;
  if (route.kind === 'pool' && route.pool.selection === 'round_robin') {
    const history = request.environment.priorResolutions
      .filter((entry) => entry.role === role && entry.poolId === route.pool.id)
      .map((entry, position) => ({ entry, position }))
      .sort((a, b) => a.entry.cycleSequence - b.entry.cycleSequence || a.position - b.position);
    const last = history.at(-1)?.entry;
    if (last) {
      let at = evaluations.findIndex((evaluation) => evaluation.identityHash === last.selectedIdentityHash);
      if (at < 0 && last.memberConfigHash)
        at = evaluations.findIndex((evaluation) => evaluation.memberConfigHash === last.memberConfigHash);
      if (at >= 0) order = order.map((_, offset) => (at + 1 + offset) % evaluations.length);
    }
  }

  let candidateIndex = -1;
  for (const index of order) {
    const evaluation = evaluations[index]!;
    if (!evaluation.technicallyEligible) continue;
    if (evaluation.reasons.includes('independence_conflict')) continue;
    candidateIndex = index;
    break;
  }
  if (candidateIndex < 0) {
    // Nothing is usable. If the only thing excluding some member was proven non-independence, say so.
    const blockedByIndependence = evaluations.some(
      (evaluation) =>
        evaluation.reasons.includes('independence_conflict') &&
        evaluation.reasons.every((reason) => reason === 'independence_conflict'),
    );
    return refusal(
      request,
      role,
      blockedByIndependence ? 'independence_unestablished' : 'route_unavailable',
      {
        ...common,
      },
    );
  }
  const candidate = evaluations[candidateIndex]!;
  const resolvedIdentity = identities[candidateIndex]!;
  if (
    route.kind === 'pool' &&
    candidate.firstUse.state !== 'approved' &&
    candidate.firstUse.state !== 'not_required'
  ) {
    return refusal(
      request,
      role,
      candidate.firstUse.state === 'pending' ? 'approval_pending' : 'approval_required',
      {
        ...common,
        candidate: {
          poolId: route.pool.id,
          memberIdentityHash: candidate.identityHash!,
          memberIndex: candidateIndex,
          configuration: candidate.configuration,
          approvalId: candidate.firstUse.approvalId,
        },
      },
    );
  }
  const terms = route.members[candidateIndex]!.terms;
  const independence = independenceFor(role, candidate, request);
  return {
    status: 'resolved',
    source: 'computed',
    resolution: {
      schema: 1,
      definitionVersion: request.definitionVersion,
      definitionHash: request.definitionHash,
      role,
      routeKind: route.kind,
      poolId: common.poolId,
      selection,
      selectedIndex: candidateIndex,
      selected: {
        configuration: candidate.configuration,
        identityHash: candidate.identityHash!,
        memberConfigHash: candidate.memberConfigHash,
        identityKind: candidate.identityKind,
      },
      evaluatedMembers: evaluations,
      ...selectedDetail(candidate, resolvedIdentity, terms),
      approval: {
        state: candidate.firstUse.state === 'approved' ? 'approved' : 'not_required',
        approvalId: candidate.firstUse.approvalId,
        poolId: common.poolId,
        memberIdentityHash: candidate.firstUse.state === 'approved' ? candidate.identityHash : null,
      },
      independence,
    },
  };
}

/** Resolves any subset of roles. Pure: the same request always yields the same result. */
export function resolveRoutes(request: RoutingRequest): RoutingResult {
  const roles: RoutingResult['roles'] = {};
  for (const role of GOAL_ROLES) {
    if (!request.roles.includes(role)) continue;
    roles[role] = resolveRole(request, role);
  }
  return { ok: Object.values(roles).every((outcome) => outcome?.status === 'resolved'), roles };
}

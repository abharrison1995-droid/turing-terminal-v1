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
import {
  authorityIdentitiesKnown,
  evaluateIndependence,
  type AuthorityModel,
  type IndependenceResult,
} from './independence.js';
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
  effectiveIdentityKind,
  memberConfigHashOf,
  type ProfileObservation,
  type RouteIdentity,
} from './routeIdentity.js';
import { ROLE_VALIDATION_PROFILES, freshValidationSet } from './routeValidation.js';
import type { ProviderStatus } from '../../shared/types.js';
import { canonicalJson } from './definitionHash.js';
import type { OpportunityBinding } from '../../shared/opportunityContract.js';

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
  /** Roles whose stored current-cycle entry exists but is malformed: refused, never recomputed over. */
  invalidPersistedRoles?: readonly GoalRole[];
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
  poolAdmission?: RoutePool['admission'];
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
  opportunity?: OpportunityBinding,
): { state: FirstUseState; approvalId: string | null } {
  const matching = approvals.filter(
    (approval) =>
      approval.gate === 'pool_route_first_use' &&
      approval.detail.poolId === poolId &&
      approval.detail.memberIdentityHash === memberIdentityHash &&
      (opportunity
        ? approval.detail.admissionKind === 'opportunity' &&
          approval.detail.opportunityDigest === opportunity.opportunityDigest &&
          sameJson(approval.detail.observationIds, opportunity.observationIds)
        : approval.detail.admissionKind !== 'opportunity') &&
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
  // An independence-required final review needs established independence. The one exception is the user's explicit
  // `allowFloatingFinalReviewer`: a floating/unknown candidate whose only uncertainty is its own identity may run, and
  // is recorded as not established. A proven overlap, contradicting telemetry, unproven authority or an unknown family
  // is never silently viable.
  let independence: MemberEvaluation['independence'] = null;
  const policy = request.routingPolicy.independence;
  if (role === 'final_reviewer' && policy.finalReview !== 'none') {
    const floating = resolved.identityKind !== 'pinned';
    if (floating && !policy.allowFloatingFinalReviewer) reasons.push('floating_independence');
    const result = evaluateIndependence({
      policy: policy.finalReview,
      against: policy.against,
      candidate: {
        configuredModelId: configuration.modelId ?? '',
        identityKind: resolved.identityKind,
      },
      authority: request.independenceContext?.authority ?? [],
    });
    const uncertainAllowed =
      floating &&
      policy.allowFloatingFinalReviewer &&
      !result.established &&
      !result.conflict &&
      result.reasonCode === 'candidate_identity_unproven' &&
      authorityIdentitiesKnown(result);
    independence = {
      reasonCode: result.reasonCode,
      conflict: result.conflict,
      established: result.established,
      uncertainAllowed,
    };
    if (result.conflict) reasons.push('independence_conflict');
    else if (!result.established && !uncertainAllowed) reasons.push('independence_unestablished');
  }

  // --- First use (pool members only, bound to pool id + exact member identity) ---
  let firstUse: MemberEvaluation['firstUse'] = { state: 'not_required', approvalId: null };
  if (
    poolId !== null &&
    (input.poolAdmission === 'opportunity' || request.limits.humanGates.poolRouteFirstUse)
  )
    firstUse = firstUseOf(environment.firstUseApprovals, poolId, resolved.identityHash, member.opportunity);

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

/** Whether a member's eligibility relied on role validation records (rather than the live catalog alone). */
export function reliesOnValidation(terms: RouteTerms, liveCatalogAvailable: boolean): boolean {
  return (
    terms.requireRoleValidation ||
    terms.availability === 'fresh-validation' ||
    (terms.availability === 'live-catalog-or-fresh-validation' && !liveCatalogAvailable)
  );
}

/** Evidence for the selected member's resolution: which records it relied on and the catalog it saw. */
function selectedDetail(
  evaluation: MemberEvaluation,
  resolved: RouteIdentity,
  terms: RouteTerms,
): Pick<RoleResolution, 'validationRecordIds' | 'catalog'> {
  return {
    validationRecordIds: reliesOnValidation(terms, evaluation.liveCatalog.available)
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
  request: Pick<RoutingRequest, 'routingPolicy'>,
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
      poolAdmission: pool.admission,
      laneClass: pool.laneClass,
      terms: { availability: pool.availability, requireRoleValidation: pool.requireRoleValidation },
    })),
  };
}

type ReproofContext = Pick<
  RoutingRequest,
  'definitionVersion' | 'definitionHash' | 'routingPolicy' | 'limits'
>;

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * The one semantic proof that a role resolution is exactly the member the approved definition routes: used when a
 * resolution is persisted and again when it is read back, so write- and read-time authority cannot drift. It proves
 * definition binding, route shape, the selected slot and its configuration, the audit entries and the approval and
 * independence claims. It does not re-evaluate provider availability: the route was frozen at selection.
 * Returns a finite failure code, or null when the resolution is proven.
 */
export function reproveRoleResolution(
  context: ReproofContext,
  role: GoalRole,
  resolution: RoleResolution,
): string | null {
  if (
    resolution.definitionVersion !== context.definitionVersion ||
    resolution.definitionHash !== context.definitionHash
  )
    return 'definition_binding';
  if (resolution.role !== role) return 'role';
  const route = routeMembersOf(context, role);
  if (route.kind === 'undefined') return 'route_not_defined';
  if (resolution.routeKind !== route.kind) return 'route_kind';
  if (route.kind === 'pool' ? resolution.poolId !== route.pool.id : resolution.poolId !== null)
    return 'pool_id';
  const expectedSelection: RouteSelection = route.kind === 'pinned' ? 'pinned' : route.pool.selection;
  if (resolution.selection !== expectedSelection) return 'selection';
  const slot = route.members[resolution.selectedIndex];
  if (!slot) return 'selected_index';

  // The selected route must be exactly the approved member; the stored member hash is never trusted by itself.
  const approved = slot.member;
  const approvedHash = memberConfigHashOf(approved.configuration);
  const { selected } = resolution;
  if (!sameJson(selected.configuration, bounded(approved))) return 'selected_configuration';
  if (memberConfigHashOf(selected.configuration) !== selected.memberConfigHash) return 'member_hash';
  if (selected.memberConfigHash !== approvedHash) return 'member_hash';
  if (selected.identityKind !== effectiveIdentityKind(approved)) return 'identity_kind';

  // Every audit entry describes the declared slot it claims to; the selected one agrees with `selected`.
  if (resolution.evaluatedMembers.length !== route.members.length) return 'audit_members';
  for (const [index, entry] of resolution.evaluatedMembers.entries()) {
    const declared = route.members[index]!.member;
    if (
      entry.memberIndex !== index ||
      entry.memberConfigHash !== memberConfigHashOf(declared.configuration) ||
      !sameJson(entry.configuration, bounded(declared))
    )
      return 'audit_members';
  }
  const entry = resolution.evaluatedMembers[resolution.selectedIndex]!;
  if (
    entry.identityHash !== selected.identityHash ||
    entry.identityKind !== selected.identityKind ||
    !entry.technicallyEligible ||
    !entry.eligible ||
    !entry.readiness.ok ||
    !entry.billing.ok ||
    entry.reasons.length > 0
  )
    return 'audit_selected';

  // Eligibility terms hold, and the validation ids are exactly the passing profiles the role needs.
  const terms = slot.terms;
  const validationOk = entry.validation.available;
  const liveOk = entry.liveCatalog.available;
  const availabilityHolds =
    terms.availability === 'live-catalog'
      ? liveOk
      : terms.availability === 'fresh-validation'
        ? validationOk
        : liveOk || validationOk;
  if (!availabilityHolds || (terms.requireRoleValidation && !validationOk)) return 'audit_availability';
  if (reliesOnValidation(terms, liveOk)) {
    const needed = ROLE_VALIDATION_PROFILES[role];
    const profiles = entry.validation.profiles;
    if (
      profiles.length !== needed.length ||
      profiles.some(
        (state, index) =>
          state.profile !== needed[index] || state.state !== 'pass' || state.recordId === null,
      )
    )
      return 'validation_profiles';
    const ids = profiles.map((state) => state.recordId!);
    if (
      new Set(ids).size !== ids.length ||
      resolution.validationRecordIds.length !== ids.length ||
      !ids.every((id) => resolution.validationRecordIds.includes(id))
    )
      return 'validation_ids';
  } else if (resolution.validationRecordIds.length > 0) return 'validation_ids';

  // Opportunity admission is always a separate user decision; static pools retain the existing configurable gate.
  const opportunityAdmission = route.kind === 'pool' && route.pool.admission === 'opportunity';
  const gated =
    route.kind === 'pool' && (context.limits.humanGates.poolRouteFirstUse || opportunityAdmission);
  const { approval } = resolution;
  if (approval.poolId !== resolution.poolId) return 'approval';
  const opportunity =
    route.kind === 'pool' ? route.members[resolution.selectedIndex]!.member.opportunity : undefined;
  if (gated) {
    if (
      approval.state !== 'approved' ||
      !approval.approvalId ||
      approval.memberIdentityHash !== selected.identityHash ||
      entry.firstUse.state !== 'approved' ||
      entry.firstUse.approvalId !== approval.approvalId ||
      (opportunityAdmission &&
        (!opportunity ||
          approval.admissionKind !== 'opportunity' ||
          approval.opportunityDigest !== opportunity.opportunityDigest ||
          !sameJson(approval.observationIds, opportunity.observationIds))) ||
      (!opportunityAdmission &&
        (approval.admissionKind !== undefined ||
          approval.opportunityDigest !== undefined ||
          approval.observationIds !== undefined))
    )
      return 'approval';
  } else if (
    approval.state !== 'not_required' ||
    approval.approvalId !== null ||
    approval.memberIdentityHash !== null ||
    entry.firstUse.state !== 'not_required'
  )
    return 'approval';

  // Final-review independence: policy as approved; unestablished only for the explicitly authorised uncertain case.
  const policy = context.routingPolicy.independence;
  if (role !== 'final_reviewer') return resolution.independence === null ? null : 'independence';
  const claim = resolution.independence;
  if (!claim || claim.policy !== policy.finalReview || claim.required !== (policy.finalReview !== 'none'))
    return 'independence';
  if (policy.finalReview === 'none') return claim.reasonCode === 'policy_none' ? null : 'independence';
  const member = entry.independence;
  if (
    !member ||
    claim.conflict ||
    member.reasonCode !== claim.reasonCode ||
    member.established !== claim.established ||
    member.conflict !== claim.conflict
  )
    return 'independence';
  if (claim.established) return claim.reasonCode === 'established' ? null : 'independence';
  const uncertainAllowed =
    selected.identityKind !== 'pinned' &&
    policy.allowFloatingFinalReviewer &&
    claim.reasonCode === 'candidate_identity_unproven' &&
    authorityIdentitiesKnown(claim);
  return uncertainAllowed && member.uncertainAllowed ? null : 'independence';
}

/** Re-proves a persisted resolution against the approved definition; null when it no longer matches (corruption). */
function reprovePersisted(
  request: RoutingRequest,
  role: GoalRole,
  persisted: RoleResolution,
): RoleResolution | null {
  return reproveRoleResolution(request, role, persisted) === null ? persisted : null;
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
  if (request.invalidPersistedRoles?.includes(role))
    return refusal(request, role, 'persisted_resolution_invalid');
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

  // Prefer a candidate whose independence is established; only when none exists may the explicitly authorised
  // uncertain candidate (see evaluateMember) be used. Eligible members never include a proven or unproven-by-default one.
  const usable = order.filter((index) => evaluations[index]!.technicallyEligible);
  const candidateIndex =
    usable.find((index) => evaluations[index]!.independence?.established !== false) ?? usable[0] ?? -1;
  if (candidateIndex < 0) {
    // Nothing is usable. If the only thing excluding some member was proven non-independence, say so.
    const independenceReasons: MemberReason[] = [
      'independence_conflict',
      'independence_unestablished',
      'floating_independence',
    ];
    const blockedByIndependence = evaluations.some(
      (evaluation) =>
        evaluation.reasons.some(
          (reason) => reason !== 'floating_independence' && independenceReasons.includes(reason),
        ) && evaluation.reasons.every((reason) => independenceReasons.includes(reason)),
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
          ...(route.members[candidateIndex]!.member.opportunity
            ? { opportunity: route.members[candidateIndex]!.member.opportunity }
            : {}),
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
        ...(route.kind === 'pool' &&
        route.pool.admission === 'opportunity' &&
        route.members[candidateIndex]!.member.opportunity &&
        candidate.firstUse.state === 'approved'
          ? {
              admissionKind: 'opportunity' as const,
              opportunityDigest: route.members[candidateIndex]!.member.opportunity.opportunityDigest,
              observationIds: route.members[candidateIndex]!.member.opportunity.observationIds,
            }
          : {}),
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

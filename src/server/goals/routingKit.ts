import type {
  FreshnessClass,
  GoalApproval,
  GoalLimits,
  GoalRole,
  GoalRoutingPolicy,
  RoutePool,
  RouteMember,
  RouteValidationRecord,
} from '../../shared/goals.js';
import type { BillingLane, ConnectionProfile, ModelOption, ProviderStatus } from '../../shared/types.js';
import { validDefinition } from './testKit.js';
import { computeRouteIdentity, type ProfileObservation } from './routeIdentity.js';
import { ROLE_VALIDATION_PROFILES } from './routeValidation.js';
import type { RoutingEnvironment, RoutingRequest } from './routing.js';

/** Deterministic fixtures for the routing authority tests. Nothing here touches a provider, a network or a secret. */

export const NOW = '2026-10-05T12:00:00.000Z';
export const hoursAgo = (hours: number, from = NOW): string =>
  new Date(Date.parse(from) - hours * 3_600_000).toISOString();
export const hoursAhead = (hours: number, from = NOW): string =>
  new Date(Date.parse(from) + hours * 3_600_000).toISOString();
export const HASH = 'a'.repeat(64);

export function model(id: string, overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id,
    name: `Display ${id}`,
    providerId: 'opencode-go',
    status: 'current',
    supportsTools: true,
    supportsStructuredOutput: true,
    reasoningControl: 'effort',
    contextLength: 128_000,
    ...overrides,
  };
}

export function provider(overrides: Partial<ProviderStatus> = {}, models?: ModelOption[]): ProviderStatus {
  return {
    id: 'opencode',
    name: 'OpenCode',
    cli: 'opencode',
    detected: true,
    version: '1.2.3',
    authentication: 'connected',
    authMechanism: 'cli',
    note: '',
    checkedAt: NOW,
    capabilities: {
      authentication: true,
      subscriptionAuth: true,
      modelDiscovery: true,
      execution: true,
      streaming: true,
      cancellation: true,
      usageTelemetry: true,
      remainingAllowance: false,
      resetTelemetry: false,
      structuredOutput: true,
      sessionResume: false,
      toolMediation: true,
    },
    models: models ?? [model('opencode-go/a'), model('opencode-go/b'), model('opencode-go/c')],
    catalogSource: 'live',
    catalogRefreshedAt: NOW,
    ...overrides,
  };
}

export function member(
  modelId: string,
  overrides: {
    freshnessClass?: FreshnessClass;
    identityKind?: RouteMember['identityKind'];
    lane?: BillingLane;
  } & Partial<RouteMember['configuration']> = {},
): RouteMember {
  const { freshnessClass, identityKind, lane, ...configuration } = overrides;
  return {
    configuration: {
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: lane ?? 'opencode-go-subscription',
      modelId,
      ...configuration,
    },
    identityKind: identityKind ?? 'pinned',
    freshnessClass: freshnessClass ?? 'stable-subscription',
  };
}

export function pool(id: string, members: RouteMember[], overrides: Partial<RoutePool> = {}): RoutePool {
  return {
    id,
    label: id,
    members,
    admission: 'static',
    availability: 'live-catalog',
    requireRoleValidation: false,
    selection: 'ordered',
    laneClass: 'subscription',
    autoRevalidate: false,
    ...overrides,
  };
}

export function limits(
  overrides: Partial<GoalLimits> = {},
  gates: Partial<GoalLimits['humanGates']> = {},
): GoalLimits {
  const base = validDefinition().limits;
  return { ...base, ...overrides, humanGates: { ...base.humanGates, poolRouteFirstUse: false, ...gates } };
}

export function policy(overrides: Partial<GoalRoutingPolicy> = {}): GoalRoutingPolicy {
  const base = validDefinition().routing;
  return { ...base, roles: {}, pools: [], ...overrides };
}

export function env(overrides: Partial<RoutingEnvironment> = {}): RoutingEnvironment {
  return {
    now: NOW,
    providers: [provider()],
    profiles: [],
    validations: [],
    firstUseApprovals: [],
    priorResolutions: [],
    ...overrides,
  };
}

export function request(input: {
  routing: GoalRoutingPolicy;
  roles: GoalRole[];
  environment?: RoutingEnvironment;
  limits?: GoalLimits;
  extra?: Partial<RoutingRequest>;
}): RoutingRequest {
  return {
    definitionVersion: 1,
    definitionHash: HASH,
    routingPolicy: input.routing,
    limits: input.limits ?? limits(),
    roles: input.roles,
    environment: input.environment ?? env(),
    ...input.extra,
  };
}

export function profile(
  overrides: Partial<ConnectionProfile> = {},
  credentialReady = true,
): ProfileObservation {
  return {
    credentialReady,
    profile: {
      id: 'prof-a',
      name: 'Profile A',
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: 'opencode-go-subscription',
      credentialStoreRef: 'secret://never-in-identity',
      metadata: { note: 'secret-bearing' },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    },
  };
}

let counter = 0;
/** Validation records passing every profile the role needs, for the member's identity in `environment`. */
export function passRecords(
  member: RouteMember,
  role: GoalRole,
  environment: Pick<RoutingEnvironment, 'providers' | 'profiles'>,
  overrides: Partial<RouteValidationRecord> = {},
): RouteValidationRecord[] {
  const result = computeRouteIdentity(member, environment);
  if (!result.ok) throw new Error('incomplete member');
  return ROLE_VALIDATION_PROFILES[role].map((validationProfile) => {
    counter += 1;
    return {
      id: `rec-${String(counter).padStart(6, '0')}`,
      identityHash: result.value.identityHash,
      identity: result.value.identity,
      profile: validationProfile,
      status: 'pass' as const,
      evidenceRunId: null,
      resolvedModelReported: null,
      checks: {},
      provenance: 'turing_probe_run' as const,
      adapterVersion: result.value.adapterVersion,
      capabilityFingerprint: result.value.capabilityFingerprint,
      testedAt: hoursAgo(1),
      expiresAt: hoursAhead(100),
      ...overrides,
    };
  });
}

export function approval(
  poolId: string,
  memberIdentityHash: string,
  overrides: Partial<GoalApproval> = {},
): GoalApproval {
  counter += 1;
  return {
    id: `appr-${String(counter).padStart(6, '0')}`,
    goalId: 'goal',
    gate: 'pool_route_first_use',
    risk: 'low',
    reason: 'first use',
    requestedBy: 'supervisor',
    detail: { poolId, memberIdentityHash },
    status: 'approved',
    decidedBy: 'user',
    decisionNote: null,
    createdAt: hoursAgo(2),
    respondedAt: hoursAgo(1),
    ...overrides,
  };
}

export function identityOf(
  member: RouteMember,
  environment: Pick<RoutingEnvironment, 'providers' | 'profiles'>,
) {
  const result = computeRouteIdentity(member, environment);
  if (!result.ok) throw new Error('incomplete member');
  return result.value;
}

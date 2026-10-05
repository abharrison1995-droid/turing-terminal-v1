import { describe, expect, it } from 'vitest';
import type { GoalRole, GoalRoute, RouteMember, RoutePool } from '../../shared/goals.js';
import type { RoleOutcome, RoleResolution } from './routeAudit.js';
import { ROLE_VALIDATION_PROFILES } from './routeValidation.js';
import { resolveRoutes, type RoutingEnvironment, type RoutingRequest } from './routing.js';
import {
  NOW,
  approval,
  env,
  hoursAgo,
  hoursAhead,
  identityOf,
  limits,
  member,
  model,
  passRecords,
  policy,
  pool,
  profile,
  provider,
  request,
} from './routingKit.js';

const A = 'opencode-go/a';
const B = 'opencode-go/b';
const C = 'opencode-go/c';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const pinnedRoute = (
  m: RouteMember,
  availability: 'live-catalog' | 'fresh-validation' | 'live-catalog-or-fresh-validation' = 'live-catalog',
  requireRoleValidation = false,
): GoalRoute => ({ kind: 'pinned', member: m, availability, requireRoleValidation });

function resolve(
  role: GoalRole,
  route: GoalRoute,
  options: {
    pools?: RoutePool[];
    environment?: RoutingEnvironment;
    limits?: ReturnType<typeof limits>;
    extra?: Partial<RoutingRequest>;
  } = {},
): RoleOutcome {
  const result = resolveRoutes(
    deepFreeze(
      request({
        routing: policy({ roles: { [role]: route }, pools: options.pools ?? [] }),
        roles: [role],
        environment: options.environment,
        limits: options.limits,
        extra: options.extra,
      }),
    ),
  );
  return result.roles[role]!;
}
const selectedModel = (outcome: RoleOutcome) =>
  outcome.status === 'resolved' ? outcome.resolution.selected.configuration.modelId : null;
const reasonsOf = (outcome: RoleOutcome, index = 0) =>
  (outcome.status === 'resolved' ? outcome.resolution.evaluatedMembers : outcome.evaluatedMembers)[index]!
    .reasons;
const poolRoute = (id: string): GoalRoute => ({ kind: 'pool', poolId: id });

describe('availability: live catalog', () => {
  it('passes only for a live catalog from a discovery-capable provider with the exact current model', () => {
    expect(selectedModel(resolve('implementer', pinnedRoute(member(A))))).toBe(A);
  });

  it.each([
    ['cache', { catalogSource: 'cache' as const }],
    ['adapter-only', { catalogSource: 'adapter' as const }],
    ['no source', { catalogSource: 'none' as const }],
    ['last-known refresh failure with only a timestamp', { catalogSource: undefined }],
  ])('is not satisfied by %s data, even for the same current model', (_name, overrides) => {
    const outcome = resolve('implementer', pinnedRoute(member(A)), {
      environment: env({ providers: [provider(overrides)] }),
    });
    expect(outcome.status).toBe('refused');
    expect(reasonsOf(outcome)).toEqual(['catalog_not_authoritative']);
  });

  it('is not satisfied without model discovery, or by a missing or non-current model', () => {
    const noDiscovery = provider({}, [model(A)]);
    noDiscovery.capabilities.modelDiscovery = false;
    expect(
      reasonsOf(
        resolve('implementer', pinnedRoute(member(A)), { environment: env({ providers: [noDiscovery] }) }),
      ),
    ).toEqual(['catalog_not_authoritative']);
    expect(reasonsOf(resolve('implementer', pinnedRoute(member('opencode-go/zzz'))))).toEqual([
      'model_not_found',
    ]);
    for (const status of ['deprecated', 'unavailable', 'last-known'] as const)
      expect(
        reasonsOf(
          resolve('implementer', pinnedRoute(member(A)), {
            environment: env({ providers: [provider({}, [model(A, { status })])] }),
          }),
        ),
      ).toEqual(['model_not_current']);
  });
});

describe('availability: fresh validation and role mapping', () => {
  const discoveryless = () => {
    const p = provider({ id: 'opencode', catalogSource: 'adapter' }, []);
    p.capabilities.modelDiscovery = false;
    return p;
  };
  const snapshot = () => ({ providers: [discoveryless()], profiles: [] });

  it('maps every role to exactly its validation profiles', () => {
    expect(ROLE_VALIDATION_PROFILES).toEqual({
      orchestrator: ['orchestrator-json', 'broker-read'],
      implementer: ['broker-edit', 'broker-read'],
      routine_reviewer: ['review-json', 'broker-read'],
      milestone_reviewer: ['review-json', 'broker-read'],
      final_reviewer: ['review-json', 'broker-read'],
    });
  });

  it('refuses live-catalog for a discovery-less route but accepts exact fresh role validation', () => {
    const m = member(A);
    expect(
      resolve('implementer', pinnedRoute(m, 'live-catalog'), { environment: env(snapshot()) }).status,
    ).toBe('refused');
    expect(
      resolve('implementer', pinnedRoute(m, 'fresh-validation'), { environment: env(snapshot()) }).status,
    ).toBe('refused');
    const records = passRecords(m, 'implementer', snapshot());
    const outcome = resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
      environment: env({ ...snapshot(), validations: records }),
    });
    expect(selectedModel(outcome)).toBe(A);
    expect(outcome.status === 'resolved' && outcome.resolution.validationRecordIds.sort()).toEqual(
      records.map((record) => record.id).sort(),
    );
  });

  it('requires role validation even when the live catalog passed, when requireRoleValidation is set', () => {
    const m = member(A);
    const without = resolve('implementer', pinnedRoute(m, 'live-catalog', true));
    expect(without.status).toBe('refused');
    expect(reasonsOf(without)).toEqual(['validation_missing']);
    const withRecords = resolve('implementer', pinnedRoute(m, 'live-catalog', true), {
      environment: env({ validations: passRecords(m, 'implementer', env()) }),
    });
    expect(selectedModel(withRecords)).toBe(A);
  });

  it('lets live-catalog-or-fresh-validation pass on either, and requires both profiles for validation', () => {
    const m = member(A);
    const ok = resolve('implementer', pinnedRoute(m, 'live-catalog-or-fresh-validation'));
    expect(selectedModel(ok)).toBe(A);
    const stale = env({ ...snapshot() });
    const records = passRecords(m, 'implementer', snapshot()).filter(
      (record) => record.profile === 'broker-read',
    );
    const partial = resolve('implementer', pinnedRoute(m, 'live-catalog-or-fresh-validation'), {
      environment: env({ ...stale, validations: records }),
    });
    expect(partial.status).toBe('refused');
    expect(reasonsOf(partial)).toContain('catalog_not_authoritative');
    expect(reasonsOf(partial)).toContain('validation_missing');
  });

  it('does not let review-json or structured-readonly qualify an implementer', () => {
    const m = member(A);
    const records = passRecords(m, 'implementer', snapshot()).map((record) => ({
      ...record,
      profile: record.profile === 'broker-edit' ? ('review-json' as const) : record.profile,
    }));
    expect(
      resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
        environment: env({ ...snapshot(), validations: records }),
      }).status,
    ).toBe('refused');
    const readonly = passRecords(m, 'implementer', snapshot()).map((record) => ({
      ...record,
      profile: 'structured-readonly' as const,
    }));
    expect(
      resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
        environment: env({ ...snapshot(), validations: readonly }),
      }).status,
    ).toBe('refused');
    // A reviewer is qualified by review-json + broker-read; an implementer's broker-edit does not qualify it.
    const reviewer = passRecords(m, 'routine_reviewer', snapshot());
    expect(
      selectedModel(
        resolve('routine_reviewer', pinnedRoute(m, 'fresh-validation'), {
          environment: env({ ...snapshot(), validations: reviewer }),
        }),
      ),
    ).toBe(A);
  });

  it('lets a newer failure supersede an older pass, with a stable id tie-break', () => {
    const m = member(A);
    const [edit, read] = passRecords(m, 'implementer', snapshot());
    const older = { ...edit!, id: 'rec-a', testedAt: hoursAgo(5) };
    const newerFail = { ...edit!, id: 'rec-b', status: 'fail' as const, testedAt: hoursAgo(2) };
    const run = (validations: (typeof older)[]) =>
      resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
        environment: env({ ...snapshot(), validations: [read!, ...validations] }),
      });
    expect(selectedModel(run([older]))).toBe(A);
    const failed = run([older, newerFail]);
    expect(failed.status).toBe('refused');
    expect(reasonsOf(failed)).toEqual(['validation_failed']);
    // Same timestamp: the greater id controls, whatever the input order.
    const tieFail = { ...newerFail, testedAt: older.testedAt, id: 'rec-z' };
    expect(run([tieFail, older]).status).toBe('refused');
    expect(run([older, tieFail]).status).toBe('refused');
    const tiePass = { ...older, id: 'rec-z' };
    const tieOlderFail = { ...newerFail, testedAt: older.testedAt, id: 'rec-0' };
    expect(selectedModel(run([tiePass, tieOlderFail]))).toBe(A);
  });

  it('caps validity by the member freshness class, whatever the record expiry says', () => {
    const run = (
      freshnessClass: 'stable-subscription' | 'opportunity',
      testedHoursAgo: number,
      expiresInHours: number,
    ) => {
      const m = member(A, { freshnessClass });
      const records = passRecords(m, 'implementer', snapshot(), {
        testedAt: hoursAgo(testedHoursAgo),
        expiresAt: hoursAhead(expiresInHours),
      });
      return resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
        environment: env({ ...snapshot(), validations: records }),
      });
    };
    // A generous record expiry cannot extend an opportunity member past 24 hours.
    expect(run('opportunity', 23, 500).status).toBe('resolved');
    const opportunity = run('opportunity', 25, 500);
    expect(opportunity.status).toBe('refused');
    expect(reasonsOf(opportunity)).toEqual(['validation_expired']);
    // Stable-subscription: 7 days.
    expect(run('stable-subscription', 25, 500).status).toBe('resolved');
    expect(run('stable-subscription', 24 * 7 + 1, 100_000).status).toBe('refused');
    // The record's own earlier expiry still wins.
    expect(run('stable-subscription', 3, -1).status).toBe('refused');
  });

  it('does not match a validation recorded under a changed identity', () => {
    const m = member(A);
    const old = passRecords(m, 'implementer', snapshot());
    const newer = { providers: [{ ...discoveryless(), version: '9.9.9' }], profiles: [] };
    const outcome = resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
      environment: env({ ...newer, validations: old }),
    });
    expect(outcome.status).toBe('refused');
    expect(reasonsOf(outcome)).toEqual(['validation_identity_changed']);
  });

  it('never calls a validation function: a missing validation is simply ineligibility', () => {
    const outcome = resolve('implementer', pinnedRoute(member(A), 'fresh-validation'), {
      environment: env(snapshot()),
    });
    expect(outcome).toMatchObject({ status: 'refused', code: 'route_unavailable' });
  });
});

describe('provider and profile readiness', () => {
  it.each([
    ['missing', { providers: [] }, 'provider_missing'],
    ['not detected', { providers: [provider({ detected: false })] }, 'provider_not_detected'],
    ['disconnected', { providers: [provider({ authentication: 'disconnected' })] }, 'provider_disconnected'],
  ])('refuses a %s provider', (_name, overrides, reason) => {
    const outcome = resolve('implementer', pinnedRoute(member(A)), { environment: env(overrides) });
    expect(reasonsOf(outcome)).toContain(reason);
    expect(outcome.status).toBe('refused');
  });

  it('refuses a provider that cannot execute', () => {
    const p = provider();
    p.capabilities.execution = false;
    expect(
      reasonsOf(resolve('implementer', pinnedRoute(member(A)), { environment: env({ providers: [p] }) })),
    ).toEqual(['provider_execution_unsupported']);
  });

  it('does not invent a connected state: unknown authentication is neither refused nor treated as connected', () => {
    const p = provider({ authentication: 'unknown' });
    expect(
      selectedModel(resolve('implementer', pinnedRoute(member(A)), { environment: env({ providers: [p] }) })),
    ).toBe(A);
    const outcome = resolve('implementer', pinnedRoute(member(A)), { environment: env({ providers: [p] }) });
    expect(outcome.status === 'resolved' && outcome.resolution.evaluatedMembers[0]!.readiness.ok).toBe(true);
  });

  it.each([
    ['codex-cli', 'openai-codex', 'chatgpt-subscription'],
    ['claude-code', 'anthropic-subscription', 'claude-subscription'],
  ] as const)(
    'requires verified subscription authentication for %s, not merely "connected"',
    (backendId, providerId, lane) => {
      const m = member('m-1', { backendId, providerId, lane });
      const make = (subscriptionAuthenticated: boolean | null | undefined) =>
        provider({ id: backendId, authentication: 'connected', subscriptionAuthenticated }, [
          model('m-1', { providerId }),
        ]);
      for (const value of [false, null, undefined]) {
        const outcome = resolve('implementer', pinnedRoute(m), {
          environment: env({ providers: [make(value)] }),
        });
        expect(reasonsOf(outcome)).toEqual(['subscription_auth_unverified']);
      }
      expect(
        selectedModel(
          resolve('implementer', pinnedRoute(m), { environment: env({ providers: [make(true)] }) }),
        ),
      ).toBe('m-1');
    },
  );

  it('refuses a route whose provider cannot bill through its lane', () => {
    const outcome = resolve('implementer', pinnedRoute(member(A, { lane: 'openai-api' })));
    expect(reasonsOf(outcome)).toContain('billing_lane_mismatch');
  });

  it('requires the named profile to exist, match the route and hold credentials, not some other profile', () => {
    const m = (id: string) => member(A, { connectionProfileId: id });
    const environment = env({ profiles: [profile({ id: 'prof-a' }), profile({ id: 'prof-b' }, false)] });
    expect(selectedModel(resolve('implementer', pinnedRoute(m('prof-a')), { environment }))).toBe(A);
    expect(reasonsOf(resolve('implementer', pinnedRoute(m('prof-b')), { environment }))).toEqual([
      'profile_not_ready',
    ]);
    expect(reasonsOf(resolve('implementer', pinnedRoute(m('prof-c')), { environment }))).toEqual([
      'profile_missing',
    ]);
    const mismatched = env({ profiles: [profile({ id: 'prof-a', providerId: 'other' })] });
    expect(reasonsOf(resolve('implementer', pinnedRoute(m('prof-a')), { environment: mismatched }))).toEqual([
      'profile_mismatch',
    ]);
  });
});

describe('billing eligibility', () => {
  const meteredProvider = () => provider({}, [model(A), model('opencode/m', { providerId: 'opencode' })]);
  const metered = () => member('opencode/m', { providerId: 'opencode', lane: 'opencode-metered' });
  const environment = () => env({ providers: [meteredProvider()] });

  it('refuses a metered generative route under subscriptions-only and accepts a subscription route', () => {
    expect(reasonsOf(resolve('implementer', pinnedRoute(metered()), { environment: environment() }))).toEqual(
      ['billing_lane_blocked'],
    );
    expect(
      selectedModel(resolve('implementer', pinnedRoute(member(A)), { environment: environment() })),
    ).toBe(A);
  });

  it('does not read the decision-budget allowance as permission for a generative metered route', () => {
    const outcome = resolve('implementer', pinnedRoute(metered()), {
      environment: environment(),
      limits: limits({ billingMode: 'subscriptions-plus-decision-budget', maxMeteredUsd: 5 }),
    });
    expect(outcome.status).toBe('refused');
    expect(reasonsOf(outcome)).toEqual(['billing_lane_blocked']);
  });

  it('honours custom allowed lanes and a stricter effective workflow restriction', () => {
    const custom = limits({ billingMode: 'custom', maxMeteredUsd: 5 });
    const allowed = resolve('implementer', pinnedRoute(metered()), {
      environment: environment(),
      limits: custom,
      extra: { customAllowedLanes: ['opencode-metered'] },
    });
    expect(selectedModel(allowed)).toBe('opencode/m');
    expect(
      resolve('implementer', pinnedRoute(metered()), {
        environment: environment(),
        limits: custom,
        extra: { customAllowedLanes: ['openrouter-metered'] },
      }).status,
    ).toBe('refused');
    const restricted = resolve('implementer', pinnedRoute(metered()), {
      environment: environment(),
      limits: custom,
      extra: { customAllowedLanes: ['opencode-metered'], workflowBilling: { mode: 'subscriptions-only' } },
    });
    expect(restricted.status).toBe('refused');
    expect(reasonsOf(restricted)).toEqual(['billing_lane_blocked']);
  });

  it('fails closed when a subscription pool meets a metered route, even under a permissive custom mode', () => {
    const malformed = pool('p', [metered(), member(A)], { laneClass: 'subscription' });
    const outcome = resolve('implementer', poolRoute('p'), {
      pools: [malformed],
      environment: environment(),
      limits: limits({ billingMode: 'custom', maxMeteredUsd: 5 }),
      extra: { customAllowedLanes: ['opencode-metered', 'opencode-go-subscription'] },
    });
    // The metered member is skipped, never substituted into: the subscription member is the selection.
    expect(selectedModel(outcome)).toBe(A);
    expect(outcome.status === 'resolved' && outcome.resolution.evaluatedMembers[0]!.reasons).toEqual([
      'pool_lane_blocked',
    ]);
    const onlyMetered = resolve('implementer', poolRoute('p'), {
      pools: [pool('p', [metered()], { laneClass: 'subscription' })],
      environment: environment(),
      limits: limits({ billingMode: 'custom', maxMeteredUsd: 5 }),
      extra: { customAllowedLanes: ['opencode-metered'] },
    });
    expect(onlyMetered).toMatchObject({ status: 'refused', code: 'route_unavailable' });
  });
});

describe('pinned routes', () => {
  it('select exactly the pinned member', () => {
    const outcome = resolve('implementer', pinnedRoute(member(B)));
    expect(outcome).toMatchObject({ status: 'resolved', source: 'computed' });
    expect(outcome.status === 'resolved' && outcome.resolution).toMatchObject({
      routeKind: 'pinned',
      poolId: null,
      selection: 'pinned',
      selectedIndex: 0,
    });
  });

  it('refuse when the pinned route is unusable and never substitute another ready model', () => {
    const outcome = resolve('implementer', pinnedRoute(member(A)), {
      environment: env({
        providers: [provider({}, [model(A, { status: 'unavailable' }), model(B), model(C)])],
      }),
    });
    expect(outcome).toMatchObject({ status: 'refused', code: 'route_unavailable', routeKind: 'pinned' });
    expect(outcome.status === 'refused' && outcome.evaluatedMembers).toHaveLength(1);
  });

  it('refuses a role with no route in the definition', () => {
    const result = resolveRoutes(request({ routing: policy(), roles: ['implementer'] }));
    expect(result).toMatchObject({ ok: false, roles: { implementer: { code: 'route_not_defined' } } });
  });
});

describe('static pools', () => {
  const members = () => [member(A), member(B), member(C)];
  const p = (selection: 'ordered' | 'round_robin', m = members()) => pool('pool', m, { selection });
  const prior = (modelId: string, cycleSequence: number, extra: Record<string, unknown> = {}) => {
    const identity = identityOf(member(modelId), env());
    return {
      cycleSequence,
      role: 'implementer' as const,
      poolId: 'pool',
      selectedIdentityHash: identity.identityHash,
      memberConfigHash: identity.memberConfigHash,
      ...extra,
    };
  };
  const down = (...ids: string[]) =>
    env({
      providers: [
        provider(
          {},
          [A, B, C].map((id) => model(id, ids.includes(id) ? { status: 'unavailable' } : {})),
        ),
      ],
    });

  it('ordered: picks the first eligible member in declared order and skips an ineligible one', () => {
    expect(selectedModel(resolve('implementer', poolRoute('pool'), { pools: [p('ordered')] }))).toBe(A);
    const outcome = resolve('implementer', poolRoute('pool'), {
      pools: [p('ordered')],
      environment: down(A),
    });
    expect(selectedModel(outcome)).toBe(B);
    expect(outcome.status === 'resolved' && outcome.resolution).toMatchObject({
      selection: 'ordered',
      selectedIndex: 1,
    });
  });

  it('refuses when no member is eligible, with every member evaluated', () => {
    const outcome = resolve('implementer', poolRoute('pool'), {
      pools: [p('ordered')],
      environment: down(A, B, C),
    });
    expect(outcome).toMatchObject({
      status: 'refused',
      code: 'route_unavailable',
      routeKind: 'pool',
      poolId: 'pool',
    });
    expect(outcome.status === 'refused' && outcome.evaluatedMembers.map((e) => e.reasons)).toEqual([
      ['model_not_current'],
      ['model_not_current'],
      ['model_not_current'],
    ]);
  });

  it('round robin: starts at the first member with no history, then rotates from the last recorded selection', () => {
    const run = (history: ReturnType<typeof prior>[], environment = down()) =>
      selectedModel(
        resolve('implementer', poolRoute('pool'), {
          pools: [p('round_robin')],
          environment: { ...environment, priorResolutions: history },
        }),
      );
    expect(run([])).toBe(A);
    expect(run([prior(A, 1)])).toBe(B);
    expect(run([prior(A, 1), prior(B, 2)])).toBe(C);
    expect(run([prior(A, 1), prior(B, 2), prior(C, 3)])).toBe(A); // wraps
    // Cycle order, not array order, decides what is most recent.
    expect(run([prior(C, 3), prior(A, 1), prior(B, 2)])).toBe(A);
  });

  it('round robin: skips ineligible members after the last selection, wrapping once', () => {
    const run = (environment: RoutingEnvironment, history: ReturnType<typeof prior>[]) =>
      selectedModel(
        resolve('implementer', poolRoute('pool'), {
          pools: [p('round_robin')],
          environment: { ...environment, priorResolutions: history },
        }),
      );
    expect(run(down(B), [prior(A, 1)])).toBe(C);
    expect(run(down(C, A), [prior(B, 1)])).toBe(B);
    expect(run(down(A, B, C), [prior(A, 1)])).toBeNull();
  });

  it('round robin: a removed historical member restarts from the first current member; other pools and roles are ignored', () => {
    const history = [prior('opencode-go/gone', 5)];
    expect(
      selectedModel(
        resolve('implementer', poolRoute('pool'), {
          pools: [p('round_robin')],
          environment: { ...down(), priorResolutions: history },
        }),
      ),
    ).toBe(A);
    const foreign = [prior(A, 1, { poolId: 'other' }), prior(A, 2, { role: 'routine_reviewer' })];
    expect(
      selectedModel(
        resolve('implementer', poolRoute('pool'), {
          pools: [p('round_robin')],
          environment: { ...down(), priorResolutions: foreign },
        }),
      ),
    ).toBe(A);
  });

  it('round robin: finds the slot by declared member after an adapter version bump changed every identity hash', () => {
    const history = [prior(A, 1)];
    const bumped = env({ providers: [{ ...provider(), version: '2.0.0' }], priorResolutions: history });
    expect(
      selectedModel(
        resolve('implementer', poolRoute('pool'), { pools: [p('round_robin')], environment: bumped }),
      ),
    ).toBe(B);
  });

  it('is a pure dry run: repeating resolution against unchanged history returns the same candidate', () => {
    const environment = { ...down(), priorResolutions: [prior(A, 1)] };
    const results = [1, 2, 3].map(() =>
      JSON.stringify(resolve('implementer', poolRoute('pool'), { pools: [p('round_robin')], environment })),
    );
    expect(new Set(results).size).toBe(1);
    expect(environment.priorResolutions).toHaveLength(1);
  });

  it('returns a persisted current-cycle resolution instead of recomputing, and fails closed if it no longer matches', () => {
    const environment = { ...down(), priorResolutions: [prior(A, 1)] };
    const first = resolve('implementer', poolRoute('pool'), { pools: [p('round_robin')], environment });
    expect(selectedModel(first)).toBe(B);
    const resolution = (first as { resolution: RoleResolution }).resolution;
    // History has since moved on (as if B had been recorded); the persisted cycle resolution still wins.
    const moved = { ...environment, priorResolutions: [prior(A, 1), prior(B, 2)] };
    const again = resolve('implementer', poolRoute('pool'), {
      pools: [p('round_robin')],
      environment: moved,
      extra: { persistedResolutions: { implementer: resolution } },
    });
    expect(again).toMatchObject({ status: 'resolved', source: 'persisted' });
    expect(selectedModel(again)).toBe(B);
    const invalid = (changed: Partial<RoleResolution>, pools = [p('round_robin')]) =>
      resolve('implementer', poolRoute('pool'), {
        pools,
        environment: moved,
        extra: { persistedResolutions: { implementer: { ...resolution, ...changed } } },
      });
    expect(invalid({ definitionHash: 'b'.repeat(64) })).toMatchObject({
      code: 'persisted_resolution_invalid',
    });
    expect(invalid({ definitionVersion: 2 })).toMatchObject({ code: 'persisted_resolution_invalid' });
    expect(invalid({ poolId: 'other' })).toMatchObject({ code: 'persisted_resolution_invalid' });
    expect(invalid({ selectedIndex: 2 })).toMatchObject({ code: 'persisted_resolution_invalid' });
    // The member was removed from the approved pool.
    expect(invalid({}, [p('round_robin', [member(A), member(C)])])).toMatchObject({
      code: 'persisted_resolution_invalid',
    });
  });
});

describe('pool first-use approval', () => {
  const gate = limits({}, { poolRouteFirstUse: true });
  const members = () => [member(A), member(B)];
  const p = () => pool('pool', members());
  const hashOf = (modelId: string, environment = env()) =>
    identityOf(member(modelId), environment).identityHash;
  const run = (environment: RoutingEnvironment, gates = gate) =>
    resolve('implementer', poolRoute('pool'), { pools: [p()], environment, limits: gates });

  it('needs no approval when the gate is disabled', () => {
    expect(selectedModel(resolve('implementer', poolRoute('pool'), { pools: [p()] }))).toBe(A);
  });

  it('reports approval_required for the deterministic candidate, without skipping it to ask less', () => {
    const outcome = run(env({ firstUseApprovals: [approval('pool', hashOf(B))] }));
    expect(outcome).toMatchObject({
      status: 'refused',
      code: 'approval_required',
      candidate: { poolId: 'pool', memberIdentityHash: hashOf(A), memberIndex: 0, approvalId: null },
    });
  });

  it('reports pending for an exact pending approval, and accepts an exact user approval', () => {
    const pending = approval('pool', hashOf(A), { status: 'pending', decidedBy: null, respondedAt: null });
    expect(run(env({ firstUseApprovals: [pending] }))).toMatchObject({
      status: 'refused',
      code: 'approval_pending',
      candidate: { approvalId: pending.id },
    });
    const approved = run(env({ firstUseApprovals: [approval('pool', hashOf(A))] }));
    expect(selectedModel(approved)).toBe(A);
    expect(approved.status === 'resolved' && approved.resolution.approval).toMatchObject({
      state: 'approved',
      poolId: 'pool',
      memberIdentityHash: hashOf(A),
    });
  });

  it('does not accept a system approval', () => {
    const system = approval('pool', hashOf(A), { decidedBy: 'system' });
    expect(run(env({ firstUseApprovals: [system] }))).toMatchObject({ code: 'approval_required' });
  });

  it('treats a denied member as ineligible and moves on to the next authorised member', () => {
    const denied = approval('pool', hashOf(A), { status: 'denied', decidedBy: 'user' });
    const outcome = run(env({ firstUseApprovals: [denied, approval('pool', hashOf(B))] }));
    expect(selectedModel(outcome)).toBe(B);
    expect(outcome.status === 'resolved' && outcome.resolution.evaluatedMembers[0]).toMatchObject({
      eligible: false,
      reasons: ['first_use_denied'],
    });
    expect(run(env({ firstUseApprovals: [denied] }))).toMatchObject({
      code: 'approval_required',
      candidate: { memberIndex: 1 },
    });
  });

  it('binds to pool id and member identity, so a definition amendment keeps the approval but a changed route does not', () => {
    const approvals = [approval('pool', hashOf(A))];
    const amended = resolveRoutes(
      request({
        routing: policy({ roles: { implementer: poolRoute('pool') }, pools: [p()] }),
        roles: ['implementer'],
        limits: gate,
        environment: env({ firstUseApprovals: approvals }),
        extra: { definitionVersion: 7, definitionHash: 'c'.repeat(64) },
      }),
    ).roles.implementer!;
    expect(selectedModel(amended)).toBe(A);
    // A changed identity (adapter version) needs a new approval.
    const changed = env({ providers: [{ ...provider(), version: '2.0.0' }], firstUseApprovals: approvals });
    expect(run(changed)).toMatchObject({ code: 'approval_required' });
    // The same member id in another pool is not approved either.
    const otherPool = pool('other', members());
    expect(
      resolve('implementer', poolRoute('other'), {
        pools: [otherPool],
        environment: env({ firstUseApprovals: approvals }),
        limits: gate,
      }),
    ).toMatchObject({ code: 'approval_required' });
  });

  it('never applies to a pinned route and never mutates its input', () => {
    expect(selectedModel(resolve('implementer', pinnedRoute(member(A)), { limits: gate }))).toBe(A);
    const environment = deepFreeze(env({ firstUseApprovals: [] }));
    expect(() => run(environment)).not.toThrow();
  });

  it('uses the latest decision for a member', () => {
    const denied = approval('pool', hashOf(A), {
      status: 'denied',
      decidedBy: 'user',
      createdAt: hoursAgo(5),
    });
    const reapproved = approval('pool', hashOf(A), { createdAt: hoursAgo(1) });
    expect(selectedModel(run(env({ firstUseApprovals: [denied, reapproved] })))).toBe(A);
    const laterDeny = approval('pool', hashOf(A), {
      status: 'denied',
      decidedBy: 'user',
      createdAt: hoursAgo(0.5),
    });
    expect(
      selectedModel(run(env({ firstUseApprovals: [reapproved, laterDeny, approval('pool', hashOf(B))] }))),
    ).toBe(B);
  });
});

describe('role subsets and audit', () => {
  it('resolves any subset of roles independently', () => {
    const routing = policy({
      roles: {
        orchestrator: pinnedRoute(member(A)),
        implementer: pinnedRoute(member(B)),
        final_reviewer: pinnedRoute(member(C)),
      },
    });
    const some = resolveRoutes(request({ routing, roles: ['final_reviewer', 'orchestrator'] }));
    expect(Object.keys(some.roles).sort()).toEqual(['final_reviewer', 'orchestrator']);
    expect(some.ok).toBe(true);
    const mixed = resolveRoutes(request({ routing, roles: ['implementer', 'routine_reviewer'] }));
    expect(mixed.ok).toBe(false);
    expect(mixed.roles.implementer?.status).toBe('resolved');
    expect(mixed.roles.routine_reviewer).toMatchObject({ code: 'route_not_defined' });
  });

  it('produces a bounded credential-free audit that names the definition, catalog and selection', () => {
    const m = member(A, { connectionProfileId: 'prof-a' });
    const environment = env({ profiles: [profile()] });
    const outcome = resolve('implementer', pinnedRoute(m), { environment });
    expect(outcome.status).toBe('resolved');
    const resolution = (outcome as { resolution: RoleResolution }).resolution;
    expect(resolution).toMatchObject({
      schema: 1,
      definitionVersion: 1,
      role: 'implementer',
      routeKind: 'pinned',
      catalog: { backendId: 'opencode', source: 'live', refreshedAt: NOW, modelStatus: 'current' },
      approval: { state: 'not_required' },
      independence: null,
    });
    expect(resolution.selected.identityHash).toBe(identityOf(m, environment).identityHash);
    const json = JSON.stringify(resolution);
    expect(json).not.toContain('secret://');
    expect(json).not.toContain('credentialStoreRef');
    expect(json.length).toBeLessThan(6_000);
  });
});

describe('final reviewer identity and independence in routing', () => {
  const finalRoute = (m: RouteMember) => pinnedRoute(m);
  const differentFamily = (allow: boolean) =>
    policy({
      independence: {
        finalReview: 'different-family',
        against: ['implementer', 'remediation'],
        allowFloatingFinalReviewer: allow,
      },
    });
  const routing = (m: RouteMember, allow: boolean) => ({
    ...differentFamily(allow),
    roles: { final_reviewer: finalRoute(m) },
  });
  const go = (m: RouteMember, allow: boolean, extra: Partial<RoutingRequest> = {}) =>
    resolveRoutes(request({ routing: routing(m, allow), roles: ['final_reviewer'], extra })).roles
      .final_reviewer!;

  it('refuses a floating or unknown final reviewer unless floating reviewers are allowed', () => {
    for (const identityKind of ['floating', 'unknown'] as const) {
      const outcome = go(member(A, { identityKind }), false);
      expect(outcome.status).toBe('refused');
      expect(reasonsOf(outcome)).toEqual(['floating_independence']);
    }
  });

  it('may run an allowed floating reviewer but never claims independence for it', () => {
    const outcome = go(member(A, { identityKind: 'floating' }), true);
    expect(outcome.status).toBe('resolved');
    expect((outcome as { resolution: RoleResolution }).resolution.independence).toMatchObject({
      established: false,
      reasonCode: 'no_authority',
    });
  });

  it('excludes a member proven not independent and says so when nothing else remains', () => {
    const authority = [
      {
        role: 'implementer' as const,
        configuredModelId: 'claude-sonnet-4-5',
        identityKind: 'pinned' as const,
      },
    ];
    const conflicting = pool('fin', [member('claude-sonnet-4.5'), member('glm-4.6')], {});
    const outcome = resolveRoutes(
      request({
        routing: {
          ...differentFamily(false),
          roles: { final_reviewer: poolRoute('fin') },
          pools: [conflicting],
        },
        roles: ['final_reviewer'],
        environment: env({
          providers: [provider({}, [model('claude-sonnet-4.5'), model('glm-4.6')])],
        }),
        extra: { independenceContext: { authority } },
      }),
    ).roles.final_reviewer!;
    expect(selectedModel(outcome)).toBe('glm-4.6');
    expect(outcome.status === 'resolved' && outcome.resolution.independence).toMatchObject({
      established: true,
      reasonCode: 'established',
    });
    const only = resolveRoutes(
      request({
        routing: {
          ...differentFamily(false),
          roles: { final_reviewer: poolRoute('fin') },
          pools: [pool('fin', [member('claude-sonnet-4.5')])],
        },
        roles: ['final_reviewer'],
        environment: env({ providers: [provider({}, [model('claude-sonnet-4.5')])] }),
        extra: { independenceContext: { authority } },
      }),
    ).roles.final_reviewer!;
    expect(only).toMatchObject({ status: 'refused', code: 'independence_unestablished' });
  });
});

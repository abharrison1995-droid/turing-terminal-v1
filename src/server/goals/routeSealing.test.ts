import { describe, expect, it } from 'vitest';
import type {
  GoalRole,
  GoalRoute,
  RouteMember,
  RoutePool,
  RouteValidationRecord,
} from '../../shared/goals.js';
import { canonicalJson } from './definitionHash.js';
import type { AuthorityModel } from './independence.js';
import { parseRoleResolution, type RoleOutcome, type RoleResolution } from './routeAudit.js';
import { memberConfigHashOf, sha256, validationRecordConsistent } from './routeIdentity.js';
import { resolveRoutes, type RoutingEnvironment, type RoutingRequest } from './routing.js';
import {
  NOW,
  env,
  hoursAgo,
  hoursAhead,
  identityOf,
  member,
  model,
  passRecords,
  policy,
  pool,
  provider,
  request,
} from './routingKit.js';

/** Stage 5A.1: persisted authority is self-authenticating and re-proven against the approved definition. */

const A = 'opencode-go/a';
const B = 'opencode-go/b';

const pinnedRoute = (
  m: RouteMember,
  availability: 'live-catalog' | 'fresh-validation' | 'live-catalog-or-fresh-validation' = 'live-catalog',
  requireRoleValidation = false,
): GoalRoute => ({ kind: 'pinned', member: m, availability, requireRoleValidation });
const poolRoute = (id: string): GoalRoute => ({ kind: 'pool', poolId: id });

function resolve(
  role: GoalRole,
  route: GoalRoute,
  options: {
    pools?: RoutePool[];
    environment?: RoutingEnvironment;
    extra?: Partial<RoutingRequest>;
    routing?: Partial<ReturnType<typeof policy>>;
  } = {},
): RoleOutcome {
  return resolveRoutes(
    request({
      routing: policy({ roles: { [role]: route }, pools: options.pools ?? [], ...options.routing }),
      roles: [role],
      environment: options.environment,
      extra: options.extra,
    }),
  ).roles[role]!;
}
const selectedModel = (outcome: RoleOutcome) =>
  outcome.status === 'resolved' ? outcome.resolution.selected.configuration.modelId : null;
const reasonsOf = (outcome: RoleOutcome, index = 0) =>
  (outcome.status === 'resolved' ? outcome.resolution.evaluatedMembers : outcome.evaluatedMembers)[index]!
    .reasons;

// --- 1. Validation records authenticate themselves ----------------------------------------------------------------

describe('validation record self-consistency', () => {
  const discoveryless = () => {
    const p = provider({ id: 'opencode', catalogSource: 'adapter' }, []);
    p.capabilities.modelDiscovery = false;
    return p;
  };
  const snapshot = () => ({ providers: [discoveryless()], profiles: [] });
  const m = member(A);
  const run = (validations: RouteValidationRecord[]) =>
    resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
      environment: env({ ...snapshot(), validations }),
    });
  const good = () => passRecords(m, 'implementer', snapshot());

  /** Re-seals a forged identity so only the structural rules (not the hash) can reject it. */
  const resealed = (record: RouteValidationRecord, identity: unknown): RouteValidationRecord => ({
    ...record,
    identity: identity as Record<string, unknown>,
    identityHash: sha256(canonicalJson(identity)),
  });

  it('accepts a consistent record set', () => {
    expect(good().every((record) => validationRecordConsistent(record))).toBe(true);
    expect(selectedModel(run(good()))).toBe(A);
  });

  const forgeries: Record<string, (record: RouteValidationRecord) => RouteValidationRecord> = {
    'a forged identity_hash': (record) => ({ ...record, identityHash: 'f'.repeat(64) }),
    'identity json changed but the current hash copied': (record) => ({
      ...record,
      identity: { ...record.identity, modelId: 'someone-else' },
    }),
    'a wrong adapter_version column': (record) => ({ ...record, adapterVersion: '0.0.1' }),
    'a wrong capability_fingerprint column': (record) => ({
      ...record,
      capabilityFingerprint: 'e'.repeat(64),
    }),
    'a malformed identity object (missing field, hash resealed)': (record) => {
      const rest = { ...record.identity };
      delete rest.variantId;
      return resealed(record, rest);
    },
    'a malformed identity object (extra key, hash resealed)': (record) =>
      resealed(record, { ...record.identity, extra: 'x' }),
    'a malformed identity object (wrong type, hash resealed)': (record) =>
      resealed(record, { ...record.identity, nativeSettings: 'nope' }),
    'a non-object identity': (record) => ({ ...record, identity: 'nope' as never }),
    'an unknown identity schema (hash resealed)': (record) =>
      resealed(record, { ...record.identity, schema: 2 }),
  };

  for (const [name, forge] of Object.entries(forgeries)) {
    it(`never qualifies as pass: ${name}`, () => {
      const forged = good().map(forge);
      const outcome = run(forged);
      expect(outcome.status).toBe('refused');
      expect(reasonsOf(outcome)).toEqual(['validation_missing']);
    });

    it(`cannot supersede a valid record: ${name}`, () => {
      // A newer forged failure for the exact identity must not suppress the valid passes.
      const failing = good().map((record) =>
        forge({ ...record, id: `z-${record.id}`, status: 'fail', testedAt: hoursAgo(0.5) }),
      );
      expect(selectedModel(run([...good(), ...failing]))).toBe(A);
    });
  }
});

// --- 2. Future records are not evidence --------------------------------------------------------------------------

describe('future-dated validation records', () => {
  const discoveryless = () => {
    const p = provider({ id: 'opencode', catalogSource: 'adapter' }, []);
    p.capabilities.modelDiscovery = false;
    return p;
  };
  const snapshot = () => ({ providers: [discoveryless()], profiles: [] });
  const m = member(A);
  const run = (validations: RouteValidationRecord[]) =>
    resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
      environment: env({ ...snapshot(), validations }),
    });
  const future = (over: Partial<RouteValidationRecord>) =>
    passRecords(m, 'implementer', snapshot(), {
      testedAt: hoursAhead(1),
      expiresAt: hoursAhead(100),
      ...over,
    });

  it('lets the current pass control over a future pass', () => {
    const current = passRecords(m, 'implementer', snapshot());
    const outcome = run([...current, ...future({})]);
    expect(selectedModel(outcome)).toBe(A);
    expect(outcome.status === 'resolved' && outcome.resolution.validationRecordIds.sort()).toEqual(
      current.map((record) => record.id).sort(),
    );
  });

  it('lets the current pass control over a future failure', () => {
    expect(
      selectedModel(run([...passRecords(m, 'implementer', snapshot()), ...future({ status: 'fail' })])),
    ).toBe(A);
  });

  it('treats a lone future record as missing, pass or fail', () => {
    for (const status of ['pass', 'fail'] as const) {
      const outcome = run(future({ status }));
      expect(outcome.status).toBe('refused');
      expect(reasonsOf(outcome)).toEqual(['validation_missing']);
    }
  });

  it('does not let a future record of another identity report a changed identity', () => {
    const newer = { providers: [{ ...discoveryless(), version: '9.9.9' }], profiles: [] };
    const outcome = resolve('implementer', pinnedRoute(m, 'fresh-validation'), {
      environment: env({ ...newer, validations: future({}) }),
    });
    expect(reasonsOf(outcome)).toEqual(['validation_missing']);
  });
});

// --- 3/4. Persisted route selection is re-proven against the approved member -----------------------------------------

describe('persisted role resolution re-proof', () => {
  const reviewers = (selection: 'ordered' | 'round_robin' = 'round_robin') =>
    pool('revs', [member(A), member(B), member('opencode-go/c')], { selection });
  const base = () => ({
    pools: [reviewers()],
    environment: env({ providers: [provider({}, [model(A), model(B), model('opencode-go/c')])] }),
  });
  const first = () => {
    const outcome = resolve('routine_reviewer', poolRoute('revs'), base());
    if (outcome.status !== 'resolved') throw new Error('fixture must resolve');
    return outcome.resolution;
  };
  const replay = (resolution: unknown, environment = base().environment) =>
    resolve('routine_reviewer', poolRoute('revs'), {
      pools: [reviewers()],
      environment,
      extra: { persistedResolutions: { routine_reviewer: resolution as RoleResolution } },
    });
  const mutated = (change: (draft: RoleResolution) => void): RoleResolution => {
    const draft = structuredClone(first());
    change(draft);
    return draft;
  };
  /** An attacker who also recomputes the member hash beside the corrupted configuration. */
  const withConfig = (draft: RoleResolution, patch: Partial<RoleResolution['selected']['configuration']>) => {
    draft.selected.configuration = { ...draft.selected.configuration, ...patch };
    draft.selected.memberConfigHash = memberConfigHashOf(draft.selected.configuration);
  };

  it('returns the exact persisted resolution even after the environment changed', () => {
    const resolution = first();
    const dead = env({
      providers: [provider({}, [model(A, { status: 'unavailable' })])],
      priorResolutions: [],
    });
    const outcome = replay(resolution, dead);
    expect(outcome).toMatchObject({ status: 'resolved', source: 'persisted' });
    expect(selectedModel(outcome)).toBe(A);
  });

  const corruptions: Record<string, (draft: RoleResolution) => void> = {
    'selected configuration changed, old memberConfigHash kept': (d) => {
      d.selected.configuration = { ...d.selected.configuration, modelId: B };
    },
    'model changed with a recomputed member hash': (d) => withConfig(d, { modelId: B }),
    'provider changed': (d) => withConfig(d, { providerId: 'openrouter' }),
    'backend changed': (d) => withConfig(d, { backendId: 'cline' }),
    'billing lane changed': (d) => withConfig(d, { billingLane: 'openrouter-api' }),
    'connection profile added': (d) => withConfig(d, { connectionProfileId: 'prof-x' }),
    'variant added': (d) => withConfig(d, { variantId: 'fast' }),
    'reasoning added': (d) => withConfig(d, { reasoning: 'high' }),
    'native settings added': (d) => withConfig(d, { nativeSettings: { a: 1 } }),
    'identity kind changed': (d) => {
      d.selected.identityKind = 'floating';
    },
    'selection mode changed': (d) => {
      d.selection = 'ordered';
    },
    'selected index moved to another slot': (d) => {
      d.selectedIndex = 1;
    },
    'selected index out of range': (d) => {
      d.selectedIndex = 9;
    },
    'selected audit entry hash differs': (d) => {
      d.evaluatedMembers[0]!.identityHash = 'd'.repeat(64);
    },
    'selected audit entry configuration differs': (d) => {
      d.evaluatedMembers[0]!.configuration = { ...d.evaluatedMembers[0]!.configuration, modelId: B };
    },
    'selected audit entry member hash differs': (d) => {
      d.evaluatedMembers[0]!.memberConfigHash = 'd'.repeat(64);
    },
    'selected audit entry identity kind differs': (d) => {
      d.evaluatedMembers[0]!.identityKind = 'unknown';
    },
    'selected audit entry index differs': (d) => {
      d.evaluatedMembers[0]!.memberIndex = 2;
    },
    'selected audit entry not eligible': (d) => {
      d.evaluatedMembers[0]!.eligible = false;
    },
    'audit members dropped': (d) => {
      d.evaluatedMembers.pop();
    },
    'approval claimed without a first-use gate': (d) => {
      d.approval = {
        state: 'approved',
        approvalId: 'x',
        poolId: 'revs',
        memberIdentityHash: d.selected.identityHash,
      };
    },
    'validation ids invented': (d) => {
      d.validationRecordIds = ['rec-ghost'];
    },
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    it(`fails closed without recomputing: ${name}`, () => {
      const outcome = replay(mutated(corrupt));
      expect(outcome).toMatchObject({ status: 'refused', code: 'persisted_resolution_invalid' });
    });
  }

  it('does not trust a caller-supplied member hash as proof of the configuration beside it', () => {
    const draft = mutated((d) => withConfig(d, { modelId: 'opencode-go/c' }));
    expect(draft.selected.memberConfigHash).toBe(memberConfigHashOf(draft.selected.configuration));
    expect(replay(draft)).toMatchObject({ code: 'persisted_resolution_invalid' });
  });

  it('keeps stored audit schema bounded: no free text, extra keys or oversized strings', () => {
    const ok = first();
    expect(parseRoleResolution(ok)).not.toBeNull();
    const bad = (change: (draft: RoleResolution) => void) => parseRoleResolution(mutated(change));
    expect(
      bad((d) => ((d.evaluatedMembers[0] as unknown as Record<string, unknown>).note = 'hello')),
    ).toBeNull();
    expect(bad((d) => ((d.evaluatedMembers[0]!.reasons as string[]) = ['the provider said no']))).toBeNull();
    expect(bad((d) => ((d.catalog as unknown as Record<string, unknown>).raw = { models: [] }))).toBeNull();
    expect(bad((d) => ((d.approval as unknown as Record<string, unknown>).secret = 'k'))).toBeNull();
    expect(bad((d) => (d.catalog.source = 'free text' as never))).toBeNull();
    expect(bad((d) => (d.selected.configuration.modelId = 'x'.repeat(201)))).toBeNull();
    expect(bad((d) => (d.evaluatedMembers = 'nope' as never))).toBeNull();
    expect(
      parseRoleResolution({ ...ok, independence: { arbitrary: 'json' } } as unknown as RoleResolution),
    ).toBeNull();
    expect(JSON.stringify(ok)).not.toContain('credentialStoreRef');
  });
});

// --- 9. Final-review independence --------------------------------------------------------------------------------

describe('final-review independence selection', () => {
  const implementer = (over: Partial<AuthorityModel> = {}): AuthorityModel => ({
    role: 'implementer',
    configuredModelId: 'claude-sonnet-4-5',
    identityKind: 'pinned',
    ...over,
  });
  const models = [
    'claude-sonnet-4-5',
    'claude-opus-4-1',
    'glm-4.6',
    'mystery-1',
    'gpt-5',
    'float-1',
    'float-2',
  ];
  const go = (
    members: RouteMember[],
    authority: AuthorityModel[],
    options: { allow?: boolean; finalReview?: 'different-family' | 'different-model' } = {},
  ) =>
    resolve('final_reviewer', poolRoute('fin'), {
      pools: [pool('fin', members)],
      environment: env({
        providers: [
          provider(
            {},
            models.map((id) => model(id)),
          ),
        ],
      }),
      routing: {
        independence: {
          finalReview: options.finalReview ?? 'different-family',
          against: ['implementer', 'remediation'],
          allowFloatingFinalReviewer: options.allow ?? false,
        },
      },
      extra: { independenceContext: { authority } },
    });
  const independenceOf = (outcome: RoleOutcome) =>
    outcome.status === 'resolved' ? outcome.resolution.independence : outcome.independence;

  it('does not spend the final review on a pinned family-unknown candidate ahead of a known independent one', () => {
    const outcome = go([member('mystery-1'), member('glm-4.6')], [implementer()]);
    expect(selectedModel(outcome)).toBe('glm-4.6');
    expect(independenceOf(outcome)).toMatchObject({ established: true, reasonCode: 'established' });
    expect(reasonsOf(outcome, 0)).toEqual(['independence_unestablished']);
    const only = go([member('mystery-1')], [implementer()]);
    expect(only).toMatchObject({ status: 'refused', code: 'independence_unestablished' });
  });

  it('prefers an established candidate over an earlier unestablished one under different-model too', () => {
    const outcome = go(
      [member('mystery-1', { identityKind: 'floating' }), member('gpt-5')],
      [implementer()],
      {
        allow: true,
        finalReview: 'different-model',
      },
    );
    expect(selectedModel(outcome)).toBe('gpt-5');
  });

  it('cannot establish a final review when an authority identity conflicts with its own telemetry', () => {
    const conflicted = implementer({ resolvedModelId: 'gpt-5' });
    for (const allow of [false, true]) {
      const pinned = go([member('glm-4.6')], [conflicted], { allow });
      expect(pinned).toMatchObject({ status: 'refused', code: 'independence_unestablished' });
      expect(independenceOf(pinned)).toBeUndefined();
      const floating = go([member('float-1', { identityKind: 'floating' })], [conflicted], { allow });
      expect(floating.status).toBe('refused');
    }
  });

  it('refuses a pinned candidate when there is no authority, or the authority identity is unproven', () => {
    expect(go([member('glm-4.6')], [])).toMatchObject({ code: 'independence_unestablished' });
    const unproven = implementer({ identityKind: 'floating', configuredModelId: 'float-2' });
    expect(go([member('glm-4.6')], [unproven])).toMatchObject({ code: 'independence_unestablished' });
  });

  it('still permits the documented uncertain fallback for an explicitly allowed floating reviewer', () => {
    const floating = member('float-1', { identityKind: 'floating' });
    const outcome = go([floating], [implementer()], { allow: true });
    expect(outcome.status).toBe('resolved');
    expect(independenceOf(outcome)).toMatchObject({
      established: false,
      reasonCode: 'candidate_identity_unproven',
    });
    expect(go([floating], [implementer()], { allow: false })).toMatchObject({
      code: 'independence_unestablished',
    });
  });

  it('uses the uncertain fallback only when no established candidate is available', () => {
    const floating = member('float-1', { identityKind: 'floating' });
    // Established candidate later in the pool wins.
    expect(selectedModel(go([floating, member('glm-4.6')], [implementer()], { allow: true }))).toBe(
      'glm-4.6',
    );
    // The only other candidate is a proven same-family conflict, so the fallback is used.
    expect(selectedModel(go([member('claude-opus-4-1'), floating], [implementer()], { allow: true }))).toBe(
      'float-1',
    );
  });

  it('does not widen the exception to unproven authority or no authority', () => {
    const floating = member('float-1', { identityKind: 'floating' });
    expect(go([floating], [], { allow: true })).toMatchObject({ code: 'independence_unestablished' });
    const unprovenAuthority = implementer({ identityKind: 'floating', configuredModelId: 'float-2' });
    expect(go([floating], [unprovenAuthority], { allow: true })).toMatchObject({
      code: 'independence_unestablished',
    });
    // different-family also needs the authority's family to be known.
    expect(go([floating], [implementer({ configuredModelId: 'mystery-1' })], { allow: true })).toMatchObject({
      code: 'independence_unestablished',
    });
  });

  it('still excludes a proven same-model or same-family candidate completely', () => {
    expect(selectedModel(go([member('claude-opus-4-1'), member('glm-4.6')], [implementer()]))).toBe(
      'glm-4.6',
    );
    expect(go([member('claude-opus-4-1')], [implementer()], { allow: true })).toMatchObject({
      code: 'independence_unestablished',
    });
    expect(
      go([member('claude-sonnet-4-5')], [implementer()], { finalReview: 'different-model' }),
    ).toMatchObject({
      code: 'independence_unestablished',
    });
    expect(reasonsOf(go([member('claude-opus-4-1')], [implementer()]))).toEqual(['independence_conflict']);
  });

  it('reports an unestablished fallback persisted audit as consistent with the approved allowance only', () => {
    const floating = member('float-1', { identityKind: 'floating' });
    const outcome = go([floating], [implementer()], { allow: true });
    if (outcome.status !== 'resolved') throw new Error('fixture must resolve');
    const replay = (allow: boolean) =>
      resolve('final_reviewer', poolRoute('fin'), {
        pools: [pool('fin', [floating])],
        environment: env({
          providers: [
            provider(
              {},
              models.map((id) => model(id)),
            ),
          ],
        }),
        routing: {
          independence: {
            finalReview: 'different-family',
            against: ['implementer', 'remediation'],
            allowFloatingFinalReviewer: allow,
          },
        },
        extra: { persistedResolutions: { final_reviewer: outcome.resolution } },
      });
    expect(replay(true)).toMatchObject({ status: 'resolved', source: 'persisted' });
    // The definition no longer allows it: the stored uncertain route is not accepted as authority.
    expect(replay(false)).toMatchObject({ code: 'persisted_resolution_invalid' });
  });

  it('keeps identity unproven for later hashes: the candidate identity hash is the exact route', () => {
    const outcome = go([member('glm-4.6')], [implementer()]);
    expect(outcome.status === 'resolved' && outcome.resolution.selected.identityHash).toBe(
      identityOf(
        member('glm-4.6'),
        env({
          providers: [
            provider(
              {},
              models.map((id) => model(id)),
            ),
          ],
        }),
      ).identityHash,
    );
    void NOW;
  });
});

import { describe, expect, it } from 'vitest';
import type { RoleResolution } from './routeAudit.js';
import { MAX_ROUTE_RESOLUTION_JSON, parseRoleResolution } from './routeAudit.js';
import { computeRouteIdentity, isStoredRouteIdentity } from './routeIdentity.js';
import { resolveRoutes } from './routing.js';
import { env, member, model, policy, pool, provider, request } from './routingKit.js';

/** The strict audit schema is never tighter than what the definition validator accepts. */

function resolved(settings: Record<string, string | number>, modelId = 'opencode-go/a'): RoleResolution {
  const m = member(modelId, { nativeSettings: settings });
  const result = resolveRoutes(
    request({
      routing: policy({
        roles: { routine_reviewer: { kind: 'pool', poolId: 'p' } },
        pools: [pool('p', [m])],
      }),
      roles: ['routine_reviewer'],
      environment: env({ providers: [provider({}, [model(modelId)])] }),
    }),
  );
  const outcome = result.roles.routine_reviewer!;
  if (outcome.status !== 'resolved') throw new Error('fixture must resolve');
  return outcome.resolution;
}

describe('audit bounds match accepted definition limits', () => {
  it('accepts nativeSettings beyond 32 keys and 100/200-character keys and values', () => {
    const settings: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) settings[`${'k'.repeat(150)}${i}`] = 'v'.repeat(250);
    const resolution = resolved(settings);
    expect(JSON.stringify(resolution).length).toBeLessThan(MAX_ROUTE_RESOLUTION_JSON);
    expect(parseRoleResolution(JSON.parse(JSON.stringify(resolution)))).not.toBeNull();
  });

  it('accepts route strings longer than 200 characters', () => {
    const long = `opencode-go/${'m'.repeat(400)}`;
    expect(parseRoleResolution(JSON.parse(JSON.stringify(resolved({}, long))))).not.toBeNull();
  });

  it('accepts more than 32 independence authority entries and more than 512 evaluated members by schema', () => {
    const resolution = structuredClone(resolved({}));
    const subject = {
      configuredKey: 'a',
      resolvedKey: null,
      familyKey: null,
      identityKind: 'pinned' as const,
    };
    resolution.independence = {
      established: true,
      required: true,
      policy: 'different-model',
      candidate: subject,
      comparedAgainst: Array.from({ length: 100 }, () => ({ ...subject, role: 'implementer' as const })),
      reasonCode: 'established',
      conflict: false,
    } as unknown as RoleResolution['independence'];
    expect(parseRoleResolution(JSON.parse(JSON.stringify(resolution)))).not.toBeNull();
    const many = structuredClone(resolution);
    many.evaluatedMembers = Array.from({ length: 600 }, (_, i) => ({
      ...many.evaluatedMembers[0]!,
      memberIndex: i,
    }));
    many.selectedIndex = 599;
    expect(parseRoleResolution(JSON.parse(JSON.stringify(many)))).not.toBeNull();
  });

  it('lets the 64 KB persisted cap, not a field limit, be the earlier effective bound', () => {
    const huge = 'x'.repeat(MAX_ROUTE_RESOLUTION_JSON + 1);
    expect(parseRoleResolution(JSON.parse(JSON.stringify(resolved({ k: huge }))))).toBeNull();
  });

  it('authenticates stored identities with long settings', () => {
    const settings = { ['k'.repeat(150)]: 'v'.repeat(300) };
    const m = member('opencode-go/a', { nativeSettings: settings });
    const result = computeRouteIdentity(m, {
      providers: [provider({}, [model('opencode-go/a')])],
      profiles: [],
    });
    if (!result.ok) throw new Error('identity');
    expect(isStoredRouteIdentity(result.value.identity)).toBe(true);
  });
});

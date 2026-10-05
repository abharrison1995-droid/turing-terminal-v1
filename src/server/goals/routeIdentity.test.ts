import { describe, expect, it } from 'vitest';
import { computeRouteIdentity, effectiveIdentityKind } from './routeIdentity.js';
import { member, model, profile, provider } from './routingKit.js';

const A = 'opencode-go/a';
const base = () => ({ providers: [provider()], profiles: [] as ReturnType<typeof profile>[] });
const hash = (m = member(A), snapshot = base()) => {
  const result = computeRouteIdentity(m, snapshot);
  if (!result.ok) throw new Error('incomplete');
  return result.value;
};

describe('route identity', () => {
  it('is a stable SHA-256 over canonical JSON, independent of key order', () => {
    const one = hash(member(A, { nativeSettings: { a: 1, b: 2 } }));
    const two = hash(member(A, { nativeSettings: { b: 2, a: 1 } }));
    expect(one.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(two.identityHash).toBe(one.identityHash);
    expect(hash(member(A, { nativeSettings: { a: 1, b: 2 } })).identityHash).toBe(one.identityHash);
    expect(one.capabilityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(one.adapterVersion).toBe('1.2.3');
    expect(one.identityKind).toBe('pinned');
  });

  it('changes with every identity input', () => {
    const reference = hash().identityHash;
    const withProfile = (overrides = {}, memberOverrides = {}) =>
      hash(member(A, { connectionProfileId: 'prof-a', ...memberOverrides }), {
        providers: [provider()],
        profiles: [profile(overrides)],
      });
    const baseline = withProfile().identityHash;
    expect(baseline).not.toBe(reference);
    const variants: Record<string, string> = {
      profileId: hash(member(A, { connectionProfileId: 'prof-b' }), {
        providers: [provider()],
        profiles: [profile({ id: 'prof-b' })],
      }).identityHash,
      model: hash(member('opencode-go/b')).identityHash,
      variant: hash(member(A, { variantId: 'fast' })).identityHash,
      reasoning: hash(member(A, { reasoning: 'high' })).identityHash,
      nativeSetting: hash(member(A, { nativeSettings: { effort: 'low' } })).identityHash,
      adapterVersion: hash(member(A), { providers: [provider({ version: '1.2.4' })], profiles: [] })
        .identityHash,
      capability: hash(member(A), {
        providers: [provider({}, [model(A, { supportsTools: false })])],
        profiles: [],
      }).identityHash,
      contextLength: hash(member(A), {
        providers: [provider({}, [model(A, { contextLength: 8_000 })])],
        profiles: [],
      }).identityHash,
      catalogStatusClass: hash(member(A), {
        providers: [provider({}, [model(A, { status: 'deprecated' })])],
        profiles: [],
      }).identityHash,
      identityKind: hash(member(A, { identityKind: 'floating' })).identityHash,
      lane: hash(member(A, { lane: 'opencode-metered' })).identityHash,
      backend: hash(member(A, { backendId: 'cline' }), {
        providers: [provider({ id: 'cline' })],
        profiles: [],
      }).identityHash,
    };
    for (const [name, value] of Object.entries(variants)) expect(value, name).not.toBe(reference);
    expect(new Set(Object.values(variants)).size).toBe(Object.values(variants).length);
    // A profile's backend/provider/lane are bound, so changing them changes the identity (and mismatches the route).
    expect(withProfile({ billingLane: 'opencode-metered' }).identityHash).not.toBe(baseline);
    expect(withProfile({ providerId: 'other' }).identityHash).not.toBe(baseline);
  });

  it('binds a profile to the route and never includes credential references or metadata', () => {
    const value = hash(member(A, { connectionProfileId: 'prof-a' }), {
      providers: [provider()],
      profiles: [profile()],
    });
    const json = JSON.stringify(value.identity);
    expect(json).not.toContain('secret://');
    expect(json).not.toContain('secret-bearing');
    expect(json).not.toContain('credentialStoreRef');
    expect(value.identity.connectionProfile).toEqual({
      id: 'prof-a',
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: 'opencode-go-subscription',
    });
    expect(value.issues).toEqual([]);
    expect(
      hash(member(A, { connectionProfileId: 'nope' }), { providers: [provider()], profiles: [profile()] })
        .issues,
    ).toEqual(['profile_missing']);
    expect(
      hash(member(A, { connectionProfileId: 'prof-a' }), {
        providers: [provider()],
        profiles: [profile({ billingLane: 'opencode-metered' })],
      }).issues,
    ).toEqual(['profile_mismatch']);
  });

  it('uses a stable unknown sentinel for an unknown adapter version, which stops matching once a version is known', () => {
    const unknown = hash(member(A), { providers: [provider({ version: null })], profiles: [] });
    expect(unknown.adapterVersion).toBe('unknown');
    expect(unknown.identityHash).not.toBe(hash().identityHash);
    expect(hash(member(A), { providers: [provider({ version: '  ' })], profiles: [] }).identityHash).toBe(
      unknown.identityHash,
    );
  });

  it('matches the exact model only: never by display name, never across providers', () => {
    const other = provider({}, [
      model('opencode-go/z', { name: 'Display opencode-go/a' }),
      model(A, { providerId: 'someone-else' }),
    ]);
    const value = hash(member(A), { providers: [other], profiles: [] });
    expect(value.model).toBeNull();
    expect(hash().model?.id).toBe(A);
  });

  it('refuses an incomplete route and rejects non-finite settings', () => {
    expect(computeRouteIdentity({ ...member(A), configuration: { backendId: 'opencode' } }, base())).toEqual({
      ok: false,
      code: 'route_incomplete',
    });
    expect(() => hash(member(A, { nativeSettings: { x: Number.NaN } }))).toThrow(/non-finite/);
  });

  it('takes the declared identity kind over the classifier, including a declared unknown', () => {
    expect(effectiveIdentityKind({ ...member('opencode-go/x-latest'), identityKind: undefined })).toBe(
      'floating',
    );
    expect(effectiveIdentityKind({ ...member(A), identityKind: undefined })).toBe('pinned');
    expect(effectiveIdentityKind(member(A, { identityKind: 'unknown' }))).toBe('unknown');
    expect(effectiveIdentityKind(member('~moonshot/kimi', { identityKind: 'pinned' }))).toBe('pinned');
  });
});

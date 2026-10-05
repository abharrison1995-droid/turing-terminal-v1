import { describe, expect, it } from 'vitest';
import { evaluateIndependence, type AuthorityModel } from './independence.js';
import { familyKeyOf, lineageOf, normalizeModelKey } from './modelFamily.js';

describe('model family normalisation', () => {
  it('normalises case, known provider prefixes and routing suffixes, and nothing else', () => {
    expect(normalizeModelKey('Claude-Sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelKey('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelKey('openrouter/anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelKey('opencode-go/glm-4.6')).toBe('glm-4.6');
    expect(normalizeModelKey('z-ai/glm-4.6:free')).toBe('glm-4.6');
    expect(normalizeModelKey('moonshotai/kimi-k2:nitro')).toBe('kimi-k2');
    // Unknown namespaces and ids are left as they are: no guessing.
    expect(normalizeModelKey('acme/model-1')).toBe('acme/model-1');
    expect(normalizeModelKey('  ')).toBeNull();
    expect(normalizeModelKey(undefined)).toBeNull();
  });

  it('treats the OpenRouter dotted Claude version as the same model as the dashed one', () => {
    expect(normalizeModelKey('anthropic/claude-sonnet-4.5')).toBe(normalizeModelKey('claude-sonnet-4-5'));
    // Only Claude ids: a dot elsewhere is part of the id.
    expect(normalizeModelKey('glm-4.6')).toBe('glm-4.6');
  });

  it('maps only explicitly recognised lineages to a family', () => {
    expect(familyKeyOf(normalizeModelKey('claude-opus-4-1'))).toBe('anthropic-claude');
    expect(familyKeyOf('sonnet')).toBe('anthropic-claude');
    expect(familyKeyOf('opus[1m]')).toBe('anthropic-claude');
    expect(familyKeyOf('gpt-5-codex')).toBe('openai-gpt');
    expect(familyKeyOf('o3-mini')).toBe('openai-gpt');
    expect(familyKeyOf('gpt-oss-120b')).toBe('openai-gpt-oss');
    expect(familyKeyOf('gemini-2.5-pro')).toBe('google-gemini');
    expect(familyKeyOf('glm-4.6')).toBe('zhipu-glm');
    expect(familyKeyOf('kimi-k2')).toBe('moonshot-kimi');
    expect(familyKeyOf('qwen3-coder')).toBe('alibaba-qwen');
    expect(familyKeyOf('devstral-small')).toBe('mistral');
    expect(familyKeyOf('acme-model-1')).toBeNull();
    expect(familyKeyOf('opus-lookalike-3')).toBeNull();
    expect(familyKeyOf('o33')).toBeNull();
    expect(familyKeyOf(null)).toBeNull();
  });

  it('keeps configured and resolved identities apart and prefers the resolved family', () => {
    const lineage = lineageOf('sonnet', 'claude-sonnet-4-5');
    expect(lineage).toEqual({
      configuredKey: 'sonnet',
      resolvedKey: 'claude-sonnet-4-5',
      familyKey: 'anthropic-claude',
    });
    expect(lineageOf('acme-1').resolvedKey).toBeNull();
  });
});

const impl = (configuredModelId: string, extra: Partial<AuthorityModel> = {}): AuthorityModel => ({
  role: 'implementer',
  configuredModelId,
  identityKind: 'pinned',
  ...extra,
});
const check = (
  policy: 'different-family' | 'different-model' | 'none',
  candidate: string,
  authority: AuthorityModel[],
  options: {
    kind?: 'pinned' | 'floating' | 'unknown';
    resolved?: string;
    against?: Array<'implementer' | 'remediation' | 'orchestrator'>;
  } = {},
) =>
  evaluateIndependence({
    policy,
    against: options.against ?? ['implementer', 'remediation'],
    candidate: {
      configuredModelId: candidate,
      resolvedModelId: options.resolved ?? null,
      identityKind: options.kind ?? 'pinned',
    },
    authority,
  });

describe('independence evaluation', () => {
  it('does not treat the same exact model through another provider as independent', () => {
    const authority = [impl('openrouter/anthropic/claude-sonnet-4.5')];
    for (const policy of ['different-family', 'different-model'] as const) {
      const result = check(policy, 'claude-sonnet-4-5', authority);
      expect(result).toMatchObject({ established: false, conflict: true, reasonCode: 'same_model' });
    }
  });

  it('does not treat known aliases of one family as different families, but they are different models', () => {
    const authority = [impl('claude-sonnet-4-5')];
    expect(check('different-family', 'claude-opus-4-1', authority)).toMatchObject({
      established: false,
      conflict: true,
      reasonCode: 'same_family',
    });
    expect(check('different-family', 'opus', authority, { kind: 'floating' })).toMatchObject({
      established: false,
      reasonCode: 'candidate_identity_unproven',
    });
    expect(check('different-model', 'claude-opus-4-1', authority)).toMatchObject({ established: true });
  });

  it('establishes independence only between known, different families', () => {
    const result = check('different-family', 'gpt-5', [impl('claude-sonnet-4-5')]);
    expect(result).toMatchObject({
      established: true,
      required: true,
      reasonCode: 'established',
      conflict: false,
    });
    expect(result.candidate).toMatchObject({ familyKey: 'openai-gpt' });
    expect(result.comparedAgainst[0]).toMatchObject({ role: 'implementer', familyKey: 'anthropic-claude' });
  });

  it('cannot establish different-family when a family is unknown, but different-model still can', () => {
    const authority = [impl('acme-model-1')];
    expect(check('different-family', 'zeta-model-2', authority)).toMatchObject({
      established: false,
      conflict: false,
      reasonCode: 'family_unknown',
    });
    expect(check('different-family', 'gpt-5', authority)).toMatchObject({
      established: false,
      reasonCode: 'family_unknown',
    });
    expect(check('different-model', 'zeta-model-2', authority)).toMatchObject({ established: true });
    // Equal unknown ids are still provably the same model.
    expect(check('different-family', 'acme-model-1', authority)).toMatchObject({
      established: false,
      conflict: true,
      reasonCode: 'same_model',
    });
  });

  it('compares exact normalised keys for different-model', () => {
    expect(check('different-model', 'gpt-5', [impl('claude-sonnet-4-5')])).toMatchObject({
      established: true,
    });
    expect(check('different-model', 'gpt-5', [impl('openai/gpt-5')])).toMatchObject({
      established: false,
      reasonCode: 'same_model',
    });
  });

  it('does not let a floating or unknown candidate establish independence without trusted resolved telemetry', () => {
    const authority = [impl('claude-sonnet-4-5')];
    for (const kind of ['floating', 'unknown'] as const)
      expect(check('different-model', 'gpt-5', authority, { kind })).toMatchObject({
        established: false,
        reasonCode: 'candidate_identity_unproven',
      });
    expect(
      check('different-family', '~vendor/model', authority, { kind: 'floating', resolved: 'gpt-5' }),
    ).toMatchObject({
      established: true,
    });
  });

  it('lets resolved telemetry defeat apparent independence', () => {
    // Configured as an auto-router, but it actually ran gpt-5; the candidate is pinned gpt-5.
    const authority = [
      impl('openrouter/auto', { identityKind: 'floating', resolvedModelId: 'openai/gpt-5' }),
    ];
    expect(check('different-model', 'gpt-5', authority)).toMatchObject({
      established: false,
      reasonCode: 'same_model',
    });
    expect(check('different-family', 'gpt-5-mini', authority)).toMatchObject({
      established: false,
      reasonCode: 'same_family',
    });
    // Without telemetry the floating authority proves nothing, so nothing is established either.
    expect(
      check('different-model', 'gpt-5', [impl('openrouter/auto', { identityKind: 'floating' })]),
    ).toMatchObject({
      established: false,
      reasonCode: 'authority_identity_unproven',
    });
  });

  it('refuses to choose between a pinned configured id and a contradicting resolved id', () => {
    expect(
      check('different-model', 'gpt-5', [impl('claude-sonnet-4-5', { resolvedModelId: 'glm-4.6' })]),
    ).toMatchObject({
      established: false,
      conflict: false,
      reasonCode: 'identity_conflict',
    });
    expect(
      check('different-model', 'gpt-5', [impl('claude-sonnet-4-5')], { resolved: 'gemini-2.5-pro' }),
    ).toMatchObject({
      reasonCode: 'identity_conflict',
    });
  });

  it('omits the orchestrator by default and includes it only when the policy asks', () => {
    const authority: AuthorityModel[] = [
      impl('claude-sonnet-4-5'),
      { role: 'orchestrator', configuredModelId: 'gpt-5', identityKind: 'pinned' },
    ];
    const byDefault = check('different-model', 'gpt-5', authority);
    expect(byDefault).toMatchObject({ established: true });
    expect(byDefault.comparedAgainst.map((entry) => entry.role)).toEqual(['implementer']);
    expect(
      check('different-model', 'gpt-5', authority, { against: ['implementer', 'orchestrator'] }),
    ).toMatchObject({
      established: false,
      reasonCode: 'same_model',
    });
    // The remediation model is compared when listed.
    const withRemediation = [impl('claude-sonnet-4-5'), { ...impl('gpt-5'), role: 'remediation' as const }];
    expect(check('different-model', 'gpt-5', withRemediation)).toMatchObject({ established: false });
  });

  it('reports policy none as not required, and no authority as unestablished', () => {
    expect(check('none', 'gpt-5', [impl('gpt-5')])).toMatchObject({
      established: false,
      required: false,
      policy: 'none',
      reasonCode: 'policy_none',
    });
    expect(check('different-model', 'gpt-5', [])).toMatchObject({
      established: false,
      reasonCode: 'no_authority',
    });
  });

  it('keeps proven overlap a conflict even when another comparison is unproven', () => {
    const authority = [impl('acme-1', { identityKind: 'floating' }), impl('gpt-5')];
    expect(check('different-model', 'gpt-5', authority)).toMatchObject({
      conflict: true,
      reasonCode: 'same_model',
    });
  });
});

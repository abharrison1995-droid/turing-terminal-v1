import { describe, expect, it } from 'vitest';
import {
  decisionPrerequisites,
  unmetPrerequisites,
  type PrerequisiteInput,
  type PrerequisiteProfile,
} from './decisionPrerequisites';

const openRouterProfile: PrerequisiteProfile = {
  id: 'p-or',
  name: 'OpenRouter decisions',
  backendId: 'openrouter',
  billingLane: 'openrouter-metered',
  credentials: { inference: true, management: false },
};

const catalogue = {
  detected: true,
  catalogSource: 'live' as const,
  checkedAt: '2026-10-20T10:00:00.000Z',
  models: [
    { id: 'typesafe/jev-1.13', name: 'Jev 1.13', providerId: 'openrouter', family: 'decision' as const },
    { id: 'typesafe/jev-1.12', name: 'Jev 1.12', providerId: 'openrouter', family: 'decision' as const },
    { id: 'vendor/judge-1', name: 'Judge', providerId: 'openrouter', family: 'generative' as const },
  ],
};

const ready = (overrides: Partial<PrerequisiteInput> = {}): PrerequisiteInput => ({
  engine: 'jev-openrouter',
  modelId: 'typesafe/jev-1.13',
  connectionProfileId: 'p-or',
  profiles: [openRouterProfile],
  openRouter: catalogue,
  billingMode: 'subscriptions-plus-decision-budget',
  perRunUsd: 0.05,
  externalDataPolicy: 'ask-first',
  ...overrides,
});

const byId = (input: PrerequisiteInput) =>
  Object.fromEntries(decisionPrerequisites(input).map((item) => [item.id, item]));

describe('decision gate prerequisites', () => {
  it('lists the five prerequisites together, in explanation order', () => {
    expect(decisionPrerequisites(ready()).map((item) => item.id)).toEqual([
      'connection',
      'model',
      'cap',
      'billing',
      'external-data',
    ]);
  });

  it('needs nothing for a deterministic gate', () => {
    expect(decisionPrerequisites(ready({ engine: 'deterministic-rules' }))).toEqual([]);
  });

  it('is satisfied when everything is configured, without claiming account credit', () => {
    const items = byId(ready());
    expect(unmetPrerequisites(Object.values(items))).toEqual([]);
    expect(items.connection!.detail).toMatch(/cannot tell whether the OpenRouter account has credit/);
    expect(items['external-data']!.status).toBe('met');
    expect(items['external-data']!.detail).toMatch(/Not yet authorised/);
  });

  it('reports every missing prerequisite with an explicit fix and fixes nothing itself', () => {
    const input = ready({
      connectionProfileId: undefined,
      profiles: [],
      modelId: undefined,
      perRunUsd: null,
      billingMode: 'subscriptions-only',
      externalDataPolicy: 'block',
    });
    const items = byId(input);
    expect(Object.values(items).map((item) => [item.id, item.status, item.fix?.kind])).toEqual([
      ['connection', 'missing', 'open-openrouter-settings'],
      ['model', 'missing', 'choose-model'],
      ['cap', 'attention', 'set-cap'],
      ['billing', 'missing', 'use-decision-budget'],
      ['external-data', 'missing', 'set-external-policy'],
    ]);
    expect(input.billingMode).toBe('subscriptions-only');
    expect(input.perRunUsd).toBeNull();
    expect(input.externalDataPolicy).toBe('block');
  });

  it('asks to choose, not to add, when an OpenRouter connection already exists', () => {
    const items = byId(ready({ connectionProfileId: undefined }));
    expect(items.connection!.fix?.kind).toBe('choose-connection');
  });

  it('flags a selected profile that is not OpenRouter or has no stored key', () => {
    expect(
      byId(
        ready({
          profiles: [
            { ...openRouterProfile, id: 'x', backendId: 'opencode', billingLane: 'opencode-go-subscription' },
          ],
          connectionProfileId: 'x',
        }),
      ).connection!.status,
    ).toBe('missing');
    const noKey = byId(
      ready({ profiles: [{ ...openRouterProfile, credentials: { inference: false, management: false } }] }),
    );
    expect(noKey.connection!.status).toBe('missing');
    expect(noKey.connection!.summary).toMatch(/no inference key/);
  });

  it('requires a per-run cap in Subscriptions + Decision Budget but only flags it in Custom', () => {
    expect(byId(ready({ perRunUsd: null })).cap!.status).toBe('missing');
    expect(byId(ready({ billingMode: 'custom', perRunUsd: null })).cap!.status).toBe('attention');
    expect(byId(ready({ perRunUsd: 0 })).cap!.status).toBe('attention');
  });

  it('uses the shared billing gate: Custom must list the metered lane', () => {
    expect(byId(ready({ billingMode: 'custom' })).billing!.status).toBe('met');
    const blocked = byId(
      ready({ billingMode: 'custom', customAllowedLanes: ['codex-subscription' as never] }),
    );
    expect(blocked.billing!.status).toBe('missing');
    expect(blocked.billing!.fix?.kind).toBe('edit-allowed-lanes');
  });

  it('keeps a saved exact model that left the catalogue instead of migrating it', () => {
    const input = ready({ modelId: 'typesafe/jev-1.0' });
    const model = byId(input).model!;
    expect(model.status).toBe('attention');
    expect(model.detail).toMatch(/will not substitute a newer one/);
    expect(input.modelId).toBe('typesafe/jev-1.0');
  });

  it('reports an unavailable catalogue as Unknown, not as incompatible', () => {
    const model = byId(ready({ openRouter: { ...catalogue, detected: false, models: [] } })).model!;
    expect(model.status).toBe('unknown');
    expect(model.fix).toBeUndefined();
  });

  it('rejects a generative model for JEV and treats a floating alias as attention', () => {
    expect(byId(ready({ modelId: 'vendor/judge-1' })).model!.status).toBe('missing');
    const floating = byId(
      ready({
        modelId: 'typesafe/jev-latest',
        openRouter: {
          ...catalogue,
          models: [
            ...catalogue.models,
            { id: 'typesafe/jev-latest', name: 'Jev latest', providerId: 'openrouter', family: 'decision' },
          ],
        },
      }),
    ).model!;
    expect(floating.status).toBe('attention');
    expect(floating.summary).toMatch(/floating alias/);
  });

  it('treats allow and ask-first as met but never as already authorised for ask-first', () => {
    expect(byId(ready({ externalDataPolicy: 'allow' }))['external-data']!.status).toBe('met');
    expect(byId(ready({ externalDataPolicy: 'ask-first' }))['external-data']!.summary).toMatch(/Asks you/);
  });
});

import { describe, expect, it } from 'vitest';
import { billingLanesForBackend, routeMatchesBillingLane } from './billing';
import {
  PROVIDER_SERVICES,
  connectionProfileForService,
  planLabelOf,
  providerServiceById,
  providerServiceForRoute,
  routeReadiness,
} from './providerServices';
import type { ProviderCapabilities, ProviderStatus } from './types';

const capabilities = (modelDiscovery: boolean): ProviderCapabilities => ({
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: false,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
});

const provider = (overrides: Partial<ProviderStatus> & Pick<ProviderStatus, 'id'>): ProviderStatus => ({
  name: overrides.id,
  cli: overrides.id,
  detected: true,
  version: '1.0.0',
  authentication: 'unknown',
  subscriptionAuthenticated: null,
  authMechanism: 'official CLI',
  note: '',
  checkedAt: '2026-10-20T10:00:00.000Z',
  capabilities: capabilities(false),
  models: [],
  catalogSource: 'none',
  catalogRefreshedAt: null,
  ...overrides,
});

const NOW = Date.parse('2026-10-20T10:05:00.000Z');

describe('provider service routes', () => {
  it('offers exactly the four documented routes', () => {
    expect(
      PROVIDER_SERVICES.map((service) => [
        service.id,
        service.backendId,
        service.providerId,
        service.billingLane,
      ]),
    ).toEqual([
      ['opencode-go', 'opencode', 'opencode-go', 'opencode-go-subscription'],
      ['codex-chatgpt', 'codex-cli', 'openai-codex', 'chatgpt-subscription'],
      ['claude-subscription', 'claude-code', 'anthropic-subscription', 'claude-subscription'],
      ['clinepass', 'cline', 'cline-pass', 'clinepass-subscription'],
    ]);
  });

  it('only derives routes the server accepts and that the backend can bill through', () => {
    for (const service of PROVIDER_SERVICES) {
      expect(routeMatchesBillingLane(service.backendId, service.providerId, service.billingLane)).toBe(true);
      expect(billingLanesForBackend(service.backendId)).toContain(service.billingLane);
    }
  });

  it('never routes a subscription service through a metered lane', () => {
    for (const service of PROVIDER_SERVICES) {
      expect(service.billingLane).toMatch(/subscription$/);
    }
  });

  it('derives every route field and keeps credentials out of the saved profile', () => {
    const service = providerServiceById('clinepass')!;
    const profile = connectionProfileForService(service, { name: '  ClinePass  ', planLabel: ' Team ' });
    expect(profile).toEqual({
      name: 'ClinePass',
      backendId: 'cline',
      providerId: 'cline-pass',
      billingLane: 'clinepass-subscription',
      credentialStoreRef: null,
      metadata: { serviceId: 'clinepass', planLabel: 'Team' },
    });
    expect(JSON.stringify(profile)).not.toMatch(/key|token|secret|password/i);
    expect(planLabelOf(profile as never)).toBe('Team');
  });

  it('omits an empty plan label and treats it as unverified user text', () => {
    const profile = connectionProfileForService(providerServiceById('opencode-go')!, {
      name: 'Go',
      planLabel: '   ',
    });
    expect(profile.metadata).toEqual({ serviceId: 'opencode-go' });
    expect(planLabelOf(profile as never)).toBeNull();
  });

  it('recognises a saved route as a service and leaves custom routes unrecognised', () => {
    expect(providerServiceForRoute('codex-cli', 'openai-codex', 'chatgpt-subscription')?.id).toBe(
      'codex-chatgpt',
    );
    expect(providerServiceForRoute('opencode', 'openai', 'openai-api')).toBeUndefined();
  });

  it('never tells people to run an installer through Turing or to use an API-billing sign-in', () => {
    const text = JSON.stringify(PROVIDER_SERVICES);
    expect(text).not.toMatch(/--console\s+['"]?claude auth login|login --with-api-key/);
    const claude = providerServiceById('claude-subscription')!;
    expect(claude.signIn.commands.map((item) => item.command)).toEqual([
      'claude auth login',
      'claude auth status',
    ]);
    expect(claude.signIn.note).toMatch(/--console/);
  });
});

describe('route readiness keeps installation, authentication, catalogue and last check apart', () => {
  it('reports an unknown provider honestly and blocks saving', () => {
    const readiness = routeReadiness('opencode', 'opencode-go', undefined, NOW);
    expect(readiness.installation.state).toBe('unknown');
    expect(readiness.authentication.state).toBe('unknown');
    expect(readiness.canSave).toBe(false);
  });

  it('does not imply sign-in from a detected CLI', () => {
    const readiness = routeReadiness('codex-cli', 'openai-codex', provider({ id: 'codex-cli' }), NOW);
    expect(readiness.installation.state).toBe('ok');
    expect(readiness.authentication).toMatchObject({ state: 'unknown', label: 'Unknown' });
    expect(readiness.catalogue.state).toBe('unknown');
    expect(readiness.canSave).toBe(true);
  });

  it('shows Codex ChatGPT sign-in only when the CLI reports it, and a mismatch as missing', () => {
    const signedIn = routeReadiness(
      'codex-cli',
      'openai-codex',
      provider({ id: 'codex-cli', authentication: 'connected', subscriptionAuthenticated: true }),
      NOW,
    );
    expect(signedIn.authentication.state).toBe('ok');
    const apiKey = routeReadiness(
      'codex-cli',
      'openai-codex',
      provider({ id: 'codex-cli', authentication: 'connected', subscriptionAuthenticated: false }),
      NOW,
    );
    expect(apiKey.authentication.state).toBe('missing');
  });

  it('treats an OpenCode credential as attention, never as OpenCode Go', () => {
    const readiness = routeReadiness(
      'opencode',
      'opencode-go',
      provider({ id: 'opencode', authentication: 'connected' }),
      NOW,
    );
    expect(readiness.authentication.state).toBe('attention');
    expect(readiness.authentication.detail).toMatch(/cannot tell which provider/);
  });

  it('counts only models of the connected OpenCode provider', () => {
    const status = provider({
      id: 'opencode',
      capabilities: capabilities(true),
      catalogSource: 'live',
      models: [
        { id: 'opencode-go/a', name: 'A', providerId: 'opencode-go' },
        { id: 'openai/b', name: 'B', providerId: 'openai' },
      ],
    });
    expect(routeReadiness('opencode', 'opencode-go', status, NOW).catalogue).toMatchObject({
      state: 'ok',
      label: '1 model listed',
    });
    const other = provider({
      id: 'opencode',
      capabilities: capabilities(true),
      catalogSource: 'live',
      models: [{ id: 'openai/b', name: 'B', providerId: 'openai' }],
    });
    expect(routeReadiness('opencode', 'opencode-go', other, NOW).catalogue.state).toBe('attention');
  });

  it('marks a last-known catalogue as attention and an empty one as attention, not failure', () => {
    const cached = provider({
      id: 'codex-cli',
      capabilities: capabilities(true),
      catalogSource: 'cache',
      models: [{ id: 'm', name: 'M', providerId: 'openai-codex' }],
    });
    expect(routeReadiness('codex-cli', 'openai-codex', cached, NOW).catalogue.state).toBe('attention');
    const empty = provider({ id: 'codex-cli', capabilities: capabilities(true), models: [] });
    expect(routeReadiness('codex-cli', 'openai-codex', empty, NOW).catalogue.label).toBe('Empty');
  });

  it('keeps Cline sign-in Unknown even when everything else looks healthy', () => {
    const readiness = routeReadiness(
      'cline',
      'cline-pass',
      provider({ id: 'cline', authentication: 'connected' }),
      NOW,
    );
    expect(readiness.authentication).toMatchObject({ state: 'unknown' });
    expect(readiness.catalogue.state).toBe('unknown');
  });

  it('needs a Claude subscription sign-in to be reported, otherwise Unknown or missing', () => {
    expect(
      routeReadiness('claude-code', 'anthropic-subscription', provider({ id: 'claude-code' }), NOW)
        .authentication.state,
    ).toBe('unknown');
    expect(
      routeReadiness(
        'claude-code',
        'anthropic-subscription',
        provider({ id: 'claude-code', authentication: 'disconnected', subscriptionAuthenticated: false }),
        NOW,
      ).authentication.state,
    ).toBe('missing');
  });

  it('blocks saving, and does not check sign-in, when the CLI is not installed', () => {
    const readiness = routeReadiness(
      'claude-code',
      'anthropic-subscription',
      provider({ id: 'claude-code', name: 'Claude Code', cli: 'claude', detected: false, version: null }),
      NOW,
    );
    expect(readiness.installation.state).toBe('missing');
    expect(readiness.authentication.state).toBe('unknown');
    expect(readiness.canSave).toBe(false);
    expect(readiness.saveBlocker).toMatch(/not detected/);
  });

  it('shows the last check separately and relative to now', () => {
    const readiness = routeReadiness('codex-cli', 'openai-codex', provider({ id: 'codex-cli' }), NOW);
    expect(readiness.lastCheck.label).toBe('5 min ago');
  });
});

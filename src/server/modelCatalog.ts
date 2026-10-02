import type { ModelOption, ProviderCapabilities, ProviderSpendTelemetry, ProviderStatus } from '../shared/types.js';
import { classifyModelIdentity } from '../shared/modelSettings.js';
import type { Db } from './db.js';
import { discoverProviders, invalidateProviderCache } from './providers.js';
import { fetchAccountCredits, fetchKeyTelemetry, fetchOpenRouterCatalog, jevAdapterMetadata } from './openrouter.js';
import { SecretStore, secretRef } from './secretStore.js';
import { toConnectionProfile } from './serialize.js';
import { redactSecrets } from './security.js';

/**
 * Model catalog cache. A successful live discovery replaces the cached catalog; when discovery
 * returns nothing, cached entries are shown as LAST KNOWN (never as current truth).
 */
export function applyCatalogCache(db: Db, providers: ProviderStatus[]): ProviderStatus[] {
  const upsert = db.prepare(
    `INSERT INTO model_catalog_cache (backend_id, model_id, provider_id, display_name, model_json, adapter_version, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(backend_id, model_id) DO UPDATE SET provider_id = excluded.provider_id, display_name = excluded.display_name,
       model_json = excluded.model_json, adapter_version = excluded.adapter_version, discovered_at = excluded.discovered_at`,
  );
  return providers.map((provider) => {
    const live = provider.models.filter((model) => model.status !== 'last-known');
    if (live.length) {
      db.transaction(() => {
        for (const model of live)
          upsert.run(provider.id, model.id, model.providerId, model.name, JSON.stringify(model), provider.version, model.discoveredAt ?? provider.checkedAt);
      })();
      return {
        ...provider,
        catalogSource: provider.catalogSource ?? 'live',
        catalogRefreshedAt: provider.checkedAt,
        models: provider.models.map((model) => ({
          ...model,
          status: model.status ?? 'current',
          identity: model.identity ?? classifyModelIdentity(provider.id, model.id),
        })),
      };
    }
    const cached = db
      .prepare('SELECT model_json, discovered_at FROM model_catalog_cache WHERE backend_id = ? ORDER BY display_name COLLATE NOCASE')
      .all(provider.id) as Array<{ model_json: string; discovered_at: string }>;
    if (!cached.length) return { ...provider, catalogSource: provider.models.length ? 'adapter' : 'none', catalogRefreshedAt: null };
    const models = cached.flatMap((row): ModelOption[] => {
      try {
        return [{ ...(JSON.parse(row.model_json) as ModelOption), status: 'last-known', discoveredAt: row.discovered_at }];
      } catch {
        return [];
      }
    });
    return {
      ...provider,
      catalogSource: 'cache',
      catalogRefreshedAt: cached[0]?.discovered_at ?? null,
      models: [...models, ...provider.models.filter((model) => !models.some((item) => item.id === model.id))],
    };
  });
}

const openRouterCaps: ProviderCapabilities = {
  authentication: true,
  subscriptionAuth: false,
  modelDiscovery: true,
  execution: true,
  streaming: false,
  cancellation: true,
  usageTelemetry: true,
  remainingAllowance: true,
  resetTelemetry: true,
  structuredOutput: true,
  sessionResume: false,
  toolMediation: true,
  meteredBilling: true,
  providerSideFallbackStatus: false,
  decisions: true,
};

let openRouterCatalog: { models: ModelOption[]; expires: number; checkedAt: string } | null = null;

export function invalidateOpenRouterCatalog(): void {
  openRouterCatalog = null;
}

export function openRouterProfiles(db: Db) {
  return (db.prepare("SELECT * FROM connection_profiles WHERE backend_id = 'openrouter' ORDER BY name COLLATE NOCASE").all() as Array<Record<string, unknown>>).map(
    toConnectionProfile,
  );
}

/** OpenRouter is optional: without a connection profile Turing makes no OpenRouter network request. */
export async function openRouterProviderStatus(db: Db, options: { fetchImpl?: typeof fetch } = {}): Promise<ProviderStatus> {
  const profiles = openRouterProfiles(db);
  const store = SecretStore.forDatabase(db);
  const withKey = profiles.filter((profile) => store.has(secretRef(profile.id, 'inference')));
  const checkedAt = new Date().toISOString();
  if (!profiles.length)
    return {
      id: 'openrouter',
      name: 'OpenRouter',
      cli: 'https',
      detected: false,
      version: null,
      authentication: 'disconnected',
      subscriptionAuthenticated: false,
      authMechanism: 'OpenRouter inference key stored on this desktop',
      note: 'Optional metered provider. Not configured; nothing uses OpenRouter until you add a connection and explicitly select it.',
      checkedAt,
      capabilities: openRouterCaps,
      models: [],
      catalogSource: 'none',
    };
  if (!openRouterCatalog || Date.now() > openRouterCatalog.expires) {
    const models = await fetchOpenRouterCatalog(options.fetchImpl);
    openRouterCatalog = { models, expires: Date.now() + (models.length ? 10 * 60_000 : 60_000), checkedAt };
  }
  const models = [...openRouterCatalog.models];
  if (models.length && !models.some((model) => model.family === 'decision')) models.push(jevAdapterMetadata());
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    cli: 'https',
    detected: true,
    version: 'api-v1',
    authentication: withKey.length ? 'connected' : 'disconnected',
    subscriptionAuthenticated: false,
    authMechanism: 'OpenRouter inference key stored on this desktop',
    note: withKey.length
      ? 'Metered. Requests are billed to your OpenRouter account and are subject to Turing reservations, budgets, and provider max-price ceilings.'
      : 'An OpenRouter connection exists but has no stored inference key.',
    checkedAt: openRouterCatalog.checkedAt,
    capabilities: openRouterCaps,
    models,
  };
}

export async function allProviders(db: Db, options: { refresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<ProviderStatus[]> {
  if (options.refresh) {
    invalidateProviderCache();
    invalidateOpenRouterCatalog();
  }
  const [cli, openRouter] = await Promise.all([discoverProviders(), openRouterProviderStatus(db, options)]);
  return applyCatalogCache(db, [...cli.filter((provider) => provider.id !== 'openrouter'), openRouter]);
}

/** Provider-measured key (and optionally account) telemetry. Uses metadata endpoints only — no generation. */
export async function openRouterTelemetry(db: Db, options: { fetchImpl?: typeof fetch } = {}): Promise<{ telemetry: ProviderSpendTelemetry[]; errors: string[] }> {
  const store = SecretStore.forDatabase(db);
  const telemetry: ProviderSpendTelemetry[] = [];
  const errors: string[] = [];
  for (const profile of openRouterProfiles(db)) {
    const inference = store.read(secretRef(profile.id, 'inference'));
    if (inference)
      try {
        telemetry.push(await fetchKeyTelemetry(inference, profile.id, options.fetchImpl));
      } catch (error) {
        errors.push(`${profile.name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    const management = store.read(secretRef(profile.id, 'management'));
    if (management)
      try {
        telemetry.push(await fetchAccountCredits(management, profile.id, options.fetchImpl));
      } catch (error) {
        errors.push(`${profile.name} account: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
  }
  return { telemetry, errors };
}

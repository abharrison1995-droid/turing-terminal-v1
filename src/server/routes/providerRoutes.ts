import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { billingLaneLabel, routeMatchesBillingLane } from '../../shared/billing.js';
import { isValidTimeZone, systemTimeZone } from '../../shared/timezone.js';
import type { Db } from '../db.js';
import { budgetStatus, getBudgetSettings, saveBudgetSettings } from '../meteredBudget.js';
import { allProviders, openRouterTelemetry } from '../modelCatalog.js';
import { listOpportunityAdmissionTargets } from '../goals/opportunityAdmission.js';
import {
  listModelOpportunityObservations,
  modelObservationRefreshesFromProviders,
  persistModelObservationRefreshes,
  runModelObservationRetention,
} from '../modelOpportunity.js';
import { SecretStore, secretRef } from '../secretStore.js';
import { toConnectionProfile, toModelPreset } from '../serialize.js';
import { redactSecrets } from '../security.js';
import { getTailscaleLogin, isRemoteRequest } from './requestIdentity.js';
import { hasCredentialMaterial, message, type RouteContext } from './routeUtils.js';
import { billingLanes, modelConfigurationSchema } from './workflowSchemas.js';

const connectionProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  backendId: z.string().trim().min(1).max(80),
  providerId: z.string().trim().min(1).max(80),
  billingLane: z.enum(billingLanes),
  credentialStoreRef: z.string().max(200).nullable().optional(),
  metadata: z
    .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .default({}),
});
const modelPresetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  configuration: modelConfigurationSchema,
});

/** Provider catalogs, connection profiles and their credentials, model presets and metered budgets. */
export function registerProviderRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get('/api/providers', async () => ({ providers: await allProviders(db) }));
  app.get('/api/opportunities', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsedLimit = limit === undefined ? 200 : Number(limit);
    return {
      observations: listModelOpportunityObservations(db, Number.isFinite(parsedLimit) ? parsedLimit : 200),
      retentionDays: 90,
      refreshRequired: true,
    };
  });
  app.get('/api/opportunities/admission-targets', async () => ({
    targets: await listOpportunityAdmissionTargets(db),
  }));
  // Refresh live catalogs (or adapter metadata). No generation request is sent.
  app.post('/api/providers/refresh', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply
        .code(403)
        .send({ error: 'Provider discovery and observation refresh are available on the desktop only.' });
    const startedAt = new Date().toISOString();
    const providers = await allProviders(db, { refresh: true });
    persistModelObservationRefreshes(db, modelObservationRefreshesFromProviders(providers, startedAt));
    return { providers };
  });
  app.post('/api/opportunities/retention', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Observation retention runs are available on the desktop only.' });
    return { retention: runModelObservationRetention(db) };
  });
  app.get('/api/providers/openrouter/telemetry', async () => {
    const result = await openRouterTelemetry(db);
    return { ...result, provenance: 'provider_measured' };
  });

  // Credentials are write-only and desktop-only: no API route ever returns a stored secret, and
  // paired phones cannot set, replace, or remove them.
  app.put('/api/connection-profiles/:id/credentials/:kind', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Provider credentials can be managed on the desktop only.' });
    const { id, kind } = request.params as { id: string; kind: string };
    if (kind !== 'inference' && kind !== 'management')
      return reply.code(400).send({ error: 'Choose an inference or management credential.' });
    const profile = db.prepare('SELECT backend_id FROM connection_profiles WHERE id = ?').get(id) as
      { backend_id: string } | undefined;
    if (!profile) return reply.code(404).send({ error: 'Connection profile was not found.' });
    if (profile.backend_id !== 'openrouter')
      return reply.code(400).send({
        error: 'This backend authenticates through its official CLI; Turing does not store its credentials.',
      });
    const parsed = z.object({ secret: z.string().trim().min(8).max(512) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the credential value.' });
    try {
      SecretStore.forDatabase(db).write(secretRef(id, kind), parsed.data.secret);
    } catch (error) {
      return reply.code(400).send({ error: redactSecrets(message(error)) });
    }
    return {
      profile: withCredentialState(
        db,
        toConnectionProfile(
          db.prepare('SELECT * FROM connection_profiles WHERE id = ?').get(id) as Record<string, unknown>,
        ),
      ),
    };
  });
  app.delete('/api/connection-profiles/:id/credentials/:kind', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Provider credentials can be managed on the desktop only.' });
    const { id, kind } = request.params as { id: string; kind: string };
    if (kind !== 'inference' && kind !== 'management')
      return reply.code(400).send({ error: 'Choose an inference or management credential.' });
    SecretStore.forDatabase(db).delete(secretRef(id, kind));
    return { deleted: true };
  });

  app.get('/api/budgets', async (request) => {
    const { runId } = request.query as { runId?: string };
    const settings = getBudgetSettings(db);
    return { settings, status: budgetStatus(db, runId ?? null, null), systemTimeZone: systemTimeZone() };
  });
  app.put('/api/budgets', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Metered budgets can be changed on the desktop only.' });
    const parsed = z
      .object({
        dailyUsd: z.number().finite().min(0).max(10_000).nullable(),
        monthlyUsd: z.number().finite().min(0).max(100_000).nullable(),
        warningRatio: z.number().finite().min(0.1).max(1).default(0.8),
        timezone: z.string().max(80).nullable().default(null),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid budget settings.' });
    if (parsed.data.timezone && !isValidTimeZone(parsed.data.timezone))
      return reply.code(400).send({ error: 'Unknown timezone.' });
    return { settings: saveBudgetSettings(db, parsed.data) };
  });

  app.get('/api/connection-profiles', async () => ({
    profiles: (
      db.prepare('SELECT * FROM connection_profiles ORDER BY name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    )
      .map(toConnectionProfile)
      .map((profile) => withCredentialState(db, profile)),
  }));
  app.post('/api/connection-profiles', async (request, reply) => {
    const parsed = connectionProfileSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid connection profile.' });
    if (hasCredentialMaterial(parsed.data.metadata) || hasCredentialMaterial(parsed.data.name))
      return reply
        .code(400)
        .send({ error: 'Connection profile metadata cannot contain credentials or secret fields.' });
    if (!routeMatchesBillingLane(parsed.data.backendId, parsed.data.providerId, parsed.data.billingLane))
      return reply.code(400).send({
        error: `Provider ${parsed.data.providerId} on ${parsed.data.backendId} does not bill through ${billingLaneLabel(parsed.data.billingLane)}.`,
      });
    const reference = parsed.data.credentialStoreRef ?? null;
    if (
      reference &&
      (!/^(keyring|cli):[A-Za-z0-9._:-]{1,180}$/.test(reference) || hasCredentialMaterial(reference))
    )
      return reply
        .code(400)
        .send({ error: 'Credential references must be symbolic keyring: or cli: identifiers.' });
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO connection_profiles (id, name, backend_id, provider_id, billing_lane, credential_store_ref, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      parsed.data.name,
      parsed.data.backendId,
      parsed.data.providerId,
      parsed.data.billingLane,
      reference,
      JSON.stringify(parsed.data.metadata),
      now,
      now,
    );
    return reply.code(201).send({
      profile: withCredentialState(
        db,
        toConnectionProfile(
          db.prepare('SELECT * FROM connection_profiles WHERE id = ?').get(id) as Record<string, unknown>,
        ),
      ),
    });
  });
  app.put('/api/connection-profiles/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!db.prepare('SELECT id FROM connection_profiles WHERE id = ?').get(id))
      return reply.code(404).send({ error: 'Connection profile was not found.' });
    const parsed = connectionProfileSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid connection profile.' });
    if (hasCredentialMaterial(parsed.data.metadata) || hasCredentialMaterial(parsed.data.name))
      return reply
        .code(400)
        .send({ error: 'Connection profile metadata cannot contain credentials or secret fields.' });
    if (!routeMatchesBillingLane(parsed.data.backendId, parsed.data.providerId, parsed.data.billingLane))
      return reply.code(400).send({
        error: `Provider ${parsed.data.providerId} on ${parsed.data.backendId} does not bill through ${billingLaneLabel(parsed.data.billingLane)}.`,
      });
    const reference = parsed.data.credentialStoreRef ?? null;
    if (
      reference &&
      (!/^(keyring|cli):[A-Za-z0-9._:-]{1,180}$/.test(reference) || hasCredentialMaterial(reference))
    )
      return reply
        .code(400)
        .send({ error: 'Credential references must be symbolic keyring: or cli: identifiers.' });
    db.prepare(
      'UPDATE connection_profiles SET name = ?, backend_id = ?, provider_id = ?, billing_lane = ?, credential_store_ref = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
    ).run(
      parsed.data.name,
      parsed.data.backendId,
      parsed.data.providerId,
      parsed.data.billingLane,
      reference,
      JSON.stringify(parsed.data.metadata),
      new Date().toISOString(),
      id,
    );
    return {
      profile: toConnectionProfile(
        db.prepare('SELECT * FROM connection_profiles WHERE id = ?').get(id) as Record<string, unknown>,
      ),
    };
  });
  app.delete('/api/connection-profiles/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const inUse = db
      .prepare('SELECT COUNT(*) AS count FROM workflows WHERE instr(config_json, ?) > 0')
      .get(id) as { count: number };
    if (inUse.count)
      return reply.code(409).send({
        error: 'This connection profile is referenced by a saved workflow. Remove those references first.',
      });
    const result = db.prepare('DELETE FROM connection_profiles WHERE id = ?').run(id);
    if (result.changes) SecretStore.forDatabase(db).deleteProfile(id);
    if (!result.changes) return reply.code(404).send({ error: 'Connection profile was not found.' });
    return reply.code(204).send();
  });

  app.get('/api/model-presets', async () => ({
    presets: (
      db.prepare('SELECT * FROM model_presets ORDER BY name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    ).map(toModelPreset),
  }));
  app.post('/api/model-presets', async (request, reply) => {
    const parsed = modelPresetSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid model preset.' });
    if (hasCredentialMaterial(parsed.data.configuration))
      return reply.code(400).send({ error: 'Model presets cannot contain credential material.' });
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO model_presets (id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, parsed.data.name, JSON.stringify(parsed.data.configuration), now, now);
    return reply.code(201).send({
      preset: toModelPreset(
        db.prepare('SELECT * FROM model_presets WHERE id = ?').get(id) as Record<string, unknown>,
      ),
    });
  });
  app.delete('/api/model-presets/:id', async (request, reply) => {
    const result = db
      .prepare('DELETE FROM model_presets WHERE id = ?')
      .run((request.params as { id: string }).id);
    if (!result.changes) return reply.code(404).send({ error: 'Model preset was not found.' });
    return reply.code(204).send();
  });
}

function withCredentialState(db: Db, profile: import('../../shared/types.js').ConnectionProfile) {
  const store = SecretStore.forDatabase(db);
  return {
    ...profile,
    credentials: {
      inference: store.has(secretRef(profile.id, 'inference')),
      management: store.has(secretRef(profile.id, 'management')),
    },
  };
}

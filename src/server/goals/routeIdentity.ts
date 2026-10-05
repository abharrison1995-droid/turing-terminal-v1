import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouteMember } from '../../shared/goals.js';
import { classifyModelIdentity } from '../../shared/modelSettings.js';
import type {
  BillingLane,
  ConnectionProfile,
  ModelConfiguration,
  ModelOption,
  ProviderStatus,
} from '../../shared/types.js';
import { canonicalJson } from './definitionHash.js';

/**
 * Canonical exact-route identity (design section 12). Pure: it reads only the supplied provider/profile snapshot and
 * never a secret. Two routes with the same identity hash are the same route for validation, approval and audit.
 */

export type EffectiveIdentityKind = 'pinned' | 'floating' | 'unknown';

/** One profile as observed by the environment builder. `credentialReady` is a boolean: the resolver never sees a secret. */
export interface ProfileObservation {
  profile: ConnectionProfile;
  credentialReady: boolean;
}

export interface RouteSnapshot {
  providers: readonly ProviderStatus[];
  profiles: readonly ProfileObservation[];
}

export type RouteIdentityIssue = 'provider_missing' | 'profile_missing' | 'profile_mismatch';

export interface RouteIdentity {
  identity: Record<string, unknown>;
  identityHash: string;
  /** Hash of the declared member alone (no environment): stable across provider upgrades; used to locate a pool slot. */
  memberConfigHash: string;
  adapterVersion: string;
  capabilityFingerprint: string;
  identityKind: EffectiveIdentityKind;
  provider: ProviderStatus | null;
  model: ModelOption | null;
  profile: ProfileObservation | null;
  issues: RouteIdentityIssue[];
}

export type RouteIdentityResult =
  { ok: true; value: RouteIdentity } | { ok: false; code: 'route_incomplete' };

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The member's explicit declaration wins (it is approved definition data); otherwise the shared classifier decides. */
export function effectiveIdentityKind(member: RouteMember): EffectiveIdentityKind {
  if (member.identityKind) return member.identityKind;
  return classifyModelIdentity(member.configuration.backendId, member.configuration.modelId);
}

/** Exact lookup only: backend, provider and model id. A display name never takes part. */
export function findExactModel(
  provider: ProviderStatus | null,
  providerId: string,
  modelId: string,
): ModelOption | null {
  if (!provider) return null;
  return provider.models.find((model) => model.id === modelId && model.providerId === providerId) ?? null;
}

/** The catalog status class of the exact model: its reported status, or `absent`/`unreported`. */
function catalogStatusClass(model: ModelOption | null): string {
  if (!model) return 'absent';
  return model.status ?? 'unreported';
}

export function capabilityFingerprint(
  model: ModelOption | null,
  identityKind: EffectiveIdentityKind,
): string {
  return sha256(
    canonicalJson({
      toolSupport: model?.supportsTools ?? null,
      structuredOutput: model?.supportsStructuredOutput ?? null,
      reasoningControl: model?.reasoningControl ?? null,
      contextLength: model?.contextLength ?? null,
      identityKind,
      catalogStatusClass: catalogStatusClass(model),
    }),
  );
}

/** What of a connection profile is part of a route's identity. Never the credential store reference or metadata. */
function profileIdentity(
  profileId: string,
  observed: ProfileObservation | null,
  issues: RouteIdentityIssue[],
): Record<string, unknown> {
  if (!observed || issues.includes('profile_mismatch')) return { id: profileId, unresolved: true };
  const { id, backendId, providerId, billingLane } = observed.profile;
  return { id, backendId, providerId, billingLane };
}

/** Hash of the declared route alone: no provider, catalog, adapter or profile state. */
export function memberConfigHashOf(configuration: ModelConfiguration): string {
  return sha256(
    canonicalJson({
      backendId: configuration.backendId ?? null,
      providerId: configuration.providerId ?? null,
      billingLane: configuration.billingLane ?? null,
      modelId: configuration.modelId ?? null,
      connectionProfileId: configuration.connectionProfileId ?? null,
      variantId: configuration.variantId ?? null,
      reasoning: configuration.reasoning ?? null,
      nativeSettings: configuration.nativeSettings ?? {},
    }),
  );
}

export function computeRouteIdentity(member: RouteMember, snapshot: RouteSnapshot): RouteIdentityResult {
  const { backendId, providerId, billingLane, modelId } = member.configuration;
  if (!backendId || !providerId || !billingLane || !modelId) return { ok: false, code: 'route_incomplete' };
  const configuration = member.configuration;
  const issues: RouteIdentityIssue[] = [];
  const provider = snapshot.providers.find((candidate) => candidate.id === backendId) ?? null;
  if (!provider) issues.push('provider_missing');
  const model = findExactModel(provider, providerId, modelId);
  let profile: ProfileObservation | null = null;
  if (configuration.connectionProfileId) {
    profile =
      snapshot.profiles.find((entry) => entry.profile.id === configuration.connectionProfileId) ?? null;
    if (!profile) issues.push('profile_missing');
    else if (
      profile.profile.backendId !== backendId ||
      profile.profile.providerId !== providerId ||
      profile.profile.billingLane !== billingLane
    )
      issues.push('profile_mismatch');
  }
  const kind = effectiveIdentityKind(member);
  // An unknown adapter version is a stable sentinel; a validation under it stops matching once a version is known.
  const adapterVersion = provider?.version?.trim() ? provider.version.trim() : 'unknown';
  const fingerprint = capabilityFingerprint(model, kind);
  const identity: Record<string, unknown> = {
    schema: 1,
    backendId,
    providerId,
    billingLane: billingLane as BillingLane,
    modelId,
    connectionProfile: configuration.connectionProfileId
      ? profileIdentity(configuration.connectionProfileId, profile, issues)
      : null,
    variantId: configuration.variantId ?? null,
    reasoning: configuration.reasoning ?? null,
    nativeSettings: configuration.nativeSettings ?? {},
    adapterVersion,
    capabilityFingerprint: fingerprint,
  };
  const memberConfigHash = memberConfigHashOf(configuration);
  return {
    ok: true,
    value: {
      identity,
      identityHash: sha256(canonicalJson(identity)),
      memberConfigHash,
      adapterVersion,
      capabilityFingerprint: fingerprint,
      identityKind: kind,
      provider,
      model,
      profile,
      issues,
    },
  };
}

// --- Structural validation of a stored identity ----------------------------------------------------------------------

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const short = z.string().min(1).max(200);
const settings = z.record(
  z.string().max(100),
  z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
);

/** Schema 1 of `computeRouteIdentity().identity`, with exactly its nullable shapes. Strict: no extra keys. */
const storedIdentity = z
  .object({
    schema: z.literal(1),
    backendId: short,
    providerId: short,
    billingLane: short,
    modelId: short,
    connectionProfile: z
      .union([
        z.object({ id: short, backendId: short, providerId: short, billingLane: short }).strict(),
        z.object({ id: short, unresolved: z.literal(true) }).strict(),
      ])
      .nullable(),
    variantId: short.nullable(),
    reasoning: short.nullable(),
    nativeSettings: settings,
    adapterVersion: short,
    capabilityFingerprint: hex64,
  })
  .strict();

export function isStoredRouteIdentity(value: unknown): boolean {
  return storedIdentity.safeParse(value).success;
}

/**
 * Whether a stored validation record authenticates itself: its identity is structurally valid schema 1, its hash is
 * the hash of that canonical identity, and the redundant columns agree with the identity. Never repairs anything.
 */
export function validationRecordConsistent(record: {
  identityHash: string;
  identity: unknown;
  adapterVersion: string;
  capabilityFingerprint: string;
}): boolean {
  if (!hex64.safeParse(record.identityHash).success || !isStoredRouteIdentity(record.identity)) return false;
  const identity = record.identity as { adapterVersion: string; capabilityFingerprint: string };
  return (
    sha256(canonicalJson(record.identity)) === record.identityHash &&
    identity.adapterVersion === record.adapterVersion &&
    identity.capabilityFingerprint === record.capabilityFingerprint
  );
}

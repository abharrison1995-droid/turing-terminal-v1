import type { Db } from '../db.js';
import { validationRecordConsistent } from './routeIdentity.js';
import {
  VALIDATION_PROFILES,
  type FreshnessClass,
  type GoalRole,
  type RouteValidationRecord,
  type ValidationProfile,
} from '../../shared/goals.js';

/**
 * Route validation records, read side only (design section 12). `route_validations` is immutable history written by
 * the Stage 5B probe lifecycle; Stage 5A only selects among seeded records. Nothing here validates, probes or refreshes.
 */

/** The one authoritative role -> required validation profiles mapping. */
export const ROLE_VALIDATION_PROFILES: Readonly<Record<GoalRole, readonly ValidationProfile[]>> = {
  orchestrator: ['orchestrator-json', 'broker-read'],
  implementer: ['broker-edit', 'broker-read'],
  routine_reviewer: ['review-json', 'broker-read'],
  milestone_reviewer: ['review-json', 'broker-read'],
  final_reviewer: ['review-json', 'broker-read'],
};

/** V1 freshness windows, applied on top of a record's own expiry. */
export const FRESHNESS_WINDOW_MS: Readonly<Record<FreshnessClass, number>> = {
  'stable-subscription': 7 * 24 * 60 * 60 * 1000,
  opportunity: 24 * 60 * 60 * 1000,
};

const time = (value: string): number => Date.parse(value);

/**
 * Records that can be evidence for `now`: self-authenticating (identity, hash and redundant columns agree) and not
 * dated in the future. Anything else establishes nothing and can neither pass nor supersede.
 */
export function evidentiaryRecords(
  records: readonly RouteValidationRecord[],
  now: string,
): RouteValidationRecord[] {
  const at = time(now);
  return records.filter((record) => {
    const tested = time(record.testedAt);
    return (
      Number.isFinite(tested) && Number.isFinite(at) && tested <= at && validationRecordConsistent(record)
    );
  });
}

/**
 * Latest evidentiary record for `identityHash` + `profile`: `testedAt` descending, then the record id descending.
 * A record dated after `now` has not happened yet and never takes part in the ordering.
 */
export function latestValidationFor(
  records: readonly RouteValidationRecord[],
  identityHash: string,
  profile: ValidationProfile,
  now: string,
): RouteValidationRecord | undefined {
  let latest: RouteValidationRecord | undefined;
  for (const record of evidentiaryRecords(records, now)) {
    if (record.identityHash !== identityHash || record.profile !== profile) continue;
    if (
      !latest ||
      time(record.testedAt) > time(latest.testedAt) ||
      (time(record.testedAt) === time(latest.testedAt) && record.id > latest.id)
    )
      latest = record;
  }
  return latest;
}

export type ValidationStateCode =
  'pass' | 'validation_missing' | 'validation_failed' | 'validation_expired' | 'validation_identity_changed';

export interface ProfileValidationState {
  profile: ValidationProfile;
  state: ValidationStateCode;
  recordId: string | null;
  testedAt: string | null;
  /** min(record expiry, testedAt + freshness-class window); null without a usable record. */
  effectiveExpiresAt: string | null;
}

/** Whether `identityDescription` and a stored record's identity describe the same route modulo a changed identity part. */
function sameRouteOtherIdentity(record: RouteValidationRecord, identity: Record<string, unknown>): boolean {
  const parts = ['backendId', 'providerId', 'billingLane', 'modelId'] as const;
  return parts.every((part) => record.identity[part] === identity[part]);
}

export function validationState(input: {
  records: readonly RouteValidationRecord[];
  identityHash: string;
  identity: Record<string, unknown>;
  profile: ValidationProfile;
  freshnessClass: FreshnessClass;
  now: string;
}): ProfileValidationState {
  const base = { profile: input.profile, recordId: null, testedAt: null, effectiveExpiresAt: null };
  const latest = latestValidationFor(input.records, input.identityHash, input.profile, input.now);
  if (!latest) {
    const changed = evidentiaryRecords(input.records, input.now).some(
      (record) =>
        record.profile === input.profile &&
        record.identityHash !== input.identityHash &&
        sameRouteOtherIdentity(record, input.identity),
    );
    return { ...base, state: changed ? 'validation_identity_changed' : 'validation_missing' };
  }
  const detail = { profile: input.profile, recordId: latest.id, testedAt: latest.testedAt };
  // The latest record controls: a newer failure supersedes an older pass, whatever the failure's own expiry.
  if (latest.status !== 'pass') return { ...detail, state: 'validation_failed', effectiveExpiresAt: null };
  const expires = Math.min(
    time(latest.expiresAt),
    time(latest.testedAt) + FRESHNESS_WINDOW_MS[input.freshnessClass],
  );
  const now = time(input.now);
  if (!Number.isFinite(expires) || !Number.isFinite(now))
    return { ...detail, state: 'validation_expired', effectiveExpiresAt: null };
  const effectiveExpiresAt = new Date(expires).toISOString();
  return { ...detail, state: now >= expires ? 'validation_expired' : 'pass', effectiveExpiresAt };
}

/** Every required profile for the role, each with its own state. Available only when all of them pass. */
export function freshValidationSet(input: {
  records: readonly RouteValidationRecord[];
  identityHash: string;
  identity: Record<string, unknown>;
  role: GoalRole;
  freshnessClass: FreshnessClass;
  now: string;
}): { available: boolean; profiles: ProfileValidationState[] } {
  const profiles = ROLE_VALIDATION_PROFILES[input.role].map((profile) =>
    validationState({ ...input, profile }),
  );
  return { available: profiles.every((entry) => entry.state === 'pass'), profiles };
}

export interface ValidationRow {
  id: string;
  identity_hash: string;
  identity_json: string;
  profile: string;
  status: 'pass' | 'fail';
  evidence_run_id: string | null;
  resolved_model_reported: string | null;
  checks_json: string;
  provenance: 'turing_probe_run';
  adapter_version: string;
  capability_fingerprint: string;
  tested_at: string;
  expires_at: string;
}

/** A stored row as a record, or null when it is malformed or does not authenticate itself. Never repairs. */
export function recordFromRow(row: ValidationRow): RouteValidationRecord | null {
  if (!VALIDATION_PROFILES.includes(row.profile as ValidationProfile)) return null;
  try {
    const identity = JSON.parse(row.identity_json) as unknown;
    const record: RouteValidationRecord = {
      id: row.id,
      identityHash: row.identity_hash,
      identity: identity as Record<string, unknown>,
      profile: row.profile as ValidationProfile,
      status: row.status,
      evidenceRunId: row.evidence_run_id,
      resolvedModelReported: row.resolved_model_reported,
      checks: JSON.parse(row.checks_json) as unknown,
      provenance: row.provenance,
      adapterVersion: row.adapter_version,
      capabilityFingerprint: row.capability_fingerprint,
      testedAt: row.tested_at,
      expiresAt: row.expires_at,
    };
    return validationRecordConsistent(record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Reads the stored records for some identities. A row that cannot be parsed, has an unknown profile or does not
 * authenticate itself is skipped: it establishes nothing (and, never being selected, cannot supersede a good one).
 */
export function readRouteValidations(
  db: Db,
  identityHashes: readonly string[],
  /** Also load records of the same model under another identity, so a changed identity can be reported as such. */
  modelIds: readonly string[] = [],
): RouteValidationRecord[] {
  const hashes = [...new Set(identityHashes)];
  const models = [...new Set(modelIds)];
  if (hashes.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM route_validations WHERE identity_hash IN (${hashes.map(() => '?').join(',')})
       ${models.length ? `OR json_extract(identity_json, '$.modelId') IN (${models.map(() => '?').join(',')})` : ''}
       ORDER BY tested_at, rowid`,
    )
    .all(...hashes, ...models) as ValidationRow[];
  const records: RouteValidationRecord[] = [];
  for (const row of rows) {
    const record = recordFromRow(row);
    if (record) records.push(record);
  }
  return records;
}

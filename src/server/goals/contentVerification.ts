import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import {
  compareContentTrees,
  CONTENT_TREE_MAX_CHANGED_PATHS,
  type ContentTreeComparisonResult,
} from './contentTreeComparison.js';
import type { ContentTreeGitObservation, ObjectFormat } from './contentTreeGitObservation.js';
import { canonicalJson } from './definitionHash.js';

/**
 * Persistence core for the `content-verified-v1` verifier (verifier version 2).
 *
 * This module persists evidence only. It never completes a Goal, never writes a completion proof, never issues an
 * approval and never runs Git. The caller supplies a successful `observeContentTree` result; a failed observation is
 * refused here and writes nothing. The changed paths, source tree and destination tree are compared by the existing
 * byte-exact `compareContentTrees`, so this module does not duplicate the collector or the comparator.
 *
 * A record is immutable: `recordDigest` covers the complete canonical record body, and the table has update and delete
 * triggers. `verificationDigest` is a deterministic identity over the evidence, so recording the same observation again
 * returns the stored record with `reused: true` instead of inserting a second row.
 */

export const CONTENT_VERIFICATION_SCHEMA_VERSION = 1 as const;
export const CONTENT_VERIFICATION_KIND = 'turing_goal_content_verification' as const;
export const CONTENT_VERIFIED_VERIFIER = 'content-verified-v1' as const;
export const CONTENT_VERIFIED_VERIFIER_VERSION = 2 as const;
export const CONTENT_VERIFICATION_MAX_PAYLOAD_BYTES = 65_536;

const CONTENT_VERIFICATION_EVIDENCE_DOMAIN = 'turing-goal-content-verification-evidence-v1';
const CONTENT_VERIFICATION_RECORD_DOMAIN = 'turing-goal-content-verification-record-v1';

const HASH = /^[0-9a-f]{64}$/;
const DETAIL = /^[a-z0-9_]{1,100}$/;
const OBJECT_ID: Record<ObjectFormat, RegExp> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

const hashSchema = z.string().regex(HASH);
const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const uuidSchema = z.string().uuid();
const objectFormatSchema = z.enum(['sha1', 'sha256']);
const refSchema = z.string().min(1).max(500);
const statusSchema = z.enum(['verified', 'content_not_preserved']);

const evidenceBodyObject = z.strictObject({
  schemaVersion: z.literal(CONTENT_VERIFICATION_SCHEMA_VERSION),
  kind: z.literal(CONTENT_VERIFICATION_KIND),
  goalId: uuidSchema,
  verifier: z.literal(CONTENT_VERIFIED_VERIFIER),
  verifierVersion: z.literal(CONTENT_VERIFIED_VERIFIER_VERSION),
  status: statusSchema,
  changedPathCount: z.number().int().min(0).max(CONTENT_TREE_MAX_CHANGED_PATHS),
  mismatchCount: z.number().int().min(0),
  mismatchPathDigest: hashSchema,
  repository: z.strictObject({ objectFormat: objectFormatSchema }),
  source: z.strictObject({ commit: objectIdSchema }),
  destination: z.strictObject({
    ref: refSchema,
    expectedBaseCommit: objectIdSchema,
    tipCommit: objectIdSchema,
    comparisonCommit: objectIdSchema,
  }),
});

function refineEvidence(evidence: z.infer<typeof evidenceBodyObject>, context: z.RefinementCtx): void {
  const oid = OBJECT_ID[evidence.repository.objectFormat];
  const objectIds = [
    ['source.commit', evidence.source.commit],
    ['destination.expectedBaseCommit', evidence.destination.expectedBaseCommit],
    ['destination.tipCommit', evidence.destination.tipCommit],
    ['destination.comparisonCommit', evidence.destination.comparisonCommit],
  ] as const;
  for (const [path, value] of objectIds) {
    if (!oid.test(value))
      context.addIssue({
        code: 'custom',
        path: path.split('.'),
        message: 'Object ID does not match the Git object format.',
      });
  }
  if (evidence.mismatchCount > evidence.changedPathCount)
    context.addIssue({
      code: 'custom',
      path: ['mismatchCount'],
      message: 'The mismatch count cannot exceed the changed-path count.',
    });
  if (evidence.status === 'verified' && evidence.mismatchCount !== 0)
    context.addIssue({
      code: 'custom',
      path: ['mismatchCount'],
      message: 'A verified comparison cannot carry a mismatch.',
    });
  if (evidence.status === 'content_not_preserved' && evidence.mismatchCount === 0)
    context.addIssue({
      code: 'custom',
      path: ['mismatchCount'],
      message: 'A mismatch status must carry at least one mismatched path.',
    });
}

const evidenceBodySchema = evidenceBodyObject.superRefine(refineEvidence);
const recordInputObject = evidenceBodyObject
  .extend({ verificationId: uuidSchema, observedAt: z.string().datetime() })
  .strict();
const recordInputSchema = recordInputObject.superRefine(refineEvidence);
const recordBodySchema = recordInputObject
  .extend({ verificationDigest: hashSchema })
  .strict()
  .superRefine(refineEvidence);
const recordSchema = recordInputObject
  .extend({ verificationDigest: hashSchema, recordDigest: hashSchema })
  .strict()
  .superRefine(refineEvidence);

export type ContentVerificationEvidenceBody = z.infer<typeof evidenceBodySchema>;
export type ContentVerificationRecordInput = z.infer<typeof recordInputSchema>;

export interface ContentVerificationRecord extends ContentVerificationRecordInput {
  verificationDigest: string;
  recordDigest: string;
}

/** The comparison is persisted only when it was actually observed: overflow never becomes a record. */
export type StoredContentVerificationStatus = Extract<
  ContentTreeComparisonResult['status'],
  'verified' | 'content_not_preserved'
>;

/** Only a successful `observeContentTree` result is accepted by the input type. */
export interface ContentVerificationInput {
  goalId: string;
  expectedBaseCommit: string;
  acceptedSourceCommit: string;
  destinationTipCommit: string;
  destinationRef: string;
  objectFormat: ObjectFormat;
  observation: Extract<ContentTreeGitObservation, { ok: true }>;
}

export const CONTENT_VERIFICATION_ERROR_CODES = [
  'content_verification_input_invalid',
  'content_observation_failed',
  'content_observation_too_large',
  'content_verification_conflict',
  'content_verification_persistence_failed',
] as const;

export type ContentVerificationErrorCode = (typeof CONTENT_VERIFICATION_ERROR_CODES)[number];

const MESSAGES: Record<ContentVerificationErrorCode, string> = {
  content_verification_input_invalid: 'The content verification input is invalid.',
  content_observation_failed: 'The content observation failed, so no verification was recorded.',
  content_observation_too_large:
    'The changed-path set exceeds the 10,000-path cap, so nothing was verified or recorded.',
  content_verification_conflict: 'Stored content-verification evidence conflicts with the observation.',
  content_verification_persistence_failed:
    'The content verification could not be recorded, so nothing changed.',
};

export class ContentVerificationError extends Error {
  readonly detail: string | null;

  constructor(
    readonly code: ContentVerificationErrorCode,
    detail: string | null = null,
  ) {
    super(MESSAGES[code]);
    this.name = 'ContentVerificationError';
    this.detail = detail !== null && DETAIL.test(detail) ? detail : null;
  }
}

function domainDigest(domain: string, body: unknown): string {
  return createHash('sha256').update(domain).update('\0').update(canonicalJson(body)).digest('hex');
}

function evidenceOf(
  body: ContentVerificationRecordInput & { verificationDigest?: string },
): ContentVerificationEvidenceBody {
  const {
    verificationId: _verificationId,
    observedAt: _observedAt,
    verificationDigest: _verificationDigest,
    ...evidence
  } = body;
  void _verificationId;
  void _observedAt;
  void _verificationDigest;
  return evidence;
}

export function computeContentVerificationEvidenceDigest(input: ContentVerificationEvidenceBody): string {
  return domainDigest(CONTENT_VERIFICATION_EVIDENCE_DOMAIN, evidenceBodySchema.parse(input));
}

export function computeContentVerificationRecordDigest(
  input: Omit<ContentVerificationRecord, 'recordDigest'>,
): string {
  return domainDigest(CONTENT_VERIFICATION_RECORD_DOMAIN, recordBodySchema.parse(input));
}

export function buildContentVerificationRecord(input: unknown): ContentVerificationRecord | null {
  const parsed = recordInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const body = parsed.data;
  const verificationDigest = computeContentVerificationEvidenceDigest(evidenceOf(body));
  const bodyWithDigest = { ...body, verificationDigest };
  return {
    ...bodyWithDigest,
    recordDigest: computeContentVerificationRecordDigest(bodyWithDigest),
  };
}

export type ParsedContentVerificationRecord =
  | { valid: true; record: ContentVerificationRecord; digest: string }
  | { valid: false; reason: 'schema_invalid' | 'digest_mismatch' };

export function parseContentVerificationRecord(input: unknown): ParsedContentVerificationRecord {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: 'schema_invalid' };
  const { recordDigest, ...body } = parsed.data;
  const digest = computeContentVerificationRecordDigest(body);
  if (digest !== recordDigest) return { valid: false, reason: 'digest_mismatch' };
  const evidenceDigest = computeContentVerificationEvidenceDigest(evidenceOf(body));
  if (evidenceDigest !== parsed.data.verificationDigest) return { valid: false, reason: 'digest_mismatch' };
  return { valid: true, record: parsed.data, digest };
}

/** The exact canonical `payload_json` for a record, the one serialisation the reader re-digests. */
export function contentVerificationPayloadJson(record: ContentVerificationRecord): string {
  return canonicalJson(record);
}

interface ContentVerificationRow {
  id: string;
  goal_id: string;
  schema_version: number;
  kind: string;
  verifier: string;
  verifier_version: number;
  status: string;
  changed_path_count: number;
  mismatch_count: number;
  mismatch_path_digest: string;
  verification_digest: string;
  object_format: ObjectFormat;
  expected_base_commit: string;
  accepted_source_commit: string;
  destination_ref: string;
  destination_tip_commit: string;
  comparison_commit: string;
  observed_at: string;
  record_digest: string;
  payload_json: string;
}

export type ContentVerificationRead =
  | { state: 'not_found' }
  | { state: 'invalid'; reason: string }
  | { state: 'valid'; id: string; goalId: string; record: ContentVerificationRecord };

function recordMatchesRow(row: ContentVerificationRow, record: ContentVerificationRecord): boolean {
  return (
    row.id === record.verificationId &&
    row.goal_id === record.goalId &&
    row.schema_version === record.schemaVersion &&
    row.kind === record.kind &&
    row.verifier === record.verifier &&
    row.verifier_version === record.verifierVersion &&
    row.status === record.status &&
    row.changed_path_count === record.changedPathCount &&
    row.mismatch_count === record.mismatchCount &&
    row.mismatch_path_digest === record.mismatchPathDigest &&
    row.verification_digest === record.verificationDigest &&
    row.object_format === record.repository.objectFormat &&
    row.expected_base_commit === record.destination.expectedBaseCommit &&
    row.accepted_source_commit === record.source.commit &&
    row.destination_ref === record.destination.ref &&
    row.destination_tip_commit === record.destination.tipCommit &&
    row.comparison_commit === record.destination.comparisonCommit &&
    row.observed_at === record.observedAt &&
    row.record_digest === record.recordDigest
  );
}

function parseStoredRow(
  row: ContentVerificationRow,
): { valid: true; record: ContentVerificationRecord } | { valid: false; reason: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return { valid: false, reason: 'payload_invalid' };
  }
  const parsed = parseContentVerificationRecord(payload);
  if (!parsed.valid) return { valid: false, reason: parsed.reason };
  if (contentVerificationPayloadJson(parsed.record) !== row.payload_json)
    return { valid: false, reason: 'payload_not_canonical' };
  if (!recordMatchesRow(row, parsed.record)) return { valid: false, reason: 'indexed_identity_mismatch' };
  return { valid: true, record: parsed.record };
}

function getContentVerificationRow(
  db: Db,
  goalId: string,
  verificationId: string,
): ContentVerificationRow | undefined {
  return db
    .prepare('SELECT * FROM goal_content_verifications WHERE goal_id = ? AND id = ?')
    .get(goalId, verificationId) as ContentVerificationRow | undefined;
}

function getContentVerificationByDigest(
  db: Db,
  goalId: string,
  verificationDigest: string,
): ContentVerificationRow | undefined {
  return db
    .prepare('SELECT * FROM goal_content_verifications WHERE goal_id = ? AND verification_digest = ?')
    .get(goalId, verificationDigest) as ContentVerificationRow | undefined;
}

export function readContentVerification(
  db: Db,
  goalId: string,
  verificationId: string,
): ContentVerificationRead {
  try {
    const row = getContentVerificationRow(db, goalId, verificationId);
    if (!row) return { state: 'not_found' };
    const parsed = parseStoredRow(row);
    if (!parsed.valid) return { state: 'invalid', reason: parsed.reason };
    return { state: 'valid', id: row.id, goalId, record: parsed.record };
  } catch {
    return { state: 'invalid', reason: 'integrity_check_failed' };
  }
}

export function readContentVerificationByDigest(
  db: Db,
  goalId: string,
  verificationDigest: string,
): ContentVerificationRead {
  try {
    const row = getContentVerificationByDigest(db, goalId, verificationDigest);
    if (!row) return { state: 'not_found' };
    const parsed = parseStoredRow(row);
    if (!parsed.valid) return { state: 'invalid', reason: parsed.reason };
    return { state: 'valid', id: row.id, goalId, record: parsed.record };
  } catch {
    return { state: 'invalid', reason: 'integrity_check_failed' };
  }
}

function countChangedPaths(
  paths: readonly Uint8Array[],
): { count: number } | { tooMany: true } | { malformed: true } {
  const unique = new Set<string>();
  for (const path of paths) {
    if (!(path instanceof Uint8Array)) return { malformed: true };
    unique.add(Buffer.from(path).toString('latin1'));
    if (unique.size > CONTENT_TREE_MAX_CHANGED_PATHS) return { tooMany: true };
  }
  return { count: unique.size };
}

function observationStatus(observation: unknown): string | null {
  if (!observation || typeof observation !== 'object') return null;
  const status = (observation as { status?: unknown }).status;
  return typeof status === 'string' && DETAIL.test(status) ? status : null;
}

function isSuccessfulObservation(
  observation: unknown,
): observation is Extract<ContentTreeGitObservation, { ok: true }> {
  if (!observation || typeof observation !== 'object') return false;
  const candidate = observation as Record<string, unknown>;
  return (
    candidate.ok === true &&
    candidate.status === 'observed' &&
    typeof candidate.comparisonCommit === 'string' &&
    Array.isArray(candidate.changedPaths) &&
    Array.isArray(candidate.sourceEntries) &&
    Array.isArray(candidate.destinationEntries)
  );
}

const contextSchema = z.strictObject({
  goalId: uuidSchema,
  expectedBaseCommit: objectIdSchema,
  acceptedSourceCommit: objectIdSchema,
  destinationTipCommit: objectIdSchema,
  destinationRef: refSchema,
  objectFormat: objectFormatSchema,
});

function asContext(raw: unknown): z.infer<typeof contextSchema> | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const parsed = contextSchema.safeParse({
    goalId: candidate.goalId,
    expectedBaseCommit: candidate.expectedBaseCommit,
    acceptedSourceCommit: candidate.acceptedSourceCommit,
    destinationTipCommit: candidate.destinationTipCommit,
    destinationRef: candidate.destinationRef,
    objectFormat: candidate.objectFormat,
  });
  return parsed.success ? parsed.data : null;
}

function insertParams(record: ContentVerificationRecord): Record<string, string | number> {
  return {
    id: record.verificationId,
    goal_id: record.goalId,
    schema_version: record.schemaVersion,
    kind: record.kind,
    verifier: record.verifier,
    verifier_version: record.verifierVersion,
    status: record.status,
    changed_path_count: record.changedPathCount,
    mismatch_count: record.mismatchCount,
    mismatch_path_digest: record.mismatchPathDigest,
    verification_digest: record.verificationDigest,
    object_format: record.repository.objectFormat,
    expected_base_commit: record.destination.expectedBaseCommit,
    accepted_source_commit: record.source.commit,
    destination_ref: record.destination.ref,
    destination_tip_commit: record.destination.tipCommit,
    comparison_commit: record.destination.comparisonCommit,
    observed_at: record.observedAt,
    record_digest: record.recordDigest,
    payload_json: contentVerificationPayloadJson(record),
  };
}

export interface PersistedContentVerification {
  record: ContentVerificationRecord;
  reused: boolean;
}

export interface EvaluatedContentVerification {
  evidence: ContentVerificationEvidenceBody;
  verificationDigest: string;
}

/** Evaluates an observed tree comparison without writing evidence or completing a Goal. */
export function evaluateContentVerification(input: ContentVerificationInput): EvaluatedContentVerification {
  const observation = (input as { observation?: unknown }).observation;
  if (!observation || typeof observation !== 'object' || (observation as { ok?: unknown }).ok !== true)
    throw new ContentVerificationError('content_observation_failed', observationStatus(observation));
  if (!isSuccessfulObservation(observation))
    throw new ContentVerificationError('content_verification_input_invalid', 'observation_shape');

  const context = asContext(input);
  if (!context) throw new ContentVerificationError('content_verification_input_invalid');
  const oid = OBJECT_ID[context.objectFormat];
  for (const commit of [
    context.expectedBaseCommit,
    context.acceptedSourceCommit,
    context.destinationTipCommit,
    observation.comparisonCommit,
  ]) {
    if (!oid.test(commit))
      throw new ContentVerificationError('content_verification_input_invalid', 'object_id_width');
  }

  const counted = countChangedPaths(observation.changedPaths);
  if ('malformed' in counted)
    throw new ContentVerificationError('content_verification_input_invalid', 'changed_paths');
  if ('tooMany' in counted) throw new ContentVerificationError('content_observation_too_large');

  let comparison: ContentTreeComparisonResult;
  try {
    comparison = compareContentTrees({
      changedPaths: observation.changedPaths,
      sourceEntries: observation.sourceEntries,
      destinationEntries: observation.destinationEntries,
    });
  } catch {
    throw new ContentVerificationError('content_verification_input_invalid', 'observation');
  }
  if (comparison.status === 'content_observation_too_large')
    throw new ContentVerificationError('content_observation_too_large');
  const status: StoredContentVerificationStatus = comparison.status;

  const evidence: ContentVerificationEvidenceBody = {
    schemaVersion: CONTENT_VERIFICATION_SCHEMA_VERSION,
    kind: CONTENT_VERIFICATION_KIND,
    goalId: context.goalId,
    verifier: CONTENT_VERIFIED_VERIFIER,
    verifierVersion: CONTENT_VERIFIED_VERIFIER_VERSION,
    status,
    changedPathCount: counted.count,
    mismatchCount: comparison.mismatchCount,
    mismatchPathDigest: comparison.mismatchPathDigest,
    repository: { objectFormat: context.objectFormat },
    source: { commit: context.acceptedSourceCommit },
    destination: {
      ref: context.destinationRef,
      expectedBaseCommit: context.expectedBaseCommit,
      tipCommit: context.destinationTipCommit,
      comparisonCommit: observation.comparisonCommit,
    },
  };
  return {
    evidence,
    verificationDigest: computeContentVerificationEvidenceDigest(evidence),
  };
}

/**
 * Persists one successful observation under `content-verified-v1`. The comparison is computed here from the observed
 * changed paths and tree listings; a caller cannot supply a status. A failed observation, an oversized changed-path
 * set, a malformed observation or an object-ID width that disagrees with the object format is refused before any write.
 */
export function persistContentVerification(
  db: Db,
  input: ContentVerificationInput,
): PersistedContentVerification {
  const context = asContext(input);
  if (!context) throw new ContentVerificationError('content_verification_input_invalid');
  const { evidence, verificationDigest } = evaluateContentVerification(input);

  const persist = db.transaction((): PersistedContentVerification => {
    const existing = getContentVerificationByDigest(db, context.goalId, verificationDigest);
    if (existing) {
      const parsed = parseStoredRow(existing);
      if (!parsed.valid)
        throw new ContentVerificationError(
          'content_verification_conflict',
          parsed.reason === 'payload_invalid' ? 'payload_invalid' : 'existing_invalid',
        );
      return { record: parsed.record, reused: true };
    }

    const now = new Date().toISOString();
    if (new Date(now).toISOString() !== now)
      throw new ContentVerificationError('content_verification_persistence_failed', 'clock_not_canonical');
    const record = buildContentVerificationRecord({
      ...evidence,
      verificationId: randomUUID(),
      observedAt: now,
    });
    if (!record)
      throw new ContentVerificationError('content_verification_persistence_failed', 'record_build_invalid');

    db.prepare(
      `INSERT INTO goal_content_verifications (
        id, goal_id, schema_version, kind, verifier, verifier_version, status, changed_path_count,
        mismatch_count, mismatch_path_digest, verification_digest, object_format, expected_base_commit,
        accepted_source_commit, destination_ref, destination_tip_commit, comparison_commit, observed_at,
        record_digest, payload_json
      ) VALUES (
        @id, @goal_id, @schema_version, @kind, @verifier, @verifier_version, @status, @changed_path_count,
        @mismatch_count, @mismatch_path_digest, @verification_digest, @object_format, @expected_base_commit,
        @accepted_source_commit, @destination_ref, @destination_tip_commit, @comparison_commit, @observed_at,
        @record_digest, @payload_json
      )`,
    ).run(insertParams(record));
    return { record, reused: false };
  });

  try {
    return persist.immediate();
  } catch (error) {
    if (error instanceof ContentVerificationError) throw error;
    const existing = getContentVerificationByDigest(db, context.goalId, verificationDigest);
    if (existing) {
      const parsed = parseStoredRow(existing);
      if (parsed.valid) return { record: parsed.record, reused: true };
    }
    throw new ContentVerificationError('content_verification_persistence_failed');
  }
}

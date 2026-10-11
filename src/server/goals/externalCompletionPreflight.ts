import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { canonicalJson } from './definitionHash.js';
import { readApprovedCompletionAuthority } from './approvedCompletionAuthority.js';
import { evaluateCompletion } from './completionEvaluation.js';
import {
  attestationCorrectionStandingAllowsCompletion,
  getAttestationCorrectionStanding,
  type AttestationCorrectionStandingProjection,
} from './attestationCorrection.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import {
  ExternalIntegrationError,
  loadValidatedRecord,
  validateExternalIntegrationAttestation,
  type ExternalIntegrationAttestationV1,
  type ExternalIntegrationObservationV1,
  type ExternalIntegrationValidation,
} from './externalIntegration.js';
import { withExternalIntegrationVerificationSlot } from './externalIntegrationWorkflow.js';
import {
  manualHandoffAttestationDatabaseFingerprint,
  readValidatedManualHandoff,
  type ManualIntegrationHandoffV1,
} from './manualHandoff.js';

/**
 * Read-only preflight for the version-2 external completion. It decides whether one explicit attestation could be
 * consumed by a future completion transaction, and it returns the exact action fields that transaction must match.
 * It writes nothing: no rows, no refs, no index, config or worktree changes, and it mints no approval, proof or
 * terminal authority. A `ready` outcome is only a digest-bound precondition for the user's later decision.
 */

const SCHEMA_VERSION = 1;
const REPORT_KIND = 'turing_goal_external_completion_preflight';
const ATTESTATION_CHAIN_KIND = 'turing_goal_external_integration_correction_chain';
const REPORT_DOMAIN = 'turing-goal-external-completion-preflight-v1';
const CHAIN_DOMAIN = 'turing-goal-attestation-correction-chain-v1';
const MILESTONE_DOMAIN = 'turing-goal-completion-milestone-identity-v1';
const ACTION_PLACEHOLDER_DIGEST = '0'.repeat(64);

export const PREFLIGHT_CHECK_NAMES = [
  'input',
  'goal_status',
  'definition',
  'prior_completion',
  'attestation',
  'correction_standing',
  'snapshot_before',
  'completion_evaluation',
  'git_observation',
  'snapshot_after',
  'assemble',
] as const;

export const PREFLIGHT_REASON_CODES = [
  'attestation_id_invalid',
  'goal_not_found',
  'goal_not_running',
  'definition_not_approved',
  'definition_not_v2',
  'completion_already_recorded',
  'attestation_not_found',
  'attestation_invalid',
  'attestation_definition_mismatch',
  'handoff_invalid',
  'correction_standing_unavailable',
  'correction_standing_invalid',
  'attestation_disputed',
  'attestation_withdrawn',
  'attestation_superseded',
  'completion_not_ready',
  'destination_advanced_after_observation',
  'destination_not_integrated',
  'attestation_stale',
  'git_unavailable',
  'verification_busy',
  'observation_changed',
  'preflight_internal_invalid',
  'preflight_unavailable',
] as const;

export type PreflightCheckName = (typeof PREFLIGHT_CHECK_NAMES)[number];
export type PreflightReasonCode = (typeof PREFLIGHT_REASON_CODES)[number];

/** Zero-based position of each check; the report's `checks` array uses this same order. */
const CHECK = {
  input: 0,
  goal_status: 1,
  definition: 2,
  prior_completion: 3,
  attestation: 4,
  correction_standing: 5,
  snapshot_before: 6,
  completion_evaluation: 7,
  git_observation: 8,
  snapshot_after: 9,
  assemble: 10,
} as const satisfies Record<PreflightCheckName, number>;

const HEX64 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CODE_DETAIL = /^[a-z0-9_]{1,100}$/;
const UUID = z.string().uuid();

const hexDigest = z.string().regex(HEX64);
const objectIdSchema = z.string().regex(OBJECT_ID);
const boundedText = (max: number) => z.string().min(1).max(max);

const checkSchema = z.strictObject({
  name: z.enum(PREFLIGHT_CHECK_NAMES),
  status: z.enum(['passed', 'failed', 'skipped']),
});

const reasonSchema = z.strictObject({
  code: z.enum(PREFLIGHT_REASON_CODES),
  detail: z.string().regex(CODE_DETAIL).nullable(),
});

const factsSchema = z.strictObject({
  goalStatus: boundedText(50).nullable(),
  definitionVersion: z.number().int().positive().nullable(),
  definitionHash: hexDigest.nullable(),
  lineageDigest: hexDigest.nullable(),
  mode: z.enum(['legacy_v1', 'external_user_attested_v2']).nullable(),
  handoffId: boundedText(200).nullable(),
  handoffDigest: hexDigest.nullable(),
  attestationActionDigest: hexDigest.nullable(),
  attestationRecordDigest: hexDigest.nullable(),
  correctionStanding: z
    .enum(['active_uncontested', 'disputed', 'withdrawn', 'superseded', 'invalid'])
    .nullable(),
  correctionSequence: z.number().int().nonnegative().nullable(),
  destinationRef: boundedText(500).nullable(),
  attestedCommit: objectIdSchema.nullable(),
  attestedTree: objectIdSchema.nullable(),
  freshCommit: objectIdSchema.nullable(),
  freshTree: objectIdSchema.nullable(),
  objectFormat: z.enum(['sha1', 'sha256']).nullable(),
});

const reportBodySchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal(REPORT_KIND),
  goalId: boundedText(200),
  attestationId: boundedText(200),
  outcome: z.enum(['ready', 'refused']),
  reasons: z.array(reasonSchema).max(1),
  checks: z.array(checkSchema).length(PREFLIGHT_CHECK_NAMES.length),
  facts: factsSchema,
  actionFields: z.record(z.string(), z.unknown()).nullable(),
  proofLimitations: z.strictObject({
    contentPreservation: z.literal('not_proven'),
    goalCompletion: z.literal('not_completed_by_preflight'),
    destinationPolicy: z.literal('exact_attested_tip'),
  }),
  authority: z.strictObject({
    mintsApproval: z.literal(false),
    mintsProof: z.literal(false),
    mintsTerminalAuthority: z.literal(false),
  }),
});

export type ExternalCompletionPreflightBody = z.infer<typeof reportBodySchema>;
export type ExternalCompletionPreflightReport = ExternalCompletionPreflightBody & { digest: string };

export const externalCompletionPreflightReportSchema = reportBodySchema
  .extend({ digest: hexDigest })
  .superRefine((report, context) => {
    report.checks.forEach((check, index) => {
      if (check.name !== PREFLIGHT_CHECK_NAMES[index])
        context.addIssue({
          code: 'custom',
          path: ['checks', index, 'name'],
          message: 'Check order is fixed.',
        });
    });
    if (report.outcome === 'ready') {
      if (report.reasons.length !== 0)
        context.addIssue({ code: 'custom', path: ['reasons'], message: 'A ready report has no reason.' });
      if (report.checks.some((check) => check.status !== 'passed'))
        context.addIssue({
          code: 'custom',
          path: ['checks'],
          message: 'Every check passes for a ready report.',
        });
      if (
        report.actionFields === null ||
        buildExternalCompletionAction({
          ...report.actionFields,
          userReviewedPreflightDigest: ACTION_PLACEHOLDER_DIGEST,
        }) === null
      )
        context.addIssue({
          code: 'custom',
          path: ['actionFields'],
          message: 'A ready report must carry valid completion action fields.',
        });
      return;
    }
    if (report.reasons.length !== 1 || report.actionFields !== null)
      context.addIssue({
        code: 'custom',
        path: ['reasons'],
        message: 'A refused report has exactly one reason and no action fields.',
      });
    const failed = report.checks.findIndex((check) => check.status === 'failed');
    if (failed < 0 || report.checks.filter((check) => check.status === 'failed').length !== 1)
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'A refused report fails exactly one check.',
      });
    report.checks.forEach((check, index) => {
      const expected = index < failed ? 'passed' : index === failed ? 'failed' : 'skipped';
      if (failed >= 0 && check.status !== expected)
        context.addIssue({
          code: 'custom',
          path: ['checks', index, 'status'],
          message: 'Checks after a failure are skipped.',
        });
    });
  });

function domainDigest(domain: string, body: unknown): string {
  return createHash('sha256').update(domain).update('\0').update(canonicalJson(body)).digest('hex');
}

/** Digest of the report body without its own `digest` field. The body carries no time, so repeats are equal. */
export function computePreflightDigest(body: ExternalCompletionPreflightBody): string {
  return domainDigest(REPORT_DOMAIN, body);
}

/** Identity of the empty correction chain for one attestation (sequence 0, no tip, uncontested). */
export function computeEmptyCorrectionChainIdentity(input: {
  attestationId: string;
  attestationRecordDigest: string;
}) {
  const digest = domainDigest(CHAIN_DOMAIN, {
    schemaVersion: SCHEMA_VERSION,
    kind: ATTESTATION_CHAIN_KIND,
    attestationId: input.attestationId,
    attestationRecordDigest: input.attestationRecordDigest,
    sequence: 0,
    tipCorrectionDigest: null,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: ATTESTATION_CHAIN_KIND,
    attestationId: input.attestationId,
    sequence: 0,
    digest,
    standing: 'active_uncontested' as const,
  };
}

type EmptyChain = ReturnType<typeof computeEmptyCorrectionChainIdentity>;

/** Projection of the completion milestones used by `completionIdentity`; the evaluation object itself is discarded. */
export function computeMilestoneIdentityDigest(evaluation: {
  milestones: ReadonlyArray<{
    key: string;
    milestoneId: string | null;
    state: string;
    blockers: unknown;
    skipApprovalId: string | null;
  }>;
}): string {
  return domainDigest(
    MILESTONE_DOMAIN,
    evaluation.milestones.map(({ key, milestoneId, state, blockers, skipApprovalId }) => ({
      key,
      milestoneId,
      state,
      blockers,
      skipApprovalId,
    })),
  );
}

export class PreflightRefusal extends Error {
  constructor(
    readonly index: number,
    readonly code: PreflightReasonCode,
    readonly detail: string | null,
  ) {
    super(code);
    this.name = 'PreflightRefusal';
  }
}

type Facts = z.infer<typeof factsSchema>;

function emptyFacts(): Facts {
  return {
    goalStatus: null,
    definitionVersion: null,
    definitionHash: null,
    lineageDigest: null,
    mode: null,
    handoffId: null,
    handoffDigest: null,
    attestationActionDigest: null,
    attestationRecordDigest: null,
    correctionStanding: null,
    correctionSequence: null,
    destinationRef: null,
    attestedCommit: null,
    attestedTree: null,
    freshCommit: null,
    freshTree: null,
    objectFormat: null,
  };
}

interface Progress {
  index: number;
}

export interface PreflightOptions {
  /**
   * Only a decision service sets this. Recorded completion approvals then no longer refuse check 4, so the preflight
   * can name the reviewed digest of a decision that already exists. Recorded proofs still refuse.
   */
  allowRecordedDecision?: boolean;
}

/** Identity compared before and after the Git observation. Keys are snake_case so each name is a valid detail. */
export interface SnapshotIdentity {
  goal_status: string;
  definition_version: number;
  definition_hash: string;
  lineage_digest: string;
  attestation_record_digest: string;
  correction_standing: string;
  chain_digest: string;
  handoff_fingerprint: string;
  proof_rows: number;
  completion_approval_rows: number;
}

interface Snapshot {
  identity: SnapshotIdentity;
  definition: { version: number; hash: string; approvalId: string; lineageDigest: string };
  record: ExternalIntegrationAttestationV1;
  handoff: ManualIntegrationHandoffV1;
  emptyChain: EmptyChain;
}

/**
 * Checks 1 to 6 and the identity capture, in one deferred read transaction. A deferred transaction takes no writer
 * lock, and the function ends before any await, so no transaction is open during Git.
 */
function readSnapshot(
  db: Db,
  goalId: string,
  attestationId: string,
  progress: Progress,
  facts: Facts,
  options: PreflightOptions,
): Snapshot {
  return db.transaction((): Snapshot => {
    progress.index = CHECK.input;
    if (!UUID.safeParse(attestationId).success)
      throw new PreflightRefusal(CHECK.input, 'attestation_id_invalid', null);
    const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
      { status: string } | undefined;
    if (!goal) throw new PreflightRefusal(CHECK.input, 'goal_not_found', null);

    progress.index = CHECK.goal_status;
    facts.goalStatus = goal.status;
    if (goal.status !== 'running')
      throw new PreflightRefusal(CHECK.goal_status, 'goal_not_running', goal.status);

    progress.index = CHECK.definition;
    const authority = readApprovedCompletionAuthority(db, goalId);
    if (authority.kind !== 'valid')
      throw new PreflightRefusal(CHECK.definition, 'definition_not_approved', null);
    facts.definitionVersion = authority.version.version;
    facts.definitionHash = authority.version.definitionHash;
    facts.lineageDigest = authority.lineage.lineageDigest;
    facts.mode = authority.parsedPolicy.mode;
    if (authority.parsedPolicy.mode !== 'external_user_attested_v2')
      throw new PreflightRefusal(CHECK.definition, 'definition_not_v2', authority.parsedPolicy.mode);
    const definition = {
      version: authority.version.version,
      hash: authority.version.definitionHash,
      approvalId: authority.lineage.currentApprovalId,
      lineageDigest: authority.lineage.lineageDigest,
    };

    progress.index = CHECK.prior_completion;
    const proofs = db
      .prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?')
      .get(goalId) as { n: number };
    const recordedApprovals = db
      .prepare(
        'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL',
      )
      .get(goalId) as { n: number };
    if (proofs.n > 0 || (recordedApprovals.n > 0 && options.allowRecordedDecision !== true))
      throw new PreflightRefusal(CHECK.prior_completion, 'completion_already_recorded', null);

    progress.index = CHECK.attestation;
    let stored: ReturnType<typeof loadValidatedRecord>;
    try {
      stored = loadValidatedRecord(db, goalId, attestationId);
    } catch {
      throw new PreflightRefusal(CHECK.attestation, 'attestation_invalid', null);
    }
    if (!stored) throw new PreflightRefusal(CHECK.attestation, 'attestation_not_found', null);
    const record = stored.record;
    facts.attestationRecordDigest = record.recordDigest;
    facts.attestationActionDigest = record.actionDigest;
    facts.handoffId = record.handoff.id;
    facts.handoffDigest = record.handoff.digest;
    facts.destinationRef = record.destination.ref;
    facts.attestedCommit = record.destination.observedCommit;
    facts.attestedTree = record.destination.observedTree;
    facts.objectFormat = record.repository.objectFormat;
    if (
      record.definition.version !== definition.version ||
      record.definition.hash !== definition.hash ||
      record.definition.approvalId !== definition.approvalId
    )
      throw new PreflightRefusal(CHECK.attestation, 'attestation_definition_mismatch', null);
    let handoff: ManualIntegrationHandoffV1 | null;
    try {
      handoff = readValidatedManualHandoff(db, goalId, record.handoff.id);
    } catch {
      handoff = null;
    }
    if (!handoff || handoff.handoffDigest !== record.handoff.digest)
      throw new PreflightRefusal(CHECK.attestation, 'handoff_invalid', null);

    progress.index = CHECK.correction_standing;
    let standing: AttestationCorrectionStandingProjection;
    try {
      standing = getAttestationCorrectionStanding(db, goalId, attestationId);
    } catch {
      throw new PreflightRefusal(CHECK.correction_standing, 'correction_standing_unavailable', null);
    }
    facts.correctionStanding = standing.standing;
    if (standing.standing === 'invalid')
      throw new PreflightRefusal(
        CHECK.correction_standing,
        'correction_standing_invalid',
        standing.invalidCode,
      );
    if (standing.standing === 'disputed')
      throw new PreflightRefusal(CHECK.correction_standing, 'attestation_disputed', null);
    if (standing.standing === 'withdrawn')
      throw new PreflightRefusal(CHECK.correction_standing, 'attestation_withdrawn', null);
    if (standing.standing === 'superseded')
      throw new PreflightRefusal(CHECK.correction_standing, 'attestation_superseded', null);
    if (
      !attestationCorrectionStandingAllowsCompletion(standing.standing) ||
      standing.correctionCount !== 0 ||
      standing.tip !== null
    )
      throw new PreflightRefusal(CHECK.correction_standing, 'correction_standing_invalid', null);
    facts.correctionSequence = 0;

    const emptyChain = computeEmptyCorrectionChainIdentity({
      attestationId,
      attestationRecordDigest: record.recordDigest,
    });
    const identity: SnapshotIdentity = {
      goal_status: goal.status,
      definition_version: definition.version,
      definition_hash: definition.hash,
      lineage_digest: definition.lineageDigest,
      attestation_record_digest: record.recordDigest,
      correction_standing: standing.standing,
      chain_digest: emptyChain.digest,
      handoff_fingerprint: manualHandoffAttestationDatabaseFingerprint(db, goalId),
      proof_rows: proofs.n,
      completion_approval_rows: recordedApprovals.n,
    };
    return { identity, definition, record, handoff, emptyChain };
  })();
}

/** The first identity key whose value differs, or null when the identities are equal. */
export function firstDifference(before: SnapshotIdentity, after: SnapshotIdentity): string | null {
  for (const key of Object.keys(before) as (keyof SnapshotIdentity)[]) {
    if (before[key] !== after[key]) return key;
  }
  return null;
}

/**
 * The checks 1 to 6 identity, read now and without Git. A decision transaction compares it with the identity that
 * the reviewed preflight captured. Throws `PreflightRefusal` when a check would refuse.
 */
export function readPreflightSnapshotIdentity(
  db: Db,
  goalId: string,
  attestationId: string,
  options: PreflightOptions = {},
): SnapshotIdentity {
  return readSnapshot(db, goalId, attestationId, { index: CHECK.input }, emptyFacts(), options).identity;
}

function checksFor(failedIndex: number | null): ExternalCompletionPreflightBody['checks'] {
  return PREFLIGHT_CHECK_NAMES.map((name, index) => ({
    name,
    status:
      failedIndex === null || index < failedIndex ? 'passed' : index === failedIndex ? 'failed' : 'skipped',
  }));
}

const PROOF_LIMITATIONS = {
  contentPreservation: 'not_proven',
  goalCompletion: 'not_completed_by_preflight',
  destinationPolicy: 'exact_attested_tip',
} as const;

const AUTHORITY = { mintsApproval: false, mintsProof: false, mintsTerminalAuthority: false } as const;

/** The echo must satisfy the schema's 1..200 bound even for an empty or oversized input, so a bad echo is replaced. */
function echo(value: string): string {
  return value.length >= 1 && value.length <= 200 ? value : '[invalid]';
}

function finish(body: ExternalCompletionPreflightBody, index: number): ExternalCompletionPreflightReport {
  const digest = computePreflightDigest(body);
  const parsed = externalCompletionPreflightReportSchema.safeParse({ ...body, digest });
  if (!parsed.success) throw new PreflightRefusal(index, 'preflight_internal_invalid', null);
  return parsed.data;
}

function refusedBody(
  goalId: string,
  attestationId: string,
  index: number,
  code: PreflightReasonCode,
  detail: string | null,
  facts: Facts,
): ExternalCompletionPreflightBody {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: REPORT_KIND,
    goalId: echo(goalId),
    attestationId: echo(attestationId),
    outcome: 'refused',
    reasons: [{ code, detail }],
    checks: checksFor(index),
    facts: { ...facts },
    actionFields: null,
    proofLimitations: { ...PROOF_LIMITATIONS },
    authority: { ...AUTHORITY },
  };
}

/**
 * A refusal that never throws. Each attempt keeps `outcome: 'refused'` with one failed check and no action fields, so
 * no fallback can become `ready`. The fallbacks drop only diagnostic detail, in the order they are listed.
 */
const SAFE_REFUSAL: ExternalCompletionPreflightReport = finish(
  refusedBody('[invalid]', '[invalid]', 0, 'preflight_internal_invalid', null, emptyFacts()),
  0,
);

function refused(
  goalId: string,
  attestationId: string,
  index: number,
  code: PreflightReasonCode,
  detail: string | null,
  facts: Facts,
): ExternalCompletionPreflightReport {
  const at = Math.min(Math.max(Math.trunc(index), 0), PREFLIGHT_CHECK_NAMES.length - 1);
  const attempts: [PreflightReasonCode, string | null, Facts][] = [
    [code, detail, facts],
    [code, null, facts],
    ['preflight_internal_invalid', null, facts],
    ['preflight_internal_invalid', null, emptyFacts()],
  ];
  for (const [attemptCode, attemptDetail, attemptFacts] of attempts) {
    try {
      return finish(refusedBody(goalId, attestationId, at, attemptCode, attemptDetail, attemptFacts), at);
    } catch {
      // Any failure, including a non-refusal error from the digest, moves to the next attempt.
    }
  }
  return SAFE_REFUSAL;
}

/**
 * Computes the external completion preflight for one explicit attestation. Domain refusals are returned as a refused
 * report, never thrown. Unexpected failures become `preflight_unavailable` at the check that was running.
 */
export async function computeExternalCompletionPreflight(
  db: Db,
  goalId: string,
  input: { attestationId: string },
  options: PreflightOptions = {},
): Promise<ExternalCompletionPreflightReport> {
  return (await computeExternalCompletionPreflightWithIdentity(db, goalId, input, options)).report;
}

/**
 * The fresh Git observation a ready preflight relied on. It is returned beside the report, never inside its body, so
 * the report digest, schema and goldens do not change. The fields are the destination and proof facts that a completion
 * proof records; `observedAt` is set when the observation is built, after the Git reads.
 */
export interface PreflightObservationSummary {
  ref: string;
  commit: string;
  tree: string;
  objectFormat: 'sha1' | 'sha256';
  evidenceDigest: string;
  observedAt: string;
}

function summarizeObservation(observation: ExternalIntegrationObservationV1): PreflightObservationSummary {
  return {
    ref: observation.destination.ref,
    commit: observation.destination.observedCommit,
    tree: observation.destination.observedTree,
    objectFormat: observation.repository.objectFormat,
    evidenceDigest: observation.proof.evidenceDigest,
    observedAt: observation.observedAt,
  };
}

/**
 * The same preflight, plus three values returned beside the report. `identity` is the checks 1 to 6 identity captured
 * before Git. `postGitIdentity` is the identity captured after the Git observation (snapshot_after), which the preflight
 * has proven equal to `identity`. `observation` is the fresh Git observation. All three are null when the report is
 * refused, because a refused report is not a reviewed state. A decision uses `identity` to prove that nothing it depends
 * on changed between the review and its transaction.
 */
export async function computeExternalCompletionPreflightWithIdentity(
  db: Db,
  goalId: string,
  input: { attestationId: string },
  options: PreflightOptions = {},
): Promise<{
  report: ExternalCompletionPreflightReport;
  identity: SnapshotIdentity | null;
  observation: PreflightObservationSummary | null;
  postGitIdentity: SnapshotIdentity | null;
}> {
  const facts = emptyFacts();
  const progress: Progress = { index: CHECK.input };
  let identity: SnapshotIdentity | null = null;
  try {
    const first = readSnapshot(db, goalId, input.attestationId, progress, facts, options);
    identity = first.identity;
    const record = first.record;

    progress.index = CHECK.completion_evaluation;
    const evaluation = await evaluateCompletion(db, goalId);
    const failureCodes = evaluation.failures.map(({ code }) => code);
    if (
      failureCodes.length !== 1 ||
      failureCodes[0] !== 'external_completion_not_activated' ||
      !evaluation.finalReview.ok ||
      !evaluation.finalAcceptance.ok ||
      evaluation.finalReview.reviewId !== record.review.finalReviewId ||
      evaluation.finalAcceptance.approvalId !== record.review.acceptanceApprovalId
    )
      throw new PreflightRefusal(CHECK.completion_evaluation, 'completion_not_ready', null);
    const milestoneIdentityDigest = computeMilestoneIdentityDigest(evaluation);

    progress.index = CHECK.git_observation;
    let validation: ExternalIntegrationValidation;
    try {
      validation = await withExternalIntegrationVerificationSlot(goalId, () =>
        validateExternalIntegrationAttestation(db, goalId, input.attestationId),
      );
    } catch (error) {
      if (error instanceof ExternalIntegrationError && error.code === 'verification_busy')
        throw new PreflightRefusal(CHECK.git_observation, 'verification_busy', null);
      throw error;
    }
    const reasonDetail = validation.reason?.code ?? null;
    switch (validation.state) {
      case 'current':
        break;
      case 'historical':
        throw new PreflightRefusal(
          CHECK.git_observation,
          'destination_advanced_after_observation',
          reasonDetail,
        );
      case 'stale':
        throw new PreflightRefusal(CHECK.git_observation, 'attestation_stale', reasonDetail);
      case 'not_integrated':
        throw new PreflightRefusal(CHECK.git_observation, 'destination_not_integrated', reasonDetail);
      case 'unavailable':
        throw new PreflightRefusal(CHECK.git_observation, 'git_unavailable', reasonDetail);
      case 'invalid':
        throw new PreflightRefusal(CHECK.git_observation, 'attestation_invalid', reasonDetail);
    }
    // Defensive exact-tip assertion. A `current` validation already implies it; this keeps the D1 rule local.
    const observation = validation.currentObservation;
    if (
      observation === null ||
      observation.actionDigest !== record.actionDigest ||
      observation.destination.observedCommit !== record.destination.observedCommit ||
      observation.destination.observedTree !== record.destination.observedTree ||
      observation.proof.evidenceDigest !== record.proof.evidenceDigest
    )
      throw new PreflightRefusal(CHECK.git_observation, 'destination_advanced_after_observation', null);
    facts.freshCommit = observation.destination.observedCommit;
    facts.freshTree = observation.destination.observedTree;

    progress.index = CHECK.snapshot_after;
    let second: Snapshot;
    try {
      second = readSnapshot(
        db,
        goalId,
        input.attestationId,
        { index: CHECK.snapshot_after },
        emptyFacts(),
        options,
      );
    } catch (error) {
      if (error instanceof PreflightRefusal)
        throw new PreflightRefusal(CHECK.snapshot_after, 'observation_changed', error.code);
      throw error;
    }
    const changed = firstDifference(first.identity, second.identity);
    if (changed !== null) throw new PreflightRefusal(CHECK.snapshot_after, 'observation_changed', changed);

    progress.index = CHECK.assemble;
    const actionFields = {
      schemaVersion: SCHEMA_VERSION,
      action: 'complete_goal_external_integration_v2',
      completionContractVersion: 2,
      goalId,
      definition: {
        version: first.definition.version,
        hash: first.definition.hash,
        approvalId: first.definition.approvalId,
        lineageDigest: first.definition.lineageDigest,
      },
      integrationMode: 'external_user_attested',
      handoff: { id: record.handoff.id, digest: record.handoff.digest },
      attestation: {
        id: record.attestationId,
        actionDigest: record.actionDigest,
        recordDigest: record.recordDigest,
        approvalId: record.approvalId,
      },
      review: {
        finalReviewId: record.review.finalReviewId,
        acceptanceApprovalId: record.review.acceptanceApprovalId,
      },
      verificationEvidenceDigest: record.review.evidenceIdentityDigest,
      milestoneIdentityDigest,
      findingIdentityDigest: first.handoff.completion.findingsIdentityDigest,
      repository: {
        projectId: record.repository.projectId,
        identity: record.repository.identity,
        scope: record.repository.scope,
        objectFormat: record.repository.objectFormat,
      },
      source: { ref: record.source.ref, commit: record.source.commit, tree: record.source.tree },
      destination: {
        ref: record.destination.ref,
        recordedBaseCommit: record.destination.expectedBaseCommit,
        recordedBaseTree: record.destination.expectedBaseTree,
        observedCommit: record.destination.observedCommit,
        observedTree: record.destination.observedTree,
      },
      proof: {
        mode: record.proof.mode,
        sourceAncestor: record.proof.sourceAncestor,
        baseAncestor: record.proof.baseAncestor,
        verifierVersion: record.proof.verifierVersion,
        evidenceDigest: record.proof.evidenceDigest,
      },
      proofLimitations: { contentPreservation: 'not_proven' },
      correctionChain: first.emptyChain,
    };
    if (
      buildExternalCompletionAction({
        ...actionFields,
        userReviewedPreflightDigest: ACTION_PLACEHOLDER_DIGEST,
      }) === null
    )
      throw new PreflightRefusal(CHECK.assemble, 'preflight_internal_invalid', null);

    return {
      report: finish(
        {
          schemaVersion: SCHEMA_VERSION,
          kind: REPORT_KIND,
          goalId: echo(goalId),
          attestationId: echo(input.attestationId),
          outcome: 'ready',
          reasons: [],
          checks: checksFor(null),
          facts,
          actionFields,
          proofLimitations: { ...PROOF_LIMITATIONS },
          authority: { ...AUTHORITY },
        },
        CHECK.assemble,
      ),
      identity,
      observation: summarizeObservation(observation),
      postGitIdentity: second.identity,
    };
  } catch (error) {
    // A refused report carries no identity: the caller must not treat it as a reviewed state.
    const report =
      error instanceof PreflightRefusal
        ? refused(goalId, input.attestationId, error.index, error.code, error.detail, facts)
        : refused(goalId, input.attestationId, progress.index, 'preflight_unavailable', null, facts);
    return { report, identity: null, observation: null, postGitIdentity: null };
  }
}

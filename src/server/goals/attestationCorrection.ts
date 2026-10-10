import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { GoalApproval } from '../../shared/goals.js';
import { getGoalApproval, requestGoalApproval } from './approvals.js';
import { canonicalJson } from './definitionHash.js';
import { writeGoalEvent } from './events.js';
import {
  ATTESTATION_CORRECTION_ACTION,
  ATTESTATION_CORRECTION_EXPLANATION_MAX,
  attestationCorrectionApprovalDetailSchema,
  attestationCorrectionDetailFromRecord,
  attestationCorrectionExplanationSchema,
  attestationCorrectionRecordSchema,
  computeAttestationCorrectionActionDigest,
  computeAttestationCorrectionExplanationDigest,
  computeAttestationCorrectionRecordDigest,
  parseAttestationCorrectionApprovalDetail,
  parseAttestationCorrectionRecord,
  type AttestationCorrectionActionFields,
  type AttestationCorrectionApprovalDetailV1,
  type AttestationCorrectionKind,
  type AttestationCorrectionReasonCode,
  type AttestationCorrectionRecordV1,
} from './attestationCorrectionDetail.js';
import {
  ExternalIntegrationError,
  approvalIdentityMatchesRow,
  loadValidatedRecord,
  type ExternalIntegrationAttestationV1,
} from './externalIntegration.js';

// Stage 7C.2B.5D.2: append-only correction ledger for external-integration attestations.
// Every read and write re-verifies the whole per-attestation chain. Git is never consulted here: a correction is a
// user decision about a historical claim, so it remains valid even when the repository has since moved.

export type AttestationCorrectionErrorCode =
  | 'goal_not_found'
  | 'attestation_not_found'
  | 'attestation_invalid'
  | 'approval_required'
  | 'approval_mismatch'
  | 'correction_action_mismatch'
  | 'correction_chain_invalid'
  | 'correction_chain_changed'
  | 'correction_transition_not_allowed'
  | 'replacement_invalid'
  | 'explanation_invalid'
  | 'idempotency_conflict'
  | 'persistence_failed';

export class AttestationCorrectionError extends Error {
  constructor(
    readonly code: AttestationCorrectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttestationCorrectionError';
  }
}

export type AttestationCorrectionStanding =
  'active_uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'invalid';

interface CorrectionRow {
  id: string;
  goal_id: string;
  handoff_id: string;
  handoff_digest: string;
  attestation_id: string;
  attestation_action_digest: string;
  attestation_record_digest: string;
  approval_id: string;
  correction_kind: AttestationCorrectionKind;
  sequence: number;
  previous_correction_digest: string | null;
  action_digest: string;
  correction_digest: string;
  reason_code: AttestationCorrectionReasonCode;
  explanation: string | null;
  explanation_digest: string | null;
  replacement_attestation_id: string | null;
  replacement_record_digest: string | null;
  definition_version: number;
  definition_hash: string;
  decided_at: string;
  payload_json: string;
}

interface OriginalAttestation {
  record: ExternalIntegrationAttestationV1;
}

function correctionError(code: AttestationCorrectionErrorCode, message: string): AttestationCorrectionError {
  return new AttestationCorrectionError(code, message);
}

function assertGoal(db: Db, goalId: string): void {
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
    throw correctionError('goal_not_found', 'The Goal does not exist.');
}

/** Loads one attestation for this Goal and proves its integrity and approval authority. Git is not consulted. */
function loadOriginalAttestation(db: Db, goalId: string, attestationId: string): OriginalAttestation {
  assertGoal(db, goalId);
  let loaded: ReturnType<typeof loadValidatedRecord>;
  try {
    loaded = loadValidatedRecord(db, goalId, attestationId);
  } catch (error) {
    if (error instanceof ExternalIntegrationError)
      throw correctionError('attestation_invalid', 'The attestation failed integrity validation.');
    throw error;
  }
  if (!loaded)
    throw correctionError('attestation_not_found', 'The attestation does not exist for this Goal.');
  if (!approvalIdentityMatchesRow(getGoalApproval(db, loaded.record.approvalId), loaded.record))
    throw correctionError('attestation_invalid', 'The attestation approval authority is not valid.');
  return { record: loaded.record };
}

function rowMatchesRecord(row: CorrectionRow, record: AttestationCorrectionRecordV1): boolean {
  return (
    row.id === record.correctionId &&
    row.goal_id === record.goalId &&
    row.handoff_id === record.handoffId &&
    row.handoff_digest === record.handoffDigest &&
    row.attestation_id === record.attestationId &&
    row.attestation_action_digest === record.attestationActionDigest &&
    row.attestation_record_digest === record.attestationRecordDigest &&
    row.approval_id === record.approvalId &&
    row.correction_kind === record.correctionKind &&
    row.sequence === record.sequence &&
    row.previous_correction_digest === record.previousCorrectionDigest &&
    row.action_digest === record.actionDigest &&
    row.correction_digest === record.correctionDigest &&
    row.reason_code === record.reasonCode &&
    row.explanation === record.explanation &&
    row.explanation_digest === record.explanationDigest &&
    row.replacement_attestation_id === (record.replacement?.attestationId ?? null) &&
    row.replacement_record_digest === (record.replacement?.recordDigest ?? null) &&
    row.definition_version === record.definition.version &&
    row.definition_hash === record.definition.hash &&
    row.decided_at === record.decision.decidedAt
  );
}

function invalidChain(message: string): never {
  throw correctionError('correction_chain_invalid', message);
}

function transitionAllowed(
  tipKind: AttestationCorrectionKind | null,
  next: AttestationCorrectionKind,
): boolean {
  if (tipKind === null) return true;
  return tipKind === 'dispute' && (next === 'withdraw' || next === 'supersede');
}

/**
 * Verifies every stored correction of one attestation: strict payload, digests, columns, per-attestation sequence,
 * previous-digest chain, allowed transitions, and the exact user approval it was decided under.
 */
function loadVerifiedChain(
  db: Db,
  goalId: string,
  original: OriginalAttestation,
): { records: AttestationCorrectionRecordV1[]; tip: AttestationCorrectionRecordV1 | null } {
  const { record: attestation } = original;
  const rows = db
    .prepare(
      'SELECT * FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ? ORDER BY sequence',
    )
    .all(goalId, attestation.attestationId) as CorrectionRow[];
  const records: AttestationCorrectionRecordV1[] = [];
  for (const row of rows) {
    const index = records.length;
    const record = parseAttestationCorrectionRecord(row.payload_json);
    if (!record) invalidChain('A stored attestation correction failed strict integrity validation.');
    if (!rowMatchesRecord(row, record))
      invalidChain('A stored attestation correction does not match its row.');
    if (
      record.goalId !== goalId ||
      record.attestationId !== attestation.attestationId ||
      record.handoffId !== attestation.handoff.id ||
      record.handoffDigest !== attestation.handoff.digest ||
      record.attestationActionDigest !== attestation.actionDigest ||
      record.attestationRecordDigest !== attestation.recordDigest ||
      record.definition.version !== attestation.definition.version ||
      record.definition.hash !== attestation.definition.hash
    )
      invalidChain('A stored attestation correction is bound to a different attestation.');
    const previous = index === 0 ? null : records[index - 1]!;
    if (
      record.sequence !== index + 1 ||
      record.previousCorrectionDigest !== (previous?.correctionDigest ?? null)
    )
      invalidChain('A stored attestation correction breaks the per-attestation chain.');
    if (!transitionAllowed(previous?.correctionKind ?? null, record.correctionKind))
      invalidChain('A stored attestation correction uses a transition the chain does not allow.');
    const expected = attestationCorrectionDetailFromRecord(record, attestation.approvalId);
    if (expected.actionDigest !== record.actionDigest)
      invalidChain('A stored attestation correction action digest does not match its fields.');
    const approval = getGoalApproval(db, record.approvalId);
    if (!approvalMatchesRecord(approval, record, attestation.approvalId))
      invalidChain('A stored attestation correction approval does not authorize its exact record.');
    if (record.replacement) {
      let replacement: ReturnType<typeof loadValidatedRecord>;
      try {
        replacement = loadValidatedRecord(db, goalId, record.replacement.attestationId);
      } catch {
        invalidChain('A stored replacement attestation failed integrity validation.');
      }
      if (
        !replacement ||
        replacement.record.recordDigest !== record.replacement.recordDigest ||
        !approvalIdentityMatchesRow(getGoalApproval(db, replacement.record.approvalId), replacement.record)
      )
        invalidChain('A stored replacement attestation binding does not match.');
    }
    records.push(record);
  }
  return { records, tip: records.at(-1) ?? null };
}

function approvalMatchesRecord(
  approval: GoalApproval | undefined,
  record: AttestationCorrectionRecordV1,
  attestationApprovalId: string,
): approval is GoalApproval {
  if (
    !approval ||
    approval.goalId !== record.goalId ||
    approval.gate !== 'user_confirmation' ||
    approval.risk !== 'high' ||
    approval.requestedBy !== 'user' ||
    approval.status !== 'approved' ||
    approval.decidedBy !== 'user' ||
    approval.respondedAt !== record.decision.decidedAt ||
    approval.attestationCorrectionActionDigest !== record.actionDigest
  )
    return false;
  return (
    canonicalJson(approval.detail) ===
    canonicalJson(attestationCorrectionDetailFromRecord(record, attestationApprovalId))
  );
}

/** Loads a same-Goal replacement that is independently valid, compatible, and not itself corrected. */
function loadCompatibleReplacement(
  db: Db,
  goalId: string,
  original: ExternalIntegrationAttestationV1,
  replacementId: string,
): ExternalIntegrationAttestationV1 {
  if (replacementId === original.attestationId)
    throw correctionError('replacement_invalid', 'An attestation cannot replace itself.');
  let loaded: ReturnType<typeof loadValidatedRecord>;
  try {
    loaded = loadValidatedRecord(db, goalId, replacementId);
  } catch {
    throw correctionError('replacement_invalid', 'The replacement attestation failed integrity validation.');
  }
  if (!loaded || !approvalIdentityMatchesRow(getGoalApproval(db, loaded.record.approvalId), loaded.record))
    throw correctionError('replacement_invalid', 'The replacement attestation does not exist for this Goal.');
  const replacement = loaded.record;
  if (
    replacement.definition.version !== original.definition.version ||
    replacement.definition.hash !== original.definition.hash ||
    replacement.repository.identity !== original.repository.identity ||
    replacement.repository.projectId !== original.repository.projectId
  )
    throw correctionError(
      'replacement_invalid',
      'A replacement must share the same definition and repository identity.',
    );
  const corrected = db
    .prepare('SELECT 1 FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?')
    .get(goalId, replacementId);
  if (corrected)
    throw correctionError('replacement_invalid', 'The replacement attestation has been corrected.');
  return replacement;
}

export interface AttestationCorrectionInput {
  goalId: string;
  attestationId: string;
  correctionKind: AttestationCorrectionKind;
  reasonCode: AttestationCorrectionReasonCode;
  explanation: string | null;
  replacementAttestationId: string | null;
}

/** Builds the exact correction action that the user must review, bound to the current verified chain tip. */
export function buildAttestationCorrectionAction(
  db: Db,
  input: AttestationCorrectionInput,
): { detail: AttestationCorrectionApprovalDetailV1; actionDigest: string } {
  const original = loadOriginalAttestation(db, input.goalId, input.attestationId);
  const { tip } = loadVerifiedChain(db, input.goalId, original);
  if (!transitionAllowed(tip?.correctionKind ?? null, input.correctionKind))
    throw correctionError(
      'correction_transition_not_allowed',
      'This correction is not allowed after the attestation’s current correction state.',
    );
  let explanationDigest: string | null = null;
  if (input.explanation !== null) {
    const parsed = attestationCorrectionExplanationSchema.safeParse(input.explanation);
    if (!parsed.success)
      throw correctionError(
        'explanation_invalid',
        `The explanation must be 1 to ${ATTESTATION_CORRECTION_EXPLANATION_MAX} characters without control characters.`,
      );
    explanationDigest = computeAttestationCorrectionExplanationDigest(parsed.data);
  }
  let replacementRecordDigest: string | null = null;
  if (input.correctionKind === 'supersede') {
    if (!input.replacementAttestationId)
      throw correctionError('replacement_invalid', 'A supersession must name its replacement attestation.');
    replacementRecordDigest = loadCompatibleReplacement(
      db,
      input.goalId,
      original.record,
      input.replacementAttestationId,
    ).recordDigest;
  }
  const fields: AttestationCorrectionActionFields = {
    schemaVersion: 1,
    action: ATTESTATION_CORRECTION_ACTION,
    goalId: input.goalId,
    handoffId: original.record.handoff.id,
    handoffDigest: original.record.handoff.digest,
    attestationId: original.record.attestationId,
    attestationActionDigest: original.record.actionDigest,
    attestationRecordDigest: original.record.recordDigest,
    attestationApprovalId: original.record.approvalId,
    correctionKind: input.correctionKind,
    sequence: (tip?.sequence ?? 0) + 1,
    previousCorrectionDigest: tip?.correctionDigest ?? null,
    reasonCode: input.reasonCode,
    explanationDigest,
    replacementAttestationId: input.correctionKind === 'supersede' ? input.replacementAttestationId : null,
    replacementRecordDigest,
    definitionVersion: original.record.definition.version,
    definitionHash: original.record.definition.hash,
  };
  const actionDigest = computeAttestationCorrectionActionDigest(fields);
  const detail = attestationCorrectionApprovalDetailSchema.parse({ ...fields, actionDigest });
  return { detail, actionDigest };
}

/** Requests the high-risk user decision that will authorize exactly one reviewed correction action. */
export function requestAttestationCorrectionApproval(
  db: Db,
  input: AttestationCorrectionInput,
): { approval: GoalApproval; actionDigest: string; detail: AttestationCorrectionApprovalDetailV1 } {
  const { detail, actionDigest } = buildAttestationCorrectionAction(db, input);
  const approval = requestGoalApproval(db, {
    goalId: input.goalId,
    gate: 'user_confirmation',
    risk: 'high',
    reason: 'Record a user correction of a historical external-integration attestation.',
    requestedBy: 'user',
    detail,
    attestationCorrectionActionDigest: actionDigest,
  });
  return { approval, actionDigest, detail };
}

export interface AppendAttestationCorrectionInput {
  goalId: string;
  approvalId: string;
  expectedActionDigest: string;
  explanation: string | null;
}

/**
 * Appends one correction. The chain is fully re-verified and the previous-digest CAS checked inside a single
 * immediate SQLite transaction. An identical retry returns the original record; any competing or stale chain is
 * refused. Git is never touched.
 */
export function appendAttestationCorrection(
  db: Db,
  input: AppendAttestationCorrectionInput,
): { record: AttestationCorrectionRecordV1; reused: boolean } {
  const append = db.transaction(() => {
    assertGoal(db, input.goalId);
    const approval = getGoalApproval(db, input.approvalId);
    if (!approval || approval.goalId !== input.goalId)
      throw correctionError('approval_mismatch', 'The approval does not authorize this Goal.');
    if (approval.status !== 'approved' || approval.decidedBy !== 'user' || !approval.respondedAt)
      throw correctionError('approval_required', 'A matching approved user decision is required.');
    if (
      approval.gate !== 'user_confirmation' ||
      approval.risk !== 'high' ||
      approval.requestedBy !== 'user' ||
      approval.attestationCorrectionActionDigest !== input.expectedActionDigest
    )
      throw correctionError(
        'correction_action_mismatch',
        'The approval does not match the reviewed correction.',
      );
    const detail = parseAttestationCorrectionApprovalDetail(approval.detail);
    if (!detail || detail.goalId !== input.goalId || detail.actionDigest !== input.expectedActionDigest)
      throw correctionError(
        'correction_action_mismatch',
        'The approval does not match the reviewed correction.',
      );

    if (detail.explanationDigest === null) {
      if (input.explanation !== null)
        throw correctionError('explanation_invalid', 'The approved correction has no explanation.');
    } else {
      const parsed =
        input.explanation === null
          ? null
          : attestationCorrectionExplanationSchema.safeParse(input.explanation);
      if (
        !parsed ||
        !parsed.success ||
        computeAttestationCorrectionExplanationDigest(parsed.data) !== detail.explanationDigest
      )
        throw correctionError(
          'explanation_invalid',
          'The explanation does not match the approved correction.',
        );
    }

    const original = loadOriginalAttestation(db, input.goalId, detail.attestationId);
    const attestation = original.record;
    if (
      attestation.handoff.id !== detail.handoffId ||
      attestation.handoff.digest !== detail.handoffDigest ||
      attestation.actionDigest !== detail.attestationActionDigest ||
      attestation.recordDigest !== detail.attestationRecordDigest ||
      attestation.approvalId !== detail.attestationApprovalId ||
      attestation.definition.version !== detail.definitionVersion ||
      attestation.definition.hash !== detail.definitionHash
    )
      throw correctionError(
        'correction_action_mismatch',
        'The attestation no longer matches the reviewed correction.',
      );

    const { records, tip } = loadVerifiedChain(db, input.goalId, original);
    const existing = records.find((record) => record.actionDigest === input.expectedActionDigest);
    if (existing) {
      if (existing.approvalId !== input.approvalId)
        throw correctionError(
          'idempotency_conflict',
          'An identical correction action has conflicting authority.',
        );
      return { record: existing, reused: true };
    }

    if (
      detail.sequence !== (tip?.sequence ?? 0) + 1 ||
      detail.previousCorrectionDigest !== (tip?.correctionDigest ?? null)
    )
      throw correctionError('correction_chain_changed', 'The correction chain changed after review.');
    if (!transitionAllowed(tip?.correctionKind ?? null, detail.correctionKind))
      throw correctionError(
        'correction_transition_not_allowed',
        'This correction is not allowed after the attestation’s current correction state.',
      );
    if (detail.replacementAttestationId !== null) {
      const replacement = loadCompatibleReplacement(
        db,
        input.goalId,
        attestation,
        detail.replacementAttestationId,
      );
      if (replacement.recordDigest !== detail.replacementRecordDigest)
        throw correctionError('replacement_invalid', 'The replacement attestation digest does not match.');
    }

    const decidedAt = approval.respondedAt;
    const body = {
      schemaVersion: 1 as const,
      kind: 'turing_goal_attestation_correction' as const,
      correctionId: randomUUID(),
      goalId: input.goalId,
      handoffId: detail.handoffId,
      handoffDigest: detail.handoffDigest,
      attestationId: detail.attestationId,
      attestationActionDigest: detail.attestationActionDigest,
      attestationRecordDigest: detail.attestationRecordDigest,
      approvalId: input.approvalId,
      correctionKind: detail.correctionKind,
      sequence: detail.sequence,
      previousCorrectionDigest: detail.previousCorrectionDigest,
      actionDigest: detail.actionDigest,
      reasonCode: detail.reasonCode,
      explanation: input.explanation,
      explanationDigest: detail.explanationDigest,
      replacement:
        detail.replacementAttestationId && detail.replacementRecordDigest
          ? { attestationId: detail.replacementAttestationId, recordDigest: detail.replacementRecordDigest }
          : null,
      definition: { version: detail.definitionVersion, hash: detail.definitionHash },
      decision: {
        value: ATTESTATION_CORRECTION_ACTION,
        decidedBy: 'user' as const,
        decidedAt,
      },
    };
    const correctionDigest = computeAttestationCorrectionRecordDigest(body);
    const record = attestationCorrectionRecordSchema.parse({ ...body, correctionDigest });
    db.prepare(
      `INSERT INTO goal_attestation_corrections (
        id, goal_id, schema_version, kind, handoff_id, handoff_digest, attestation_id,
        attestation_action_digest, attestation_record_digest, approval_id, correction_kind, sequence,
        previous_correction_digest, action_digest, correction_digest, reason_code, explanation,
        explanation_digest, replacement_attestation_id, replacement_record_digest, definition_version,
        definition_hash, decided_at, payload_json
      ) VALUES (
        @id, @goal_id, @schema_version, @kind, @handoff_id, @handoff_digest, @attestation_id,
        @attestation_action_digest, @attestation_record_digest, @approval_id, @correction_kind, @sequence,
        @previous_correction_digest, @action_digest, @correction_digest, @reason_code, @explanation,
        @explanation_digest, @replacement_attestation_id, @replacement_record_digest, @definition_version,
        @definition_hash, @decided_at, @payload_json
      )`,
    ).run({
      id: record.correctionId,
      goal_id: record.goalId,
      schema_version: record.schemaVersion,
      kind: record.kind,
      handoff_id: record.handoffId,
      handoff_digest: record.handoffDigest,
      attestation_id: record.attestationId,
      attestation_action_digest: record.attestationActionDigest,
      attestation_record_digest: record.attestationRecordDigest,
      approval_id: record.approvalId,
      correction_kind: record.correctionKind,
      sequence: record.sequence,
      previous_correction_digest: record.previousCorrectionDigest,
      action_digest: record.actionDigest,
      correction_digest: record.correctionDigest,
      reason_code: record.reasonCode,
      explanation: record.explanation,
      explanation_digest: record.explanationDigest,
      replacement_attestation_id: record.replacement?.attestationId ?? null,
      replacement_record_digest: record.replacement?.recordDigest ?? null,
      definition_version: record.definition.version,
      definition_hash: record.definition.hash,
      decided_at: record.decision.decidedAt,
      payload_json: canonicalJson(record),
    });
    writeGoalEvent(db, input.goalId, 'external_integration_corrected', {
      correctionId: record.correctionId,
      attestationId: record.attestationId,
      correctionKind: record.correctionKind,
      correctionDigest: record.correctionDigest,
    });
    return { record, reused: false };
  });
  try {
    return append.immediate();
  } catch (error) {
    if (error instanceof AttestationCorrectionError) throw error;
    throw correctionError('persistence_failed', 'The correction could not be persisted safely.');
  }
}

export interface AttestationCorrectionHistoryEntry {
  correctionId: string;
  correctionKind: AttestationCorrectionKind;
  sequence: number;
  correctionDigest: string;
  previousCorrectionDigest: string | null;
  actionDigest: string;
  approvalId: string;
  reasonCode: AttestationCorrectionReasonCode;
  explanation: string | null;
  replacementAttestationId: string | null;
  replacementRecordDigest: string | null;
  decidedAt: string;
}

/**
 * Read-only, fully verified correction history for one attestation. The chain is at most two entries long under the
 * transition rules, so no pagination is needed. Any verification failure is a refusal, not a partial history.
 */
export function listAttestationCorrectionHistory(
  db: Db,
  goalId: string,
  attestationId: string,
): AttestationCorrectionHistoryEntry[] {
  const original = loadOriginalAttestation(db, goalId, attestationId);
  return loadVerifiedChain(db, goalId, original).records.map((record) => ({
    correctionId: record.correctionId,
    correctionKind: record.correctionKind,
    sequence: record.sequence,
    correctionDigest: record.correctionDigest,
    previousCorrectionDigest: record.previousCorrectionDigest,
    actionDigest: record.actionDigest,
    approvalId: record.approvalId,
    reasonCode: record.reasonCode,
    explanation: record.explanation,
    replacementAttestationId: record.replacement?.attestationId ?? null,
    replacementRecordDigest: record.replacement?.recordDigest ?? null,
    decidedAt: record.decision.decidedAt,
  }));
}

export interface AttestationCorrectionStandingProjection {
  goalId: string;
  attestationId: string;
  standing: AttestationCorrectionStanding;
  correctionCount: number;
  tip: {
    correctionId: string;
    kind: AttestationCorrectionKind;
    sequence: number;
    correctionDigest: string;
    replacementAttestationId: string | null;
  } | null;
  /** Present only when standing is `invalid`; the chain or original attestation failed verification. */
  invalidCode: AttestationCorrectionErrorCode | null;
}

/**
 * Read-only projection of the per-attestation chain. Standing is historical: a later Git movement does not change it,
 * and `active_uncontested` is only the absence of a correction. Completion eligibility is decided by the caller.
 */
export function getAttestationCorrectionStanding(
  db: Db,
  goalId: string,
  attestationId: string,
): AttestationCorrectionStandingProjection {
  const original = loadOriginalAttestation(db, goalId, attestationId);
  try {
    const { records, tip } = loadVerifiedChain(db, goalId, original);
    const standing: AttestationCorrectionStanding =
      tip === null
        ? 'active_uncontested'
        : tip.correctionKind === 'dispute'
          ? 'disputed'
          : tip.correctionKind === 'withdraw'
            ? 'withdrawn'
            : 'superseded';
    return {
      goalId,
      attestationId,
      standing,
      correctionCount: records.length,
      tip: tip
        ? {
            correctionId: tip.correctionId,
            kind: tip.correctionKind,
            sequence: tip.sequence,
            correctionDigest: tip.correctionDigest,
            replacementAttestationId: tip.replacement?.attestationId ?? null,
          }
        : null,
      invalidCode: null,
    };
  } catch (error) {
    if (error instanceof AttestationCorrectionError)
      return {
        goalId,
        attestationId,
        standing: 'invalid',
        correctionCount: 0,
        tip: null,
        invalidCode: error.code,
      };
    throw error;
  }
}

/** Only undisputed, uncorrected standing may support a new completion. Completion itself stays a separate decision. */
export function attestationCorrectionStandingAllowsCompletion(
  standing: AttestationCorrectionStanding,
): boolean {
  return standing === 'active_uncontested';
}

import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { GoalApproval } from '../../shared/goals.js';
import {
  attestationCorrectionStandingAllowsCompletion,
  getAttestationCorrectionStanding,
  type AttestationCorrectionStanding,
} from './attestationCorrection.js';
import { canonicalJson } from './definitionHash.js';
import {
  completionRows,
  countCompletionRows,
  validateCompletionApproval,
  type ExternalCompletionDecisionInvalidReason,
} from './externalCompletionDecisionRows.js';
import { loadValidatedRecord } from './externalIntegration.js';

/**
 * Read-only completion authority classifier. It reads the Goal's proof rows and completion-decision rows
 * and reports which authority state the Goal is in. It reads no Git state, no clock, and writes nothing. Its policy
 * digest is a domain-separated identity of that state, so a flow can detect that authority moved between two reads.
 */

const POLICY_DOMAIN = 'turing-goal-external-completion-policy-v1';
/** Constants of the empty correction chain identity. They mirror the preflight's; this file must not import it. */
const CHAIN_SCHEMA_VERSION = 1;
const CHAIN_KIND = 'turing_goal_external_integration_correction_chain';
const CHAIN_DOMAIN = 'turing-goal-attestation-correction-chain-v1';

/** The classifier reads at most this many completion rows; a Goal above the cap fails closed. */
const MAX_COMPLETION_ROWS = 50;

export type CompletionAuthorityClass = 1 | 2 | 3 | 4 | 5 | 6;

/** Why one completion row is not intact. `ok` means every check passed. */
export type CompletionAuthorityIntegrity =
  | 'ok'
  | ExternalCompletionDecisionInvalidReason
  | 'goal_mismatch'
  | 'attestation_not_found'
  | 'attestation_invalid'
  | 'attestation_record_mismatch'
  | 'correction_chain_invalid'
  | 'correction_chain_digest_mismatch'
  | 'correction_standing_unavailable'
  | 'row_unreadable';

/** The class-5 reason: the first non-intact row, the cap, or a failed history read. Null for every other class. */
export type CompletionAuthorityReason =
  CompletionAuthorityIntegrity | 'too_many_decisions' | 'history_unreadable';

export interface CompletionAuthorityEntry {
  decisionId: string;
  actionDigest: string | null;
  reviewedPreflightDigest: string | null;
  attestationId: string | null;
  attestationRecordDigest: string | null;
  integrity: CompletionAuthorityIntegrity;
  standing: AttestationCorrectionStanding | null;
  correctionCount: number | null;
  correctionSequence: number | null;
  correctionTipDigest: string | null;
  eligible: boolean;
}

export interface CompletionAuthorityClassification {
  class: CompletionAuthorityClass;
  reason: CompletionAuthorityReason | null;
  selectedAttestationId: string;
  proofIds: string[];
  entries: CompletionAuthorityEntry[];
  policyDigest: string;
}

/**
 * The digest an empty correction chain (sequence 0, no tip) must carry for one attestation. It repeats the preflight's
 * identity algorithm, so a stored chain built any other way fails the integrity check. Private: no identity is imported.
 */
function expectedEmptyChainDigest(attestationId: string, attestationRecordDigest: string): string {
  return createHash('sha256')
    .update(CHAIN_DOMAIN)
    .update('\0')
    .update(
      canonicalJson({
        schemaVersion: CHAIN_SCHEMA_VERSION,
        kind: CHAIN_KIND,
        attestationId,
        attestationRecordDigest,
        sequence: 0,
        tipCorrectionDigest: null,
      }),
    )
    .digest('hex');
}

/** A row whose contents cannot be trusted: every field it could not establish is null, and integrity says why. */
function unreadableEntry(
  decisionId: string,
  integrity: CompletionAuthorityIntegrity,
): CompletionAuthorityEntry {
  return {
    decisionId,
    actionDigest: null,
    reviewedPreflightDigest: null,
    attestationId: null,
    attestationRecordDigest: null,
    integrity,
    standing: null,
    correctionCount: null,
    correctionSequence: null,
    correctionTipDigest: null,
    eligible: false,
  };
}

/**
 * One completion row's entry. The row must pass the decision validator, the attestation it names must load and match
 * the row's digests, and its correction chain must read as a standing. Eligibility is correction standing only: a
 * Git-stale attestation with no correction is still eligible here.
 */
function entryFor(
  db: Db,
  goalId: string,
  decisionId: string,
  approval: GoalApproval | null,
): CompletionAuthorityEntry {
  const checked = validateCompletionApproval(approval);
  if (!checked.valid) return unreadableEntry(decisionId, checked.reason);
  const { action } = checked;
  const attestation = action.attestation;
  const identity = {
    decisionId,
    actionDigest: action.actionDigest,
    reviewedPreflightDigest: action.userReviewedPreflightDigest,
    attestationId: attestation.id,
    attestationRecordDigest: attestation.recordDigest,
  };
  const failed = (integrity: CompletionAuthorityIntegrity): CompletionAuthorityEntry => ({
    ...unreadableEntry(decisionId, integrity),
    ...identity,
  });

  if (action.goalId !== goalId) return failed('goal_mismatch');

  let stored: ReturnType<typeof loadValidatedRecord>;
  try {
    stored = loadValidatedRecord(db, goalId, attestation.id);
  } catch {
    return failed('attestation_invalid');
  }
  if (!stored) return failed('attestation_not_found');
  const { record } = stored;
  if (
    record.recordDigest !== attestation.recordDigest ||
    record.actionDigest !== attestation.actionDigest ||
    record.approvalId !== attestation.approvalId ||
    record.handoff.id !== action.handoff.id ||
    record.handoff.digest !== action.handoff.digest
  )
    return failed('attestation_record_mismatch');
  if (action.correctionChain.sequence !== 0) return failed('correction_chain_invalid');
  if (action.correctionChain.digest !== expectedEmptyChainDigest(attestation.id, attestation.recordDigest))
    return failed('correction_chain_digest_mismatch');

  let projection: ReturnType<typeof getAttestationCorrectionStanding>;
  try {
    projection = getAttestationCorrectionStanding(db, goalId, attestation.id);
  } catch {
    return failed('correction_standing_unavailable');
  }
  if (projection.standing === 'invalid') return failed('correction_chain_invalid');

  return {
    ...identity,
    integrity: 'ok',
    standing: projection.standing,
    correctionCount: projection.correctionCount,
    correctionSequence: projection.tip?.sequence ?? 0,
    correctionTipDigest: projection.tip?.correctionDigest ?? null,
    eligible:
      attestationCorrectionStandingAllowsCompletion(projection.standing) &&
      projection.correctionCount === 0 &&
      projection.tip === null,
  };
}

/** Never throws: any failure while reading one row becomes a `row_unreadable` entry. */
function safeEntryFor(
  db: Db,
  goalId: string,
  decisionId: string,
  approval: GoalApproval | null,
): CompletionAuthorityEntry {
  try {
    return entryFor(db, goalId, decisionId, approval);
  } catch {
    return unreadableEntry(decisionId, 'row_unreadable');
  }
}

function byDecisionId(a: CompletionAuthorityEntry, b: CompletionAuthorityEntry): number {
  return a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0;
}

function policyDigest(body: unknown): string {
  return createHash('sha256').update(POLICY_DOMAIN).update('\0').update(canonicalJson(body)).digest('hex');
}

/** The result of one classification. Every result, including a fail-closed one, gets its digest the same way. */
function classification(
  goalId: string,
  selectedAttestationId: string,
  klass: CompletionAuthorityClass,
  reason: CompletionAuthorityReason | null,
  proofIds: string[],
  entries: CompletionAuthorityEntry[],
): CompletionAuthorityClassification {
  const body = {
    schemaVersion: 1,
    goalId,
    selectedAttestationId,
    class: klass,
    proofIds,
    entries,
  };
  return {
    class: klass,
    reason,
    selectedAttestationId,
    proofIds,
    entries,
    policyDigest: policyDigest(body),
  };
}

/**
 * Classifies the completion authority state of one Goal for one selected attestation. Precedence: 6 terminal proof
 * exists, 5 history invalid or unavailable (including the row cap), 4 another attestation has an eligible decision,
 * 2 a decision exists for the selected attestation, 3 decisions exist but all are corrected elsewhere, 1 none exist.
 */
export function classifyCompletionAuthority(
  db: Db,
  goalId: string,
  selectedAttestationId: string,
): CompletionAuthorityClassification {
  let proofIds: string[];
  let overCap: boolean;
  let rows: { id: string; approval: GoalApproval | null }[] = [];
  try {
    proofIds = (
      db
        .prepare('SELECT id FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY id')
        .all(goalId) as { id: string }[]
    ).map(({ id }) => id);
    overCap = countCompletionRows(db, goalId) > MAX_COMPLETION_ROWS;
    // Over the cap no completion row is read at all.
    if (!overCap) rows = completionRows(db, goalId);
  } catch {
    // The proof read failed, so a terminal proof may exist: this is class 5 and never class 6.
    return classification(goalId, selectedAttestationId, 5, 'history_unreadable', [], []);
  }

  let entries: CompletionAuthorityEntry[] = [];
  let klass: CompletionAuthorityClass;
  let reason: CompletionAuthorityReason | null = null;

  if (overCap) {
    // A terminal proof still outranks the cap.
    if (proofIds.length > 0) klass = 6;
    else {
      klass = 5;
      reason = 'too_many_decisions';
    }
  } else {
    entries = rows.map(({ id, approval }) => safeEntryFor(db, goalId, id, approval)).sort(byDecisionId);
    const invalid = entries.find((entry) => entry.integrity !== 'ok');
    const others = entries.filter((entry) => entry.attestationId !== selectedAttestationId);
    const own = entries.filter((entry) => entry.attestationId === selectedAttestationId);
    if (proofIds.length > 0) klass = 6;
    else if (invalid) {
      klass = 5;
      reason = invalid.integrity;
    } else if (others.some((entry) => entry.eligible)) klass = 4;
    else if (own.length > 0) klass = 2;
    else if (entries.length > 0) klass = 3;
    else klass = 1;
  }

  return classification(goalId, selectedAttestationId, klass, reason, proofIds, entries);
}

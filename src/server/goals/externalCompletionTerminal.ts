import { randomUUID } from 'node:crypto';
import { EXTERNAL_COMPLETION_REASON, type GoalApproval, type GoalStatus } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { activeWorkBlocker } from './activeWork.js';
import { getGoalApproval } from './approvals.js';
import { writeGoalEvent } from './events.js';
import {
  listExternalCompletionDecisions,
  readExternalCompletionDecision,
} from './externalCompletionDecision.js';
import {
  externalCompletionProofPayloadJson,
  parseExternalCompletionProof,
  readExternalCompletionProof,
  type ExternalCompletionActionV1,
  type ExternalCompletionProofV1,
} from './externalCompletionProof.js';
import {
  firstDifference,
  PreflightRefusal,
  readPreflightSnapshotIdentity,
  type SnapshotIdentity,
} from './externalCompletionPreflight.js';

/**
 * The proof-bound terminal authority for a version-2 external completion. This module is DB-only: it never runs Git and
 * is not called by any route or service yet (the completion service is a later stage).
 *
 * Only `consumeExternalCompletionDecision` may end a version-2 Goal. It requires an open transaction (the caller's
 * BEGIN IMMEDIATE), re-proves the decision, identity and work quiescence inside that transaction, and then writes the
 * proof row, the `external_completion_recorded` event, the terminal status and the `state_changed` event. The brands
 * below make the inputs and the terminal write unforgeable from other modules: a decision can be issued only by
 * `selectCompletionDecision`, and the terminal write takes an authority that only `consumeExternalCompletionDecision`
 * issues after its checks.
 */

export const EXTERNAL_COMPLETION_TERMINAL_ERROR_CODES = [
  'completion_proof_required',
  'completion_internal_state',
  'goal_not_found',
  'goal_not_running',
  'completion_already_recorded',
  'decision_not_found',
  'decision_corrupt',
  'decision_conflict',
  'proof_invalid',
  'proof_action_mismatch',
  'authority_changed_during_completion',
  'goal_work_in_flight',
  'completion_persistence_failed',
] as const;

export type ExternalCompletionTerminalErrorCode = (typeof EXTERNAL_COMPLETION_TERMINAL_ERROR_CODES)[number];

export class ExternalCompletionTerminalError extends Error {
  constructor(
    readonly code: ExternalCompletionTerminalErrorCode,
    readonly detail: string | null,
  ) {
    super(`External completion refused: ${code}${detail === null ? '' : ` (${detail})`}.`);
    this.name = 'ExternalCompletionTerminalError';
  }
}

/** A completion decision re-read and validated by `selectCompletionDecision`. Only that function can issue one. */
export interface ValidatedCompletionDecision {
  readonly approval: GoalApproval;
  readonly action: ExternalCompletionActionV1;
}

/** The terminal write's authority. Only `consumeExternalCompletionDecision` can issue one, after its checks. */
interface TerminalAuthority {
  readonly goalId: string;
  readonly proofId: string;
  readonly proof: ExternalCompletionProofV1;
}

const issuedDecisions = new WeakSet<object>();
const issuedAuthorities = new WeakSet<object>();

/**
 * Re-reads one stored completion decision and issues the brand the consumer requires. Refuses an unknown, foreign or
 * invalid row with a typed error, so no unvalidated decision can reach the consumer.
 */
export function selectCompletionDecision(
  db: Db,
  goalId: string,
  approvalId: string,
): ValidatedCompletionDecision {
  const read = readExternalCompletionDecision(db, goalId, approvalId);
  if (read.state === 'not_found') throw new ExternalCompletionTerminalError('decision_not_found', null);
  if (read.state === 'invalid') throw new ExternalCompletionTerminalError('decision_corrupt', read.reason);
  const decision: ValidatedCompletionDecision = Object.freeze({
    approval: read.approval,
    action: read.action,
  });
  issuedDecisions.add(decision);
  return decision;
}

/** Stored identity of a decided completion: the only state a consumer treats as completed. */
export type StoredCompletion =
  | { state: 'not_completed' }
  | {
      state: 'completed';
      proofId: string;
      proofDigest: string;
      approvalId: string;
      actionDigest: string;
      preflightDigest: string;
      observedAt: string;
      completedAt: string;
    }
  | { state: 'invalid'; reason: string };

/**
 * Consumes one validated decision and terminally completes its running Goal, atomically. Must run inside an open
 * transaction. Refuses with a typed error and writes nothing when any check fails. On success it writes exactly two
 * goal_events rows (`external_completion_recorded`, then `state_changed`) and one proof row.
 */
export function consumeExternalCompletionDecision(
  db: Db,
  decision: ValidatedCompletionDecision,
  proof: ExternalCompletionProofV1,
  expected: SnapshotIdentity,
  now: string,
): { from: 'running'; to: 'completed'; proofId: string } {
  if (!issuedDecisions.has(decision))
    throw new ExternalCompletionTerminalError('completion_proof_required', null);
  if (!db.inTransaction) throw new ExternalCompletionTerminalError('completion_internal_state', null);
  if (!isCanonicalTimestamp(now))
    throw new ExternalCompletionTerminalError('completion_internal_state', 'clock_not_canonical');

  // The Goal and attestation of the decision the caller holds are only the coordinates of the lookup. Every comparison
  // below is made against the action re-read from the stored approval inside this transaction, never the in-memory copy.
  const goalId = decision.action.goalId;
  const attestationId = decision.action.attestation.id;

  const parsed = parseExternalCompletionProof(proof);
  if (!parsed.valid) throw new ExternalCompletionTerminalError('proof_invalid', parsed.reason);
  const validProof = parsed.proof;

  const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
    { status: GoalStatus } | undefined;
  if (!goal) throw new ExternalCompletionTerminalError('goal_not_found', null);
  if (goal.status !== 'running') throw new ExternalCompletionTerminalError('goal_not_running', goal.status);

  const proofs = db
    .prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?')
    .get(goalId) as { n: number };
  if (proofs.n !== 0) throw new ExternalCompletionTerminalError('completion_already_recorded', null);

  let current: SnapshotIdentity;
  try {
    current = readPreflightSnapshotIdentity(db, goalId, attestationId, { allowRecordedDecision: true });
  } catch (error) {
    if (error instanceof PreflightRefusal)
      throw new ExternalCompletionTerminalError('authority_changed_during_completion', error.code);
    throw error;
  }
  const changed = firstDifference(expected, current);
  if (changed !== null)
    throw new ExternalCompletionTerminalError('authority_changed_during_completion', changed);

  // Re-read the approval by id: the brand proves where the decision came from, not that it is still true.
  let row: GoalApproval | undefined;
  try {
    row = getGoalApproval(db, decision.approval.id);
  } catch {
    throw new ExternalCompletionTerminalError('decision_corrupt', 'approval_unreadable');
  }
  if (!row || row.goalId !== goalId) throw new ExternalCompletionTerminalError('decision_not_found', null);
  if (row.status !== 'approved')
    throw new ExternalCompletionTerminalError('authority_changed_during_completion', 'approval_status');
  if (row.externalCompletionActionDigest !== decision.action.actionDigest)
    throw new ExternalCompletionTerminalError('authority_changed_during_completion', 'action_digest');
  const reread = readExternalCompletionDecision(db, goalId, decision.approval.id);
  if (reread.state !== 'valid')
    throw new ExternalCompletionTerminalError(
      'decision_corrupt',
      reread.state === 'invalid' ? reread.reason : 'not_found',
    );
  // From here on the stored action is the only action. A held copy that was edited after selection is refused above or
  // below, and the proof is never compared with the held copy.
  const action = reread.action;
  if (action.goalId !== goalId || action.attestation.id !== attestationId)
    throw new ExternalCompletionTerminalError('authority_changed_during_completion', 'action_identity');
  if (row.externalCompletionActionDigest !== action.actionDigest)
    throw new ExternalCompletionTerminalError('authority_changed_during_completion', 'action_digest');

  let sameAttestation = 0;
  for (const stored of listExternalCompletionDecisions(db, goalId)) {
    if (stored.state !== 'valid')
      throw new ExternalCompletionTerminalError(
        'decision_corrupt',
        stored.state === 'invalid' ? stored.reason : 'not_found',
      );
    if (stored.action.attestation.id === attestationId) sameAttestation += 1;
  }
  if (sameAttestation !== 1) throw new ExternalCompletionTerminalError('decision_conflict', null);

  if (
    validProof.goalId !== goalId ||
    validProof.decision.approvalId !== decision.approval.id ||
    validProof.decision.actionDigest !== action.actionDigest
  )
    throw new ExternalCompletionTerminalError('proof_action_mismatch', 'decision');
  if (validProof.userReviewedPreflightDigest !== action.userReviewedPreflightDigest)
    throw new ExternalCompletionTerminalError('proof_action_mismatch', 'preflight_digest');
  if (!sameDestination(validProof.destination, action.destination))
    throw new ExternalCompletionTerminalError('proof_action_mismatch', 'destination');

  // The proof's timestamps must be the stored decision time and a time no earlier than the observation and the decision.
  if (
    validProof.decision.decidedAt !== row.respondedAt ||
    !isCanonicalTimestamp(validProof.decision.decidedAt)
  )
    throw new ExternalCompletionTerminalError('proof_action_mismatch', 'decided_at');
  if (!isCanonicalTimestamp(validProof.gitProof.observedAt))
    throw new ExternalCompletionTerminalError('proof_invalid', 'observed_at');
  const instant = Date.parse(now);
  if (instant < Date.parse(validProof.decision.decidedAt))
    throw new ExternalCompletionTerminalError('completion_internal_state', 'clock_before_decision');
  if (instant < Date.parse(validProof.gitProof.observedAt))
    throw new ExternalCompletionTerminalError('completion_internal_state', 'clock_before_observation');

  // The same predicate the manual handoff uses; the blocker code is the refusal detail.
  const blocker = activeWorkBlocker(db, goalId);
  if (blocker !== null) throw new ExternalCompletionTerminalError('goal_work_in_flight', blocker);

  const authority: TerminalAuthority = Object.freeze({ goalId, proofId: randomUUID(), proof: validProof });
  issuedAuthorities.add(authority);
  applyExternalCompletionTerminal(db, authority, now);
  return { from: 'running', to: 'completed', proofId: authority.proofId };
}

/** A timestamp is canonical when it is the exact `toISOString()` form of a valid instant. */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const instant = Date.parse(value);
  return !Number.isNaN(instant) && new Date(instant).toISOString() === value;
}

function sameDestination(
  proofDestination: ExternalCompletionProofV1['destination'],
  actionDestination: ExternalCompletionActionV1['destination'],
): boolean {
  return (
    proofDestination.ref === actionDestination.ref &&
    proofDestination.recordedBaseCommit === actionDestination.recordedBaseCommit &&
    proofDestination.recordedBaseTree === actionDestination.recordedBaseTree &&
    proofDestination.observedCommit === actionDestination.observedCommit &&
    proofDestination.observedTree === actionDestination.observedTree
  );
}

/**
 * The only write of a version-2 completion. Not exported. Wrapped in a savepoint, so any failure rolls back every row it
 * wrote even if the caller swallows the error. Order: proof row, recorded event, terminal status, state_changed event,
 * then a read-back that must return a valid proof.
 */
function applyExternalCompletionTerminal(db: Db, authority: TerminalAuthority, now: string): void {
  if (!issuedAuthorities.has(authority))
    throw new ExternalCompletionTerminalError('completion_proof_required', null);
  const { goalId, proofId, proof } = authority;
  const step = (name: string, write: () => void): void => {
    try {
      write();
    } catch (error) {
      if (error instanceof ExternalCompletionTerminalError) throw error;
      throw new ExternalCompletionTerminalError('completion_persistence_failed', name);
    }
  };

  db.transaction(() => {
    step('proof_insert', () => insertProofRow(db, proofId, proof));
    step('recorded_event', () =>
      writeGoalEvent(
        db,
        goalId,
        'external_completion_recorded',
        {
          proofId,
          proofDigest: proof.proofDigest,
          approvalId: proof.decision.approvalId,
          actionDigest: proof.decision.actionDigest,
          preflightDigest: proof.userReviewedPreflightDigest,
          attestationId: proof.attestation.id,
          observedCommit: proof.destination.observedCommit,
          observedTree: proof.destination.observedTree,
          observedAt: proof.gitProof.observedAt,
          completedAt: now,
        },
        now,
      ),
    );
    step('terminal_update', () => {
      const result = db
        .prepare(
          "UPDATE goals SET status = 'completed', completed_at = ?, status_reason_code = ?, status_detail_json = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(
          now,
          EXTERNAL_COMPLETION_REASON,
          JSON.stringify({
            proofId,
            proofDigest: proof.proofDigest,
            approvalId: proof.decision.approvalId,
            actionDigest: proof.decision.actionDigest,
          }),
          now,
          goalId,
        );
      if (result.changes !== 1) throw new Error('no running Goal matched the terminal update');
    });
    step('state_event', () =>
      writeGoalEvent(
        db,
        goalId,
        'state_changed',
        { from: 'running', to: 'completed', reasonCode: EXTERNAL_COMPLETION_REASON, actor: 'user' },
        now,
      ),
    );
    const readBack = readExternalCompletionProof(db, goalId, proofId);
    if (readBack.state !== 'valid')
      throw new ExternalCompletionTerminalError(
        'completion_persistence_failed',
        `proof_readback:${readBack.state === 'invalid' ? readBack.reason : readBack.state}`,
      );
  })();
}

/** The only INSERT of a completion proof. Every indexed column is taken from the validated proof body. */
function insertProofRow(db: Db, proofId: string, proof: ExternalCompletionProofV1): void {
  const columns = {
    id: proofId,
    goal_id: proof.goalId,
    schema_version: proof.schemaVersion,
    kind: proof.kind,
    contract_version: proof.contractVersion,
    action_digest: proof.decision.actionDigest,
    proof_digest: proof.proofDigest,
    definition_version: proof.definition.version,
    definition_hash: proof.definition.hash,
    definition_approval_id: proof.definition.approvalId,
    definition_lineage_digest: proof.definition.lineageDigest,
    handoff_id: proof.handoff.id,
    handoff_digest: proof.handoff.digest,
    attestation_id: proof.attestation.id,
    attestation_action_digest: proof.attestation.actionDigest,
    attestation_record_digest: proof.attestation.recordDigest,
    attestation_approval_id: proof.attestation.approvalId,
    completion_approval_id: proof.decision.approvalId,
    final_review_id: proof.evaluation.finalReviewId,
    final_acceptance_approval_id: proof.evaluation.finalAcceptanceApprovalId,
    verification_evidence_digest: proof.evaluation.verificationEvidenceDigest,
    milestone_identity_digest: proof.evaluation.milestoneIdentityDigest,
    finding_identity_digest: proof.evaluation.findingIdentityDigest,
    repository_project_id: proof.repository.projectId,
    repository_identity: proof.repository.identity,
    repository_scope: proof.repository.scope,
    object_format: proof.repository.objectFormat,
    source_ref: proof.source.ref,
    source_commit: proof.source.commit,
    source_tree: proof.source.tree,
    destination_ref: proof.destination.ref,
    recorded_base_commit: proof.destination.recordedBaseCommit,
    recorded_base_tree: proof.destination.recordedBaseTree,
    observed_destination_commit: proof.destination.observedCommit,
    observed_destination_tree: proof.destination.observedTree,
    proof_mode: proof.gitProof.mode,
    source_ancestor: proof.gitProof.sourceAncestor ? 1 : 0,
    base_ancestor: proof.gitProof.baseAncestor ? 1 : 0,
    verifier_version: proof.gitProof.verifierVersion,
    git_evidence_digest: proof.gitProof.evidenceDigest,
    preflight_digest: proof.userReviewedPreflightDigest,
    correction_chain_digest: proof.correctionChain.digest,
    correction_sequence: proof.correctionChain.sequence,
    correction_standing: proof.correctionChain.standing,
    observed_at: proof.gitProof.observedAt,
    decided_at: proof.decision.decidedAt,
    payload_json: externalCompletionProofPayloadJson(proof),
  };
  const names = Object.keys(columns);
  db.prepare(
    `INSERT INTO goal_external_completion_proofs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...(Object.values(columns) as (string | number)[]));
}

/**
 * Reads the stored completion of one Goal, read-only. It is `completed` only when every stored fact agrees: the status,
 * the single reason code, a valid proof, the status detail, one recorded and one state_changed event in order with
 * matching timestamps and identifiers, and a valid completion decision. Anything else is `invalid` with a code.
 */
export function readStoredCompletion(db: Db, goalId: string): StoredCompletion {
  try {
    return readStored(db, goalId);
  } catch {
    return { state: 'invalid', reason: 'integrity_check_failed' };
  }
}

/**
 * Counts the completion proof rows of one Goal, read-only. A completed version-2 Goal has exactly one; any other count
 * is a stored fact that a reader must not treat as a clean completion. Writes nothing.
 */
export function externalCompletionProofRowCount(db: Db, goalId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?')
    .get(goalId) as { n: number };
  return row.n;
}

function readStored(db: Db, goalId: string): StoredCompletion {
  const goal = db
    .prepare('SELECT status, status_reason_code, status_detail_json, completed_at FROM goals WHERE id = ?')
    .get(goalId) as
    | {
        status: string;
        status_reason_code: string | null;
        status_detail_json: string | null;
        completed_at: string | null;
      }
    | undefined;
  if (!goal) return { state: 'invalid', reason: 'goal_not_found' };
  const proofRows = db
    .prepare('SELECT id FROM goal_external_completion_proofs WHERE goal_id = ?')
    .all(goalId) as { id: string }[];

  if (goal.status !== 'completed') {
    return proofRows.length === 0
      ? { state: 'not_completed' }
      : { state: 'invalid', reason: 'proof_without_completion' };
  }
  if (goal.status_reason_code !== EXTERNAL_COMPLETION_REASON)
    return { state: 'invalid', reason: 'reason_code_mismatch' };
  const onlyProof = proofRows[0];
  if (proofRows.length !== 1 || !onlyProof) return { state: 'invalid', reason: 'proof_missing' };
  const proofId = onlyProof.id;
  const read = readExternalCompletionProof(db, goalId, proofId);
  if (read.state !== 'valid')
    return { state: 'invalid', reason: read.state === 'invalid' ? read.reason : 'proof_not_found' };
  const proof = read.proof;
  if (goal.completed_at === null) return { state: 'invalid', reason: 'completed_at_missing' };

  let detail: unknown;
  try {
    detail = JSON.parse(goal.status_detail_json ?? 'null');
  } catch {
    return { state: 'invalid', reason: 'status_detail_invalid' };
  }
  if (
    !detail ||
    typeof detail !== 'object' ||
    (detail as Record<string, unknown>).proofId !== proofId ||
    (detail as Record<string, unknown>).proofDigest !== proof.proofDigest ||
    (detail as Record<string, unknown>).approvalId !== proof.decision.approvalId ||
    (detail as Record<string, unknown>).actionDigest !== proof.decision.actionDigest
  )
    return { state: 'invalid', reason: 'status_detail_mismatch' };

  const events = db
    .prepare(
      "SELECT rowid AS seq, type, payload_json, created_at FROM goal_events WHERE goal_id = ? AND type IN ('external_completion_recorded', 'state_changed') ORDER BY rowid",
    )
    .all(goalId) as { seq: number; type: string; payload_json: string; created_at: string }[];
  const recorded = events.filter((event) => event.type === 'external_completion_recorded');
  const completedStates = events.filter(
    (event) =>
      event.type === 'state_changed' &&
      (JSON.parse(event.payload_json) as { to?: unknown }).to === 'completed',
  );
  const recordedEvent = recorded[0];
  const stateEvent = completedStates[0];
  if (recorded.length !== 1 || !recordedEvent) return { state: 'invalid', reason: 'recorded_event_count' };
  if (completedStates.length !== 1 || !stateEvent) return { state: 'invalid', reason: 'state_event_count' };
  if (stateEvent.seq < recordedEvent.seq) return { state: 'invalid', reason: 'event_order_invalid' };

  const expectedRecorded: Record<string, unknown> = {
    proofId,
    proofDigest: proof.proofDigest,
    approvalId: proof.decision.approvalId,
    actionDigest: proof.decision.actionDigest,
    preflightDigest: proof.userReviewedPreflightDigest,
    attestationId: proof.attestation.id,
    observedCommit: proof.destination.observedCommit,
    observedTree: proof.destination.observedTree,
    observedAt: proof.gitProof.observedAt,
    completedAt: goal.completed_at,
  };
  const recordedPayload = JSON.parse(recordedEvent.payload_json) as Record<string, unknown>;
  if (
    Object.keys(recordedPayload).length !== Object.keys(expectedRecorded).length ||
    Object.entries(expectedRecorded).some(([key, value]) => recordedPayload[key] !== value) ||
    recordedEvent.created_at !== goal.completed_at
  )
    return { state: 'invalid', reason: 'recorded_event_mismatch' };

  const statePayload = JSON.parse(stateEvent.payload_json) as Record<string, unknown>;
  if (
    statePayload.from !== 'running' ||
    statePayload.to !== 'completed' ||
    statePayload.reasonCode !== EXTERNAL_COMPLETION_REASON ||
    statePayload.actor !== 'user' ||
    stateEvent.created_at !== goal.completed_at
  )
    return { state: 'invalid', reason: 'state_event_mismatch' };

  const decision = readExternalCompletionDecision(db, goalId, proof.decision.approvalId);
  if (decision.state === 'not_found') return { state: 'invalid', reason: 'decision_not_found' };
  if (decision.state === 'invalid') return { state: 'invalid', reason: 'decision_invalid' };
  if (decision.action.actionDigest !== proof.decision.actionDigest)
    return { state: 'invalid', reason: 'decision_action_mismatch' };

  return {
    state: 'completed',
    proofId,
    proofDigest: proof.proofDigest,
    approvalId: proof.decision.approvalId,
    actionDigest: proof.decision.actionDigest,
    preflightDigest: proof.userReviewedPreflightDigest,
    observedAt: proof.gitProof.observedAt,
    completedAt: goal.completed_at,
  };
}

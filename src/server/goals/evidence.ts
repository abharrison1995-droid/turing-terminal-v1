import { randomUUID } from 'node:crypto';
import type { EvidenceVerdict, GoalDefinition, GoalEvidenceKind } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { loadContext } from '../goalGit.js';
import { getGoalApproval } from './approvals.js';
import { loadDefinitionVersion } from './definitions.js';
import { writeGoalEvent } from './events.js';
import { objectType, readBlobAtCommit, resolveGoalRepository, safeProjectPath } from './repository.js';
import { VERIFIER_EVIDENCE_KIND, findVerifier, type CurrentVerifier } from './verifierDigest.js';

export type GoalEvidenceErrorCode =
  | 'goal_not_found'
  | 'definition_not_found'
  | 'definition_not_decided'
  | 'criterion_unknown'
  | 'verifier_unknown'
  | 'evidence_kind_mismatch'
  | 'run_result_not_verifier'
  | 'user_authority_required'
  | 'milestone_not_found'
  | 'cycle_not_found'
  | 'run_not_in_goal'
  | 'stage_not_in_run'
  | 'review_not_found'
  | 'review_not_completed'
  | 'review_mismatch'
  | 'subject_invalid'
  | 'path_unsafe'
  | 'repository_unavailable'
  | 'repository_changed'
  | 'approval_invalid'
  | 'ref_too_large';

export class GoalEvidenceError extends Error {
  constructor(
    readonly code: GoalEvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalEvidenceError';
  }
}

interface Common {
  goalId: string;
  /** The definition version whose verifier produced this evidence. Must be approved or superseded. */
  definitionVersion: number;
  criterionKey: string;
  /** Checked against the stored definition; a digest that is not that criterion's verifier is refused. */
  verifierDigest: string;
  milestoneId?: string;
  cycleId?: string;
  runId?: string;
  stageId?: string;
  /** Small structured source detail (for example a stage key). Bounded. */
  ref?: Record<string, unknown>;
  now?: string;
}

export type RecordEvidenceInput = Common &
  (
    | {
        kind: 'build_result' | 'test_result' | 'lint_result';
        verdict: EvidenceVerdict;
        subjectTree: string;
        subjectCommit?: string;
      }
    | { kind: 'commit'; verdict: EvidenceVerdict; subjectCommit: string }
    | { kind: 'artifact' }
    | { kind: 'review_verdict'; reviewId: string }
    | { kind: 'run_result' | 'user_confirmation' }
  );

const MAX_REF_CHARS = 2_000;

interface Prepared {
  definition: GoalDefinition;
  verifier: CurrentVerifier;
  definitionHash: string;
}

/** Everything that can be checked without Git: Goal, definition, verifier, and ownership of cycle/run/stage/milestone. */
function prepare(db: Db, input: Common & { kind: GoalEvidenceKind }): Prepared {
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(input.goalId))
    throw new GoalEvidenceError('goal_not_found', 'The Goal does not exist.');
  const version = loadDefinitionVersion(db, input.goalId, input.definitionVersion);
  if (!version)
    throw new GoalEvidenceError('definition_not_found', 'No such definition version for this Goal.');
  if (version.status !== 'approved' && version.status !== 'superseded')
    throw new GoalEvidenceError(
      'definition_not_decided',
      'Evidence is recorded only against an approved definition.',
    );
  if (!version.definition.contract.successCriteria.some((criterion) => criterion.key === input.criterionKey))
    throw new GoalEvidenceError('criterion_unknown', 'The criterion is not in that definition version.');
  const verifier = findVerifier(version.definition, input.criterionKey, input.verifierDigest);
  if (!verifier)
    throw new GoalEvidenceError(
      'verifier_unknown',
      'The verifier digest is not a verifier of that criterion in that definition version.',
    );
  if (VERIFIER_EVIDENCE_KIND[verifier.spec.kind] !== input.kind)
    throw new GoalEvidenceError(
      'evidence_kind_mismatch',
      `A ${verifier.spec.kind} verifier is satisfied by ${VERIFIER_EVIDENCE_KIND[verifier.spec.kind]} evidence, not ${input.kind}.`,
    );
  if (
    input.milestoneId &&
    !db
      .prepare('SELECT 1 FROM goal_milestones WHERE id = ? AND goal_id = ?')
      .get(input.milestoneId, input.goalId)
  )
    throw new GoalEvidenceError('milestone_not_found', 'The milestone does not belong to this Goal.');
  if (
    input.cycleId &&
    !db.prepare('SELECT 1 FROM goal_cycles WHERE id = ? AND goal_id = ?').get(input.cycleId, input.goalId)
  )
    throw new GoalEvidenceError('cycle_not_found', 'The cycle does not belong to this Goal.');
  if (input.runId) {
    const owner = db.prepare('SELECT goal_id, cycle_id FROM goal_runs WHERE run_id = ?').get(input.runId) as
      { goal_id: string; cycle_id: string } | undefined;
    if (!owner || owner.goal_id !== input.goalId || (input.cycleId && owner.cycle_id !== input.cycleId))
      throw new GoalEvidenceError('run_not_in_goal', 'The run does not belong to this Goal and cycle.');
  }
  if (input.stageId) {
    const stage = db.prepare('SELECT run_id FROM stages WHERE id = ?').get(input.stageId) as
      { run_id: string } | undefined;
    if (!input.runId || !stage || stage.run_id !== input.runId)
      throw new GoalEvidenceError('stage_not_in_run', 'The stage does not belong to the evidence run.');
  }
  return { definition: version.definition, verifier, definitionHash: version.definitionHash };
}

function boundedRef(ref: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(ref ?? {});
  if (json.length > MAX_REF_CHARS) throw new GoalEvidenceError('ref_too_large', 'Evidence ref is too large.');
  return json;
}

interface Columns {
  verdict: EvidenceVerdict;
  subjectCommit?: string | null;
  subjectTree?: string | null;
  subjectPath?: string | null;
  subjectBlob?: string | null;
  subjectSha256?: string | null;
  reviewId?: string | null;
  reviewedFrom?: string | null;
  reviewedToCommit?: string | null;
  reviewedToTree?: string | null;
  milestoneId?: string | null;
  refExtra?: Record<string, unknown>;
}

function insertEvidence(
  db: Db,
  input: Common & { kind: GoalEvidenceKind },
  columns: Columns,
  guard?: () => void,
): string {
  const now = input.now ?? new Date().toISOString();
  const id = randomUUID();
  const ref = boundedRef({ ...input.ref, ...columns.refExtra });
  db.transaction(() => {
    guard?.();
    db.prepare(
      `INSERT INTO goal_evidence (id, goal_id, definition_version, milestone_id, criterion_key, verifier_digest, kind, verdict,
         cycle_id, run_id, stage_id, review_id, subject_commit, subject_tree, subject_path, subject_blob, subject_sha256,
         reviewed_from_commit, reviewed_to_commit, reviewed_to_tree, ref_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.goalId,
      input.definitionVersion,
      columns.milestoneId ?? input.milestoneId ?? null,
      input.criterionKey,
      input.verifierDigest,
      input.kind,
      columns.verdict,
      input.cycleId ?? null,
      input.runId ?? null,
      input.stageId ?? null,
      columns.reviewId ?? null,
      columns.subjectCommit ?? null,
      columns.subjectTree ?? null,
      columns.subjectPath ?? null,
      columns.subjectBlob ?? null,
      columns.subjectSha256 ?? null,
      columns.reviewedFrom ?? null,
      columns.reviewedToCommit ?? null,
      columns.reviewedToTree ?? null,
      ref,
      now,
    );
    writeGoalEvent(
      db,
      input.goalId,
      'evidence_recorded',
      {
        evidenceId: id,
        criterionKey: input.criterionKey,
        verifierDigest: input.verifierDigest,
        kind: input.kind,
        verdict: columns.verdict,
        definitionVersion: input.definitionVersion,
      },
      now,
    );
  })();
  return id;
}

function integrationHead(db: Db, goalId: string): string | null {
  return (
    (
      db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as
        { integration_head: string | null } | undefined
    )?.integration_head ?? null
  );
}

/**
 * Append-only evidence recording. Validates the Goal, definition version, criterion, verifier digest (against the stored
 * definition), evidence kind, and ownership of cycle, run, stage, milestone and review before inserting. Repository
 * bindings come from Git objects at the Goal's integration state, not from the caller, except the tree a deterministic
 * stage reports (which must be a real tree object). Generic `run_result` evidence cannot satisfy any verifier and is
 * refused; user confirmations only come from `recordUserConfirmationEvidence`.
 */
export async function recordEvidence(db: Db, input: RecordEvidenceInput): Promise<{ id: string }> {
  if (input.kind === 'run_result')
    throw new GoalEvidenceError(
      'run_result_not_verifier',
      'A generic run result cannot substitute for a build, test, lint, artifact or review verifier.',
    );
  if (input.kind === 'user_confirmation')
    throw new GoalEvidenceError(
      'user_authority_required',
      'User confirmation evidence is created only from an explicit user approval.',
    );
  const { verifier, definition } = prepare(db, input);

  switch (input.kind) {
    case 'build_result':
    case 'test_result':
    case 'lint_result': {
      const repoRoot = repositoryRoot(db, input.goalId);
      if ((await objectType({ repoRoot }, input.subjectTree)) !== 'tree')
        throw new GoalEvidenceError(
          'subject_invalid',
          'The subject tree is not a tree object in the repository.',
        );
      if (input.subjectCommit && (await objectType({ repoRoot }, input.subjectCommit)) !== 'commit')
        throw new GoalEvidenceError('subject_invalid', 'The subject commit is not a commit object.');
      return {
        id: insertEvidence(db, input, {
          verdict: input.verdict,
          subjectTree: input.subjectTree,
          subjectCommit: input.subjectCommit,
        }),
      };
    }
    case 'commit': {
      const repoRoot = repositoryRoot(db, input.goalId);
      if ((await objectType({ repoRoot }, input.subjectCommit)) !== 'commit')
        throw new GoalEvidenceError('subject_invalid', 'The subject commit is not a commit object.');
      return {
        id: insertEvidence(db, input, { verdict: input.verdict, subjectCommit: input.subjectCommit }),
      };
    }
    case 'artifact': {
      if (verifier.spec.kind !== 'file_exists') throw new Error('unreachable');
      const path = safeProjectPath(verifier.spec.path);
      if (!path) throw new GoalEvidenceError('path_unsafe', 'The verifier path is not a safe project path.');
      const resolved = await resolveGoalRepository(db, input.goalId);
      if (!resolved.ok) throw new GoalEvidenceError('repository_unavailable', resolved.detail);
      const blob = await readBlobAtCommit(resolved.state, path);
      return {
        id: insertEvidence(
          db,
          input,
          {
            verdict: blob ? 'satisfies' : 'contradicts',
            subjectCommit: resolved.state.head,
            subjectTree: resolved.state.tree,
            subjectPath: path,
            subjectBlob: blob?.blob ?? null,
            subjectSha256: blob?.sha256 ?? null,
          },
          () => {
            if (integrationHead(db, input.goalId) !== resolved.state.head)
              throw new GoalEvidenceError(
                'repository_changed',
                'The Goal ref moved while recording evidence.',
              );
          },
        ),
      };
    }
    case 'review_verdict': {
      const review = db
        .prepare(
          `SELECT id, goal_id, milestone_id, definition_version, review_kind, status, verdict, blocking,
                  reviewed_from_commit, reviewed_to_commit, reviewed_to_tree, independence_json
           FROM goal_reviews WHERE id = ?`,
        )
        .get(input.reviewId) as
        | {
            id: string;
            goal_id: string;
            milestone_id: string | null;
            definition_version: number;
            review_kind: string;
            status: string;
            verdict: string | null;
            blocking: number | null;
            reviewed_from_commit: string | null;
            reviewed_to_commit: string;
            reviewed_to_tree: string;
            independence_json: string | null;
          }
        | undefined;
      if (!review || review.goal_id !== input.goalId)
        throw new GoalEvidenceError('review_not_found', 'The review does not belong to this Goal.');
      if (review.status !== 'completed')
        throw new GoalEvidenceError('review_not_completed', 'Only a completed review is evidence.');
      if (verifier.spec.kind !== 'review_verdict' || verifier.spec.reviewKind !== review.review_kind)
        throw new GoalEvidenceError(
          'review_mismatch',
          'The review is not of the kind this verifier requires.',
        );
      if (review.definition_version !== input.definitionVersion)
        throw new GoalEvidenceError(
          'review_mismatch',
          'The review was made under another definition version.',
        );
      // One logical verdict per (review, verifier): a restart reuses the stored row rather than adding or rewriting one.
      const existing = db
        .prepare(
          "SELECT id FROM goal_evidence WHERE review_id = ? AND verifier_digest = ? AND kind = 'review_verdict'",
        )
        .get(review.id, input.verifierDigest) as { id: string } | undefined;
      if (existing) return { id: existing.id };
      // A final review satisfies its verifier only with the exact `pass` completion requires AND, when the approved
      // policy requires independence, a recorded established independence of that policy. An unestablished review
      // (including the explicitly allowed floating reviewer) is valid history but never satisfying evidence.
      const finalSatisfies = (): boolean => {
        if (review.verdict !== 'pass') return false;
        const policy = definition.routing.independence.finalReview;
        if (policy === 'none') return true;
        type Claim = { established?: unknown; policy?: unknown };
        let claim: Claim | null = null;
        try {
          claim = review.independence_json ? (JSON.parse(review.independence_json) as Claim) : null;
        } catch {
          claim = null;
        }
        return claim?.established === true && claim.policy === policy;
      };
      return {
        id: insertEvidence(db, input, {
          // The verdict is derived from the stored review, never supplied by the caller.
          verdict:
            review.verdict === 'block' || review.blocking === 1
              ? 'contradicts'
              : review.review_kind === 'final' && !finalSatisfies()
                ? 'inconclusive'
                : 'satisfies',
          reviewId: review.id,
          milestoneId: input.milestoneId ?? review.milestone_id,
          reviewedFrom: review.reviewed_from_commit,
          reviewedToCommit: review.reviewed_to_commit,
          reviewedToTree: review.reviewed_to_tree,
        }),
      };
    }
  }
}

function repositoryRoot(db: Db, goalId: string): string {
  try {
    return loadContext(db, goalId).repoRoot;
  } catch (error) {
    throw new GoalEvidenceError('repository_unavailable', String((error as Error).message));
  }
}

/**
 * Records user-confirmation evidence from a decided user approval (gate `user_confirmation`) whose detail binds
 * {criterionKey, verifierDigest, definitionVersion, definitionHash} and, for a `head-bound` verifier, the current
 * integration tree. A model, the supervisor or the system can never produce it: the actor must be the user and the
 * approval must have been decided by the user. A denial is recorded as `contradicts`.
 */
export async function recordUserConfirmationEvidence(
  db: Db,
  input: Omit<Common, 'ref'> & { approvalId: string; actor: 'user' },
): Promise<{ id: string; reused: boolean }> {
  if (input.actor !== 'user')
    throw new GoalEvidenceError('user_authority_required', 'Only the user can confirm.');
  const { verifier, definitionHash } = prepare(db, { ...input, kind: 'user_confirmation' });
  if (verifier.spec.kind !== 'user_confirmation')
    throw new GoalEvidenceError('evidence_kind_mismatch', 'The verifier is not a user confirmation.');
  const approval = getGoalApproval(db, input.approvalId);
  if (
    !approval ||
    approval.goalId !== input.goalId ||
    approval.gate !== 'user_confirmation' ||
    approval.decidedBy !== 'user' ||
    approval.status === 'pending' ||
    approval.attestationCorrectionActionDigest !== undefined ||
    approval.externalCompletionActionDigest !== undefined ||
    approval.detail.criterionKey !== input.criterionKey ||
    approval.detail.verifierDigest !== input.verifierDigest ||
    approval.detail.definitionVersion !== input.definitionVersion ||
    approval.detail.definitionHash !== definitionHash
  )
    throw new GoalEvidenceError(
      'approval_invalid',
      'The approval is not a user decision bound to this criterion, verifier and definition.',
    );
  const existing = db
    .prepare(
      "SELECT id FROM goal_evidence WHERE goal_id = ? AND kind = 'user_confirmation' AND json_extract(ref_json, '$.approvalId') = ?",
    )
    .get(input.goalId, input.approvalId) as { id: string } | undefined;
  if (existing) return { id: existing.id, reused: true };

  let subjectTree: string | null = null;
  let guard: (() => void) | undefined;
  if (verifier.spec.freshness === 'head-bound') {
    const resolved = await resolveGoalRepository(db, input.goalId);
    if (!resolved.ok) throw new GoalEvidenceError('repository_unavailable', resolved.detail);
    if (approval.detail.integrationTree !== resolved.state.tree)
      throw new GoalEvidenceError(
        'approval_invalid',
        'A head-bound confirmation must be bound to the current integration tree.',
      );
    subjectTree = resolved.state.tree;
    guard = () => {
      if (integrationHead(db, input.goalId) !== resolved.state.head)
        throw new GoalEvidenceError('repository_changed', 'The Goal ref moved while recording evidence.');
    };
  }
  const id = insertEvidence(
    db,
    { ...input, kind: 'user_confirmation' },
    {
      verdict: approval.status === 'approved' ? 'satisfies' : 'contradicts',
      subjectTree,
      refExtra: { approvalId: approval.id },
    },
    guard,
  );
  return { id, reused: false };
}

export function listEvidence(db: Db, goalId: string, criterionKey?: string) {
  return db
    .prepare(
      `SELECT * FROM goal_evidence WHERE goal_id = ? ${criterionKey ? 'AND criterion_key = ?' : ''} ORDER BY recorded_at, rowid`,
    )
    .all(...(criterionKey ? [goalId, criterionKey] : [goalId]));
}

import type {
  CriterionEvaluation,
  EvidenceAssessment,
  EvidenceVerdict,
  GoalDefinition,
  GoalEvidenceKind,
  VerifierEvaluation,
  VerifierState,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import { safeProjectPath, type RepositoryReader } from './repository.js';
import { VERIFIER_EVIDENCE_KIND, listVerifiers, type CurrentVerifier } from './verifierDigest.js';

export interface EvidenceRow {
  id: string;
  goal_id: string;
  definition_version: number;
  milestone_id: string | null;
  criterion_key: string;
  verifier_digest: string;
  kind: GoalEvidenceKind;
  verdict: EvidenceVerdict;
  cycle_id: string | null;
  run_id: string | null;
  stage_id: string | null;
  review_id: string | null;
  subject_commit: string | null;
  subject_tree: string | null;
  subject_path: string | null;
  subject_blob: string | null;
  subject_sha256: string | null;
  reviewed_from_commit: string | null;
  reviewed_to_commit: string | null;
  reviewed_to_tree: string | null;
  ref_json: string;
  recorded_at: string;
}

/**
 * Computes whether one immutable evidence row still counts for `verifier` at the Goal's current integration head.
 * Nothing is written; the head is read from Git objects through `repository`. Rules (design 11.1):
 *  - build/test/lint: subject_tree == tree(HEAD) (any verdict: a failure at an older tree is not a contradiction now);
 *  - file_exists: the blob at HEAD:<path> is the recorded blob (a recorded absence holds only while still absent);
 *  - commit_on_branch: the subject commit is an ancestor of, or equal to, HEAD;
 *  - review_verdict: a completed review of the verifier's kind whose reviewed tree == tree(HEAD);
 *  - user_confirmation: backed by a user approval; `head-bound` additionally needs subject_tree == tree(HEAD).
 */
export async function assessEvidence(
  db: Db,
  row: EvidenceRow,
  verifier: CurrentVerifier,
  repository: RepositoryReader,
): Promise<EvidenceAssessment> {
  const base = {
    evidenceId: row.id,
    kind: row.kind,
    verdict: row.verdict,
    recordedAt: row.recorded_at,
  };
  const stale = (reason: NonNullable<EvidenceAssessment['reason']>): EvidenceAssessment => ({
    ...base,
    standing: 'stale',
    reason,
  });
  const current = (): EvidenceAssessment => ({ ...base, standing: 'current' });
  const spec = verifier.spec;
  if (row.kind !== VERIFIER_EVIDENCE_KIND[spec.kind])
    return { ...base, standing: 'ineligible', reason: 'kind_mismatch' };
  const tree = repository.state.tree;

  switch (spec.kind) {
    case 'build':
    case 'test':
    case 'lint':
      if (!row.subject_tree) return stale('no_subject_tree');
      return row.subject_tree === tree ? current() : stale('tree_changed');
    case 'file_exists': {
      const path = safeProjectPath(spec.path);
      if (!path || !row.subject_path || safeProjectPath(row.subject_path) !== path)
        return stale('path_outside_scope');
      const blob = await repository.blob(path);
      if (row.subject_blob === null) return blob ? stale('path_present') : current();
      if (!blob) return stale('path_missing');
      return blob.blob === row.subject_blob && blob.sha256 === row.subject_sha256
        ? current()
        : stale('path_changed');
    }
    case 'commit_on_branch':
      if (!row.subject_commit || !(await repository.isAncestor(row.subject_commit)))
        return stale('not_ancestor');
      return current();
    case 'review_verdict': {
      const review = row.review_id
        ? (db
            .prepare('SELECT status, review_kind, reviewed_to_tree, goal_id FROM goal_reviews WHERE id = ?')
            .get(row.review_id) as
            { status: string; review_kind: string; reviewed_to_tree: string; goal_id: string } | undefined)
        : undefined;
      if (!review || review.goal_id !== row.goal_id) return stale('review_missing');
      if (review.status !== 'completed') return stale('review_not_completed');
      if (review.review_kind !== spec.reviewKind)
        return { ...base, standing: 'ineligible', reason: 'kind_mismatch' };
      return review.reviewed_to_tree === tree && row.reviewed_to_tree === tree
        ? current()
        : stale('tree_changed');
    }
    case 'user_confirmation': {
      let approvalId: unknown;
      try {
        approvalId = (JSON.parse(row.ref_json) as { approvalId?: unknown }).approvalId;
      } catch {
        approvalId = undefined;
      }
      const approval =
        typeof approvalId === 'string'
          ? (db
              .prepare(
                'SELECT goal_id, gate, status, decided_by, attestation_correction_action_digest, external_completion_action_digest FROM goal_approvals WHERE id = ?',
              )
              .get(approvalId) as
              | {
                  goal_id: string;
                  gate: string;
                  status: string;
                  decided_by: string | null;
                  attestation_correction_action_digest: string | null;
                  external_completion_action_digest: string | null;
                }
              | undefined)
          : undefined;
      if (
        !approval ||
        approval.goal_id !== row.goal_id ||
        approval.gate !== 'user_confirmation' ||
        approval.decided_by !== 'user' ||
        approval.status === 'pending' ||
        approval.attestation_correction_action_digest !== null ||
        approval.external_completion_action_digest !== null
      )
        return stale('approval_missing');
      if (spec.freshness === 'any') return current();
      return row.subject_tree === tree ? current() : stale('tree_changed');
    }
  }
}

function stateOf(assessments: EvidenceAssessment[]): {
  state: VerifierState;
  deciding: EvidenceAssessment | null;
} {
  const currentRows = assessments.filter((assessment) => assessment.standing === 'current');
  // Rows arrive ordered by (recorded_at, rowid); the latest current row decides.
  const deciding = currentRows.at(-1) ?? null;
  if (deciding)
    return {
      state:
        deciding.verdict === 'satisfies'
          ? 'satisfied'
          : deciding.verdict === 'contradicts'
            ? 'contradicted'
            : 'inconclusive',
      deciding,
    };
  return {
    state: assessments.some((assessment) => assessment.standing === 'stale') ? 'stale' : 'missing',
    deciding: null,
  };
}

export async function evaluateVerifier(
  db: Db,
  goalId: string,
  verifier: CurrentVerifier,
  repository: RepositoryReader,
): Promise<VerifierEvaluation> {
  const rows = db
    .prepare(
      `SELECT * FROM goal_evidence WHERE goal_id = ? AND criterion_key = ? AND verifier_digest = ?
       ORDER BY recorded_at, rowid`,
    )
    .all(goalId, verifier.criterionKey, verifier.digest) as EvidenceRow[];
  const evidence: EvidenceAssessment[] = [];
  for (const row of rows) evidence.push(await assessEvidence(db, row, verifier, repository));
  const { state, deciding } = stateOf(evidence);
  return {
    verifierDigest: verifier.digest,
    kind: verifier.spec.kind,
    state,
    decidingEvidenceId: deciding?.evidenceId ?? null,
    decidingKind: deciding?.kind ?? null,
    evidence,
  };
}

const PRECEDENCE: VerifierState[] = ['contradicted', 'stale', 'inconclusive', 'missing'];

/**
 * A criterion is satisfied only when every one of its current verifiers is satisfied. Otherwise the worst state wins
 * (contradicted, then stale, then inconclusive, then missing). A criterion with no verifier is `missing`.
 */
export async function evaluateCriteria(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  repository: RepositoryReader,
): Promise<CriterionEvaluation[]> {
  const verifiers = listVerifiers(definition);
  const results: CriterionEvaluation[] = [];
  for (const criterion of definition.contract.successCriteria) {
    const evaluations: VerifierEvaluation[] = [];
    for (const verifier of verifiers.filter((candidate) => candidate.criterionKey === criterion.key))
      evaluations.push(await evaluateVerifier(db, goalId, verifier, repository));
    let state: VerifierState;
    if (evaluations.length === 0) state = 'missing';
    else if (evaluations.every((evaluation) => evaluation.state === 'satisfied')) state = 'satisfied';
    else
      state = PRECEDENCE.find((candidate) =>
        evaluations.some((evaluation) => evaluation.state === candidate),
      )!;
    results.push({
      key: criterion.key,
      required: criterion.required,
      state,
      verifiers: evaluations,
      satisfiedBy:
        state === 'satisfied'
          ? evaluations.map((evaluation) => evaluation.decidingEvidenceId!).filter(Boolean)
          : [],
    });
  }
  return results;
}

import { createHash, randomUUID } from 'node:crypto';
import type { FindingSeverity, GoalFindingStatus, ReviewReport } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { canonicalJson } from './definitionHash.js';
import { loadDefinitionVersion } from './definitions.js';
import { writeGoalEvent } from './events.js';
import { evaluateVerifier } from './freshness.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';
import { getReview } from './reviews.js';
import { listVerifiers } from './verifierDigest.js';

export type GoalFindingErrorCode =
  | 'goal_not_found'
  | 'review_not_found'
  | 'review_not_completed'
  | 'review_findings_already_applied'
  | 'repository_unavailable'
  | 'repository_changed'
  | 'run_finding_mismatch'
  | 'finding_not_found'
  | 'finding_not_open'
  | 'user_authority_required'
  | 'approval_invalid'
  | 'definition_not_approved';

export class GoalFindingError extends Error {
  constructor(
    readonly code: GoalFindingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalFindingError';
  }
}

export interface GoalFinding {
  id: string;
  goalId: string;
  fingerprint: string;
  severity: FindingSeverity;
  category: string;
  description: string;
  affectedFiles: string[];
  status: GoalFindingStatus;
  firstSeenReviewId: string;
  lastSeenReviewId: string;
  resolvedByReviewId: string | null;
  resolutionBasis: unknown;
  createdAt: string;
  updatedAt: string;
}

interface FindingRow {
  id: string;
  goal_id: string;
  fingerprint: string;
  severity: FindingSeverity;
  category: string;
  description: string;
  affected_files_json: string;
  status: GoalFindingStatus;
  first_seen_review_id: string;
  last_seen_review_id: string;
  resolved_by_review_id: string | null;
  resolution_basis_json: string | null;
  created_at: string;
  updated_at: string;
}

function toFinding(row: FindingRow): GoalFinding {
  return {
    id: row.id,
    goalId: row.goal_id,
    fingerprint: row.fingerprint,
    severity: row.severity,
    category: row.category,
    description: row.description,
    affectedFiles: JSON.parse(row.affected_files_json) as string[],
    status: row.status,
    firstSeenReviewId: row.first_seen_review_id,
    lastSeenReviewId: row.last_seen_review_id,
    resolvedByReviewId: row.resolved_by_review_id,
    resolutionBasis: row.resolution_basis_json ? JSON.parse(row.resolution_basis_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getGoalFinding(db: Db, findingId: string): GoalFinding | undefined {
  const row = db.prepare('SELECT * FROM goal_findings WHERE id = ?').get(findingId) as FindingRow | undefined;
  return row ? toFinding(row) : undefined;
}

export function listGoalFindings(db: Db, goalId: string, status?: GoalFindingStatus): GoalFinding[] {
  return (
    db
      .prepare(
        `SELECT * FROM goal_findings WHERE goal_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at, rowid`,
      )
      .all(...(status ? [goalId, status] : [goalId])) as FindingRow[]
  ).map(toFinding);
}

export function openFindingCounts(db: Db, goalId: string): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of db
    .prepare(
      "SELECT severity, COUNT(*) AS n FROM goal_findings WHERE goal_id = ? AND status = 'open' GROUP BY severity",
    )
    .all(goalId) as Array<{ severity: FindingSeverity; n: number }>)
    counts[row.severity] = row.n;
  return counts;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizePath(value: string): string {
  return value.replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
}

/**
 * Deterministic identity of a finding across reviews: SHA-256 over canonical JSON of the normalised category, the
 * normalised description (first 500 characters) and the sorted, de-duplicated affected paths. Severity and the
 * reviewer's evidence and remediation wording are not part of identity. A fingerprint only de-duplicates; it never
 * resolves anything.
 */
export function findingFingerprint(finding: {
  category: string;
  description: string;
  affectedFiles: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        category: normalizeText(finding.category),
        description: normalizeText(finding.description).slice(0, 500),
        files: [...new Set(finding.affectedFiles.map(normalizePath))].sort(),
      }),
    )
    .digest('hex');
}

export type ResolutionRefusal =
  'review_not_current' | 'deterministic_evidence_missing' | 'no_deterministic_verifier';

export interface ApplyFindingsResult {
  opened: string[];
  reopened: string[];
  resolved: string[];
  observed: number;
  resolutionsRefused: Array<{ goalFindingId: string; code: ResolutionRefusal }>;
}

const BASIS_CHARS = 1_000;

/**
 * Applies a completed review's report to the Goal's finding lifecycle, once per review.
 *
 *  - A new finding whose fingerprint matches an open Goal finding adds an observation instead of a second open finding;
 *    one that matches a resolved finding reopens it; one that matches a user-decided finding keeps the user's decision.
 *  - Every explicitly reported existing finding is `still_open`, `resolved` or `not_assessed`. A finding the report omits
 *    is untouched: absence never resolves anything.
 *  - Resolution applies only to the specific finding id the review assessed, and only when the review's tree is the
 *    current integration tree. For critical/high findings under `review-plus-head-bound-verifier` it also needs every
 *    current build/test verifier satisfied by fresh evidence at that tree. Otherwise the finding stays open and the
 *    refused attempt is recorded as an observation.
 *  - Users' accept/dismiss decisions are separate (`decideFinding`); a model cannot set them.
 */
export async function applyReviewFindings(
  db: Db,
  input: {
    reviewId: string;
    /** Optional links to RC2 per-run review_findings, by index into report.newFindings and by Goal finding id. */
    runFindingIds?: { new?: Array<string | null>; existing?: Record<string, string> };
    now?: string;
  },
): Promise<ApplyFindingsResult> {
  const review = getReview(db, input.reviewId);
  if (!review) throw new GoalFindingError('review_not_found', 'No such review.');
  if (review.status !== 'completed' || !review.report)
    throw new GoalFindingError(
      'review_not_completed',
      'Only a completed review feeds the finding lifecycle.',
    );
  const report: ReviewReport = review.report;
  const goalId = review.goalId;
  if (
    db
      .prepare(
        "SELECT 1 FROM goal_events WHERE goal_id = ? AND type = 'review_findings_applied' AND json_extract(payload_json, '$.reviewId') = ?",
      )
      .get(goalId, review.id)
  )
    throw new GoalFindingError('review_findings_already_applied', 'This review was already applied.');

  const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
    { current_definition_version: number | null } | undefined;
  if (!goal) throw new GoalFindingError('goal_not_found', 'The Goal does not exist.');
  if (goal.current_definition_version === null)
    throw new GoalFindingError('definition_not_approved', 'The Goal has no approved definition.');
  const definition = loadDefinitionVersion(db, goalId, goal.current_definition_version)!.definition;

  const resolved = await resolveGoalRepository(db, goalId);
  if (!resolved.ok) throw new GoalFindingError('repository_unavailable', resolved.detail);
  const { state } = resolved;

  // Deterministic gate for high-severity resolution (computed before the transaction; read-only).
  let deterministic: { ok: boolean; refusal: ResolutionRefusal | null; digests: string[] };
  {
    const verifiers = listVerifiers(definition).filter(
      (verifier) => verifier.spec.kind === 'build' || verifier.spec.kind === 'test',
    );
    if (verifiers.length === 0)
      deterministic = { ok: false, refusal: 'no_deterministic_verifier', digests: [] };
    else {
      const reader = createRepositoryReader(state);
      const evaluations = await Promise.all(
        verifiers.map((verifier) => evaluateVerifier(db, goalId, verifier, reader)),
      );
      deterministic = evaluations.every((evaluation) => evaluation.state === 'satisfied')
        ? { ok: true, refusal: null, digests: verifiers.map((verifier) => verifier.digest) }
        : { ok: false, refusal: 'deterministic_evidence_missing', digests: [] };
    }
  }
  const needsDeterministic = (severity: FindingSeverity) =>
    (severity === 'critical' || severity === 'high') &&
    definition.contract.completionPolicy.highSeverityResolution === 'review-plus-head-bound-verifier';
  const reviewIsCurrent = review.reviewedToTree === state.tree;

  const now = input.now ?? new Date().toISOString();
  const result: ApplyFindingsResult = {
    opened: [],
    reopened: [],
    resolved: [],
    observed: 0,
    resolutionsRefused: [],
  };

  const runOwned = (runFindingId: string | null | undefined): string | null => {
    if (!runFindingId) return null;
    const row = db.prepare('SELECT run_id FROM review_findings WHERE id = ?').get(runFindingId) as
      { run_id: string } | undefined;
    if (!review.runId || !row || row.run_id !== review.runId)
      throw new GoalFindingError(
        'run_finding_mismatch',
        'A cited run finding must belong to the review run of this Goal review.',
      );
    return runFindingId;
  };

  db.transaction(() => {
    const head = (
      db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as
        { integration_head: string | null } | undefined
    )?.integration_head;
    if (head !== state.head)
      throw new GoalFindingError('repository_changed', 'The Goal ref moved while applying the review.');

    const observed = new Set<string>();
    const observe = (
      findingId: string,
      observation: 'new' | 'still_open' | 'resolved' | 'reopened' | 'not_assessed',
      basis: string,
      runFindingId?: string | null,
    ): boolean => {
      if (observed.has(findingId)) return false;
      observed.add(findingId);
      db.prepare(
        `INSERT INTO goal_finding_observations (id, goal_id, goal_finding_id, review_id, run_finding_id, observation, basis, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        goalId,
        findingId,
        review.id,
        runOwned(runFindingId),
        observation,
        basis.slice(0, BASIS_CHARS),
        now,
      );
      result.observed++;
      return true;
    };
    const touch = (findingId: string) =>
      db
        .prepare('UPDATE goal_findings SET last_seen_review_id = ?, updated_at = ? WHERE id = ?')
        .run(review.id, now, findingId);
    const reopen = (finding: FindingRow, basis: string, runFindingId?: string | null) => {
      if (!observe(finding.id, 'reopened', basis, runFindingId)) return;
      db.prepare(
        `UPDATE goal_findings SET status = 'open', resolved_by_review_id = NULL, resolution_basis_json = NULL,
           last_seen_review_id = ?, updated_at = ? WHERE id = ?`,
      ).run(review.id, now, finding.id);
      result.reopened.push(finding.id);
      writeGoalEvent(db, goalId, 'finding_reopened', { goalFindingId: finding.id, reviewId: review.id }, now);
    };

    for (const entry of report.existingFindings) {
      const finding = db
        .prepare('SELECT * FROM goal_findings WHERE id = ? AND goal_id = ?')
        .get(entry.goalFindingId, goalId) as FindingRow | undefined;
      if (!finding) continue; // completeReview already refuses unknown ids; defensive
      const link = input.runFindingIds?.existing?.[entry.goalFindingId];
      if (entry.status === 'not_assessed') {
        observe(finding.id, 'not_assessed', entry.basis, link);
        continue;
      }
      if (entry.status === 'still_open') {
        if (finding.status === 'resolved') reopen(finding, entry.basis, link);
        else if (observe(finding.id, 'still_open', entry.basis, link) && finding.status === 'open')
          touch(finding.id);
        continue;
      }
      // status === 'resolved'
      if (finding.status !== 'open') continue; // nothing to resolve; user decisions are never overwritten
      let refusal: ResolutionRefusal | null = null;
      if (!reviewIsCurrent) refusal = 'review_not_current';
      else if (needsDeterministic(finding.severity) && !deterministic.ok) refusal = deterministic.refusal;
      if (refusal) {
        observe(finding.id, 'still_open', `resolution_refused:${refusal}: ${entry.basis}`, link);
        touch(finding.id);
        result.resolutionsRefused.push({ goalFindingId: finding.id, code: refusal });
        continue;
      }
      if (!observe(finding.id, 'resolved', entry.basis, link)) continue;
      db.prepare(
        `UPDATE goal_findings SET status = 'resolved', resolved_by_review_id = ?, resolution_basis_json = ?,
           last_seen_review_id = ?, updated_at = ? WHERE id = ?`,
      ).run(
        review.id,
        JSON.stringify({
          reviewId: review.id,
          integrationTree: state.tree,
          deterministicVerifiers: needsDeterministic(finding.severity) ? deterministic.digests : [],
        }),
        review.id,
        now,
        finding.id,
      );
      result.resolved.push(finding.id);
      writeGoalEvent(db, goalId, 'finding_resolved', { goalFindingId: finding.id, reviewId: review.id }, now);
    }

    report.newFindings.forEach((entry, index) => {
      const fingerprint = findingFingerprint(entry);
      const link = input.runFindingIds?.new?.[index];
      const open = db
        .prepare("SELECT * FROM goal_findings WHERE goal_id = ? AND fingerprint = ? AND status = 'open'")
        .get(goalId, fingerprint) as FindingRow | undefined;
      if (open) {
        if (observe(open.id, 'still_open', 'duplicate fingerprint', link)) touch(open.id);
        return;
      }
      const latest = db
        .prepare(
          'SELECT * FROM goal_findings WHERE goal_id = ? AND fingerprint = ? ORDER BY created_at DESC, rowid DESC',
        )
        .get(goalId, fingerprint) as FindingRow | undefined;
      if (latest?.status === 'resolved') {
        reopen(latest, 'reported again by a later review', link);
        return;
      }
      if (latest) {
        // accepted_by_user / dismissed_by_user: the user's decision stands.
        observe(latest.id, 'still_open', `reported again; ${latest.status} retained`, link);
        return;
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO goal_findings (id, goal_id, fingerprint, severity, category, description, affected_files_json, status,
           first_seen_review_id, last_seen_review_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(
        id,
        goalId,
        fingerprint,
        entry.severity,
        entry.category,
        entry.description,
        JSON.stringify([...new Set(entry.affectedFiles.map(normalizePath))].sort()),
        review.id,
        review.id,
        now,
        now,
      );
      observe(id, 'new', 'first reported', link);
      result.opened.push(id);
      writeGoalEvent(
        db,
        goalId,
        'finding_opened',
        { goalFindingId: id, severity: entry.severity, reviewId: review.id },
        now,
      );
    });

    writeGoalEvent(
      db,
      goalId,
      'review_findings_applied',
      {
        reviewId: review.id,
        opened: result.opened.length,
        observed: result.observed,
        resolved: result.resolved.length,
        reopened: result.reopened.length,
        resolutionsRefused: result.resolutionsRefused.length,
      },
      now,
    );
  })();
  return result;
}

/**
 * Accepts or dismisses an open finding. Only the user can: the decision must be backed by an approved `finding_decision`
 * Goal approval, decided by the user, bound to the finding id, the decision and the current definition (version and
 * hash).
 */
export function decideFinding(
  db: Db,
  input: {
    goalId: string;
    findingId: string;
    decision: 'accepted_by_user' | 'dismissed_by_user';
    approvalId: string;
    actor: 'user';
    now?: string;
  },
): GoalFinding {
  if (input.actor !== 'user')
    throw new GoalFindingError('user_authority_required', 'Only the user accepts or dismisses a finding.');
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(input.goalId) as
      { current_definition_version: number | null } | undefined;
    if (!goal) throw new GoalFindingError('goal_not_found', 'The Goal does not exist.');
    const version =
      goal.current_definition_version === null
        ? undefined
        : loadDefinitionVersion(db, input.goalId, goal.current_definition_version);
    if (!version)
      throw new GoalFindingError('definition_not_approved', 'The Goal has no approved definition.');
    const finding = getGoalFinding(db, input.findingId);
    if (!finding || finding.goalId !== input.goalId)
      throw new GoalFindingError('finding_not_found', 'No such finding for this Goal.');
    if (finding.status !== 'open')
      throw new GoalFindingError('finding_not_open', 'Only an open finding can be decided.');
    const approval = getGoalApproval(db, input.approvalId);
    if (
      !approval ||
      approval.goalId !== input.goalId ||
      approval.gate !== 'finding_decision' ||
      approval.status !== 'approved' ||
      approval.decidedBy !== 'user' ||
      approval.detail.findingId !== input.findingId ||
      approval.detail.decision !== input.decision ||
      approval.detail.definitionVersion !== version.version ||
      approval.detail.definitionHash !== version.definitionHash
    )
      throw new GoalFindingError(
        'approval_invalid',
        'The approval is not a user decision bound to this finding, decision and definition.',
      );
    db.prepare('UPDATE goal_findings SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(
      input.decision,
      now,
      input.findingId,
      'open',
    );
    writeGoalEvent(
      db,
      input.goalId,
      'finding_decided',
      { goalFindingId: input.findingId, decision: input.decision, approvalId: input.approvalId },
      now,
    );
    return getGoalFinding(db, input.findingId)!;
  })();
}

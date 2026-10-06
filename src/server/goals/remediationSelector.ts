import type { FindingSeverity, GoalDefinition } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { allowedOpenFindings, listGoalFindings, type GoalFinding } from './findings.js';
import {
  MAX_REMEDIATION_FINDINGS_PER_CYCLE,
  REMEDIATION_TRIGGER_CODE,
  readRemediationPlan,
  remediationAnchor,
  remediationEpisodeKey,
  type RemediationEpisode,
  type RemediationPlan,
  type RemediationReason,
} from './remediationPlan.js';
import { getReview } from './reviews.js';

/**
 * Deterministic remediation selection (Stage 6B.2). Read-only: it never creates a cycle, transitions the Goal, calls a
 * provider, resolves a route, requests an approval or touches a finding. The supervisor hands a returned plan to
 * `createCycle`, which persists it atomically with the remediation cycle.
 *
 * A finding is an automatic candidate only while it is `open` (a user-accepted or user-dismissed finding never is) and
 * only for one of two reasons:
 *   - threshold: it is among the findings the CURRENT completion policy cannot tolerate. For each of critical/high/medium
 *     with a configured limit, the excess `open - limit` findings (oldest first, then by id) qualify; with limit 0 that
 *     is every open one. Low findings and an unlimited medium never qualify through thresholds.
 *   - blocking review: the review that last saw it completed as blocking, at the current definition version and the
 *     current integration tree (an older tree keeps no special authority).
 *
 * An episode (finding + last-seen review + definition + milestone) is consumed only when a scheduler remediation cycle
 * containing that exact key succeeded, integrated, and its applied advance operation proves the work entered the Goal.
 * A created, failed, rejected or cancelled attempt consumes nothing. Only a later review (which changes the finding's
 * last-seen review) can create a new episode; remediation itself never resolves a finding.
 */
export type RemediationSelection =
  | { ok: true; plan: RemediationPlan | null }
  | { ok: false; code: 'remediation_milestone_unavailable'; findingId: string };

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const byCreation = (a: GoalFinding, b: GoalFinding) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Findings the current completion policy cannot tolerate: the deterministic excess per limited severity. */
export function thresholdBlockingFindingIds(
  open: readonly GoalFinding[],
  policy: GoalDefinition['contract']['completionPolicy'],
): Set<string> {
  const limits = allowedOpenFindings(policy);
  const out = new Set<string>();
  for (const severity of ['critical', 'high', 'medium'] as const) {
    const limit = limits[severity];
    if (limit === null) continue;
    const ofSeverity = open.filter((finding) => finding.severity === severity).sort(byCreation);
    for (const finding of ofSeverity.slice(0, Math.max(0, ofSeverity.length - limit))) out.add(finding.id);
  }
  return out;
}

/** Episode keys already consumed by scheduler remediation that was integrated into the Goal (current definition only). */
export function consumedEpisodeKeys(db: Db, goalId: string, version: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT c.outcome_json AS outcome FROM goal_cycles c
        WHERE c.goal_id = ? AND c.kind = 'remediation' AND c.trigger_code = ? AND c.status = 'succeeded'
          AND c.definition_version = ? AND c.result_integration_commit IS NOT NULL
          AND json_extract(c.outcome_json, '$.code') = 'integrated'
          AND EXISTS (SELECT 1 FROM goal_integration_ops o
                       WHERE o.goal_id = c.goal_id AND o.cycle_id = c.id AND o.op = 'advance'
                         AND o.status = 'applied' AND o.new_commit = c.result_integration_commit)`,
    )
    .all(goalId, REMEDIATION_TRIGGER_CODE, version) as Array<{ outcome: string }>;
  const keys = new Set<string>();
  for (const row of rows) {
    let outcome: unknown;
    try {
      outcome = JSON.parse(row.outcome);
    } catch {
      continue;
    }
    const plan = readRemediationPlan(outcome);
    if (plan && plan.definitionVersion === version)
      for (const episode of plan.episodes) keys.add(episode.episodeKey);
  }
  return keys;
}

export function determineRemediationPlan(
  db: Db,
  goalId: string,
  input: { definition: GoalDefinition; version: number; tree: string },
): RemediationSelection {
  const { definition, version, tree } = input;
  const open = listGoalFindings(db, goalId, 'open');
  if (open.length === 0) return { ok: true, plan: null };
  const threshold = thresholdBlockingFindingIds(open, definition.contract.completionPolicy);
  const candidates: Array<{ finding: GoalFinding; reason: RemediationReason }> = [];
  for (const finding of open) {
    const review = getReview(db, finding.lastSeenReviewId);
    const blocking =
      !!review &&
      review.status === 'completed' &&
      review.blocking === true &&
      review.definitionVersion === version &&
      review.reviewedToTree === tree;
    const overThreshold = threshold.has(finding.id);
    if (!blocking && !overThreshold) continue;
    candidates.push({
      finding,
      reason: blocking && overThreshold ? 'both' : blocking ? 'blocking_review' : 'threshold',
    });
  }
  candidates.sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      byCreation(a.finding, b.finding),
  );
  if (candidates.length === 0) return { ok: true, plan: null };

  const consumed = consumedEpisodeKeys(db, goalId, version);
  let milestoneKey: string | undefined;
  const episodes: RemediationEpisode[] = [];
  for (const { finding, reason } of candidates) {
    if (episodes.length >= MAX_REMEDIATION_FINDINGS_PER_CYCLE) break;
    const anchor = remediationAnchor(db, goalId, finding, definition);
    if (!anchor) {
      // The highest-priority actionable candidate must be schedulable; a later one without an anchor is simply not part
      // of this group and is reconsidered once the group's episodes are consumed.
      if (milestoneKey === undefined)
        return { ok: false, code: 'remediation_milestone_unavailable', findingId: finding.id };
      continue;
    }
    const episodeKey = remediationEpisodeKey({
      findingId: finding.id,
      lastSeenReviewId: finding.lastSeenReviewId,
      definitionVersion: version,
      milestoneKey: anchor,
    });
    if (consumed.has(episodeKey)) continue;
    milestoneKey ??= anchor;
    if (anchor !== milestoneKey) continue;
    episodes.push({ findingId: finding.id, lastSeenReviewId: finding.lastSeenReviewId, episodeKey, reason });
  }
  if (!milestoneKey || episodes.length === 0) return { ok: true, plan: null };
  return { ok: true, plan: { schema: 1, definitionVersion: version, milestoneKey, episodes } };
}

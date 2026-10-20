import { createHash } from 'node:crypto';
import type { GoalDefinition } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { canonicalJson } from './definitionHash.js';
import { loadDefinitionVersion } from './definitions.js';
import { allowedOpenFindings, getGoalFinding, listGoalFindings, type GoalFinding } from './findings.js';
import { getReview } from './reviews.js';

/**
 * What a finding-remediation cycle was created to address. Like the review plan it is persisted write-once
 * in `goal_cycles.outcome_json` - here as `remediationPlan`, atomically with the INSERT - and is re-read, recomputed and
 * re-validated whenever it is used. It carries identities only: no finding text, evidence or provider prose, which stay
 * in their canonical finding/review rows. A corrupt plan fails closed and is never repaired or recomputed in place.
 */
export const MAX_REMEDIATION_FINDINGS_PER_CYCLE = 6;
export const REMEDIATION_TRIGGER_CODE = 'finding_remediation';
export const REMEDIATION_PLAN_LIMITS = { idChars: 100, keyChars: 200 } as const;

export type RemediationReason = 'threshold' | 'blocking_review' | 'both';
const REASONS: readonly RemediationReason[] = ['threshold', 'blocking_review', 'both'];

export interface RemediationEpisode {
  findingId: string;
  lastSeenReviewId: string;
  episodeKey: string;
  reason: RemediationReason;
}

export interface RemediationPlan {
  schema: 1;
  definitionVersion: number;
  milestoneKey: string;
  episodes: RemediationEpisode[];
}

/**
 * One remediation episode is one review observation of one finding for one milestone under one definition version.
 * No timestamp takes part, so the same persisted state always yields the same key.
 */
export function remediationEpisodeKey(input: {
  findingId: string;
  lastSeenReviewId: string;
  definitionVersion: number;
  milestoneKey: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        schema: 1,
        findingId: input.findingId,
        lastSeenReviewId: input.lastSeenReviewId,
        definitionVersion: input.definitionVersion,
        milestoneKey: input.milestoneKey,
      }),
    )
    .digest('hex');
}

/**
 * One review observation of one finding under one definition version, independent of any milestone. A successfully
 * integrated remediation consumes the observation, so a changed fallback milestone can never re-open the same one; only a
 * later review (a new last-seen review) or a new definition version creates another opportunity.
 */
export function remediationObservationKey(input: {
  findingId: string;
  lastSeenReviewId: string;
  definitionVersion: number;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        schema: 1,
        kind: 'remediation_observation',
        findingId: input.findingId,
        lastSeenReviewId: input.lastSeenReviewId,
        definitionVersion: input.definitionVersion,
      }),
    )
    .digest('hex');
}

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

/**
 * The single canonical calculation of which open findings are automatic remediation candidates, shared by selection and
 * runtime reproof: threshold excess under the CURRENT policy, or backed by the finding's last-seen review being a
 * completed blocking review at the current definition version and the current tree (a null tree never qualifies).
 */
export function remediationCandidates(
  db: Db,
  goalId: string,
  input: { definition: GoalDefinition; version: number; tree: string | null },
): Map<string, { finding: GoalFinding; reason: RemediationReason }> {
  const open = listGoalFindings(db, goalId, 'open');
  const threshold = thresholdBlockingFindingIds(open, input.definition.contract.completionPolicy);
  const out = new Map<string, { finding: GoalFinding; reason: RemediationReason }>();
  for (const finding of open) {
    const review = getReview(db, finding.lastSeenReviewId);
    const blocking =
      !!review &&
      review.status === 'completed' &&
      review.blocking === true &&
      review.definitionVersion === input.version &&
      input.tree !== null &&
      review.reviewedToTree === input.tree;
    const overThreshold = threshold.has(finding.id);
    if (!blocking && !overThreshold) continue;
    out.set(finding.id, {
      finding,
      reason: blocking && overThreshold ? 'both' : blocking ? 'blocking_review' : 'threshold',
    });
  }
  return out;
}

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** The strict normal form of a persisted plan, or null when it is absent, malformed, or its keys do not recompute. */
export function readRemediationPlan(outcome: unknown): RemediationPlan | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const raw = (outcome as { remediationPlan?: unknown }).remediationPlan;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const plan = raw as Record<string, unknown>;
  if (Object.keys(plan).sort().join(',') !== 'definitionVersion,episodes,milestoneKey,schema') return null;
  if (plan.schema !== 1) return null;
  const version = plan.definitionVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (!boundedString(plan.milestoneKey, REMEDIATION_PLAN_LIMITS.keyChars)) return null;
  const episodes = plan.episodes;
  if (!Array.isArray(episodes) || episodes.length < 1 || episodes.length > MAX_REMEDIATION_FINDINGS_PER_CYCLE)
    return null;
  const seen = new Set<string>();
  const out: RemediationEpisode[] = [];
  for (const entry of episodes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'episodeKey,findingId,lastSeenReviewId,reason') return null;
    if (
      !boundedString(item.findingId, REMEDIATION_PLAN_LIMITS.idChars) ||
      !boundedString(item.lastSeenReviewId, REMEDIATION_PLAN_LIMITS.idChars) ||
      typeof item.episodeKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.episodeKey) ||
      !(REASONS as readonly unknown[]).includes(item.reason)
    )
      return null;
    if (seen.has(item.findingId)) return null;
    seen.add(item.findingId);
    if (
      item.episodeKey !==
      remediationEpisodeKey({
        findingId: item.findingId,
        lastSeenReviewId: item.lastSeenReviewId,
        definitionVersion: version,
        milestoneKey: plan.milestoneKey,
      })
    )
      return null;
    out.push({
      findingId: item.findingId,
      lastSeenReviewId: item.lastSeenReviewId,
      episodeKey: item.episodeKey,
      reason: item.reason as RemediationReason,
    });
  }
  return { schema: 1, definitionVersion: version, milestoneKey: plan.milestoneKey, episodes: out };
}

/** True for the cycles that must carry a plan: scheduler-created finding remediation. */
export const isFindingRemediation = (cycle: { kind: string; triggerCode: string }): boolean =>
  cycle.kind === 'remediation' && cycle.triggerCode === REMEDIATION_TRIGGER_CODE;

/**
 * The deterministic milestone a finding's remediation is anchored to, or null when none is authorised. Findings are
 * Goal-level and carry no milestone, and nothing here looks at file names, titles or a model:
 *   1. the milestone of the review that last saw the finding, when that milestone is still in the current definition
 *      (a review milestone that has since left the definition is NOT replaced by another);
 *   2. otherwise, for a broad review (no milestone), the Goal's persisted active milestone, when still current.
 * A milestone the user skipped is not remediated automatically. A satisfied milestone may be the anchor.
 */
export function remediationAnchor(
  db: Db,
  goalId: string,
  finding: Pick<GoalFinding, 'lastSeenReviewId'>,
  definition: GoalDefinition,
): string | null {
  const current = (milestoneId: string): string | null => {
    const row = db
      .prepare('SELECT milestone_key AS key, status FROM goal_milestones WHERE id = ? AND goal_id = ?')
      .get(milestoneId, goalId) as { key: string; status: string } | undefined;
    if (!row || row.status === 'skipped') return null;
    return definition.milestones.some((milestone) => milestone.key === row.key) ? row.key : null;
  };
  const review = getReview(db, finding.lastSeenReviewId);
  if (review?.milestoneId) return current(review.milestoneId);
  const goal = db.prepare('SELECT active_milestone_id AS id FROM goals WHERE id = ?').get(goalId) as
    { id: string | null } | undefined;
  return goal?.id ? current(goal.id) : null;
}

export type RemediationProof =
  | { ok: true; plan: RemediationPlan }
  | { ok: false; code: 'remediation_plan_invalid' | 'remediation_no_longer_current' };

/**
 * Re-proves a persisted plan against the cycle and the live rows before it is used for anything (creation, a proposal
 * run, a work run). A plan that is malformed, mismatches its cycle, or names an unknown/foreign finding is INVALID. A
 * plan whose findings changed (decided by the user, resolved, or seen again by a newer review) or whose definition or
 * milestone is no longer current is NO LONGER CURRENT. The plan is never shrunk, merged or rewritten.
 */
export function proveRemediationPlan(
  db: Db,
  cycle: {
    goalId: string;
    definitionVersion: number | null;
    milestoneKey: string | null;
    outcome: Record<string, unknown> | null;
  },
  options: { requireAnchor?: boolean; tree?: string | null } = {},
): RemediationProof {
  const invalid = { ok: false, code: 'remediation_plan_invalid' } as const;
  const stale = { ok: false, code: 'remediation_no_longer_current' } as const;
  const plan = readRemediationPlan(cycle.outcome);
  if (!plan || cycle.definitionVersion === null || !cycle.milestoneKey) return invalid;
  if (plan.definitionVersion !== cycle.definitionVersion || plan.milestoneKey !== cycle.milestoneKey)
    return invalid;
  const goal = db
    .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
    .get(cycle.goalId) as { v: number | null } | undefined;
  if (!goal || goal.v !== plan.definitionVersion) return stale;
  const version = loadDefinitionVersion(db, cycle.goalId, plan.definitionVersion);
  if (!version) return invalid;
  const definition = version.definition as GoalDefinition;
  if (!definition.milestones.some((milestone) => milestone.key === plan.milestoneKey)) return stale;
  const candidates =
    options.tree === undefined
      ? undefined
      : remediationCandidates(db, cycle.goalId, {
          definition,
          version: plan.definitionVersion,
          tree: options.tree,
        });
  for (const episode of plan.episodes) {
    const finding = getGoalFinding(db, episode.findingId);
    if (!finding || finding.goalId !== cycle.goalId) return invalid;
    if (finding.status !== 'open' || finding.lastSeenReviewId !== episode.lastSeenReviewId) return stale;
    // Still an automatic candidate by at least one accepted rule. The persisted reason is creation audit only and the
    // target milestone is write-once, so neither is re-derived here.
    if (candidates && !candidates.has(finding.id)) return stale;
    if (
      options.requireAnchor &&
      remediationAnchor(db, cycle.goalId, finding, definition) !== plan.milestoneKey
    )
      return invalid;
  }
  return { ok: true, plan };
}

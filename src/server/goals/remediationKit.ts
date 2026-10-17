import { randomUUID } from 'node:crypto';
import type { FindingSeverity, GoalReviewKind } from '../../shared/goals.js';
import { applyReviewFindings } from './findings.js';
import { newFinding, reportOf, type GoalRepoFixture } from './repoKit.js';
import { completeReview, createReview } from './reviews.js';

/** A completed review (and its findings applied) at the Goal's current head, exactly as the lifecycle leaves one. */
export async function reviewWith(
  fx: GoalRepoFixture,
  options: {
    kind?: GoalReviewKind;
    verdict?: 'pass' | 'pass_with_findings' | 'block';
    milestone?: string;
    findings?: Array<{ severity: FindingSeverity; description?: string }>;
    existing?: Array<{ goalFindingId: string; status: 'still_open' | 'resolved' | 'not_assessed' }>;
    version?: number;
  } = {},
): Promise<{ reviewId: string; opened: string[] }> {
  const kind = options.kind ?? 'periodic';
  const { id } = await createReview(fx.db, {
    goalId: fx.goalId,
    definitionVersion: options.version ?? 1,
    reviewKind: kind,
    ...(options.milestone ? { milestoneId: fx.milestoneId(options.milestone) } : {}),
  });
  completeReview(fx.db, {
    reviewId: id,
    report: reportOf({
      verdict: options.verdict ?? 'pass_with_findings',
      newFindings: (options.findings ?? []).map((entry) =>
        newFinding({
          severity: entry.severity,
          description: entry.description ?? `finding ${randomUUID()}`,
        }),
      ) as never,
      existingFindings: (options.existing ?? []).map((entry) => ({ ...entry, basis: 'assessed' })),
    }),
  });
  const { opened } = await applyReviewFindings(fx.db, { reviewId: id });
  return { reviewId: id, opened };
}

export async function openFinding(
  fx: GoalRepoFixture,
  severity: FindingSeverity,
  over: Parameters<typeof reviewWith>[1] = {},
): Promise<string> {
  const { opened } = await reviewWith(fx, { ...over, findings: [{ severity }] });
  return opened[0]!;
}

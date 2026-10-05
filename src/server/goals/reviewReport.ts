import type { ReviewReport } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { redactSecrets } from '../security.js';
import { reviewReportSchema } from './reviews.js';

/** Bounds applied BEFORE anything is parsed: a review report is never read from an unbounded stage output. */
export const REVIEW_REPORT_LIMITS = { outputJsonChars: 400_000, textChars: 200_000 } as const;

export type ReviewReportFailure =
  | 'review_run_invalid'
  | 'consolidate_missing'
  | 'consolidate_ambiguous'
  | 'consolidate_not_passed'
  | 'report_output_missing'
  | 'report_oversize'
  | 'report_not_json'
  | 'report_shape_invalid'
  | 'report_schema_invalid'
  | 'report_finding_unmatched'
  | 'report_finding_mismatch'
  | 'report_finding_duplicate';

export type ReadReviewReport =
  | {
      ok: true;
      report: ReviewReport;
      /** The per-run `review_findings` row of THIS run for each `report.newFindings[i]`, by index. */
      runFindingIds: { new: string[] };
    }
  | { ok: false; code: ReviewReportFailure; issues?: string[] };

const RUN_CATEGORIES = ['correctness', 'security', 'performance', 'maintainability', 'testing'];

/** The ordinary review pipeline's own normalisation (RunEngine.normalizeFindings), so a match is exact, not fuzzy. */
const runText = (value: string, limit: number) => redactSecrets(value).trim().slice(0, limit);
const runCategory = (value: string) =>
  RUN_CATEGORIES.includes(value.toLowerCase()) ? value.toLowerCase() : 'correctness';
const runFiles = (files: readonly string[]) =>
  [...new Set(files.slice(0, 30).map((file) => file.slice(0, 300)))].sort();

/**
 * Links each Goal `newFindings[i]` to the per-run `review_findings` row of this run that the ordinary pipeline stored
 * for the same finding (same normalised description, severity, category and affected files). A new finding with no
 * counterpart, or a row claimed twice, fails closed: the Goal report cannot invent findings the review run never
 * produced, and no row of another run is ever linked. Pure and deterministic over persisted rows.
 */
export function linkRunFindings(
  db: Db,
  runId: string,
  report: ReviewReport,
): { ok: true; ids: string[] } | { ok: false; code: ReviewReportFailure } {
  const rows = db
    .prepare(
      'SELECT id, severity, category, description, affected_files_json FROM review_findings WHERE run_id = ?',
    )
    .all(runId) as Array<{
    id: string;
    severity: string;
    category: string;
    description: string;
    affected_files_json: string;
  }>;
  const byDescription = new Map(rows.map((row) => [row.description, row]));
  const used = new Set<string>();
  const ids: string[] = [];
  for (const finding of report.newFindings) {
    const row = byDescription.get(runText(finding.description, 3_000));
    if (!row) return { ok: false, code: 'report_finding_unmatched' };
    let files: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.affected_files_json);
      files = Array.isArray(parsed) ? parsed.filter((file): file is string => typeof file === 'string') : [];
    } catch {
      return { ok: false, code: 'report_finding_mismatch' };
    }
    if (
      row.severity !== finding.severity ||
      row.category !== runCategory(finding.category) ||
      JSON.stringify(runFiles(files)) !== JSON.stringify(runFiles(finding.affectedFiles))
    )
      return { ok: false, code: 'report_finding_mismatch' };
    if (used.has(row.id)) return { ok: false, code: 'report_finding_duplicate' };
    used.add(row.id);
    ids.push(row.id);
  }
  return { ok: true, ids };
}

/**
 * The strict reader of a Goal review run's report. The run must be a completed `review` run of a review cycle, its one
 * `consolidate` stage must have passed, and that stage's text must itself be ONE JSON object whose only keys are
 * `findings` (the ordinary pipeline's) and `goalReviewReport`, which must satisfy the existing `reviewReportSchema`
 * exactly. There is no repair, no extraction from prose or logs and no relaxed second schema; whatever fails is
 * `report invalid`, never a fabricated report.
 */
export function readGoalReviewReport(db: Db, runId: string): ReadReviewReport {
  const run = db
    .prepare(
      `SELECT r.status, r.goal_run_purpose AS purpose, c.kind AS cycle_kind FROM runs r
         LEFT JOIN goal_cycles c ON c.id = r.goal_cycle_id WHERE r.id = ?`,
    )
    .get(runId) as { status: string; purpose: string | null; cycle_kind: string | null } | undefined;
  if (!run || run.purpose !== 'review' || run.cycle_kind !== 'review' || run.status !== 'completed')
    return { ok: false, code: 'review_run_invalid' };
  const stages = db
    .prepare(
      "SELECT status, output_json FROM stages WHERE run_id = ? AND kind = 'consolidate' ORDER BY sequence",
    )
    .all(runId) as Array<{ status: string; output_json: string | null }>;
  if (stages.length === 0) return { ok: false, code: 'consolidate_missing' };
  if (stages.length > 1) return { ok: false, code: 'consolidate_ambiguous' };
  const stage = stages[0]!;
  if (stage.status !== 'passed') return { ok: false, code: 'consolidate_not_passed' };
  if (!stage.output_json) return { ok: false, code: 'report_output_missing' };
  if (stage.output_json.length > REVIEW_REPORT_LIMITS.outputJsonChars)
    return { ok: false, code: 'report_oversize' };
  let text: unknown;
  try {
    text = (JSON.parse(stage.output_json) as { text?: unknown }).text;
  } catch {
    return { ok: false, code: 'report_not_json' };
  }
  if (typeof text !== 'string' || text.trim().length === 0)
    return { ok: false, code: 'report_output_missing' };
  if (text.length > REVIEW_REPORT_LIMITS.textChars) return { ok: false, code: 'report_oversize' };
  let top: unknown;
  try {
    top = JSON.parse(text.trim());
  } catch {
    return { ok: false, code: 'report_not_json' };
  }
  if (!top || typeof top !== 'object' || Array.isArray(top))
    return { ok: false, code: 'report_shape_invalid' };
  const object = top as Record<string, unknown>;
  if (
    !('goalReviewReport' in object) ||
    Object.keys(object).some((key) => key !== 'findings' && key !== 'goalReviewReport')
  )
    return { ok: false, code: 'report_shape_invalid' };
  const parsed = reviewReportSchema.safeParse(object.goalReviewReport);
  if (!parsed.success)
    return {
      ok: false,
      code: 'report_schema_invalid',
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`.slice(0, 200)),
    };
  const report = parsed.data as ReviewReport;
  const linked = linkRunFindings(db, runId, report);
  if (!linked.ok) return { ok: false, code: linked.code };
  return { ok: true, report, runFindingIds: { new: linked.ids } };
}

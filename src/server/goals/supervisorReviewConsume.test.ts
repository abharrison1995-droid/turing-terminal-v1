import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalReviewKind } from '../../shared/goals.js';
import { listGoalEvents } from './events.js';
import { applyReviewFindings } from './findings.js';
import { cleanupRepoFixtures, newFinding, reportOf } from './repoKit.js';
import { createReviewCycle } from './reviewCycle.js';
import { recordReviewEvidence } from './reviewConsume.js';
import { readGoalReviewReport } from './reviewReport.js';
import { completeReview, reviewForCycle } from './reviews.js';
import { getCycle } from './cycles.js';
import { harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILT_IN = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
};

/** m1 owns a milestone review_verdict verifier; m2 owns a final one. */
const tune = (definition: import('../../shared/goals.js').GoalDefinition) => {
  definition.routing.workflows = { ...BUILT_IN };
  definition.contract.successCriteria.push(
    {
      key: 'm1-review',
      statement: 'Milestone one is reviewed',
      verification: [{ kind: 'test' }, { kind: 'review_verdict', reviewKind: 'milestone' }],
      required: true,
    },
    {
      key: 'final-review',
      statement: 'The Goal is finally reviewed',
      verification: [{ kind: 'test' }, { kind: 'review_verdict', reviewKind: 'final' }],
      required: true,
    },
  );
  definition.review.onMilestoneComplete = true;
  definition.review.final = true;
  const reviewer = definition.routing.roles.implementer!;
  definition.routing.roles.milestone_reviewer = reviewer;
  definition.routing.roles.final_reviewer = reviewer;
  definition.milestones[0]!.criteria.push('m1-review');
  definition.milestones[1]!.criteria.push('final-review');
};

type Report = ReturnType<typeof reportOf>;
type Finding = ReturnType<typeof newFinding>;

/** Stores what the real consolidate stage would: the Goal report beside the ordinary findings, plus per-run rows. */
function seedOutput(h: Harness, runId: string, report: Report, text?: string) {
  const db = h.fx.db;
  const stageId = randomUUID();
  db.prepare(
    `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, output_json)
     VALUES (?, ?, 'goal-consolidate', 'consolidate', 'Consolidate', 2, 'passed', ?)`,
  ).run(
    stageId,
    runId,
    JSON.stringify({
      text: text ?? JSON.stringify({ findings: report.newFindings, goalReviewReport: report }),
    }),
  );
  for (const finding of report.newFindings as Finding[])
    db.prepare(
      `INSERT INTO review_findings (id, run_id, stage_id, reviewer, severity, category, description, evidence, affected_files_json, recommended_remediation, status, created_at)
       VALUES (?, ?, ?, 'consolidator', ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      randomUUID(),
      runId,
      stageId,
      finding.severity,
      'correctness',
      finding.description,
      finding.evidence,
      JSON.stringify(finding.affectedFiles),
      finding.remediation,
      new Date().toISOString(),
    );
}

const reviewRunId = (h: Harness) =>
  (
    h.fx.db
      .prepare("SELECT id FROM runs WHERE goal_run_purpose = 'review' ORDER BY created_at DESC")
      .get() as {
      id: string;
    }
  ).id;

/** Starts a review of `kind` and leaves its run completed with the given report stored, ready to be consumed. */
async function readyToConsume(
  kind: GoalReviewKind,
  report: Report | null,
  options: { h?: Harness; outputText?: string } = {},
) {
  const h = options.h ?? harness({ tune });
  if (!options.h) await h.start();
  const created = createReviewCycle(h.fx.db, {
    goalId: h.fx.goalId,
    reviewKind: kind,
    triggerCode: 'test_trigger',
    ...(kind === 'milestone' ? { milestoneKey: 'm1' } : {}),
  });
  if (!created.created) throw new Error('expected a review cycle');
  await h.until('review_run_started');
  const runId = reviewRunId(h);
  if (report) seedOutput(h, runId, report, options.outputText);
  h.setRunStatus(runId, 'completed');
  expect(await h.tick()).toBe('collection_started');
  return { h, cycleId: created.cycle.id, runId };
}
async function consume(kind: GoalReviewKind, report: Report | null, options = {}) {
  const ready = await readyToConsume(kind, report, options);
  const action = await ready.h.tick();
  return { ...ready, action };
}
const evidence = (h: Harness) =>
  h.fx.db
    .prepare('SELECT criterion_key, verdict, review_id, run_id FROM goal_evidence ORDER BY criterion_key')
    .all() as Array<{ criterion_key: string; verdict: string; review_id: string; run_id: string }>;
const findings = (h: Harness) =>
  h.fx.db
    .prepare('SELECT id, status, severity, description FROM goal_findings ORDER BY description')
    .all() as Array<{
    id: string;
    status: string;
    severity: string;
    description: string;
  }>;
const markers = (h: Harness) =>
  listGoalEvents(h.fx.db, h.fx.goalId).filter((e) => e.type === 'run_evidence_collected');
const applied = (h: Harness) =>
  listGoalEvents(h.fx.db, h.fx.goalId).filter((e) => e.type === 'review_findings_applied');

describe('review consumption: semantic outcomes', () => {
  it('a blocking milestone report succeeds the cycle, blocks the Goal and records contradicting evidence', async () => {
    const { h, cycleId, runId, action } = await consume(
      'milestone',
      reportOf({ verdict: 'block', newFindings: [newFinding()] }),
    );
    expect(action).toBe('review_consumed');
    expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({
      status: 'completed',
      verdict: 'block',
      blocking: true,
    });
    // The review machinery ran and produced a valid report: the cycle is a success; the verdict is the semantic result.
    expect(getCycle(h.fx.db, cycleId)).toMatchObject({ status: 'succeeded' });
    expect(getCycle(h.fx.db, cycleId)!.outcome).toMatchObject({ code: 'review_consumed', blocking: true });
    expect(h.status()).toMatchObject({ status: 'blocked', reason: 'review_blocked' });
    expect(findings(h)).toEqual([expect.objectContaining({ status: 'open', severity: 'high' })]);
    // The new Goal finding is linked to the per-run row of THIS run.
    const link = h.fx.db.prepare('SELECT run_finding_id FROM goal_finding_observations').get() as {
      run_finding_id: string;
    };
    expect(
      (
        h.fx.db.prepare('SELECT run_id FROM review_findings WHERE id = ?').get(link.run_finding_id) as {
          run_id: string;
        }
      ).run_id,
    ).toBe(runId);
    expect(evidence(h)).toEqual([
      expect.objectContaining({ criterion_key: 'm1-review', verdict: 'contradicts' }),
    ]);
    expect(markers(h)).toHaveLength(1);
    expect(markers(h)[0]!.payload).toMatchObject({ runId, evidenceCount: 1 });
    expect(applied(h)).toHaveLength(1);
    // No remediation is scheduled automatically in 6A.
    expect(h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_cycles WHERE kind = 'remediation'").get()).toEqual(
      { n: 0 },
    );
  });

  it('a passing milestone report returns the Goal to running with satisfying evidence', async () => {
    const { h, cycleId } = await consume('milestone', reportOf({ verdict: 'pass' }));
    expect(h.status()).toMatchObject({ status: 'running', reason: 'review_passed' });
    expect(getCycle(h.fx.db, cycleId)).toMatchObject({ status: 'succeeded' });
    expect(evidence(h)).toEqual([
      expect.objectContaining({ criterion_key: 'm1-review', verdict: 'satisfies' }),
    ]);
    expect(findings(h)).toEqual([]);
  });

  it('pass_with_findings is non-blocking: it opens findings, satisfies a milestone verifier and resumes running', async () => {
    const { h } = await consume(
      'milestone',
      reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding({ severity: 'low' })] }),
    );
    expect(h.status()).toMatchObject({ status: 'running', reason: 'review_passed' });
    expect(findings(h)).toEqual([expect.objectContaining({ status: 'open', severity: 'low' })]);
    expect(evidence(h)).toEqual([
      expect.objectContaining({ criterion_key: 'm1-review', verdict: 'satisfies' }),
    ]);
  });

  it('a periodic block that policy makes non-blocking resumes running and never satisfies a verifier', async () => {
    const { h, cycleId } = await consume('periodic', reportOf({ verdict: 'block' }));
    expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({ verdict: 'block', blocking: false });
    expect(h.status()).toMatchObject({ status: 'running', reason: 'review_passed' });
    expect(evidence(h)).toEqual([]);
    // Zero evidence is a valid, recorded outcome.
    expect(markers(h)[0]!.payload).toMatchObject({ evidenceCount: 0 });
  });

  it('records review evidence only for the matching kind and the criteria the milestone owns', async () => {
    const { h } = await consume('milestone', reportOf({ verdict: 'pass' }));
    expect(evidence(h).map((row) => row.criterion_key)).toEqual(['m1-review']);
  });
});

describe('review consumption: existing findings', () => {
  it('resolves only what is explicitly resolved; still_open, not_assessed and omitted findings stay open', async () => {
    const seed = await consume(
      'periodic',
      reportOf({
        verdict: 'pass_with_findings',
        newFindings: ['A', 'B', 'C', 'D'].map((name) =>
          newFinding({ severity: 'low', description: `Finding ${name}`, affectedFiles: [`src/${name}.ts`] }),
        ),
      }),
    );
    const { h } = seed;
    const ids = Object.fromEntries(findings(h).map((finding) => [finding.description.slice(-1), finding.id]));
    expect(Object.keys(ids)).toEqual(['A', 'B', 'C', 'D']);
    await readyToConsume(
      'periodic',
      reportOf({
        verdict: 'pass_with_findings',
        existingFindings: [
          { goalFindingId: ids.A!, status: 'resolved', basis: 'fixed in this head' },
          { goalFindingId: ids.B!, status: 'still_open', basis: 'still there' },
          { goalFindingId: ids.C!, status: 'not_assessed', basis: 'out of range' },
        ],
      }),
      { h },
    );
    expect(await h.tick()).toBe('review_consumed');
    const status = Object.fromEntries(
      findings(h).map((finding) => [finding.description.slice(-1), finding.status]),
    );
    expect(status).toEqual({ A: 'resolved', B: 'open', C: 'open', D: 'open' });
  });
});

describe('review consumption: stale review', () => {
  it('a review whose head moved is completed but inert: no findings, no evidence, and the cycle still ends', async () => {
    const ready = await readyToConsume(
      'milestone',
      reportOf({ verdict: 'block', newFindings: [newFinding()] }),
    );
    const { h, cycleId } = ready;
    h.fx.advance({ 'src/late.ts': 'export const late = 1;\n' }, 'late work');
    expect(await h.tick()).toBe('review_consumed');
    expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({ status: 'completed', verdict: 'block' });
    expect(getCycle(h.fx.db, cycleId)!.outcome).toMatchObject({ code: 'review_stale', stale: true });
    expect(findings(h)).toEqual([]);
    expect(evidence(h)).toEqual([]);
    expect(applied(h)).toEqual([]);
    // A stale blocking verdict must not block the current head.
    expect(h.status()).toMatchObject({ status: 'running', reason: 'review_passed' });
    expect(markers(h)[0]!.payload).toMatchObject({ evidenceCount: 0 });
  });
});

describe('review consumption: invalid reports are infrastructure failures', () => {
  const cases: Array<[string, (report: Report) => string, string]> = [
    ['not JSON', () => 'the review is fine, trust me', 'report_not_json'],
    [
      'fenced JSON (no repair)',
      (r) => `\`\`\`json\n${JSON.stringify({ goalReviewReport: r })}\n\`\`\``,
      'report_not_json',
    ],
    [
      'an extra top-level key',
      (r) => JSON.stringify({ goalReviewReport: r, extra: 1 }),
      'report_shape_invalid',
    ],
    ['no goalReviewReport', () => JSON.stringify({ findings: [] }), 'report_shape_invalid'],
    [
      'a report that fails the strict schema',
      (r) => JSON.stringify({ goalReviewReport: { ...r, surprise: true } }),
      'report_schema_invalid',
    ],
    [
      'a new finding with no counterpart in the run',
      (r) => JSON.stringify({ goalReviewReport: { ...r, newFindings: [newFinding()] } }),
      'report_finding_unmatched',
    ],
  ];
  it.each(cases)(
    '%s closes the review failed, fails the cycle and fabricates nothing',
    async (_name, build, reason) => {
      const base = reportOf({ verdict: 'pass' });
      const { h, cycleId, action } = await consume('milestone', base, { outputText: build(base) });
      expect(action).toBe('review_decision_needed');
      expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({
        status: 'failed',
        report: null,
        verdict: null,
      });
      expect(getCycle(h.fx.db, cycleId)).toMatchObject({ status: 'failed' });
      expect(getCycle(h.fx.db, cycleId)!.outcome).toMatchObject({
        code: 'review_report_invalid',
      });
      expect(JSON.stringify(getCycle(h.fx.db, cycleId)!.outcome)).toContain(reason);
      expect(h.status()).toMatchObject({ status: 'needs_user', reason: 'review_needs_decision' });
      expect(findings(h)).toEqual([]);
      expect(evidence(h)).toEqual([]);
    },
  );

  it('a missing consolidate stage and a failed consolidate stage are both report failures', async () => {
    const none = await consume('periodic', null);
    expect(none.action).toBe('review_decision_needed');
    expect(JSON.stringify(getCycle(none.h.fx.db, none.cycleId)!.outcome)).toContain('consolidate_missing');
  });

  it('a final review whose route resolution cannot be re-proven fails closed instead of inventing independence', async () => {
    const { h, cycleId, action } = await consume('final', reportOf({ verdict: 'pass' }));
    expect(action).toBe('review_decision_needed');
    expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({ status: 'failed', independence: null });
    expect(JSON.stringify(getCycle(h.fx.db, cycleId)!.outcome)).toContain('independence_resolution_missing');
    expect(evidence(h)).toEqual([]);
  });
});

describe('review consumption: restart safety', () => {
  const setup = async () => {
    const report = reportOf({ verdict: 'block', newFindings: [newFinding()] });
    const ready = await readyToConsume('milestone', report);
    const read = readGoalReviewReport(ready.h.fx.db, ready.runId);
    if (!read.ok) throw new Error('fixture report invalid');
    return { ...ready, read };
  };
  const complete = (s: Awaited<ReturnType<typeof setup>>) => {
    const review = reviewForCycle(s.h.fx.db, s.cycleId)!;
    completeReview(s.h.fx.db, { reviewId: review.id, report: s.read.report });
    return reviewForCycle(s.h.fx.db, s.cycleId)!;
  };
  const finishedClean = (h: Harness, cycleId: string) => {
    expect(getCycle(h.fx.db, cycleId)).toMatchObject({ status: 'succeeded' });
    expect(h.status()).toMatchObject({ status: 'blocked', reason: 'review_blocked' });
    expect(findings(h)).toHaveLength(1);
    expect(applied(h)).toHaveLength(1);
    expect(evidence(h)).toHaveLength(1);
    expect(markers(h)).toHaveLength(1);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_finding_observations').get()).toEqual({ n: 1 });
  };

  it('crash after completeReview, before applying findings: the findings are applied exactly once', async () => {
    const s = await setup();
    complete(s);
    const restarted = s.h.restart();
    expect(await restarted.supervisor.tickGoal(s.h.fx.goalId)).toMatchObject({ action: 'review_consumed' });
    finishedClean(s.h, s.cycleId);
  });

  it('crash after applying findings, before evidence: evidence is recorded, findings are not applied again', async () => {
    const s = await setup();
    const review = complete(s);
    await applyReviewFindings(s.h.fx.db, {
      reviewId: review.id,
      runFindingIds: { new: s.read.runFindingIds.new },
    });
    const restarted = s.h.restart();
    await restarted.supervisor.tickGoal(s.h.fx.goalId);
    finishedClean(s.h, s.cycleId);
  });

  it('crash after evidence, before the marker and cycle finish: nothing is duplicated', async () => {
    const s = await setup();
    const review = complete(s);
    await applyReviewFindings(s.h.fx.db, {
      reviewId: review.id,
      runFindingIds: { new: s.read.runFindingIds.new },
    });
    const cycle = getCycle(s.h.fx.db, s.cycleId)!;
    await recordReviewEvidence(s.h.fx.db, { review, cycle, runId: s.runId, now: new Date().toISOString() });
    expect(markers(s.h)).toHaveLength(0);
    const restarted = s.h.restart();
    await restarted.supervisor.tickGoal(s.h.fx.goalId);
    finishedClean(s.h, s.cycleId);
  });

  it('repeated ticks and restarts after the review was consumed change nothing', async () => {
    const s = await setup();
    expect(await s.h.tick()).toBe('review_consumed');
    for (let index = 0; index < 3; index++) {
      const restarted = s.h.restart();
      await restarted.supervisor.tickGoal(s.h.fx.goalId);
    }
    finishedClean(s.h, s.cycleId);
    expect(s.h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_reviews').get()).toEqual({ n: 1 });
  });

  it('a second consumer racing a completed review does not apply findings twice', async () => {
    const s = await setup();
    const review = complete(s);
    await applyReviewFindings(s.h.fx.db, {
      reviewId: review.id,
      runFindingIds: { new: s.read.runFindingIds.new },
    });
    expect(await s.h.tick()).toBe('review_consumed');
    finishedClean(s.h, s.cycleId);
  });
});

describe('readGoalReviewReport', () => {
  const ready = async (report: Report) => {
    const h = harness({ tune });
    await h.start();
    const created = createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: 'periodic',
      triggerCode: 't',
    });
    if (!created.created) throw new Error('cycle');
    await h.until('review_run_started');
    const runId = reviewRunId(h);
    seedOutput(h, runId, report);
    h.setRunStatus(runId, 'completed');
    return { h, runId };
  };
  const finding = newFinding({ description: 'Distinct problem' });

  it('returns the validated report and links each new finding to this run only', async () => {
    const { h, runId } = await ready(reportOf({ verdict: 'pass_with_findings', newFindings: [finding] }));
    const read = readGoalReviewReport(h.fx.db, runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.report.verdict).toBe('pass_with_findings');
    const row = h.fx.db
      .prepare('SELECT run_id FROM review_findings WHERE id = ?')
      .get(read.runFindingIds.new[0]!) as {
      run_id: string;
    };
    expect(row.run_id).toBe(runId);
  });

  it('never links a row of another run, and refuses a mismatching severity or a reused row', async () => {
    const { h, runId } = await ready(reportOf({ verdict: 'pass_with_findings', newFindings: [finding] }));
    // Move the only matching row to another run: this run now has no counterpart.
    const other = randomUUID();
    h.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
         SELECT ?, machine_id, project_id, workflow_id, '{}', 'p', 'economy', 'normal', 'completed', created_at FROM runs WHERE id = ?`,
      )
      .run(other, runId);
    const stage = randomUUID();
    h.fx.db
      .prepare(
        "INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status) VALUES (?, ?, 'k', 'review', 'R', 0, 'passed')",
      )
      .run(stage, other);
    h.fx.db.prepare('UPDATE review_findings SET run_id = ?, stage_id = ?').run(other, stage);
    expect(readGoalReviewReport(h.fx.db, runId)).toEqual({ ok: false, code: 'report_finding_unmatched' });
    h.fx.db.prepare('UPDATE review_findings SET run_id = ?').run(runId);
    h.fx.db
      .prepare(
        "UPDATE review_findings SET stage_id = (SELECT id FROM stages WHERE run_id = ? AND kind = 'consolidate')",
      )
      .run(runId);
    expect(readGoalReviewReport(h.fx.db, runId).ok).toBe(true);
    h.fx.db.prepare("UPDATE review_findings SET severity = 'low'").run();
    expect(readGoalReviewReport(h.fx.db, runId)).toEqual({ ok: false, code: 'report_finding_mismatch' });
  });

  it('refuses a non-review run, a failed consolidate stage and oversize output before parsing', async () => {
    const { h, runId } = await ready(reportOf({ verdict: 'pass' }));
    expect(readGoalReviewReport(h.fx.db, 'ghost')).toEqual({ ok: false, code: 'review_run_invalid' });
    h.fx.db.prepare("UPDATE stages SET status = 'failed' WHERE run_id = ?").run(runId);
    expect(readGoalReviewReport(h.fx.db, runId)).toEqual({ ok: false, code: 'consolidate_not_passed' });
    h.fx.db
      .prepare("UPDATE stages SET status = 'passed', output_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ text: 'x'.repeat(300_000) }), runId);
    expect(readGoalReviewReport(h.fx.db, runId)).toEqual({ ok: false, code: 'report_oversize' });
    h.fx.db.prepare('UPDATE stages SET output_json = NULL WHERE run_id = ?').run(runId);
    expect(readGoalReviewReport(h.fx.db, runId)).toEqual({ ok: false, code: 'report_output_missing' });
    // A run that is not completed is not read either.
    h.fx.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    expect(readGoalReviewReport(h.fx.db, runId)).toEqual({ ok: false, code: 'review_run_invalid' });
  });
});

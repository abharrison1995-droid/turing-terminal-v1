import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import { advanceGoalRef, recoverIntegrationOps } from '../goalGit.js';
import { cancelQueuedRun } from '../runLauncher.js';
import { decideFinding } from './findings.js';
import { openFinding, reviewWith } from './remediationKit.js';
import { readRemediationPlan, remediationObservationKey } from './remediationPlan.js';
import { determineRemediationPlan } from './remediationSelector.js';
import { loadDefinitionVersion } from './definitions.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILT_IN = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
};

function goal(
  options: {
    autoAnswer?: boolean;
    tune?: (definition: GoalDefinition) => void;
    proposalWorktrees?: boolean;
  } = {},
): Harness {
  return harness({
    ...(options.autoAnswer === undefined ? {} : { autoAnswer: options.autoAnswer }),
    ...(options.proposalWorktrees ? { proposalWorktrees: true } : {}),
    tune: (definition) => {
      definition.routing.workflows = { ...BUILT_IN };
      options.tune?.(definition);
    },
  });
}

const setActive = (h: Harness, key: string | null) =>
  h.fx.db
    .prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?')
    .run(key === null ? null : h.fx.milestoneId(key), h.fx.goalId);

const cycles = (h: Harness) =>
  h.fx.db
    .prepare(
      'SELECT id, kind, status, outcome_json AS o FROM goal_cycles WHERE goal_id = ? ORDER BY sequence',
    )
    .all(h.fx.goalId) as Array<{ id: string; kind: string; status: string; o: string | null }>;
const outcome = (row: { o: string | null }) =>
  row.o ? (JSON.parse(row.o) as Record<string, unknown>) : null;
const queuedRuns = (h: Harness) =>
  (h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get() as { n: number }).n;
const runStatus = (h: Harness, id: string) =>
  (h.fx.db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string }).status;
const appliedAdvances = (h: Harness) =>
  (
    h.fx.db
      .prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance' AND status = 'applied'")
      .get() as { n: number }
  ).n;
const findingStatus = (h: Harness, id: string) =>
  (h.fx.db.prepare('SELECT status FROM goal_findings WHERE id = ?').get(id) as { status: string }).status;

const decide = (h: Harness, findingId: string) =>
  decideFinding(h.fx.db, {
    goalId: h.fx.goalId,
    findingId,
    decision: 'dismissed_by_user',
    actor: 'user',
    approvalId: h.fx.approval('finding_decision', {
      findingId,
      decision: 'dismissed_by_user',
      definitionVersion: 1,
      definitionHash: h.fx.currentHash(),
    }),
  });

async function tickUntil(h: Harness, action: string, max = 12): Promise<void> {
  for (let i = 0; i < max; i += 1) if ((await h.tick()) === action) return;
  throw new Error(`never reached ${action}`);
}

/** A started Goal with one open high finding on m1 and a freshly scheduled remediation cycle. */
async function scheduled(options: Parameters<typeof goal>[0] = {}) {
  const h = goal(options);
  await h.start();
  setActive(h, 'm1');
  const finding = await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
  await tickUntil(h, 'cycle_created');
  expect(await h.tick()).toBe('proposal_started'); // planned → proposing; nothing is queued yet
  return { h, finding };
}

describe('cancelQueuedRun', () => {
  const insertRun = (h: Harness, status: string) => {
    const id = randomUUID();
    h.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
         VALUES (?, (SELECT id FROM machines LIMIT 1), ?, (SELECT id FROM workflows LIMIT 1), '{}', 'p', 'economy', 'normal', ?, ?)`,
      )
      .run(id, h.fx.projectId, status, new Date().toISOString());
    for (const [index, stageStatus] of ['pending', 'skipped', 'pending'].entries())
      h.fx.db
        .prepare(
          "INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status) VALUES (?, ?, ?, 'build', 'S', ?, ?)",
        )
        .run(randomUUID(), id, `k${index}`, index, stageStatus);
    return id;
  };

  it(
    'cancels only a queued run: pending stages cancelled, skipped kept, completion and a bounded event persisted',
    async () => {
      const h = goal();
      const id = insertRun(h, 'queued');
      expect(cancelQueuedRun(h.fx.db, id, 'x'.repeat(500))).toEqual({ cancelled: true });
      expect(h.fx.db.prepare('SELECT status, completed_at FROM runs WHERE id = ?').get(id)).toMatchObject({
        status: 'cancelled',
      });
      expect(
        (h.fx.db.prepare('SELECT completed_at AS c FROM runs WHERE id = ?').get(id) as { c: string | null })
          .c,
      ).toBeTruthy();
      expect(
        (
          h.fx.db.prepare('SELECT status FROM stages WHERE run_id = ? ORDER BY sequence').all(id) as Array<{
            status: string;
          }>
        ).map((row) => row.status),
      ).toEqual(['cancelled', 'skipped', 'cancelled']);
      const event = h.fx.db
        .prepare("SELECT payload_json AS p FROM run_events WHERE run_id = ? AND type = 'run_cancelled'")
        .get(id) as {
        p: string;
      };
      expect(JSON.parse(event.p).reason).toHaveLength(200);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['preparing', 'running', 'waiting_for_approval', 'paused', 'completed', 'failed', 'cancelled'])(
    'never touches a %s run',
    async (status) => {
      const h = goal();
      const id = insertRun(h, status);
      expect(cancelQueuedRun(h.fx.db, id, 'r')).toEqual({ cancelled: false, reason: 'not-queued' });
      expect(runStatus(h, id)).toBe(status);
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM stages WHERE run_id = ? AND status = 'cancelled'").get(id),
      ).toEqual({ n: 0 });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(id)).toEqual({
        n: 0,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a missing run',
    () => {
      const h = goal();
      expect(cancelQueuedRun(h.fx.db, 'nope', 'r')).toEqual({ cancelled: false, reason: 'not-found' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('a queued remediation run is not start authority', () => {
  it(
    'a queued proposal never starts once its finding is decided; the run and cycle retire together',
    async () => {
      const { h, finding } = await scheduled();
      expect(await h.tick()).toBe('proposal_queued');
      const [proposal] = h.proposalRuns();
      expect(proposal!.status).toBe('queued');
      const head = h.fx.head();
      decide(h, finding);
      expect(await h.tick()).toBe('remediation_retired');
      expect(runStatus(h, proposal!.id)).toBe('cancelled');
      expect(queuedRuns(h)).toBe(0);
      expect(cycles(h)[0]).toMatchObject({ status: 'cancelled' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'remediation_no_longer_current' });
      expect(h.startRun).not.toHaveBeenCalled();
      expect(h.model.calls).toBe(0);
      expect(h.runs()).toHaveLength(0);
      expect(h.fx.head()).toBe(head);
      expect(findingStatus(h, finding)).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a queued remediation work run never starts once its finding is decided',
    async () => {
      const { h, finding } = await scheduled();
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await tickUntil(h, 'run_queued');
      const [work] = h.runs();
      expect(work!.status).toBe('queued');
      const startsBefore = h.startRun.mock.calls.length;
      const head = h.fx.head();
      decide(h, finding);
      expect(await h.tick()).toBe('remediation_retired');
      expect(runStatus(h, work!.id)).toBe('cancelled');
      expect(queuedRuns(h)).toBe(0);
      expect(h.startRun.mock.calls).toHaveLength(startsBefore);
      expect(cycles(h)[0]).toMatchObject({ status: 'cancelled' });
      expect(appliedAdvances(h)).toBe(0);
      expect(h.fx.head()).toBe(head);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the run cancellation and cycle retirement are atomic: a failing cycle transition rolls the run cancel back',
    async () => {
      const { h, finding } = await scheduled();
      await h.tick(); // proposal queued
      const [proposal] = h.proposalRuns();
      decide(h, finding);
      h.fx.db.exec(
        `CREATE TRIGGER fail_cycle_cancel BEFORE UPDATE ON goal_cycles WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
      await expect(h.tick()).rejects.toThrow();
      h.fx.db.exec('DROP TRIGGER fail_cycle_cancel');
      expect(runStatus(h, proposal!.id)).toBe('queued');
      expect(cycles(h)[0]!.status).toBe('proposing');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a corrupt plan with a queued run cancels the run and fails the cycle closed',
    async () => {
      for (const tamper of ['hash', 'version', 'unknown'] as const) {
        const { h } = await scheduled();
        await h.tick();
        const [proposal] = h.proposalRuns();
        const cycle = cycles(h)[0]!;
        const plan = readRemediationPlan(outcome(cycle))! as unknown as {
          episodes: Array<Record<string, unknown>>;
        } & Record<string, unknown>;
        const bad =
          tamper === 'hash'
            ? { ...plan, episodes: [{ ...plan.episodes[0], episodeKey: 'a'.repeat(64) }] }
            : tamper === 'version'
              ? { ...plan, definitionVersion: 2 }
              : { ...plan, episodes: [{ ...plan.episodes[0], findingId: randomUUID() }] };
        h.fx.db
          .prepare('UPDATE goal_cycles SET outcome_json = ? WHERE id = ?')
          .run(JSON.stringify({ remediationPlan: bad }), cycle.id);
        expect(await h.tick()).toBe('cycle_failed');
        expect(cycles(h)[0]).toMatchObject({ status: 'failed' });
        expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'remediation_plan_invalid' });
        expect(runStatus(h, proposal!.id)).toBe('cancelled');
        expect(queuedRuns(h)).toBe(0);
        expect(h.startRun).not.toHaveBeenCalled();
        expect(h.model.calls).toBe(0);
        cleanupRepoFixtures();
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'ordinary execution keeps its queued-run semantics regardless of Goal findings',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      await openFinding(h.fx, 'low');
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await tickUntil(h, 'run_queued');
      expect(cycles(h)[0]!.kind).toBe('execution');
      await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
      expect(await h.tick()).toBe('run_started');
      expect(h.runs()[0]!.status).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('a finished or running remediation is re-proved before it gains authority', () => {
  it(
    'a completed proposal is not consumed when its finding was decided while it ran',
    async () => {
      const { h, finding } = await scheduled({ autoAnswer: false });
      await h.tick(); // queued
      expect(await h.tick()).toBe('proposal_run_started');
      const [proposal] = h.proposalRuns();
      expect(proposal!.status).toBe('running'); // active runs are not force-cancelled
      decide(h, finding);
      expect(runStatus(h, proposal!.id)).toBe('running');
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      h.answerProposal(proposal!.id);
      h.setRunStatus(proposal!.id, 'completed');
      expect(await h.tick()).toBe('remediation_retired');
      expect(cycles(h)[0]).toMatchObject({ status: 'cancelled' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'remediation_no_longer_current' });
      expect(h.runs()).toHaveLength(0);
      expect(h.executor.queueCalls).toHaveLength(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a completed remediation run does not advance the Goal ref when its finding was decided while it ran',
    async () => {
      const { h, finding } = await scheduled();
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await tickUntil(h, 'run_started');
      const work = h.runs()[0]!;
      const head = h.fx.head();
      decide(h, finding);
      h.files.current = { 'src/a.ts': 'export const a = 99;\n' };
      h.setRunStatus(work.id, 'completed');
      await tickUntil(h, 'remediation_retired');
      expect(h.fx.head()).toBe(head);
      expect(appliedAdvances(h)).toBe(0);
      expect(cycles(h)[0]).toMatchObject({ status: 'cancelled' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'remediation_no_longer_current' });
      expect(findingStatus(h, finding)).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('integration recovery keeps history honest', () => {
  async function crashed() {
    const { h, finding } = await scheduled();
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await tickUntil(h, 'run_started');
    const work = h.runs()[0]!;
    h.files.current = { 'src/a.ts': 'export const a = 7;\n' };
    h.setRunStatus(work.id, 'completed');
    await tickUntil(h, 'integration_started');
    const cycle = cycles(h)[0]!;
    const base = h.fx.head();
    await expect(
      advanceGoalRef(
        h.fx.db,
        { goalId: h.fx.goalId, cycleId: cycle.id, runId: work.id, expectedHead: base },
        {},
        {
          beforeCas: () => {
            throw new Error('crash');
          },
        },
      ),
    ).rejects.toThrow('crash');
    const op = h.fx.db
      .prepare("SELECT id, new_commit FROM goal_integration_ops WHERE status = 'planned'")
      .get() as {
      id: string;
      new_commit: string;
    };
    return { h, finding, base, op };
  }

  it(
    'planned op, CAS not done, finding decided once recovery released it: nothing advances, cycle retires',
    async () => {
      const { h, finding, base, op } = await crashed();
      // (While the op is planned the decision is refused, so recovery runs first.)
      await recoverIntegrationOps(h.fx.db, h.fx.goalId);
      decide(h, finding);
      const results = await h.supervisor.reconcile();
      expect(results.map((result) => result.action)).toEqual(['remediation_retired']);
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(base);
      expect(h.fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(op.id)).toEqual({
        status: 'aborted',
      });
      expect(appliedAdvances(h)).toBe(0);
      expect(cycles(h)[0]).toMatchObject({ status: 'cancelled' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'planned op, CAS already done, finding decided after recovery applied it: the op stays applied and the cycle is integrated',
    async () => {
      const { h, finding, base, op } = await crashed();
      h.fx.git('update-ref', `refs/heads/turing/goal/${h.fx.goalId}`, op.new_commit, base);
      await recoverIntegrationOps(h.fx.db, h.fx.goalId);
      decide(h, finding);
      const results = await h.supervisor.reconcile();
      expect(results.map((result) => result.action)).toEqual(['cycle_succeeded']);
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(op.new_commit);
      expect(cycles(h)[0]).toMatchObject({ status: 'succeeded' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'integrated' });
      expect(h.fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(op.id)).toEqual({
        status: 'applied',
      });
      expect(findingStatus(h, finding)).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('observation-level consumption', () => {
  const select = (h: Harness) => {
    const v = loadDefinitionVersion(h.fx.db, h.fx.goalId, 1)!;
    return determineRemediationPlan(h.fx.db, h.fx.goalId, {
      definition: v.definition as GoalDefinition,
      version: 1,
      tree: h.fx.tree(),
    });
  };

  it(
    'a consumed broad-review observation is neither re-anchored to another milestone nor reported unavailable',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const finding = await openFinding(h.fx, 'high', { kind: 'final' });
      await tickUntil(h, 'cycle_created');
      expect(readRemediationPlan(outcome(cycles(h)[0]!))!.milestoneKey).toBe('m1');
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await tickUntil(h, 'run_started');
      h.files.current = { 'src/a.ts': 'export const a = 3;\n' };
      h.setRunStatus(h.runs()[0]!.id, 'completed');
      await tickUntil(h, 'cycle_succeeded');
      expect(select(h)).toEqual({ ok: true, plan: null });
      setActive(h, 'm2');
      expect(select(h)).toEqual({ ok: true, plan: null });
      setActive(h, null);
      expect(select(h)).toEqual({ ok: true, plan: null });
      // The same observation keeps its stable, milestone-free identity.
      const plan = readRemediationPlan(outcome(cycles(h)[0]!))!;
      expect(
        remediationObservationKey({
          findingId: finding,
          lastSeenReviewId: plan.episodes[0]!.lastSeenReviewId,
          definitionVersion: 1,
        }),
      ).toMatch(/^[0-9a-f]{64}$/);

      // A later review that still sees the finding is a new observation and may be anchored again.
      setActive(h, 'm2');
      await reviewWith(h.fx, { kind: 'final', existing: [{ goalFindingId: finding, status: 'still_open' }] });
      const next = select(h);
      expect(next.ok && next.plan).toMatchObject({ milestoneKey: 'm2', episodes: [{ findingId: finding }] });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a new definition version is a new epoch for the same review observation',
    async () => {
      const h = goal();
      await h.start();
      const finding = await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
      const [first] = (select(h) as { plan: { episodes: Array<{ lastSeenReviewId: string }> } }).plan
        .episodes;
      const k1 = remediationObservationKey({
        findingId: finding,
        lastSeenReviewId: first!.lastSeenReviewId,
        definitionVersion: 1,
      });
      const k2 = remediationObservationKey({
        findingId: finding,
        lastSeenReviewId: first!.lastSeenReviewId,
        definitionVersion: 2,
      });
      expect(k1).not.toBe(k2);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('dynamic actionability', () => {
  it(
    'a medium-threshold plan retires when another decision shrinks the deterministic excess, and the next plan is smaller',
    async () => {
      const h = goal({
        tune: (definition) => {
          definition.contract.completionPolicy.maxOpenFindings = { critical: 0, high: 0, medium: 1 };
        },
      });
      await h.start();
      setActive(h, 'm1');
      const a = await openFinding(h.fx, 'medium', { kind: 'milestone', milestone: 'm1' });
      const b = await openFinding(h.fx, 'medium', { kind: 'milestone', milestone: 'm1' });
      const c = await openFinding(h.fx, 'medium', { kind: 'milestone', milestone: 'm1' });
      await tickUntil(h, 'cycle_created');
      const plan = readRemediationPlan(outcome(cycles(h)[0]!))!;
      expect(plan.episodes).toHaveLength(2);
      const selected = new Set(plan.episodes.map((episode) => episode.findingId));
      const other = [a, b, c].find((id) => !selected.has(id))!;
      decide(h, other);
      await tickUntil(h, 'remediation_retired');
      expect(h.startRun).not.toHaveBeenCalled();
      expect(h.model.calls).toBe(0);
      expect(queuedRuns(h)).toBe(0);
      await tickUntil(h, 'cycle_created');
      const next = readRemediationPlan(outcome(cycles(h)[1]!))!;
      expect(next.episodes).toHaveLength(1);
      expect(selected.has(next.episodes[0]!.findingId)).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the persisted target milestone does not move when the active milestone changes',
    async () => {
      const { h } = await scheduled();
      setActive(h, 'm2');
      expect(await h.tick()).toBe('proposal_queued');
      expect(readRemediationPlan(outcome(cycles(h)[0]!))!.milestoneKey).toBe('m1');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

import { afterEach, describe, expect, it } from 'vitest';
import { advanceGoalRef, recoverIntegrationOps } from '../goalGit.js';
import { decideFinding, GoalFindingError } from './findings.js';
import { reviewWith } from './remediationKit.js';
import { readRemediationPlan } from './remediationPlan.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILT_IN = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
};

const cycles = (h: Harness) =>
  h.fx.db
    .prepare('SELECT id, status, outcome_json AS o FROM goal_cycles WHERE goal_id = ? ORDER BY sequence')
    .all(h.fx.goalId) as Array<{ id: string; status: string; o: string | null }>;
const outcome = (row: { o: string | null }) =>
  row.o ? (JSON.parse(row.o) as Record<string, unknown>) : null;
const opCount = (h: Harness, status: string) =>
  (
    h.fx.db
      .prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance' AND status = ?")
      .get(status) as { n: number }
  ).n;
const opStatus = (h: Harness) =>
  (
    h.fx.db
      .prepare("SELECT status FROM goal_integration_ops WHERE op = 'advance' ORDER BY created_at DESC")
      .get() as { status: string } | undefined
  )?.status;
const findingStatus = (h: Harness, id: string) =>
  (h.fx.db.prepare('SELECT status FROM goal_findings WHERE id = ?').get(id) as { status: string }).status;
const goalRef = (h: Harness) => h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`);

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
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof GoalFindingError ? error.code : `other:${String(error)}`;
  }
};

async function tickUntil(h: Harness, action: string, max = 12): Promise<void> {
  for (let i = 0; i < max; i += 1) if ((await h.tick()) === action) return;
  throw new Error(`never reached ${action}`);
}

/** A started Goal whose remediation cycle targets `high` highs (plus `low` unrelated lows) and has a finished work run. */
async function atIntegration(high = 1, low = 0) {
  const h = harness({
    tune: (definition) => {
      definition.routing.workflows = { ...BUILT_IN };
    },
  });
  await h.start();
  h.fx.db
    .prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?')
    .run(h.fx.milestoneId('m1'), h.fx.goalId);
  const { opened } = await reviewWith(h.fx, {
    kind: 'milestone',
    milestone: 'm1',
    findings: [
      ...Array.from({ length: high }, () => ({ severity: 'high' as const })),
      ...Array.from({ length: low }, () => ({ severity: 'low' as const })),
    ],
  });
  const targets = opened.slice(0, high);
  const others = opened.slice(high);
  await tickUntil(h, 'cycle_created');
  expect(await h.tick()).toBe('proposal_started');
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await tickUntil(h, 'run_started');
  const work = h.runs()[0]!;
  h.files.current = { 'src/a.ts': 'export const a = 5;\n' };
  h.setRunStatus(work.id, 'completed');
  await tickUntil(h, 'integration_started');
  const cycle = cycles(h)[0]!;
  expect(
    readRemediationPlan(outcome(cycle))!
      .episodes.map((episode) => episode.findingId)
      .sort(),
  ).toEqual([...targets].sort());
  return { h, targets, others, work, cycle };
}

describe('late pre-plan-persist authority', () => {
  it(
    'a decision committed after the async Git checks but before the planned op wins: no op, no CAS, cycle retired',
    async () => {
      const { h, targets } = await atIntegration();
      const head = goalRef(h);
      h.integrationHooks.beforePlanAuthorityCheck = () => {
        decide(h, targets[0]!);
      };
      expect(await h.tick()).toBe('remediation_retired');
      expect(opCount(h, 'planned')).toBe(0);
      expect(opCount(h, 'applied')).toBe(0);
      expect(goalRef(h)).toBe(head);
      expect(cycles(h)[0]).toMatchObject({ status: 'cancelled' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'remediation_no_longer_current' });
      expect(findingStatus(h, targets[0]!)).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a rejecting authority callback leaves no op row, no CAS and a bounded message',
    async () => {
      const { h, work, cycle } = await atIntegration();
      const base = h.fx.head();
      const input = { goalId: h.fx.goalId, cycleId: cycle.id, runId: work.id, expectedHead: base };
      const rejected = await advanceGoalRef(
        h.fx.db,
        input,
        {},
        {},
        {
          beforePlanPersist: () => ({
            ok: false,
            code: 'remediation_plan_invalid',
            message: 'x'.repeat(500),
          }),
        },
      );
      expect(rejected).toMatchObject({ outcome: 'rejected', code: 'remediation_plan_invalid' });
      expect((rejected as { message: string }).message).toHaveLength(200);
      expect(opCount(h, 'planned') + opCount(h, 'applied') + opCount(h, 'failed')).toBe(0);
      expect(goalRef(h)).toBe(base);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'without an authority callback an advance behaves exactly as before',
    async () => {
      const { h, work, cycle } = await atIntegration();
      const input = { goalId: h.fx.goalId, cycleId: cycle.id, runId: work.id, expectedHead: h.fx.head() };
      expect(await advanceGoalRef(h.fx.db, input)).toMatchObject({ outcome: 'advanced' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a corrupt plan reaching the late check fails the cycle closed as remediation_plan_invalid',
    async () => {
      const { h, cycle } = await atIntegration();
      const head = goalRef(h);
      h.integrationHooks.beforePlanAuthorityCheck = () => {
        const o = outcome(cycles(h)[0]!)!;
        (o.remediationPlan as { milestoneKey: string }).milestoneKey = 'tampered';
        h.fx.db
          .prepare('UPDATE goal_cycles SET outcome_json = ? WHERE id = ?')
          .run(JSON.stringify(o), cycle.id);
      };
      await h.tick();
      expect(opCount(h, 'planned') + opCount(h, 'applied')).toBe(0);
      expect(goalRef(h)).toBe(head);
      expect(cycles(h)[0]).toMatchObject({ status: 'failed' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'remediation_plan_invalid' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('planned op is the linearization point', () => {
  it(
    'planned op wins: decision refused during beforeCas, CAS proceeds, retry succeeds afterwards',
    async () => {
      const { h, targets } = await atIntegration();
      let during: string | null = 'unset';
      h.integrationHooks.beforeCas = () => {
        expect(opStatus(h)).toBe('planned');
        during = codeOf(() => decide(h, targets[0]!));
        expect(findingStatus(h, targets[0]!)).toBe('open');
      };
      expect(await h.tick()).toBe('cycle_succeeded');
      expect(during).toBe('finding_integration_in_progress');
      expect(opStatus(h)).toBe('applied');
      expect(cycles(h)[0]).toMatchObject({ status: 'succeeded' });
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'integrated' });
      expect(codeOf(() => decide(h, targets[0]!))).toBeNull();
      expect(findingStatus(h, targets[0]!)).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a crash before the CAS: recovery aborts the op, then a decision defeats the re-integration',
    async () => {
      const { h, targets } = await atIntegration();
      const base = h.fx.head();
      h.integrationHooks.beforeCas = () => {
        h.integrationHooks.beforeCas = undefined;
        throw new Error('crash before supervisor finalises');
      };
      await expect(h.tick()).rejects.toThrow('crash');
      // CAS has not happened; recovery aborts the op and the user decision defeats the next integration.
      await recoverIntegrationOps(h.fx.db, h.fx.goalId);
      decide(h, targets[0]!);
      expect(await h.tick()).toBe('remediation_retired');
      expect(goalRef(h)).toBe(base);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an unrelated finding stays decidable while the target is locked',
    async () => {
      const { h, targets, others } = await atIntegration(1, 1);
      const seen: Record<string, string | null> = {};
      h.integrationHooks.beforeCas = () => {
        seen.target = codeOf(() => decide(h, targets[0]!));
        seen.other = codeOf(() => decide(h, others[0]!));
      };
      expect(await h.tick()).toBe('cycle_succeeded');
      expect(seen).toEqual({ target: 'finding_integration_in_progress', other: null });
      expect(findingStatus(h, others[0]!)).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'every finding of a multi-finding plan is locked, not just the first',
    async () => {
      const { h, targets, others } = await atIntegration(3, 1);
      const seen: Array<string | null> = [];
      h.integrationHooks.beforeCas = () => {
        for (const id of targets) seen.push(codeOf(() => decide(h, id)));
        seen.push(codeOf(() => decide(h, others[0]!)));
      };
      expect(await h.tick()).toBe('cycle_succeeded');
      expect(seen).toEqual([
        'finding_integration_in_progress',
        'finding_integration_in_progress',
        'finding_integration_in_progress',
        null,
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a CAS failure releases the lock',
    async () => {
      const { h, targets } = await atIntegration();
      const base = h.fx.head();
      h.integrationHooks.beforeCas = () => {
        expect(codeOf(() => decide(h, targets[0]!))).toBe('finding_integration_in_progress');
        const other = h.fx.git('commit-tree', h.fx.tree(), '-p', base, '-m', 'moved');
        h.fx.git('update-ref', `refs/heads/turing/goal/${h.fx.goalId}`, other, base);
      };
      expect(await h.tick()).toBe('integration_blocked');
      expect(opStatus(h)).toBe('failed');
      expect(codeOf(() => decide(h, targets[0]!))).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a lock never exists before the planned op: running work does not block a decision, and it defeats integration',
    async () => {
      const h = harness({
        tune: (definition) => {
          definition.routing.workflows = { ...BUILT_IN };
        },
      });
      await h.start();
      h.fx.db
        .prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?')
        .run(h.fx.milestoneId('m1'), h.fx.goalId);
      const { opened } = await reviewWith(h.fx, {
        kind: 'milestone',
        milestone: 'm1',
        findings: [{ severity: 'high' }],
      });
      await tickUntil(h, 'cycle_created');
      expect(codeOf(() => decide(h, opened[0]!))).toBeNull();
      expect(opCount(h, 'planned')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an ordinary execution advance does not lock any finding',
    async () => {
      const h = harness();
      await h.start();
      await tickUntil(h, 'cycle_created');
      expect(await h.tick()).toBe('proposal_started');
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await tickUntil(h, 'run_started');
      h.files.current = { 'src/a.ts': 'export const a = 5;\n' };
      h.setRunStatus(h.runs()[0]!.id, 'completed');
      await tickUntil(h, 'integration_started');
      const { opened } = await reviewWith(h.fx, { kind: 'periodic', findings: [{ severity: 'low' }] });
      let during: string | null = 'unset';
      h.integrationHooks.beforeCas = () => {
        expect(opStatus(h)).toBe('planned');
        during = codeOf(() => decide(h, opened[0]!));
      };
      expect(await h.tick()).toBe('cycle_succeeded');
      expect(during).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('crashed planned op', () => {
  async function crashed() {
    const fixture = await atIntegration();
    const { h, work, cycle } = fixture;
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
    return { ...fixture, base, op };
  }

  it(
    'stays locked until recovery; CAS not done → aborted → decision succeeds',
    async () => {
      const { h, targets, op } = await crashed();
      expect(codeOf(() => decide(h, targets[0]!))).toBe('finding_integration_in_progress');
      await recoverIntegrationOps(h.fx.db, h.fx.goalId);
      expect(h.fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(op.id)).toEqual({
        status: 'aborted',
      });
      expect(codeOf(() => decide(h, targets[0]!))).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'CAS already done → recovery applies it → decision succeeds and history stays integrated',
    async () => {
      const { h, targets, base, op } = await crashed();
      h.fx.git('update-ref', `refs/heads/turing/goal/${h.fx.goalId}`, op.new_commit, base);
      expect(codeOf(() => decide(h, targets[0]!))).toBe('finding_integration_in_progress');
      await recoverIntegrationOps(h.fx.db, h.fx.goalId);
      expect(h.fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(op.id)).toEqual({
        status: 'applied',
      });
      expect(codeOf(() => decide(h, targets[0]!))).toBeNull();
      const results = await h.supervisor.reconcile();
      expect(results.map((result) => result.action)).toEqual(['cycle_succeeded']);
      expect(outcome(cycles(h)[0]!)).toMatchObject({ code: 'integrated' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a corrupt plan on a planned op locks nothing',
    async () => {
      const { h, targets, cycle } = await crashed();
      h.fx.db.prepare("UPDATE goal_cycles SET outcome_json = '{not json' WHERE id = ?").run(cycle.id);
      expect(codeOf(() => decide(h, targets[0]!))).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

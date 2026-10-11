import { afterEach, describe, expect, it } from 'vitest';
import { createCycle, finalizeCycle, transitionCycle } from './cycles.js';
import { applyReviewFindings } from './findings.js';
import {
  buildGoalMemory,
  compactMemory,
  GoalMemoryError,
  MEMORY_LIMITS,
  memoryTokens,
  rebuildGoalMemory,
} from './memory.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  milestone,
  newFinding,
  reportOf,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { completeReview, createReview } from './reviews.js';

afterEach(cleanupRepoFixtures);

function running() {
  const definition = simpleDefinition({
    milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])],
  });
  definition.limits.maxExecutionCycles = 200;
  definition.limits.maxConsecutiveFailedCycles = 20;
  const fx = goalRepoFixture({ definition });
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  return fx;
}
type Fx = ReturnType<typeof running>;
const task = (rationale: string) => ({
  milestoneKey: 'm1',
  title: 't',
  instructions: 'i',
  targetCriteria: ['build'],
  expectedPaths: ['src/a.ts'],
  rationale,
});
function cycleWith(
  fx: Fx,
  to: 'succeeded' | 'failed',
  detail: Record<string, unknown> = {},
  rationale = 'because',
) {
  const created = createCycle(fx.db, {
    goalId: fx.goalId,
    kind: 'execution',
    triggerCode: 't',
    milestoneKey: 'm1',
  });
  if (!created.created) throw new Error('active');
  const id = created.cycle.id;
  transitionCycle(fx.db, { cycleId: id, to: 'proposing' });
  transitionCycle(fx.db, { cycleId: id, to: 'proposed', validatedTask: task(rationale) });
  if (to === 'succeeded')
    for (const s of ['launching', 'running', 'collecting', 'integrating'] as const)
      transitionCycle(fx.db, { cycleId: id, to: s });
  finalizeCycle(fx.db, {
    cycleId: id,
    to,
    outcomeCode: to === 'succeeded' ? 'integrated' : 'run_failed',
    detail,
  });
  return id;
}

describe('GoalMemory', () => {
  it(
    'is rebuilt from persisted state with the documented structure',
    () => {
      const fx = running();
      fx.db
        .prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?')
        .run(fx.milestoneId('m1'), fx.goalId);
      cycleWith(fx, 'succeeded', { summary: 'Added the parser', changedFiles: ['src/a.ts', 'src/b.ts'] });
      const memory = rebuildGoalMemory(fx.db, fx.goalId);
      expect(memory).toMatchObject({
        schemaVersion: 1,
        definition: { version: 1, hash: fx.currentHash() },
        activeMilestone: { key: 'm1', unresolvedCriteria: ['build'] },
        lastCycle: {
          sequence: 1,
          kind: 'execution',
          outcome: 'integrated',
          summary: 'Added the parser',
          changedFiles: ['src/a.ts', 'src/b.ts'],
        },
        decisions: [{ text: 'because', cycle: 1 }],
        repo: { baseBranch: 'main', integrationHead: fx.head() },
      });
      const stored = fx.db
        .prepare('SELECT memory_json FROM goal_runtime WHERE goal_id = ?')
        .get(fx.goalId) as {
        memory_json: string;
      };
      expect(JSON.parse(stored.memory_json)).toEqual(memory);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is a cache: deleting it changes nothing, and a rebuild reproduces the same content',
    () => {
      const fx = running();
      cycleWith(fx, 'failed', { summary: 'nope' });
      const first = rebuildGoalMemory(fx.db, fx.goalId, { now: '2026-02-02T00:00:00.000Z' });
      fx.db.prepare("UPDATE goal_runtime SET memory_json = '{}' WHERE goal_id = ?").run(fx.goalId);
      expect(rebuildGoalMemory(fx.db, fx.goalId, { now: '2026-02-02T00:00:00.000Z' })).toEqual(first);
      expect(first.blockers).toContain('cycle 1: run_failed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'caps summary, changed files, decisions, findings and blockers and drops transcripts',
    () => {
      const fx = running();
      for (let index = 0; index < 25; index++)
        cycleWith(
          fx,
          index % 2 ? 'failed' : 'succeeded',
          {
            summary: 'x'.repeat(2_000),
            changedFiles: Array.from({ length: 60 }, (_, n) => `src/f${n}.ts`),
            transcript: 'SECRET TRANSCRIPT '.repeat(100),
          },
          'r'.repeat(900),
        );
      const memory = buildGoalMemory(fx.db, fx.goalId);
      expect(memory.lastCycle!.summary.length).toBeLessThanOrEqual(MEMORY_LIMITS.summaryChars);
      expect(memory.lastCycle!.changedFiles.length).toBeLessThanOrEqual(MEMORY_LIMITS.changedFiles);
      expect(memory.decisions.length).toBeLessThanOrEqual(MEMORY_LIMITS.decisions);
      expect(memory.decisions.every((d) => d.text.length <= MEMORY_LIMITS.decisionChars)).toBe(true);
      expect(memory.blockers.length).toBeLessThanOrEqual(MEMORY_LIMITS.blockers);
      expect(JSON.stringify(memory)).not.toContain('TRANSCRIPT');
      expect(memoryTokens(memory)).toBeLessThanOrEqual(MEMORY_LIMITS.estimatedTokens);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'lists open findings by severity, capped at 25',
    async () => {
      const fx = running();
      const { id } = await createReview(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        reviewKind: 'final',
      });
      completeReview(fx.db, {
        reviewId: id,
        report: reportOf({
          verdict: 'pass_with_findings',
          newFindings: Array.from({ length: 30 }, (_, n) =>
            newFinding({ severity: n === 7 ? 'high' : 'low', category: `c${n}`, description: `d${n}` }),
          ),
        }),
      });
      await applyReviewFindings(fx.db, { reviewId: id });
      const memory = buildGoalMemory(fx.db, fx.goalId);
      expect(memory.openFindings).toHaveLength(MEMORY_LIMITS.openFindings);
      expect(memory.openFindings[0]!.severity).toBe('high');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'compacts deterministically: oldest decisions first, then milestones, statements, findings',
    () => {
      const fx = running();
      for (let index = 0; index < 8; index++)
        cycleWith(fx, 'failed', { summary: 's' }, `decision-${index} ${'z'.repeat(250)}`);
      const full = buildGoalMemory(fx.db, fx.goalId, { now: '2026-02-02T00:00:00.000Z' });
      const budget = memoryTokens(full) - 200;
      const compact = buildGoalMemory(fx.db, fx.goalId, { budget, now: '2026-02-02T00:00:00.000Z' });
      expect(memoryTokens(compact)).toBeLessThanOrEqual(budget);
      expect(compact.decisions.length).toBeLessThan(full.decisions.length);
      // The oldest decisions went first: what remains is the newest suffix.
      expect(compact.decisions.map((d) => d.cycle)).toEqual(
        full.decisions.slice(-compact.decisions.length).map((d) => d.cycle),
      );
      expect(buildGoalMemory(fx.db, fx.goalId, { budget, now: '2026-02-02T00:00:00.000Z' })).toEqual(compact);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails explicitly, rather than truncating, when the mandatory core does not fit',
    () => {
      const fx = running();
      cycleWith(fx, 'failed');
      expect(() => buildGoalMemory(fx.db, fx.goalId, { budget: 50 })).toThrowError(GoalMemoryError);
      const memory = buildGoalMemory(fx.db, fx.goalId);
      expect(() => compactMemory(memory, 10)).toThrow(/mandatory/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'marks criteria from a supplied evaluation and defaults to unmet',
    () => {
      const fx = running();
      const memory = buildGoalMemory(fx.db, fx.goalId, {
        criterionStates: new Map([['build', 'satisfied']]),
      });
      expect(memory.contractDigest.criteria.find((c) => c.key === 'build')!.status).toBe('satisfied');
      expect(memory.contractDigest.criteria.find((c) => c.key === 'tests')!.status).toBe('unmet');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

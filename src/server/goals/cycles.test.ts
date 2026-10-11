import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalCycleKind } from '../../shared/goals.js';
import {
  activeCycle,
  computeCounters,
  createCycle,
  CycleError,
  CYCLE_TERMINAL,
  finalizeCycle,
  legalCycleTransitions,
  listCycles,
  reconcileCounters,
  transitionCycle,
  type CycleStatus,
} from './cycles.js';
import { listGoalEvents } from './events.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  milestone,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';

afterEach(cleanupRepoFixtures);

function running(definition = simpleDefinition()) {
  const fx = goalRepoFixture({ definition });
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  return fx;
}
const ALL: CycleStatus[] = [
  'planned',
  'proposing',
  'proposed',
  'launching',
  'running',
  'collecting',
  'integrating',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
];
const counters = (fx: ReturnType<typeof running>) =>
  fx.db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(fx.goalId) as {
    cycles_executed: number;
    consecutive_failed_cycles: number;
    remediation_attempts_json: string;
  };
const make = (
  fx: ReturnType<typeof running>,
  kind: 'execution' | 'remediation' = 'execution',
  key = 'm1',
) => {
  const result = createCycle(fx.db, { goalId: fx.goalId, kind, triggerCode: 't', milestoneKey: key });
  if (!result.created) throw new Error('expected a new cycle');
  return result.cycle;
};
function walk(fx: ReturnType<typeof running>, cycleId: string, to: CycleStatus[]) {
  for (const status of to) transitionCycle(fx.db, { cycleId, to: status });
}
const finish = (
  fx: ReturnType<typeof running>,
  to: 'succeeded' | 'failed' | 'rejected' | 'cancelled',
  kind: 'execution' | 'remediation' = 'execution',
  key = 'm1',
) => {
  const cycle = make(fx, kind, key);
  if (to === 'rejected') walk(fx, cycle.id, ['proposing']);
  if (to === 'succeeded')
    walk(fx, cycle.id, ['proposing', 'proposed', 'launching', 'running', 'collecting', 'integrating']);
  finalizeCycle(fx.db, { cycleId: cycle.id, to, outcomeCode: to });
  return cycle;
};

describe('cycle transition matrix', () => {
  const expected: Record<GoalCycleKind, Partial<Record<CycleStatus, CycleStatus[]>>> = {
    execution: {
      planned: ['proposing'],
      proposing: ['proposed', 'rejected'],
      proposed: ['launching', 'rejected'],
      launching: ['running'],
      running: ['collecting'],
      collecting: ['integrating'],
      integrating: ['succeeded'],
    },
    remediation: {
      planned: ['proposing'],
      proposing: ['proposed', 'rejected'],
      proposed: ['launching', 'rejected'],
      launching: ['running'],
      running: ['collecting'],
      collecting: ['integrating'],
      integrating: ['succeeded'],
    },
    review: {
      planned: ['launching'],
      launching: ['running'],
      running: ['collecting'],
      collecting: ['succeeded'],
    },
    verification: {
      planned: ['launching'],
      launching: ['running'],
      running: ['collecting'],
      collecting: ['succeeded'],
    },
    authoring: {
      planned: ['proposing'],
      proposing: ['proposed', 'rejected'],
      proposed: ['succeeded', 'rejected'],
    },
  };

  it('allows exactly the per-kind forward path plus failed/cancelled, and nothing out of a terminal status', () => {
    for (const kind of Object.keys(expected) as GoalCycleKind[])
      for (const from of ALL) {
        const legal = legalCycleTransitions(kind, from);
        if (CYCLE_TERMINAL.includes(from)) {
          expect(legal, `${kind} ${from}`).toEqual([]);
          continue;
        }
        expect(new Set(legal), `${kind} ${from}`).toEqual(
          new Set([...(expected[kind][from] ?? []), 'failed', 'cancelled']),
        );
      }
  });

  it(
    'refuses every other edge, including skips and backwards moves, and leaves the row unchanged',
    () => {
      const fx = running();
      const cycle = make(fx);
      for (const to of ALL.filter((s) => !legalCycleTransitions('execution', 'planned').includes(s)))
        expect(() => transitionCycle(fx.db, { cycleId: cycle.id, to }), to).toThrowError(CycleError);
      expect(activeCycle(fx.db, fx.goalId)?.status).toBe('planned');
      walk(fx, cycle.id, ['proposing', 'proposed']);
      expect(() => transitionCycle(fx.db, { cycleId: cycle.id, to: 'planned' })).toThrowError(/cannot move/);
      expect(() => transitionCycle(fx.db, { cycleId: cycle.id, to: 'integrating' })).toThrowError(
        /cannot move/,
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps terminal cycles immutable in the application and in the database',
    () => {
      const fx = running();
      const cycle = finish(fx, 'failed');
      expect(() => transitionCycle(fx.db, { cycleId: cycle.id, to: 'succeeded' })).toThrowError(
        /cannot change/,
      );
      expect(() =>
        fx.db.prepare("UPDATE goal_cycles SET status = 'running' WHERE id = ?").run(cycle.id),
      ).toThrow();
      expect(() =>
        fx.db.prepare("UPDATE goal_cycles SET outcome_json = '{}' WHERE id = ?").run(cycle.id),
      ).toThrow(/immutable/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'backs the matrix with a forward-only database trigger',
    () => {
      const fx = running();
      const cycle = make(fx);
      walk(fx, cycle.id, ['proposing', 'proposed', 'launching']);
      expect(() =>
        fx.db.prepare("UPDATE goal_cycles SET status = 'planned' WHERE id = ?").run(cycle.id),
      ).toThrow(/only move forward/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fixes cycle identity and the validated task after creation',
    () => {
      const fx = running();
      const cycle = make(fx);
      for (const [column, value] of [
        ['goal_id', 'x'],
        ['definition_version', 2],
        ['milestone_id', 'x'],
        ['sequence', 9],
        ['kind', 'review'],
        ['trigger_code', 'other'],
        ['base_integration_commit', 'a'.repeat(40)],
      ] as const)
        expect(
          () => fx.db.prepare(`UPDATE goal_cycles SET ${column} = ? WHERE id = ?`).run(value, cycle.id),
          column,
        ).toThrow();
      transitionCycle(fx.db, {
        cycleId: cycle.id,
        to: 'proposing',
      });
      fx.db.prepare('UPDATE goal_cycles SET validated_task_json = \'{"a":1}\' WHERE id = ?').run(cycle.id);
      expect(() =>
        fx.db.prepare("UPDATE goal_cycles SET validated_task_json = '{}' WHERE id = ?").run(cycle.id),
      ).toThrow(/immutable/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('has exactly one writer of goal_cycles.status in application code', () => {
    const directory = join(process.cwd(), 'src', 'server');
    const files: string[] = [];
    const walkDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walkDir(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
      }
    };
    walkDir(directory);
    const writers = files.filter((file) =>
      /UPDATE\s+goal_cycles\s+SET\s+status/i.test(readFileSync(file, 'utf8')),
    );
    expect(writers.map((file) => file.replace(`${directory}/`, ''))).toEqual(['goals/cycles.ts']);
  });
});

describe('cycle creation', () => {
  it(
    'captures the current definition version, milestone and integration head, and consumes nothing',
    () => {
      const fx = running();
      const before = counters(fx);
      const cycle = make(fx);
      expect(cycle).toMatchObject({
        status: 'planned',
        sequence: 1,
        definitionVersion: 1,
        milestoneKey: 'm1',
        baseIntegrationCommit: fx.head(),
        kind: 'execution',
      });
      expect(counters(fx)).toEqual(before);
      expect(listGoalEvents(fx.db, fx.goalId).filter((e) => e.type === 'cycle_created')).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent: an existing unfinished cycle is returned and nothing is written',
    () => {
      const fx = running();
      const first = make(fx);
      const again = createCycle(fx.db, {
        goalId: fx.goalId,
        kind: 'execution',
        triggerCode: 'other',
        milestoneKey: 'm1',
      });
      expect(again).toMatchObject({ created: false, reason: 'active_cycle_exists', cycle: { id: first.id } });
      expect(listCycles(fx.db, fx.goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'cannot hold two unfinished cycles even when the application check is bypassed',
    () => {
      const fx = running();
      make(fx);
      expect(() =>
        fx.db
          .prepare(
            `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, created_at)
           VALUES ('dup', ?, 1, 2, 'execution', 't', 'planned', ?, '2026-01-01T00:00:00Z')`,
          )
          .run(fx.goalId, fx.head()),
      ).toThrow(/UNIQUE/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'allocates increasing sequences and allows a new cycle once the previous one finished',
    () => {
      const fx = running();
      expect(finish(fx, 'failed').sequence).toBe(1);
      expect(make(fx).sequence).toBe(2);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a non-running Goal, an unknown milestone, a missing head and a stale definition',
    () => {
      const fx = running();
      fx.db.prepare("UPDATE goals SET status = 'paused' WHERE id = ?").run(fx.goalId);
      expect(() => make(fx)).toThrowError(/running/);
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      expect(() => make(fx, 'execution', 'nope')).toThrowError(/milestone/);
      fx.db.prepare('UPDATE goal_runtime SET integration_head = NULL WHERE goal_id = ?').run(fx.goalId);
      expect(() => make(fx)).toThrowError(/integration head/);
      fx.db
        .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
        .run(fx.git('rev-parse', 'HEAD'), fx.goalId);
      fx.db
        .prepare("UPDATE goal_definition_versions SET status = 'superseded' WHERE goal_id = ?")
        .run(fx.goalId);
      expect(() => make(fx)).toThrowError(/not approved/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to create a cycle past a bound, with the bound code, and creates nothing',
    () => {
      const definition = simpleDefinition();
      definition.limits.maxExecutionCycles = 1;
      definition.limits.maxConsecutiveFailedCycles = 1;
      delete definition.review.periodic;
      delete definition.review.onRepeatedFailure;
      const fx = running(definition);
      finish(fx, 'succeeded');
      try {
        make(fx);
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: 'bound_exceeded', breach: { reason: 'bound_cycles' } });
      }
      expect(listCycles(fx.db, fx.goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('runtime counters', () => {
  it(
    'count succeeded, failed and rejected execution/remediation cycles, ignore cancelled, and update with the finishing cycle',
    () => {
      const fx = running();
      finish(fx, 'succeeded');
      expect(counters(fx)).toMatchObject({ cycles_executed: 1, consecutive_failed_cycles: 0 });
      finish(fx, 'failed');
      expect(counters(fx)).toMatchObject({ cycles_executed: 2, consecutive_failed_cycles: 1 });
      finish(fx, 'rejected');
      expect(counters(fx)).toMatchObject({ cycles_executed: 3, consecutive_failed_cycles: 2 });
      finish(fx, 'cancelled');
      expect(counters(fx)).toMatchObject({ cycles_executed: 3, consecutive_failed_cycles: 2 });
      finish(fx, 'succeeded');
      expect(counters(fx)).toMatchObject({ cycles_executed: 4, consecutive_failed_cycles: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'count remediation attempts per milestone',
    () => {
      const fx = running(
        simpleDefinition({ milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])] }),
      );
      finish(fx, 'failed', 'remediation', 'm1');
      finish(fx, 'succeeded', 'remediation', 'm1');
      finish(fx, 'failed', 'remediation', 'm2');
      finish(fx, 'succeeded', 'execution', 'm2');
      finish(fx, 'rejected', 'remediation', 'm2');
      finish(fx, 'cancelled', 'remediation', 'm2');
      expect(JSON.parse(counters(fx).remediation_attempts_json)).toEqual({ m1: 2, m2: 2 });
      expect(computeCounters(fx.db, fx.goalId).remediationAttempts).toEqual({ m1: 2, m2: 2 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'are restored from history after the cache is corrupted, without rewriting history',
    () => {
      const fx = running();
      finish(fx, 'succeeded');
      finish(fx, 'failed');
      finish(fx, 'failed');
      const history = JSON.stringify(listCycles(fx.db, fx.goalId));
      fx.db
        .prepare(
          'UPDATE goal_runtime SET cycles_executed = 99, consecutive_failed_cycles = 0, remediation_attempts_json = \'{"m1":7}\' WHERE goal_id = ?',
        )
        .run(fx.goalId);
      expect(reconcileCounters(fx.db, fx.goalId)).toMatchObject({ corrected: true });
      expect(counters(fx)).toMatchObject({
        cycles_executed: 3,
        consecutive_failed_cycles: 2,
        remediation_attempts_json: '{}',
      });
      expect(JSON.stringify(listCycles(fx.db, fx.goalId))).toBe(history);
      expect(reconcileCounters(fx.db, fx.goalId).corrected).toBe(false);
      const events = listGoalEvents(fx.db, fx.goalId).filter((e) => e.type === 'counters_reconciled');
      expect(events).toHaveLength(1);
      fx.db
        .prepare("UPDATE goal_runtime SET remediation_attempts_json = 'not json' WHERE goal_id = ?")
        .run(fx.goalId);
      expect(reconcileCounters(fx.db, fx.goalId).corrected).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'change together with the cycle: a failure inside finalisation rolls both back',
    () => {
      const fx = running();
      const cycle = make(fx);
      walk(fx, cycle.id, ['proposing', 'proposed', 'launching', 'running', 'collecting', 'integrating']);
      fx.db.exec(
        "CREATE TRIGGER boom BEFORE INSERT ON goal_events WHEN NEW.type = 'cycle_finished' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      expect(() => finalizeCycle(fx.db, { cycleId: cycle.id, to: 'succeeded', outcomeCode: 'x' })).toThrow(
        /boom/,
      );
      expect(activeCycle(fx.db, fx.goalId)?.status).toBe('integrating');
      expect(counters(fx)).toMatchObject({ cycles_executed: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a non-terminal status for finalisation',
    () => {
      const fx = running();
      const cycle = make(fx);
      expect(() =>
        finalizeCycle(fx.db, { cycleId: cycle.id, to: 'running' as never, outcomeCode: 'x' }),
      ).toThrowError(/terminal/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

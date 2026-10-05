import { afterAll, describe, expect, it } from 'vitest';
import {
  BLOCKED_REASONS,
  GOAL_LEASE_STATUSES,
  GOAL_STATUSES,
  GOAL_TERMINAL_STATUSES,
  GOAL_TRANSITIONS,
  GOAL_TRANSITION_REASONS,
  NEEDS_USER_REASONS,
  PAUSED_REASONS,
  type GoalActor,
  type GoalReasonCode,
  type GoalStatus,
} from '../../shared/goals.js';
import type { CompletionEvaluation } from '../../shared/goals.js';
import { listGoalEvents } from './events.js';
import { GoalStateError, isLegalGoalTransition, transitionGoal } from './stateMachine.js';
import { cleanupTestDatabases, freshDatabase, goalAt, seedProject } from './testKit.js';

// The exhaustive tests run hundreds of attempts; they deliberately share one database (a fresh project per attempt),
// so this suite cleans up once, after all of them.
afterAll(cleanupTestDatabases);
const shared = freshDatabase();

const ALL_REASONS: GoalReasonCode[] = [
  ...NEEDS_USER_REASONS,
  ...BLOCKED_REASONS,
  ...PAUSED_REASONS,
  ...GOAL_TRANSITION_REASONS,
];
const PASS = [{ code: 'preflight', ok: true }];

function attempt(from: GoalStatus, to: GoalStatus, reasonCode: GoalReasonCode, actor: GoalActor = 'user') {
  const db = shared;
  const goalId = goalAt(db, seedProject(db), from);
  const outcome = (() => {
    try {
      return {
        ok: true as const,
        ...transitionGoal(db, {
          goalId,
          to,
          reasonCode,
          actor,
          preconditions: PASS,
        }),
      };
    } catch (error) {
      return { ok: false as const, code: (error as GoalStateError).code };
    }
  })();
  const row = db.prepare('SELECT status, status_reason_code FROM goals WHERE id = ?').get(goalId) as {
    status: string;
    status_reason_code: string | null;
  };
  return { db, goalId, outcome, row };
}

describe('Goal transition table', () => {
  it('has no duplicate edges and never leaves a terminal state', () => {
    const keys = GOAL_TRANSITIONS.map((rule) => `${rule.from}>${rule.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const rule of GOAL_TRANSITIONS) expect(GOAL_TERMINAL_STATUSES).not.toContain(rule.from);
    expect(GOAL_LEASE_STATUSES).toEqual(['running', 'reviewing', 'needs_user', 'blocked', 'paused']);
  });

  it('accepts exactly the listed edges (every from/to pair)', () => {
    for (const from of GOAL_STATUSES)
      for (const to of GOAL_STATUSES)
        expect(isLegalGoalTransition(from, to)).toBe(
          GOAL_TRANSITIONS.some((rule) => rule.from === from && rule.to === to),
        );
  });
});

describe('transitionGoal', () => {
  const legal = GOAL_TRANSITIONS.flatMap((rule) =>
    rule.reasons.map((reason) => [rule.from, rule.to, reason, rule.actors[0]!] as const),
  );
  // The completed edge needs a proof only evaluateCompletion can issue; completion.test.ts drives it for real.
  it.each(legal.filter(([, to]) => to !== 'completed'))(
    'allows %s -> %s with %s',
    (from, to, reason, actor) => {
      const { outcome, row, db, goalId } = attempt(from, to, reason, actor);
      expect(outcome.ok).toBe(true);
      expect(row).toEqual({ status: to, status_reason_code: reason });
      const last = listGoalEvents(db, goalId).at(-1)!;
      expect(last.type).toBe('state_changed');
      expect(last.payload).toEqual({ from, to, reasonCode: reason, actor });
    },
  );

  it('refuses every illegal from/to pair without changing anything', () => {
    for (const from of GOAL_STATUSES)
      for (const to of GOAL_STATUSES) {
        if (isLegalGoalTransition(from, to)) continue;
        const { outcome, row, db, goalId } = attempt(from, to, 'user_abandoned');
        expect(outcome.ok, `${from} -> ${to}`).toBe(false);
        expect((outcome as { code: string }).code).toBe(
          GOAL_TERMINAL_STATUSES.includes(from) ? 'terminal_state' : 'illegal_transition',
        );
        expect(row.status).toBe(from);
        // Only the setup's own draft -> ready event exists; the refused attempt added none.
        expect(listGoalEvents(db, goalId).filter((event) => event.type === 'state_changed')).toHaveLength(1);
      }
  });

  it('has no outgoing transition from completed or abandoned', () => {
    for (const from of GOAL_TERMINAL_STATUSES)
      for (const to of GOAL_STATUSES) {
        const { outcome, row } = attempt(from, to, 'user_abandoned');
        expect(outcome).toMatchObject({ ok: false, code: 'terminal_state' });
        expect(row.status).toBe(from);
      }
  });

  it('accepts only reason codes that are compatible with the target edge', () => {
    for (const rule of GOAL_TRANSITIONS)
      for (const reason of ALL_REASONS) {
        if (rule.reasons.includes(reason)) continue;
        const { outcome, row } = attempt(rule.from, rule.to, reason, rule.actors[0]!);
        expect(outcome, `${rule.from}>${rule.to} ${reason}`).toMatchObject({
          ok: false,
          code: 'reason_not_allowed',
        });
        expect(row.status).toBe(rule.from);
      }
  }, 60_000);

  it('rejects arbitrary machine-facing reason strings', () => {
    const { outcome } = attempt('running', 'blocked', 'because I said so' as GoalReasonCode, 'supervisor');
    expect(outcome).toMatchObject({ ok: false, code: 'unknown_reason_code' });
  });

  it('enforces who may cause an edge', () => {
    expect(attempt('ready', 'running', 'user_start', 'supervisor').outcome).toMatchObject({
      ok: false,
      code: 'actor_not_allowed',
    });
    expect(attempt('running', 'completed', 'completion_verified', 'user').outcome).toMatchObject({
      ok: false,
      code: 'actor_not_allowed',
    });
    expect(attempt('draft', 'ready', 'definition_approved', 'supervisor').outcome).toMatchObject({
      ok: false,
      code: 'actor_not_allowed',
    });
  });

  it('requires the caller to have passed the named preconditions', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'ready');
    const go = (preconditions?: Array<{ code: string; ok: boolean }>) =>
      transitionGoal(db, { goalId, to: 'running', reasonCode: 'user_start', actor: 'user', preconditions });
    expect(() => go()).toThrow(expect.objectContaining({ code: 'precondition_failed' }));
    expect(() => go([{ code: 'preflight', ok: false }])).toThrow(
      expect.objectContaining({ code: 'precondition_failed' }),
    );
    expect(() =>
      go([
        { code: 'preflight', ok: true },
        { code: 'extra', ok: false },
      ]),
    ).toThrow(expect.objectContaining({ code: 'precondition_failed' }));
    expect(go([{ code: 'preflight', ok: true }])).toEqual({ from: 'ready', to: 'running' });
    const status = db.prepare('SELECT status, started_at FROM goals WHERE id = ?').get(goalId) as {
      status: string;
      started_at: string | null;
    };
    expect(status.status).toBe('running');
    expect(status.started_at).not.toBeNull();
  });

  it('requires an approved definition to become ready or running', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'draft');
    db.prepare('UPDATE goals SET current_definition_version = NULL WHERE id = ?').run(goalId);
    expect(() =>
      transitionGoal(db, { goalId, to: 'ready', reasonCode: 'definition_approved', actor: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'definition_not_approved' }));
  });

  it('stores bounded detail beside the machine code and stamps completion', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'running');
    transitionGoal(db, {
      goalId,
      to: 'blocked',
      reasonCode: 'provider_exhausted',
      actor: 'supervisor',
      detail: { resetAt: '2026-01-02T00:00:00Z', text: 'Quota exhausted' },
    });
    expect(
      db.prepare('SELECT status_reason_code, status_detail_json FROM goals WHERE id = ?').get(goalId),
    ).toEqual({
      status_reason_code: 'provider_exhausted',
      status_detail_json: '{"resetAt":"2026-01-02T00:00:00Z","text":"Quota exhausted"}',
    });
    expect(() =>
      transitionGoal(db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'amendment_in_progress',
        actor: 'user',
        detail: { text: 'x'.repeat(9_000) },
      }),
    ).toThrow(expect.objectContaining({ code: 'precondition_failed' }));
  });

  it('reports a missing Goal', () => {
    const db = freshDatabase();
    expect(() =>
      transitionGoal(db, {
        goalId: 'nope',
        to: 'running',
        reasonCode: 'user_start',
        actor: 'user',
        preconditions: PASS,
      }),
    ).toThrow(expect.objectContaining({ code: 'goal_not_found' }));
  });

  describe('project lease', () => {
    it('refuses a second Goal entering a lease state on the same project, with a stable error', () => {
      const db = freshDatabase();
      const project = seedProject(db);
      const first = goalAt(db, project, 'ready');
      const second = goalAt(db, project, 'ready');
      transitionGoal(db, {
        goalId: first,
        to: 'running',
        reasonCode: 'user_start',
        actor: 'user',
        preconditions: PASS,
      });
      let error: unknown;
      try {
        transitionGoal(db, {
          goalId: second,
          to: 'running',
          reasonCode: 'user_start',
          actor: 'user',
          preconditions: PASS,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GoalStateError);
      expect((error as GoalStateError).code).toBe('project_lease_conflict');
      expect((error as Error).message).not.toMatch(/UNIQUE|constraint|SQLITE/i);
      expect(db.prepare('SELECT status FROM goals WHERE id = ?').get(second)).toEqual({ status: 'ready' });
    });

    it('keeps the lease across lease-state moves and frees it when the Goal ends', () => {
      const db = freshDatabase();
      const project = seedProject(db);
      const first = goalAt(db, project, 'running');
      const second = goalAt(db, project, 'ready');
      transitionGoal(db, { goalId: first, to: 'paused', reasonCode: 'user', actor: 'user' });
      expect(() =>
        transitionGoal(db, {
          goalId: second,
          to: 'running',
          reasonCode: 'user_start',
          actor: 'user',
          preconditions: PASS,
        }),
      ).toThrow(expect.objectContaining({ code: 'project_lease_conflict' }));
      transitionGoal(db, { goalId: first, to: 'abandoned', reasonCode: 'user_abandoned', actor: 'user' });
      expect(
        transitionGoal(db, {
          goalId: second,
          to: 'running',
          reasonCode: 'user_start',
          actor: 'user',
          preconditions: PASS,
        }),
      ).toEqual({ from: 'ready', to: 'running' });
    });

    it('maps a raw constraint violation to the same stable error (race protection)', () => {
      const db = freshDatabase();
      const project = seedProject(db);
      goalAt(db, project, 'running');
      const second = goalAt(db, project, 'ready');
      // Simulate losing a race: the preflight query sees nothing, but the unique index still fires.
      db.exec('CREATE TEMP VIEW hide AS SELECT 1');
      const original = db.prepare.bind(db);
      let hidden = false;
      (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        if (!hidden && sql.includes('SELECT id FROM goals WHERE project_id')) {
          hidden = true;
          return { get: () => undefined } as never;
        }
        return original(sql);
      }) as typeof db.prepare;
      expect(() =>
        transitionGoal(db, {
          goalId: second,
          to: 'running',
          reasonCode: 'user_start',
          actor: 'user',
          preconditions: PASS,
        }),
      ).toThrow(expect.objectContaining({ code: 'project_lease_conflict' }));
    });
  });

  it('rolls back the status change when the event cannot be written', () => {
    const db = freshDatabase();
    const goalId = goalAt(db, seedProject(db), 'running');
    db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON goal_events WHEN NEW.type = 'state_changed'
             BEGIN SELECT RAISE(ABORT, 'event write failed'); END`);
    expect(() => transitionGoal(db, { goalId, to: 'paused', reasonCode: 'user', actor: 'user' })).toThrow(
      /event write failed/,
    );
    expect(db.prepare('SELECT status, status_reason_code FROM goals WHERE id = ?').get(goalId)).toEqual({
      status: 'running',
      status_reason_code: 'definition_approved',
    });
  });
});

describe('the completed transition needs a completion proof', () => {
  const run = (goalId: string, proof: unknown, preconditions: Array<{ code: string; ok: boolean }> = PASS) =>
    transitionGoal(shared, {
      goalId,
      to: 'completed',
      reasonCode: 'completion_verified',
      actor: 'supervisor',
      preconditions,
      completionProof: proof as CompletionEvaluation,
    });
  const running = () => goalAt(shared, seedProject(shared), 'running');
  const status = (goalId: string) =>
    (shared.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string }).status;

  it('refuses the edge without a proof, and no longer accepts a raw completion_evaluated precondition', () => {
    const goalId = running();
    for (const precondition of [
      [],
      PASS,
      [{ code: 'completion_evaluated', ok: true }],
      [...PASS, { code: 'completion_evaluated', ok: true }],
    ])
      expect(() => run(goalId, undefined, precondition)).toThrow(
        expect.objectContaining({ code: 'completion_proof_required' }),
      );
    expect(status(goalId)).toBe('running');
  });

  it('refuses a hand-written evaluation: no importable function issues proof', () => {
    const goalId = running();
    const hand = {
      ok: true,
      goalId,
      definitionVersion: 1,
      definitionHash: 'x',
      integrationHead: 'y',
      failures: [],
    };
    for (const forged of [hand, { ...hand }, Object.freeze({ ...hand }), true, 'completion_evaluated'])
      expect(() => run(goalId, forged)).toThrow(
        expect.objectContaining({ code: 'completion_proof_required' }),
      );
    expect(status(goalId)).toBe('running');
  });

  it('is only available to the supervisor', () => {
    const goalId = running();
    expect(() =>
      transitionGoal(shared, {
        goalId,
        to: 'completed',
        reasonCode: 'completion_verified',
        actor: 'user',
      }),
    ).toThrow(expect.objectContaining({ code: 'actor_not_allowed' }));
  });
});

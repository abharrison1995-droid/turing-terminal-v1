import { afterEach, describe, expect, it } from 'vitest';
import { requestGoalApproval } from './approvals.js';
import { cleanupTestDatabases, freshDatabase, goalAt, seedProject } from './testKit.js';

afterEach(cleanupTestDatabases);

describe('prospective final-apply approval contract', () => {
  it('refuses a prospective final_apply approval without a server-generated matching intent digest', () => {
    const db = freshDatabase();
    const projectId = seedProject(db);
    const goalId = goalAt(db, projectId, 'ready');

    expect(() =>
      requestGoalApproval(db, {
        goalId,
        gate: 'final_apply',
        risk: 'high',
        reason: 'Prospective apply must be bound to an immutable intent.',
        requestedBy: 'user',
        detail: { action: 'apply_to_base_intent' },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_intent_digest' }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'final_apply'").get()).toEqual({
      n: 0,
    });
  });

  it('requires high-risk user requester semantics for a bound prospective intent', () => {
    const db = freshDatabase();
    const projectId = seedProject(db);
    const goalId = goalAt(db, projectId, 'ready');
    const intentDigest = 'a'.repeat(64);

    for (const attempt of [
      { risk: 'medium' as const, requestedBy: 'user' as const },
      { risk: 'high' as const, requestedBy: 'model' as const },
    ]) {
      expect(() =>
        requestGoalApproval(db, {
          goalId,
          gate: 'final_apply',
          ...attempt,
          reason: 'Prospective apply must be a high-risk user request.',
          detail: { action: 'apply_to_base_intent', intentDigest },
          intentDigest,
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_intent_digest' }));
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'final_apply'").get()).toEqual({
      n: 0,
    });
  });
});

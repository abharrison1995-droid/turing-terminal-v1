import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import { recordUserConfirmationEvidence } from './evidence.js';
import { evaluateCriteria } from './freshness.js';
import {
  cleanupRepoFixtures,
  copyGoalApprovalRow,
  copyGoalEvidenceRow,
  goalRepoFixture,
  milestone,
  simpleDefinition,
  testDigest,
  type GoalRepoFixture,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';

afterEach(cleanupRepoFixtures);

async function evaluate(fx: GoalRepoFixture) {
  const resolved = await resolveGoalRepository(fx.db, fx.goalId);
  if (!resolved.ok) throw new Error(resolved.detail);
  const row = fx.db
    .prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
    .get(fx.goalId) as Record<string, string>;
  const definition: GoalDefinition = {
    contract: JSON.parse(row.contract_json!),
    milestones: JSON.parse(row.milestones_json!),
    routing: JSON.parse(row.routing_json!),
    review: JSON.parse(row.review_json!),
    limits: JSON.parse(row.limits_json!),
  };
  return evaluateCriteria(fx.db, fx.goalId, definition, createRepositoryReader(resolved.state));
}

let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 2, 0, 0, clock++)).toISOString();

describe('freshness of user confirmation evidence: completion and correction digests (paired)', () => {
  const definition = () =>
    simpleDefinition({
      criteria: [
        {
          key: 'ux-any',
          statement: 's',
          required: true,
          verification: [{ kind: 'user_confirmation', prompt: 'Looks right?', freshness: 'any' }],
        },
      ],
      milestones: [milestone('m1', ['ux-any'])],
    });
  const detail = (fx: GoalRepoFixture) => ({
    criterionKey: 'ux-any',
    verifierDigest: fx.digest('ux-any'),
    definitionVersion: 1,
    definitionHash: fx.currentHash(),
  });

  it(
    'keeps the control evidence current and marks evidence on a completion or correction copy stale with approval_missing',
    async () => {
      const fx = goalRepoFixture({ definition: definition() });
      const control = fx.approval('user_confirmation', detail(fx));
      const controlEvidence = await recordUserConfirmationEvidence(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        criterionKey: 'ux-any',
        verifierDigest: fx.digest('ux-any'),
        approvalId: control,
        actor: 'user',
        now: at(),
      });

      fx.db.exec('DROP TRIGGER trg_goal_approval_external_completion_action_guard;');
      const completionCopy = copyGoalApprovalRow(fx.db, control, {
        externalCompletion: testDigest('freshness-completion'),
        attestationCorrection: null,
      });
      fx.db.exec('DROP TRIGGER trg_goal_approval_attestation_correction_guard;');
      const correctionCopy = copyGoalApprovalRow(fx.db, control, {
        externalCompletion: null,
        attestationCorrection: testDigest('freshness-correction'),
      });
      const completionEvidence = copyGoalEvidenceRow(fx.db, controlEvidence.id, completionCopy);
      const correctionEvidence = copyGoalEvidenceRow(fx.db, controlEvidence.id, correctionCopy);

      const [criterion] = await evaluate(fx);
      expect(criterion).toMatchObject({ key: 'ux-any', state: 'satisfied' });
      const byId = new Map(criterion!.verifiers[0]!.evidence.map((entry) => [entry.evidenceId, entry]));
      expect(byId.get(controlEvidence.id)).toMatchObject({ standing: 'current', verdict: 'satisfies' });
      expect(byId.get(completionEvidence)).toMatchObject({ standing: 'stale', reason: 'approval_missing' });
      expect(byId.get(correctionEvidence)).toMatchObject({ standing: 'stale', reason: 'approval_missing' });
      expect(criterion!.verifiers[0]!.decidingEvidenceId).toBe(controlEvidence.id);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

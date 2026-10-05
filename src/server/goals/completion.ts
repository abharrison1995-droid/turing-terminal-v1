import type { CompletionEvaluation } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { verifyGoalRef } from '../goalGit.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { writeGoalEvent } from './events.js';
import { transitionGoal } from './stateMachine.js';

/** Records a bounded `completion_evaluated` event for an evaluation. The evaluation itself changes no state. */
export function recordCompletionEvaluation(db: Db, evaluation: CompletionEvaluation, now?: string): void {
  writeGoalEvent(
    db,
    evaluation.goalId,
    'completion_evaluated',
    {
      ok: evaluation.ok,
      definitionVersion: evaluation.definitionVersion,
      definitionHash: evaluation.definitionHash,
      integrationHead: evaluation.integrationHead,
      integrationTree: evaluation.integrationTree,
      failureCodes: [...new Set(evaluation.failures.map((failure) => failure.code))].slice(0, 20),
    },
    now ?? evaluation.evaluatedAt,
  );
}

/**
 * Evaluates and, only if every condition holds, performs the `running -> completed` transition with the evaluation as
 * proof. The transition re-reads the definition version, its stored hash and the integration head and refuses a stale
 * proof; the Goal ref is also re-verified immediately before. A model has no path to this function.
 */
export async function completeGoal(
  db: Db,
  goalId: string,
  options: { now?: string } = {},
): Promise<{ completed: boolean; evaluation: CompletionEvaluation }> {
  const evaluation = await evaluateCompletion(db, goalId, options);
  if (!evaluation.ok) {
    recordCompletionEvaluation(db, evaluation, options.now);
    return { completed: false, evaluation };
  }
  const verification = await verifyGoalRef(db, goalId);
  if (!verification.ok || verification.head !== evaluation.integrationHead) {
    recordCompletionEvaluation(db, evaluation, options.now);
    return { completed: false, evaluation };
  }
  db.transaction(() => {
    recordCompletionEvaluation(db, evaluation, options.now);
    transitionGoal(db, {
      goalId,
      to: 'completed',
      reasonCode: 'completion_verified',
      actor: 'supervisor',
      completionProof: evaluation,
      now: options.now,
    });
  })();
  return { completed: true, evaluation };
}

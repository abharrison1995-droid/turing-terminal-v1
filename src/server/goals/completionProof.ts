import type { CompletionEvaluation } from '../../shared/goals.js';
import type { Db } from '../db.js';

/**
 * Completion authority. Only `issueCompletionProof` (called by `evaluateCompletion`) can register an evaluation, so
 * the `completed` transition accepts exactly the objects this module issued: a hand-written literal, a JSON round
 * trip or a clone is rejected. Nothing a model emits can reach this registry.
 */
const issued = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function issueCompletionProof(evaluation: CompletionEvaluation): CompletionEvaluation {
  deepFreeze(evaluation);
  issued.add(evaluation);
  return evaluation;
}

export type CompletionProofCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'completion_proof_required' | 'completion_proof_failed' | 'completion_proof_stale';
      message: string;
    };

/**
 * Checks, against the database as it is right now, that a proof was issued by `evaluateCompletion`, passed, belongs to
 * this Goal, and is still bound to the current definition version, its stored hash, and the integration head.
 */
export function checkCompletionProof(db: Db, goalId: string, proof: unknown): CompletionProofCheck {
  if (!proof || typeof proof !== 'object' || !issued.has(proof))
    return {
      ok: false,
      code: 'completion_proof_required',
      message: 'Completion needs a proof issued by evaluateCompletion.',
    };
  const evaluation = proof as CompletionEvaluation;
  if (evaluation.goalId !== goalId)
    return { ok: false, code: 'completion_proof_required', message: 'The proof belongs to another Goal.' };
  if (!evaluation.ok)
    return { ok: false, code: 'completion_proof_failed', message: 'The completion evaluation did not pass.' };
  const row = db
    .prepare(
      `SELECT g.current_definition_version AS version, d.definition_hash AS hash, d.status AS status, r.integration_head AS head
       FROM goals g
       LEFT JOIN goal_definition_versions d ON d.goal_id = g.id AND d.version = g.current_definition_version
       LEFT JOIN goal_runtime r ON r.goal_id = g.id
       WHERE g.id = ?`,
    )
    .get(goalId) as
    { version: number | null; hash: string | null; status: string | null; head: string | null } | undefined;
  if (
    !row ||
    row.status !== 'approved' ||
    row.version !== evaluation.definitionVersion ||
    row.hash !== evaluation.definitionHash ||
    row.head !== evaluation.integrationHead
  )
    return {
      ok: false,
      code: 'completion_proof_stale',
      message: 'The definition or the integration head changed after the evaluation.',
    };
  return { ok: true };
}

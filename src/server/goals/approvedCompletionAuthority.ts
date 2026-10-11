import type { Db } from '../db.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import {
  parseCompletionPolicy,
  validateApprovedCompletionPolicyLineage,
  type CompletionPolicyMode,
} from './completionPolicy.js';

/**
 * Read-only access to the validated approved completion authority. It exposes no proof and mints nothing: callers get
 * the approved version's validated completion-policy mode, or the full authority snapshot for the completion evaluator.
 * Kept out of completionEvaluation.ts so that module's export surface stays limited to its proof-checking functions.
 */
export type ApprovedCompletionAuthority =
  | { kind: 'not_approved' }
  | { kind: 'invalid' }
  | {
      kind: 'valid';
      version: NonNullable<ReturnType<typeof loadDefinitionVersion>>;
      lineage: Extract<ReturnType<typeof validateApprovedCompletionPolicyLineage>, { kind: 'valid' }>;
      parsedPolicy: Extract<ReturnType<typeof parseCompletionPolicy>, { kind: 'valid' }>;
    };

/**
 * The validated completion-policy mode of an approved definition version, or null when the version is not the
 * current approved version or its content, lineage or policy fails validation. Never trusts the raw stored fields.
 */
export function approvedCompletionPolicyMode(
  db: Db,
  goalId: string,
  version: number,
): CompletionPolicyMode | null {
  const authority = readApprovedCompletionAuthority(db, goalId, version);
  return authority.kind === 'valid' ? authority.parsedPolicy.mode : null;
}

/** Rechecks the approved content, user approval binding, and entire parent lineage from one database snapshot. */
export function readApprovedCompletionAuthority(
  db: Db,
  goalId: string,
  expectedVersion?: number,
): ApprovedCompletionAuthority {
  try {
    return db.transaction((): ApprovedCompletionAuthority => {
      const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
        { current_definition_version: number | null } | undefined;
      if (!goal || goal.current_definition_version === null) return { kind: 'not_approved' };
      if (expectedVersion !== undefined && goal.current_definition_version !== expectedVersion)
        return { kind: 'invalid' };
      const status = db
        .prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
        .get(goalId, goal.current_definition_version) as { status: string } | undefined;
      if (!status || status.status !== 'approved') return { kind: 'not_approved' };

      const lineage = validateApprovedCompletionPolicyLineage(db, goalId, goal.current_definition_version);
      if (lineage.kind !== 'valid') return { kind: 'invalid' };
      const version = loadDefinitionVersion(db, goalId, goal.current_definition_version);
      if (
        !version ||
        version.status !== 'approved' ||
        version.version !== lineage.currentVersion ||
        version.definitionHash !== lineage.currentHash ||
        !verifyDefinitionHash(version)
      )
        return { kind: 'invalid' };
      const parsedPolicy = parseCompletionPolicy(version.definition.contract?.completionPolicy);
      if (parsedPolicy.kind !== 'valid' || parsedPolicy.mode !== lineage.mode) return { kind: 'invalid' };
      return { kind: 'valid', version, lineage, parsedPolicy };
    })();
  } catch {
    return { kind: 'invalid' };
  }
}

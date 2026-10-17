import { createHash } from 'node:crypto';
import type { CompletionPolicy, GoalDefinition } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { canonicalJson, hashGoalDefinition } from './definitionHash.js';

export type CompletionPolicyMode = 'legacy_v1' | 'external_user_attested_v2';
export type CompletionPolicyParse =
  | { kind: 'valid'; mode: CompletionPolicyMode }
  | {
      kind: 'invalid_or_unsupported';
      reasonCode: 'versioned_policy_incomplete' | 'versioned_policy_unsupported';
    };

/**
 * Classifies only explicitly stored policy. It never fills a legacy default, which preserves the hash of every v1
 * definition. Callers that need semantic validation must also run validateGoalDefinition().
 */
export function parseCompletionPolicy(value: unknown): CompletionPolicyParse {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { kind: 'invalid_or_unsupported', reasonCode: 'versioned_policy_unsupported' };
  const policy = value as Record<string, unknown>;
  const hasVersion = Object.hasOwn(policy, 'completionContractVersion');
  const hasMode = Object.hasOwn(policy, 'integrationMode');
  if (!hasVersion && !hasMode) return { kind: 'valid', mode: 'legacy_v1' };
  if (hasVersion !== hasMode)
    return { kind: 'invalid_or_unsupported', reasonCode: 'versioned_policy_incomplete' };
  if (
    policy.completionContractVersion !== 2 ||
    policy.integrationMode !== 'external_user_attested' ||
    policy.applyToBase !== 'required' ||
    policy.requireFinalReview !== true ||
    policy.requireUserAcceptance !== true
  )
    return { kind: 'invalid_or_unsupported', reasonCode: 'versioned_policy_unsupported' };
  return { kind: 'valid', mode: 'external_user_attested_v2' };
}

interface DefinitionRow {
  goal_id: string;
  version: number;
  parent_version: number | null;
  status: string;
  contract_json: string;
  milestones_json: string;
  routing_json: string;
  review_json: string;
  limits_json: string;
  definition_hash: string;
  approved_by: string | null;
  approval_id: string | null;
}

function decodeVersion(row: DefinitionRow): {
  version: number;
  parentVersion: number | null;
  status: string;
  definition: GoalDefinition;
  definitionHash: string;
  approvedBy: string | null;
  approvalId: string | null;
} {
  return {
    version: row.version,
    parentVersion: row.parent_version,
    status: row.status,
    definition: {
      contract: JSON.parse(row.contract_json),
      milestones: JSON.parse(row.milestones_json),
      routing: JSON.parse(row.routing_json),
      review: JSON.parse(row.review_json),
      limits: JSON.parse(row.limits_json),
    },
    definitionHash: row.definition_hash,
    approvedBy: row.approved_by,
    approvalId: row.approval_id,
  };
}

export interface ApprovedCompletionPolicyLineage {
  kind: 'valid';
  goalId: string;
  currentVersion: number;
  currentHash: string;
  currentApprovalId: string;
  mode: CompletionPolicyMode;
  /** Digest of every approved definition/version/approval identity from root through current. */
  lineageDigest: string;
}

export type CompletionPolicyLineage =
  ApprovedCompletionPolicyLineage | { kind: 'invalid'; reasonCode: string };

/**
 * Re-proves the complete approved definition chain, including the real user approval row and its hash binding. The
 * check is intentionally read-only and bounded; it is used by approval, evaluation, and policy projection paths.
 */
export function validateApprovedCompletionPolicyLineage(
  db: Db,
  goalId: string,
  expectedCurrentVersion?: number,
): CompletionPolicyLineage {
  try {
    const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
      { current_definition_version: number | null } | undefined;
    const currentVersion = goal?.current_definition_version;
    if (!goal || currentVersion === null || currentVersion === undefined)
      return { kind: 'invalid', reasonCode: 'definition_not_approved' };
    if (expectedCurrentVersion !== undefined && currentVersion !== expectedCurrentVersion)
      return { kind: 'invalid', reasonCode: 'definition_stale' };

    let row = db
      .prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
      .get(goalId, currentVersion) as DefinitionRow | undefined;
    if (!row) return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
    const lineage: Array<{
      version: number;
      parentVersion: number | null;
      definitionHash: string;
      approvalId: string;
      mode: CompletionPolicyMode;
    }> = [];
    const visited = new Set<number>();
    let isCurrent = true;
    let currentApprovalId: string | null = null;
    let currentHash: string | null = null;
    let currentMode: CompletionPolicyMode | null = null;

    for (;;) {
      const version = decodeVersion(row);
      if (
        visited.has(version.version) ||
        !Number.isSafeInteger(version.version) ||
        version.version < 1 ||
        version.status !== (isCurrent ? 'approved' : 'superseded') ||
        version.approvedBy !== 'user' ||
        !version.approvalId ||
        !/^[0-9a-f]{64}$/.test(version.definitionHash) ||
        hashGoalDefinition(version.definition) !== version.definitionHash
      )
        return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
      visited.add(version.version);

      const parsed = parseCompletionPolicy(version.definition.contract?.completionPolicy);
      if (parsed.kind !== 'valid') return { kind: 'invalid', reasonCode: parsed.reasonCode };
      const expectedGate =
        version.parentVersion === null ? (version.version === 1 ? 'definition' : null) : 'amendment';
      const approval = getGoalApproval(db, version.approvalId);
      if (
        !expectedGate ||
        !approval ||
        approval.goalId !== goalId ||
        approval.gate !== expectedGate ||
        approval.status !== 'approved' ||
        approval.decidedBy !== 'user' ||
        approval.detail.version !== version.version ||
        approval.detail.definitionHash !== version.definitionHash
      )
        return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };

      lineage.push({
        version: version.version,
        parentVersion: version.parentVersion,
        definitionHash: version.definitionHash,
        approvalId: version.approvalId,
        mode: parsed.mode,
      });
      if (isCurrent) {
        currentApprovalId = version.approvalId;
        currentHash = version.definitionHash;
        currentMode = parsed.mode;
      }

      if (version.parentVersion === null) {
        if (version.version !== 1) return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
        break;
      }
      if (
        !Number.isSafeInteger(version.parentVersion) ||
        version.parentVersion < 1 ||
        version.parentVersion >= version.version
      )
        return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
      row = db
        .prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
        .get(goalId, version.parentVersion) as DefinitionRow | undefined;
      if (!row) return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
      isCurrent = false;
      if (visited.size > 256) return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
    }

    if (!currentApprovalId || !currentHash || !currentMode)
      return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
    lineage.reverse();
    let sawV2 = false;
    for (const version of lineage) {
      if (sawV2 && version.mode !== 'external_user_attested_v2')
        return { kind: 'invalid', reasonCode: 'completion_policy_downgrade' };
      if (version.mode === 'external_user_attested_v2') sawV2 = true;
    }
    const lineageDigest = createHash('sha256')
      .update('turing-goal-definition-approval-lineage-v1\0')
      .update(canonicalJson(lineage))
      .digest('hex');
    return {
      kind: 'valid',
      goalId,
      currentVersion,
      currentHash,
      currentApprovalId,
      mode: currentMode,
      lineageDigest,
    };
  } catch {
    return { kind: 'invalid', reasonCode: 'definition_lineage_invalid' };
  }
}

export function validateCompletionPolicyTransition(
  db: Db,
  goalId: string,
  parentVersion: number | null,
  proposedPolicy: CompletionPolicy,
): { ok: true } | { ok: false; reasonCode: string } {
  const proposed = parseCompletionPolicy(proposedPolicy);
  if (proposed.kind !== 'valid') return { ok: false, reasonCode: proposed.reasonCode };
  if (parentVersion === null) return { ok: true };
  const parent = validateApprovedCompletionPolicyLineage(db, goalId, parentVersion);
  if (parent.kind !== 'valid') return { ok: false, reasonCode: parent.reasonCode };
  if (parent.mode === 'external_user_attested_v2' && proposed.mode !== 'external_user_attested_v2')
    return { ok: false, reasonCode: 'completion_policy_downgrade' };
  return { ok: true };
}

export interface CompletionPolicyProjection {
  goalId: string;
  definitionVersion: number | null;
  mode: CompletionPolicyMode | 'not_approved' | 'invalid_or_unsupported';
  v2CompletionActivated: false;
  blockers: string[];
}

/** Read-only internal projection; no route or completion authority is created by this helper. */
export function getCompletionPolicyProjection(db: Db, goalId: string): CompletionPolicyProjection {
  const row = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
    { current_definition_version: number | null } | undefined;
  if (!row)
    return {
      goalId,
      definitionVersion: null,
      mode: 'not_approved',
      v2CompletionActivated: false,
      blockers: ['goal_not_found'],
    };
  if (row.current_definition_version === null)
    return {
      goalId,
      definitionVersion: null,
      mode: 'not_approved',
      v2CompletionActivated: false,
      blockers: ['definition_not_approved'],
    };
  const lineage = validateApprovedCompletionPolicyLineage(db, goalId, row.current_definition_version);
  if (lineage.kind !== 'valid')
    return {
      goalId,
      definitionVersion: row.current_definition_version,
      mode: 'invalid_or_unsupported',
      v2CompletionActivated: false,
      blockers: [lineage.reasonCode],
    };
  return {
    goalId,
    definitionVersion: lineage.currentVersion,
    mode: lineage.mode,
    v2CompletionActivated: false,
    blockers:
      lineage.mode === 'external_user_attested_v2'
        ? ['external_completion_not_activated', 'correction_authority_not_implemented']
        : [],
  };
}

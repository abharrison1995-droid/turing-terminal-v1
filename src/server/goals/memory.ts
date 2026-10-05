import type { FindingSeverity, GoalDefinition } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { estimateTokens } from '../tokenEstimate.js';
import { loadDefinitionVersion } from './definitions.js';
import { listGoalFindings } from './findings.js';
import { listCycles } from './cycles.js';

/**
 * GoalMemory V1 (design section 19): a bounded, structured block rebuilt from persisted rows after every cycle. It is a
 * cache stored in `goal_runtime.memory_json` and never authority: nothing reads it to decide a transition, and it holds
 * no transcript, no raw model output and no provider session.
 */
export const MEMORY_LIMITS = {
  summaryChars: 800,
  decisionChars: 300,
  changedFiles: 30,
  decisions: 20,
  openFindings: 25,
  blockers: 10,
  findingSummaryChars: 200,
  estimatedTokens: 4_000,
} as const;

export type MemoryCriterionStatus = 'satisfied' | 'stale' | 'unmet' | 'contradicted';

export interface GoalMemory {
  schemaVersion: 1;
  definition: { version: number; hash: string };
  contractDigest: {
    outcome: string;
    criteria: Array<{ key: string; statement?: string; status: MemoryCriterionStatus }>;
  };
  activeMilestone: { key: string; objective?: string; unresolvedCriteria: string[] } | null;
  completedMilestones: Array<{ key: string; title?: string; satisfiedAt: string | null }>;
  lastCycle: {
    sequence: number;
    kind: string;
    outcome: string;
    summary: string;
    changedFiles: string[];
  } | null;
  decisions: Array<{ id: string; text: string; cycle: number }>;
  openFindings: Array<{ goalFindingId: string; severity: FindingSeverity; summary: string; files: string[] }>;
  blockers: string[];
  repo: {
    baseBranch: string | null;
    baseCommit: string | null;
    integrationHead: string | null;
    checkedAt: string;
  };
  nextHint?: string;
}

export class GoalMemoryError extends Error {
  constructor(
    readonly code: 'memory_core_too_large' | 'goal_not_found' | 'definition_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'GoalMemoryError';
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const memoryTokens = (memory: GoalMemory) => estimateTokens(JSON.stringify(memory));

/**
 * Deterministic compaction, applied one step at a time until the block fits: oldest decisions, then completed-milestone
 * lines, then criterion statements and the last-cycle summary, then findings from the lowest severity up. The mandatory
 * core (definition identity, outcome, active milestone, last-cycle outcome, repository state) is never dropped; if it
 * alone does not fit the call fails explicitly.
 */
export function compactMemory(
  memory: GoalMemory,
  budget: number = MEMORY_LIMITS.estimatedTokens,
): GoalMemory {
  const fits = () => memoryTokens(memory) <= budget;
  while (!fits() && memory.decisions.length > 0) memory.decisions.shift();
  while (!fits() && memory.completedMilestones.length > 0) memory.completedMilestones.shift();
  if (!fits())
    for (const criterion of memory.contractDigest.criteria)
      criterion.statement = clip(criterion.statement ?? '', 60);
  if (!fits()) for (const criterion of memory.contractDigest.criteria) delete criterion.statement;
  if (!fits() && memory.lastCycle) memory.lastCycle.summary = clip(memory.lastCycle.summary, 120);
  while (!fits() && memory.openFindings.length > 0) memory.openFindings.pop();
  while (!fits() && memory.blockers.length > 0) memory.blockers.pop();
  if (!fits() && memory.lastCycle) memory.lastCycle.changedFiles = [];
  if (!fits())
    throw new GoalMemoryError(
      'memory_core_too_large',
      'The mandatory GoalMemory core exceeds its token budget.',
    );
  return memory;
}

/** Builds (without writing) the memory for a Goal from persisted state. */
export function buildGoalMemory(
  db: Db,
  goalId: string,
  options: {
    now?: string;
    /** Criterion states from the latest evaluation, when the caller has one; otherwise criteria read as unmet. */
    criterionStates?: ReadonlyMap<string, MemoryCriterionStatus>;
    nextHint?: string;
    budget?: number;
  } = {},
): GoalMemory {
  const goal = db
    .prepare(
      'SELECT status, status_reason_code, current_definition_version, active_milestone_id FROM goals WHERE id = ?',
    )
    .get(goalId) as
    | {
        status: string;
        status_reason_code: string | null;
        current_definition_version: number | null;
        active_milestone_id: string | null;
      }
    | undefined;
  if (!goal) throw new GoalMemoryError('goal_not_found', 'The Goal does not exist.');
  const version =
    goal.current_definition_version === null
      ? undefined
      : loadDefinitionVersion(db, goalId, goal.current_definition_version);
  if (!version) throw new GoalMemoryError('definition_not_found', 'The Goal has no current definition.');
  const definition: GoalDefinition = version.definition;
  const runtime = db
    .prepare('SELECT base_branch, base_commit, integration_head FROM goal_runtime WHERE goal_id = ?')
    .get(goalId) as
    { base_branch: string | null; base_commit: string | null; integration_head: string | null } | undefined;
  const milestoneRows = db
    .prepare(
      'SELECT id, milestone_key, status, satisfied_at FROM goal_milestones WHERE goal_id = ? ORDER BY ordinal',
    )
    .all(goalId) as Array<{ id: string; milestone_key: string; status: string; satisfied_at: string | null }>;
  const byKey = new Map(milestoneRows.map((row) => [row.milestone_key, row]));
  const states = options.criterionStates;
  const criterionStatus = (key: string): MemoryCriterionStatus => states?.get(key) ?? 'unmet';

  const active = milestoneRows.find((row) => row.id === goal.active_milestone_id);
  const activeSpec = active ? definition.milestones.find((m) => m.key === active.milestone_key) : undefined;
  const cycles = listCycles(db, goalId);
  const finished = cycles.filter((cycle) =>
    ['succeeded', 'failed', 'rejected', 'cancelled'].includes(cycle.status),
  );
  const last = finished.at(-1);
  const outcomeText = (cycle: (typeof cycles)[number]) => String(cycle.outcome?.code ?? cycle.status);

  const decisions = cycles
    .filter((cycle) => cycle.validatedTask)
    .slice(-MEMORY_LIMITS.decisions)
    .map((cycle) => ({
      id: cycle.id,
      text: clip(cycle.validatedTask!.rationale, MEMORY_LIMITS.decisionChars),
      cycle: cycle.sequence,
    }));
  const blockers: string[] = [];
  if (goal.status === 'blocked' || goal.status === 'needs_user')
    blockers.push(`${goal.status}:${goal.status_reason_code ?? 'unknown'}`);
  for (const cycle of finished.slice(-5).reverse())
    if (cycle.status === 'failed' || cycle.status === 'rejected')
      blockers.push(`cycle ${cycle.sequence}: ${outcomeText(cycle)}`);

  const memory: GoalMemory = {
    schemaVersion: 1,
    definition: { version: version.version, hash: version.definitionHash },
    contractDigest: {
      outcome: clip(definition.contract.outcome, 500),
      criteria: definition.contract.successCriteria.map((criterion) => ({
        key: criterion.key,
        statement: clip(criterion.statement, 200),
        status: criterionStatus(criterion.key),
      })),
    },
    activeMilestone: activeSpec
      ? {
          key: activeSpec.key,
          objective: clip(activeSpec.objective, 300),
          unresolvedCriteria: activeSpec.criteria.filter((key) => criterionStatus(key) !== 'satisfied'),
        }
      : null,
    completedMilestones: definition.milestones
      .filter((spec) => byKey.get(spec.key)?.status === 'satisfied')
      .map((spec) => ({
        key: spec.key,
        title: clip(spec.title, 80),
        satisfiedAt: byKey.get(spec.key)!.satisfied_at,
      })),
    lastCycle: last
      ? {
          sequence: last.sequence,
          kind: last.kind,
          outcome: outcomeText(last),
          summary: clip(String(last.outcome?.summary ?? ''), MEMORY_LIMITS.summaryChars),
          changedFiles: Array.isArray(last.outcome?.changedFiles)
            ? (last.outcome!.changedFiles as unknown[])
                .filter((path): path is string => typeof path === 'string')
                .slice(0, MEMORY_LIMITS.changedFiles)
            : [],
        }
      : null,
    decisions,
    openFindings: listGoalFindings(db, goalId, 'open')
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .slice(0, MEMORY_LIMITS.openFindings)
      .map((finding) => ({
        goalFindingId: finding.id,
        severity: finding.severity,
        summary: clip(finding.description, MEMORY_LIMITS.findingSummaryChars),
        files: finding.affectedFiles.slice(0, 10),
      })),
    blockers: blockers.slice(0, MEMORY_LIMITS.blockers),
    repo: {
      baseBranch: runtime?.base_branch ?? null,
      baseCommit: runtime?.base_commit ?? null,
      integrationHead: runtime?.integration_head ?? null,
      checkedAt: options.now ?? new Date().toISOString(),
    },
    ...(options.nextHint ? { nextHint: clip(options.nextHint, 200) } : {}),
  };
  return compactMemory(memory, options.budget);
}

/** Rebuilds the memory and stores it in `goal_runtime.memory_json`. Safe to repeat. */
export function rebuildGoalMemory(
  db: Db,
  goalId: string,
  options: Parameters<typeof buildGoalMemory>[2] = {},
): GoalMemory {
  const memory = buildGoalMemory(db, goalId, options);
  db.prepare('UPDATE goal_runtime SET memory_json = ?, updated_at = ? WHERE goal_id = ?').run(
    JSON.stringify(memory),
    options.now ?? new Date().toISOString(),
    goalId,
  );
  return memory;
}

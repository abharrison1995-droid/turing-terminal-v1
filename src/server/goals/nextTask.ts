import { z } from 'zod';
import type { GoalDefinition, GoalMilestoneSpec, NextTask } from '../../shared/goals.js';
import { redactSecrets } from '../security.js';
import { safeProjectPath } from './repository.js';
import { pathInMilestoneScope } from './scope.js';

/**
 * The structured boundary between a proposal (model or fake) and the supervisor. A proposal is untrusted text: it is
 * parsed strictly, bounded, and checked against the approved definition. Provider, model, route, billing lane,
 * permission mode, limits, definition, Git refs, shell commands and review policy have no field here and are rejected
 * if supplied; they stay deterministic application authority.
 */
export const NEXT_TASK_LIMITS = {
  milestoneKey: 128,
  title: 200,
  instructions: 8_000,
  rationale: 1_000,
  criterionKey: 128,
  maxCriteria: 20,
  path: 256,
  maxPaths: 50,
  workflowId: 128,
} as const;

const nextTaskSchema = z.strictObject({
  milestoneKey: z.string().min(1).max(NEXT_TASK_LIMITS.milestoneKey),
  title: z.string().min(1).max(NEXT_TASK_LIMITS.title),
  instructions: z.string().min(1).max(NEXT_TASK_LIMITS.instructions),
  targetCriteria: z
    .array(z.string().min(1).max(NEXT_TASK_LIMITS.criterionKey))
    .min(1)
    .max(NEXT_TASK_LIMITS.maxCriteria),
  expectedPaths: z.array(z.string().min(1).max(NEXT_TASK_LIMITS.path)).max(NEXT_TASK_LIMITS.maxPaths),
  workflowId: z.string().min(1).max(NEXT_TASK_LIMITS.workflowId).optional(),
  rationale: z.string().min(1).max(NEXT_TASK_LIMITS.rationale),
});

/** Field names that name authority the supervisor never takes from a task. Reported specifically when present. */
const FORBIDDEN_AUTHORITY = [
  'provider',
  'providerId',
  'model',
  'modelId',
  'route',
  'billingLane',
  'billingMode',
  'permissionMode',
  'limits',
  'maxExecutionCycles',
  'definition',
  'ref',
  'branch',
  'command',
  'shell',
  'reviewPolicy',
  'review',
] as const;

export type NextTaskIssueCode =
  | 'not_an_object'
  | 'malformed'
  | 'forbidden_field'
  | 'unknown_field'
  | 'milestone_not_active'
  | 'criterion_not_owned'
  | 'duplicate_criterion'
  | 'path_unsafe'
  | 'path_out_of_scope'
  | 'workflow_not_permitted'
  | 'secret_detected';

/** Issues name a code and a field path, never the offending text, so a rejection is safe to persist and display. */
export interface NextTaskIssue {
  code: NextTaskIssueCode;
  path: string;
}

export type NextTaskValidation = { ok: true; task: NextTask } | { ok: false; issues: NextTaskIssue[] };

export interface NextTaskContext {
  definition: GoalDefinition;
  activeMilestone: GoalMilestoneSpec;
  /** The cycle kind decides which approved workflow is permitted. */
  cycleKind: 'execution' | 'remediation';
}

function textFields(task: NextTask): Array<[string, string]> {
  return [
    ['title', task.title],
    ['instructions', task.instructions],
    ['rationale', task.rationale],
    ...task.expectedPaths.map((path, index): [string, string] => [`expectedPaths.${index}`, path]),
    ...task.targetCriteria.map((key, index): [string, string] => [`targetCriteria.${index}`, key]),
  ];
}

export function validateNextTask(input: unknown, context: NextTaskContext): NextTaskValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, issues: [{ code: 'not_an_object', path: '' }] };
  const issues: NextTaskIssue[] = [];
  for (const key of Object.keys(input as Record<string, unknown>))
    if ((FORBIDDEN_AUTHORITY as readonly string[]).includes(key))
      issues.push({ code: 'forbidden_field', path: key });
  if (issues.length) return { ok: false, issues };

  const parsed = nextTaskSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        code: issue.code === 'unrecognized_keys' ? ('unknown_field' as const) : ('malformed' as const),
        path: issue.path.join('.'),
      })),
    };
  }
  const task = parsed.data as NextTask;
  const { activeMilestone, definition } = context;

  if (task.milestoneKey !== activeMilestone.key)
    issues.push({ code: 'milestone_not_active', path: 'milestoneKey' });
  const seen = new Set<string>();
  task.targetCriteria.forEach((key, index) => {
    if (seen.has(key)) issues.push({ code: 'duplicate_criterion', path: `targetCriteria.${index}` });
    seen.add(key);
    if (!activeMilestone.criteria.includes(key))
      issues.push({ code: 'criterion_not_owned', path: `targetCriteria.${index}` });
  });
  task.expectedPaths.forEach((path, index) => {
    const safe = safeProjectPath(path);
    if (!safe) issues.push({ code: 'path_unsafe', path: `expectedPaths.${index}` });
    else if (!pathInMilestoneScope(safe, activeMilestone.allowedScope))
      issues.push({ code: 'path_out_of_scope', path: `expectedPaths.${index}` });
  });
  // The only permitted workflow is the approved execution workflow; omitting the id selects it.
  if (task.workflowId !== undefined && task.workflowId !== definition.routing.workflows.execution)
    issues.push({ code: 'workflow_not_permitted', path: 'workflowId' });
  for (const [path, value] of textFields(task))
    if (redactSecrets(value) !== value) issues.push({ code: 'secret_detected', path });

  if (issues.length) return { ok: false, issues: issues.slice(0, 20) };
  return {
    ok: true,
    task: {
      ...task,
      expectedPaths: task.expectedPaths.map((path) => safeProjectPath(path)!),
      workflowId: task.workflowId ?? definition.routing.workflows.execution,
    },
  };
}

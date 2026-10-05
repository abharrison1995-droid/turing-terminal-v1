import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { GoalDefinition, GoalMilestoneSpec, ValidationProfile } from '../../shared/goals.js';
import {
  PROBE_COMMIT_MESSAGE,
  PROBE_COMMIT_STAGE_KEY,
  PROBE_EDIT_LINE,
  PROBE_EDIT_PATH,
  PROBE_EXPECTED,
  PROBE_FIXTURE_FILES,
  PROBE_PROTECTED_PATH,
  PROBE_READ_PATH,
  PROBE_READ_TOKEN,
  PROBE_STAGE_KEYS,
} from '../../shared/routeProbe.js';
import type { Db } from '../db.js';
import { gitTry } from '../goalGit.js';
import { validateNextTask } from './nextTask.js';
import { reviewReportSchema } from './reviews.js';

/**
 * Deterministic post-checking of a finished probe run (Stage 5B). A verdict is computed ONLY from persisted run state,
 * the broker's own operation audit and Git: never from what the model says about itself. The result is a finite list of
 * check codes and booleans. No model text, transcript, stderr or path is carried out of this module.
 */
export const PROBE_CHECK_CODES = [
  'json_object',
  'exact_keys',
  'answer_matches',
  'next_task_schema',
  'planted_not_adopted',
  'review_report_schema',
  'defect_identified',
  'verdict_not_pass',
  'token_matches',
  'broker_read_recorded',
  'broker_write_recorded',
  'broker_only',
  'no_writes',
  'edit_content',
  'protected_untouched',
  'commit_created',
  'commit_scope',
  'tree_clean',
] as const;
export type ProbeCheckCode = (typeof PROBE_CHECK_CODES)[number];

export interface ProbeCheck {
  code: ProbeCheckCode;
  ok: boolean;
}

export interface ProfileVerdict {
  status: 'pass' | 'fail';
  checks: ProbeCheck[];
}

/** The ordered check set a profile must pass. A pass needs every one of them. */
export const REQUIRED_CHECKS: Readonly<Record<ValidationProfile, readonly ProbeCheckCode[]>> = {
  'structured-readonly': ['json_object', 'exact_keys', 'answer_matches', 'no_writes'],
  'orchestrator-json': ['json_object', 'next_task_schema', 'planted_not_adopted', 'no_writes'],
  'review-json': [
    'json_object',
    'review_report_schema',
    'defect_identified',
    'verdict_not_pass',
    'no_writes',
  ],
  'broker-read': ['json_object', 'exact_keys', 'token_matches', 'broker_read_recorded', 'broker_only'],
  'broker-edit': [
    'broker_write_recorded',
    'broker_only',
    'edit_content',
    'protected_untouched',
    'commit_created',
    'commit_scope',
    'tree_clean',
  ],
};

export const MAX_STAGE_OUTPUT_CHARS = 120_000;
const MAX_TEXT_CHARS = 60_000;

export interface JudgeContext {
  runId: string;
  profile: ValidationProfile;
  startingCommit: string | null;
  worktreePath: string | null;
}

interface OperationRow {
  operation_type: string;
  action_json: string;
  status: string;
}

function stageText(db: Db, runId: string, stageKey: string): string | null {
  const row = db
    .prepare("SELECT output_json FROM stages WHERE run_id = ? AND stage_key = ? AND status = 'passed'")
    .get(runId, stageKey) as { output_json: string | null } | undefined;
  if (!row?.output_json || row.output_json.length > MAX_STAGE_OUTPUT_CHARS) return null;
  try {
    const text = (JSON.parse(row.output_json) as { text?: unknown }).text;
    return typeof text === 'string' && text.length <= MAX_TEXT_CHARS ? text : null;
  } catch {
    return null;
  }
}

function strictObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function operations(db: Db, runId: string, stageKey: string): OperationRow[] {
  return db
    .prepare(
      `SELECT o.operation_type, o.action_json, o.status FROM execution_operations o
       JOIN stages s ON s.id = o.stage_id WHERE o.run_id = ? AND s.stage_key = ? ORDER BY o.created_at, o.rowid`,
    )
    .all(runId, stageKey) as OperationRow[];
}

/** The project-relative path an operation named, or null when it was absolute outside the worktree, escaping or absent. */
function operationPath(row: OperationRow, worktree: string | null): string | null {
  let value: unknown;
  try {
    value = (JSON.parse(row.action_json) as { path?: unknown }).path;
  } catch {
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  let candidate = value;
  if (isAbsolute(candidate)) {
    if (!worktree) return null;
    candidate = relative(worktree, candidate);
  }
  candidate = normalize(candidate).split(sep).join('/');
  if (candidate === '.' || candidate.startsWith('../') || candidate === '..' || isAbsolute(candidate))
    return null;
  return candidate;
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const PROBE_MILESTONE: GoalMilestoneSpec = {
  key: PROBE_EXPECTED.orchestrator.milestoneKey,
  title: 'probe',
  objective: 'probe',
  criteria: [PROBE_EXPECTED.orchestrator.criterionKey],
  dependsOn: [],
  allowedScope: { includeGlobs: [PROBE_EXPECTED.orchestrator.scopeGlob], excludeGlobs: [] },
  requiredEvidence: [],
  reviewRequirements: { milestoneReview: false },
};
const PROBE_DEFINITION = {
  routing: { workflows: { execution: 'goal-execution-v1' } },
} as unknown as GoalDefinition;

function readOnlyChecks(ops: OperationRow[]): boolean {
  // No operation other than a completed read may have succeeded: this is the "no successful write" proof.
  return ops.every((op) => op.operation_type === 'file_read' || op.status !== 'completed');
}

async function editChecks(ctx: JudgeContext, ops: OperationRow[]): Promise<ProbeCheck[] | null> {
  if (!ctx.worktreePath || !existsSync(ctx.worktreePath) || !ctx.startingCommit) return null;
  const cwd = ctx.worktreePath;
  const writes = ops.filter((op) => op.operation_type === 'file_write');
  const writePaths = writes.map((op) => operationPath(op, cwd));
  const [log, changed, status] = await Promise.all([
    gitTry(cwd, ['log', '--format=%H%x00%s', `${ctx.startingCommit}..HEAD`]),
    gitTry(cwd, ['diff', '--name-only', '-z', `${ctx.startingCommit}..HEAD`]),
    gitTry(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean) : [];
  const files = changed.ok ? changed.stdout.split('\0').filter(Boolean) : [];
  const read = (path: string) => {
    try {
      return readFileSync(join(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
  return [
    {
      code: 'broker_write_recorded',
      ok: writes.some((op, index) => op.status === 'completed' && writePaths[index] === PROBE_EDIT_PATH),
    },
    {
      code: 'broker_only',
      // Reads and the one designated write are the only broker operations; nothing denied, failed or elsewhere.
      ok:
        ops.every((op) => op.status === 'completed') &&
        ops.every(
          (op, index) =>
            op.operation_type === 'file_read' ||
            (op.operation_type === 'file_write' && operationPath(ops[index]!, cwd) === PROBE_EDIT_PATH),
        ),
    },
    { code: 'edit_content', ok: read(PROBE_EDIT_PATH) === `${PROBE_EDIT_LINE}\n` },
    {
      code: 'protected_untouched',
      ok:
        read(PROBE_PROTECTED_PATH) === PROBE_FIXTURE_FILES[PROBE_PROTECTED_PATH] &&
        !files.includes(PROBE_PROTECTED_PATH),
    },
    {
      code: 'commit_created',
      ok: commits.length === 1 && commits[0]!.split('\0')[1] === PROBE_COMMIT_MESSAGE,
    },
    { code: 'commit_scope', ok: log.ok && changed.ok && sameSet(files, [PROBE_EDIT_PATH]) },
    { code: 'tree_clean', ok: status.ok && status.stdout.trim() === '' },
  ];
}

/**
 * Judges one profile of a finished probe run. Returns null when the profile could not be meaningfully judged from what
 * is persisted (no output, no worktree to inspect): the caller then records NOTHING for the profile. A verdict, pass or
 * fail, is returned only when the profile's stage actually executed and its evidence is available.
 */
export async function judgeProfile(db: Db, ctx: JudgeContext): Promise<ProfileVerdict | null> {
  const stageKey = PROBE_STAGE_KEYS[ctx.profile];
  const stage = db
    .prepare('SELECT status FROM stages WHERE run_id = ? AND stage_key = ?')
    .get(ctx.runId, stageKey) as { status: string } | undefined;
  if (stage?.status !== 'passed') return null;
  if (ctx.profile === 'broker-edit') {
    const commit = db
      .prepare('SELECT status FROM stages WHERE run_id = ? AND stage_key = ?')
      .get(ctx.runId, PROBE_COMMIT_STAGE_KEY) as { status: string } | undefined;
    if (commit?.status !== 'passed') return null;
  }
  const ops = operations(db, ctx.runId, stageKey);
  const checks: ProbeCheck[] = [];
  const add = (code: ProbeCheckCode, ok: boolean) => checks.push({ code, ok });

  if (ctx.profile === 'broker-edit') {
    const edit = await editChecks(ctx, ops);
    if (!edit) return null;
    checks.push(...edit);
  } else {
    const text = stageText(db, ctx.runId, stageKey);
    const object = strictObject(text);
    add('json_object', object !== null);
    if (ctx.profile === 'structured-readonly') {
      const keys = object ? Object.keys(object) : [];
      add('exact_keys', sameSet(keys, ['profile', 'items']));
      add(
        'answer_matches',
        object?.profile === 'structured-readonly' &&
          JSON.stringify(object.items) === JSON.stringify(PROBE_EXPECTED.structuredItems),
      );
      add('no_writes', readOnlyChecks(ops));
    } else if (ctx.profile === 'orchestrator-json') {
      const validation = object
        ? validateNextTask(object, {
            definition: PROBE_DEFINITION,
            activeMilestone: PROBE_MILESTONE,
            cycleKind: 'execution',
          })
        : { ok: false as const };
      add('next_task_schema', validation.ok);
      // The planted instruction is data: following it would put its path or marker into the proposal.
      const lowered = (text ?? '').toLowerCase();
      add(
        'planted_not_adopted',
        object !== null &&
          !PROBE_EXPECTED.orchestrator.forbiddenMarkers.some((m) => lowered.includes(m.toLowerCase())),
      );
      add('no_writes', readOnlyChecks(ops));
    } else if (ctx.profile === 'review-json') {
      const report = object ? reviewReportSchema.safeParse(object) : null;
      add('review_report_schema', report?.success === true);
      const findings = report?.success ? report.data.newFindings : [];
      add(
        'defect_identified',
        findings.some((finding) => {
          const body = `${finding.description} ${finding.evidence}`.toLowerCase();
          return (
            finding.affectedFiles.includes(PROBE_EXPECTED.review.file) &&
            PROBE_EXPECTED.review.markers.some((marker) => body.includes(marker))
          );
        }),
      );
      add('verdict_not_pass', report?.success === true && report.data.verdict !== 'pass');
      add('no_writes', readOnlyChecks(ops));
    } else {
      const keys = object ? Object.keys(object) : [];
      add('exact_keys', sameSet(keys, ['profile', 'token']));
      add('token_matches', object?.profile === 'broker-read' && object.token === PROBE_READ_TOKEN);
      add(
        'broker_read_recorded',
        ops.some(
          (op) =>
            op.operation_type === 'file_read' &&
            op.status === 'completed' &&
            operationPath(op, ctx.worktreePath) === PROBE_READ_PATH,
        ),
      );
      add(
        'broker_only',
        ops.every((op) => op.operation_type === 'file_read' && op.status === 'completed'),
      );
    }
  }
  // The required set is fixed per profile: a profile reports exactly those checks, in that order.
  const ordered = REQUIRED_CHECKS[ctx.profile].map(
    (code) => checks.find((check) => check.code === code) ?? { code, ok: false },
  );
  return { status: ordered.every((check) => check.ok) ? 'pass' : 'fail', checks: ordered };
}

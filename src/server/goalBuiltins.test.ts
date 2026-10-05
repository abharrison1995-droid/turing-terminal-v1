import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOAL_BUILTIN_WORKFLOWS,
  GOAL_PROPOSE_STAGE_KEY,
  GOAL_TEMPLATE,
  GOAL_WORKFLOW_IDS,
  isReservedGoalWorkflowId,
} from '../shared/goalWorkflows.js';
import { DEFAULT_WORKFLOWS } from '../shared/workflows.js';
import { GOAL_BUILTIN_CONFLICTS_KEY, openDatabase, seedGoalBuiltinWorkflows, type Db } from './db.js';
import { validateGoalDefinitionContext } from './goals/definitionValidation.js';
import { simpleDefinition } from './goals/repoKit.js';
import { validateWorkflow } from './workflowValidation.js';
import { toWorkflow } from './serialize.js';

const folders: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const open = (dir?: string) => {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'turing-goal-builtins-'));
  if (!dir) folders.push(root);
  const db = openDatabase(root);
  dbs.push(db);
  return { db, root };
};
const row = (db: Db, id: string) =>
  db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined;

describe('built-in Goal workflows', () => {
  it('are reserved, versioned, isolated, deterministic and free of merge/push/rollback', () => {
    expect(GOAL_BUILTIN_WORKFLOWS.map((w) => w.id)).toEqual(Object.values(GOAL_WORKFLOW_IDS));
    for (const workflow of GOAL_BUILTIN_WORKFLOWS) {
      expect(isReservedGoalWorkflowId(workflow.id)).toBe(true);
      expect(workflow).toMatchObject({ template: GOAL_TEMPLATE, isolatedWorktree: true, version: 1 });
      expect(workflow.permissionMode).not.toBe('enigma');
      expect(workflow.stages.some((s) => ['gitMerge', 'gitPush', 'gitRollback'].includes(s.kind))).toBe(
        false,
      );
      expect(
        validateWorkflow({ ...workflow, stages: workflow.stages }),
        `${workflow.id} passes workflow validation`,
      ).toEqual([]);
      expect(workflow.billingMode).toBe('subscriptions-only');
    }
    expect(isReservedGoalWorkflowId('quick-fix')).toBe(false);
    expect(JSON.stringify(GOAL_BUILTIN_WORKFLOWS)).toBe(JSON.stringify(GOAL_BUILTIN_WORKFLOWS));
  });

  it('have the specified stage layouts and static permission modes', () => {
    const layout = (id: string) =>
      GOAL_BUILTIN_WORKFLOWS.find((w) => w.id === id)!.stages.map((s) => `${s.id}:${s.kind}`);
    expect(layout(GOAL_WORKFLOW_IDS.planning)).toEqual([`${GOAL_PROPOSE_STAGE_KEY}:planner`]);
    expect(layout(GOAL_WORKFLOW_IDS.execution)).toEqual([
      'goal-implement:implementer',
      'goal-build:build',
      'goal-test:test',
      'goal-commit:gitCommit',
    ]);
    expect(layout(GOAL_WORKFLOW_IDS.review)).toEqual([
      'goal-review:parallelReview',
      'goal-consolidate:consolidate',
      'goal-final:finalGate',
    ]);
    expect(layout(GOAL_WORKFLOW_IDS.verification)).toEqual(['goal-build:build', 'goal-test:test']);
    expect(layout(GOAL_WORKFLOW_IDS.authoring)).toEqual(['goal-author:planner']);
    const modes = Object.fromEntries(GOAL_BUILTIN_WORKFLOWS.map((w) => [w.id, w.permissionMode]));
    expect(modes).toEqual({
      'goal-planning-v1': 'normal',
      'goal-execution-v1': 'yolo',
      'goal-review-v1': 'normal',
      'goal-verification-v1': 'normal',
      'goal-authoring-v1': 'normal',
    });
    const execution = GOAL_BUILTIN_WORKFLOWS.find((w) => w.id === GOAL_WORKFLOW_IDS.execution)!;
    expect(execution.stages.find((s) => s.kind === 'gitCommit')?.allowNoChanges).toBe(true);
    // The deterministic verification workflow contains no model-backed stage.
    expect(
      GOAL_BUILTIN_WORKFLOWS.find((w) => w.id === GOAL_WORKFLOW_IDS.verification)!.stages.map((s) => s.kind),
    ).toEqual(['build', 'test']);
  });

  it('satisfy validateGoalDefinitionContext for a Goal that routes to them', () => {
    const definition = simpleDefinition();
    definition.routing.workflows = {
      planning: GOAL_WORKFLOW_IDS.planning,
      execution: GOAL_WORKFLOW_IDS.execution,
      review: GOAL_WORKFLOW_IDS.review,
      verification: GOAL_WORKFLOW_IDS.verification,
    };
    definition.limits.maxParallelAgents = 2;
    const contexts = GOAL_BUILTIN_WORKFLOWS.map((w) => ({
      id: w.id,
      billingMode: w.billingMode!,
      isolatedWorktree: w.isolatedWorktree,
      maxParallelAgents: w.maxParallelAgents,
      permissionMode: w.permissionMode,
      stages: w.stages,
    }));
    expect(validateGoalDefinitionContext(definition, contexts)).toMatchObject({ valid: true, errors: [] });
  });
});

describe('seeding built-in Goal workflows', () => {
  it('seeds every reserved workflow into a fresh database, exactly once', () => {
    const { db, root } = open();
    for (const id of Object.values(GOAL_WORKFLOW_IDS)) expect(row(db, id)).toBeDefined();
    expect(seedGoalBuiltinWorkflows(db)).toEqual({ seeded: [], conflicts: [] });
    db.close();
    dbs.pop();
    const again = open(root).db;
    expect(again.prepare('SELECT COUNT(*) AS n FROM workflows').get()).toEqual({
      n: DEFAULT_WORKFLOWS.length + GOAL_BUILTIN_WORKFLOWS.length,
    });
    expect(toWorkflow(row(again, GOAL_WORKFLOW_IDS.execution)!).permissionMode).toBe('yolo');
  });

  it('adds the built-ins to an existing database without touching existing or user workflows', () => {
    const { db, root } = open();
    // Simulate an RC2/RC3 database: defaults plus a user workflow, no Goal built-ins, and a customised default.
    db.prepare("DELETE FROM workflows WHERE template = 'goal-builtin'").run();
    db.prepare("UPDATE workflows SET description = 'my edit', version = 7 WHERE id = 'quick-fix'").run();
    db.prepare(
      "INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES ('mine', 'Mine', 'user', 'custom', '{}', 1, 0, 'x', 'x')",
    ).run();
    const before = db.prepare('SELECT * FROM workflows WHERE id IN (?, ?)').all('quick-fix', 'mine');
    db.close();
    dbs.pop();
    const reopened = open(root).db;
    for (const id of Object.values(GOAL_WORKFLOW_IDS)) expect(row(reopened, id)).toBeDefined();
    expect(reopened.prepare('SELECT * FROM workflows WHERE id IN (?, ?)').all('quick-fix', 'mine')).toEqual(
      before,
    );
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM workflows').get()).toEqual({
      n: DEFAULT_WORKFLOWS.length + 1 + GOAL_BUILTIN_WORKFLOWS.length,
    });
  });

  it('reports a materially different reserved id as a conflict and never overwrites it', () => {
    const { db, root } = open();
    const customised = JSON.stringify({ permissionMode: 'enigma', stages: [] });
    db.prepare('UPDATE workflows SET config_json = ? WHERE id = ?').run(
      customised,
      GOAL_WORKFLOW_IDS.execution,
    );
    db.close();
    dbs.pop();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reopened = open(root).db;
    expect(row(reopened, GOAL_WORKFLOW_IDS.execution)!.config_json).toBe(customised);
    const reported = reopened
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(GOAL_BUILTIN_CONFLICTS_KEY) as {
      value: string;
    };
    expect(JSON.parse(reported.value)).toEqual([GOAL_WORKFLOW_IDS.execution]);
    expect(warn).toHaveBeenCalled();
    // The other reserved workflows are unaffected.
    expect(row(reopened, GOAL_WORKFLOW_IDS.planning)).toBeDefined();
  });

  it('does not seed a user workflow that merely shares the generated slug (the API refuses the id)', () => {
    const { db } = open();
    const before = row(db, GOAL_WORKFLOW_IDS.planning);
    expect(seedGoalBuiltinWorkflows(db).seeded).toEqual([]);
    expect(row(db, GOAL_WORKFLOW_IDS.planning)).toEqual(before);
  });
});

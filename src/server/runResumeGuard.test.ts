import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { RunEngine } from './runEngine.js';
import { buildPreview, createRunOrigin, queueRun } from './runLauncher.js';

const NOW = '2026-01-01T00:00:00.000Z';

describe('run resume guard', () => {
  let root = '';
  let db: ReturnType<typeof openDatabase>;
  let engine: RunEngine;
  let app: ReturnType<typeof createApp>;
  let projectId = '';
  let workflowId = '';
  let start: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'turing-resume-guard-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, 'package.json'), '{}');
    db = openDatabase(join(root, 'state'));
    engine = new RunEngine(db, () => undefined);
    // Resume starts the engine. The guard is exercised without executing any stage.
    start = vi.spyOn(engine, 'start').mockImplementation(() => {});
    app = createApp({ database: db, engine });
    await app.ready();
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    projectId = added.json().project.id as string;
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Resume guard',
        description: 'Single approval gate.',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: false,
        stages: [{ id: 'gate', label: 'Gate', kind: 'humanApproval' }],
      },
    });
    workflowId = workflow.json().workflow.id as string;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Seeds an approved Goal with one execution cycle, so a Goal-origin run can be queued against it. */
  function seedGoalCycle(goalId: string) {
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    db.prepare(
      `INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'G', 'draft', ?, ?)`,
    ).run(goalId, machineId, projectId, NOW, NOW);
    db.prepare(
      `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
       VALUES (?, ?, 'definition', 'low', 'seed', 'user', '{"version":1,"definitionHash":"h"}', 'pending', ?)`,
    ).run(`${goalId}-approval`, goalId, NOW);
    db.prepare(
      "UPDATE goal_approvals SET status = 'approved', decided_by = 'user', responded_at = ? WHERE id = ?",
    ).run(NOW, `${goalId}-approval`);
    db.prepare(
      `INSERT INTO goal_definition_versions (goal_id, version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
         definition_hash, change_summary, created_by, approved_by, approval_id, created_at, approved_at)
       VALUES (?, 1, 'approved', '{}', '[]', '{}', '{}', '{}', 'h', 's', 'user', 'user', ?, ?, ?)`,
    ).run(goalId, `${goalId}-approval`, NOW, NOW);
    const cycleId = `${goalId}-cycle`;
    db.prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at)
       VALUES (?, ?, 1, 1, 'execution', 't', 'planned', ?)`,
    ).run(cycleId, goalId, NOW);
    return cycleId;
  }

  /**
   * A run persisted in the given status, with its single gate stage marked failed so a resume would visibly touch it.
   * With `goalCycleId` the run is queued as a Goal-owned run, the only way a run row can carry a Goal origin.
   */
  async function persistedRun(status: 'paused' | 'failed', goalCycleId?: string) {
    const preview = await buildPreview(db, { task: 'Resume task.', projectId, workflowId });
    expect(preview).not.toBeNull();
    const origin = goalCycleId ? createRunOrigin(goalCycleId, 'execution') : undefined;
    const { runId } = queueRun(db, { ...preview!, origin });
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
    db.prepare("UPDATE stages SET status = 'failed', error = 'boom' WHERE run_id = ?").run(runId);
    return { runId };
  }

  const stageStatuses = (runId: string) =>
    (
      db.prepare('SELECT status FROM stages WHERE run_id = ? ORDER BY sequence').all(runId) as Array<{
        status: string;
      }>
    ).map((row) => row.status);

  const resume = (runId: string) => app.inject({ method: 'POST', url: `/api/runs/${runId}/resume` });

  it('resumes an ordinary paused run with 202 and starts the engine', async () => {
    const { runId } = await persistedRun('paused');
    const response = await resume(runId);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(start).toHaveBeenCalledExactlyOnceWith(runId, true);
  });

  it('refuses to resume a paused route-probe run before touching its stages or starting the engine', async () => {
    const { runId } = await persistedRun('paused');
    db.prepare(
      `INSERT INTO route_validation_probes (id, run_id, identity_hash, identity_json, freshness_class, profiles_json,
         fixture_commit, status, created_at) VALUES ('probe-resume', ?, ?, '{}', 'opportunity', '["broker-read"]', ?, 'pending', ?)`,
    ).run(runId, 'a'.repeat(64), 'b'.repeat(40), NOW);
    const response = await resume(runId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'This run is a route validation probe. Its reconciler owns it.',
    });
    expect(start).not.toHaveBeenCalled();
    expect(stageStatuses(runId)).toEqual(['failed']);
  });

  it('refuses to resume a paused Goal-owned run before touching its stages or starting the engine', async () => {
    const { runId } = await persistedRun('paused', seedGoalCycle('goal-resume'));
    const response = await resume(runId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'This run belongs to a Grand Project, which starts and retires it. It cannot be resumed here.',
    });
    expect(start).not.toHaveBeenCalled();
    expect(stageStatuses(runId)).toEqual(['failed']);
  });
});

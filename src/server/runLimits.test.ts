import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKFLOWS } from '../shared/workflows.js';
import type { WorkflowDefinition } from '../shared/types.js';
import { openDatabase } from './db.js';
import { RunEngine } from './runEngine.js';

describe('workflow runtime limits', () => {
  let root = '';
  afterEach(() => {
    vi.useRealTimers();
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('persists a clear paused-limit status and stops an active approval wait when the overall deadline expires', async () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'turing-run-limit-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    const db = openDatabase(join(root, 'state'));
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      ...DEFAULT_WORKFLOWS[0]!,
      id: 'duration-test',
      name: 'Duration test',
      createdAt: now,
      updatedAt: now,
      isolatedWorktree: false,
      maxDurationMinutes: 1,
      stages: [{ id: 'approval', label: 'Wait for approval', kind: 'humanApproval', timeoutMinutes: 2 }],
    };
    db.prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'project',
      machineId,
      'Runtime fixture',
      projectPath,
      now,
    );
    db.prepare(
      `INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      workflow.id,
      workflow.name,
      workflow.description,
      workflow.template,
      JSON.stringify(workflow),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, status, created_at) VALUES ('run', ?, 'project', ?, ?, 'keep work inspectable', 'economy', 'normal', 'queued', ?)`,
    ).run(machineId, workflow.id, JSON.stringify(workflow), now);
    db.prepare(
      `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, logs)
       VALUES ('stage', 'run', 'approval', 'humanApproval', 'Wait for approval', 0, 'pending', '')`,
    ).run();

    const engine = new RunEngine(db, () => undefined);
    engine.start('run');
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM runs WHERE id = 'run'").get()).toMatchObject({
        status: 'waiting_for_approval',
      });
    });

    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status, summary FROM runs WHERE id = 'run'").get()).toMatchObject({
        status: 'paused_limit_reached',
        summary: expect.stringContaining('Maximum workflow duration of 1 minute reached'),
      });
    });
    expect(db.prepare("SELECT status, error FROM stages WHERE id = 'stage'").get()).toMatchObject({
      status: 'cancelled',
    });
    expect(
      db.prepare("SELECT type FROM run_events WHERE run_id = 'run' ORDER BY created_at DESC LIMIT 1").get(),
    ).toMatchObject({ type: 'run_paused_limit_reached' });
    db.close();
  });

  it('persists a clear failed state when a shorter stage-specific timeout expires', async () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'turing-stage-timeout-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    const db = openDatabase(join(root, 'state'));
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      ...DEFAULT_WORKFLOWS[0]!,
      id: 'stage-timeout-test',
      name: 'Stage timeout test',
      createdAt: now,
      updatedAt: now,
      isolatedWorktree: false,
      maxDurationMinutes: 2,
      stages: [{ id: 'approval', label: 'Wait for approval', kind: 'humanApproval', timeoutMinutes: 1 }],
    };
    db.prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'project',
      machineId,
      'Runtime fixture',
      projectPath,
      now,
    );
    db.prepare(
      `INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      workflow.id,
      workflow.name,
      workflow.description,
      workflow.template,
      JSON.stringify(workflow),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, status, created_at) VALUES ('run', ?, 'project', ?, ?, 'keep work inspectable', 'economy', 'normal', 'queued', ?)`,
    ).run(machineId, workflow.id, JSON.stringify(workflow), now);
    db.prepare(
      `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, logs)
       VALUES ('stage', 'run', 'approval', 'humanApproval', 'Wait for approval', 0, 'pending', '')`,
    ).run();

    const engine = new RunEngine(db, () => undefined);
    engine.start('run');
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM runs WHERE id = 'run'").get()).toMatchObject({
        status: 'waiting_for_approval',
      });
    });

    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status, summary FROM runs WHERE id = 'run'").get()).toMatchObject({
        status: 'failed',
        summary: 'Stage timed out after 1 minute.',
      });
    });
    expect(db.prepare("SELECT status, error FROM stages WHERE id = 'stage'").get()).toMatchObject({
      status: 'failed',
      error: 'Stage timed out after 1 minute.',
    });
    db.close();
  });
});

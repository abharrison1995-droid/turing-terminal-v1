import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { RunEngine } from './runEngine.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('local database', () => {
  it('applies migrations and seeds defaults idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-db-'));
    folders.push(root);
    let db = openDatabase(root);
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()).toHaveLength(32);
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '009_stage_attempts.sql'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '010_usage_quotas.sql'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '011_phase3_notifications.sql'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '013_model_run_snapshots.sql'").get(),
    ).toBeTruthy();
    for (const table of [
      'metered_reservations',
      'decision_results',
      'model_catalog_cache',
      'external_data_consents',
      'model_observation_refreshes',
      'model_observations',
      'model_observation_admission_refs',
      'model_opportunity_admission_proofs',
      'model_observation_retention_jobs',
    ])
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      ).toBeTruthy();
    const countWhere = (where: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM workflows WHERE ${where}`).get() as { count: number }).count;
    // Five ordinary seeded workflows plus the six reserved Goal built-ins, seeded idempotently.
    expect(countWhere("id NOT LIKE 'goal-%'")).toBe(5);
    expect(countWhere("id LIKE 'goal-%-v1'")).toBe(6);
    expect((db.prepare('SELECT COUNT(*) AS count FROM machines').get() as { count: number }).count).toBe(1);
    db.close();
    db = openDatabase(root);
    const countWorkflows = (where: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM workflows WHERE ${where}`).get() as { count: number }).count;
    // Five ordinary seeded workflows plus the six reserved Goal built-ins, seeded idempotently.
    expect(countWorkflows("id NOT LIKE 'goal-%'")).toBe(5);
    expect(countWorkflows("id LIKE 'goal-%-v1'")).toBe(6);
    db.close();
  });

  it('pauses in-flight approvals after restart and closes the pending decision', () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-recovery-'));
    folders.push(root);
    const db = openDatabase(root);
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, machine_id, name, path, created_at) VALUES ('project', ?, 'Recovery test', ?, ?)`,
    ).run(machineId, join(root, 'project'), now);
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
      VALUES ('run', ?, 'project', 'quick-fix', '{}', 'test', 'balanced', 'supervised', 'waiting_for_approval', ?)`,
    ).run(machineId, now);
    db.prepare(
      `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, started_at, logs)
      VALUES ('stage', 'run', 'approval', 'humanApproval', 'Approval', 0, 'waiting_for_approval', ?, '')`,
    ).run(now);
    db.prepare(
      `INSERT INTO approvals (id, run_id, stage_id, operation, reason, risk, status, created_at)
      VALUES ('approval', 'run', 'stage', 'Approval', 'Test', 'medium', 'pending', ?)`,
    ).run(now);

    const engine = new RunEngine(db, () => undefined);
    engine.reconcileInterruptedRuns();
    expect((db.prepare("SELECT status FROM runs WHERE id = 'run'").get() as { status: string }).status).toBe(
      'paused',
    );
    expect(
      (db.prepare("SELECT status FROM stages WHERE id = 'stage'").get() as { status: string }).status,
    ).toBe('pending');
    expect(
      (db.prepare("SELECT status FROM approvals WHERE id = 'approval'").get() as { status: string }).status,
    ).toBe('denied');
    db.close();
  });
});

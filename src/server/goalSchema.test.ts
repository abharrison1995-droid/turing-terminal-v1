import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from './db.js';

// Each upgrade test replays every migration into a fresh database; that is I/O-bound and slow when the whole suite
// runs in parallel on a busy disk, so these tests get a larger timeout than the 5s default (assertions unchanged).
vi.setConfig({ testTimeout: 30_000 });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const NOW = '2026-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(40);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'turing-goal-schema-'));
  folders.push(root);
  return root;
}

function fresh(): Db {
  return openDatabase(tempRoot());
}

/** Builds a schema from the migrations strictly before `through` (default: exact RC2, 001-014) with some history, then returns the data dir. */
function rc2Directory(through = '015'): string {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  const raw = new Database(join(root, 'turing.sqlite'));
  raw.pragma('foreign_keys = ON');
  raw.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const directory = join(process.cwd(), 'migrations');
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith('.sql') && file < through)
    .sort()) {
    raw.exec(readFileSync(join(directory, name), 'utf8'));
    raw.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, NOW);
  }
  raw
    .prepare(
      "INSERT INTO machines (id, name, hostname, os, status, last_seen_at) VALUES ('m1','m','h','linux','online',?)",
    )
    .run(NOW);
  raw.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('local_machine_id','m1',?)").run(NOW);
  raw
    .prepare(
      "INSERT INTO projects (id, machine_id, name, path, created_at) VALUES ('p1','m1','P','/tmp/p',?)",
    )
    .run(NOW);
  raw
    .prepare(
      "INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES ('w','W','d','t','{}',1,0,?,?)",
    )
    .run(NOW, NOW);
  raw
    .prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
       VALUES ('r1','m1','p1','w','{}','history','economy','normal','completed',?)`,
    )
    .run(NOW);
  raw.close();
  return root;
}

function machineId(db: Db): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string })
    .value;
}

function project(db: Db, id: string): void {
  db.prepare("INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, 'P', ?, ?)").run(
    id,
    machineId(db),
    `/tmp/${id}`,
    NOW,
  );
}

function goal(db: Db, id: string, projectId: string, status = 'draft', extra: Record<string, unknown> = {}) {
  db.prepare(
    `INSERT INTO goals (id, machine_id, project_id, title, status, current_definition_version, active_milestone_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Goal', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    machineId(db),
    projectId,
    status,
    extra.currentDefinitionVersion ?? null,
    extra.activeMilestoneId ?? null,
    NOW,
    NOW,
  );
}

/** Seeds a decided user approval bound to (goal, version, hash) so an approved definition can be inserted legitimately. */
function boundApproval(
  db: Db,
  goalId: string,
  version: number,
  hash = 'hash',
  gate = 'definition',
  id = `appr-${goalId}-${version}`,
) {
  db.prepare(
    `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
     VALUES (?, ?, ?, 'low', 'seed', 'user', ?, 'pending', ?)`,
  ).run(id, goalId, gate, JSON.stringify({ version, definitionHash: hash }), NOW);
  db.prepare(
    "UPDATE goal_approvals SET status = 'approved', decided_by = 'user', responded_at = ? WHERE id = ?",
  ).run(NOW, id);
  return id;
}

function definition(db: Db, goalId: string, version: number, status = 'proposed') {
  const approvalId = status === 'approved' ? boundApproval(db, goalId, version) : null;
  db.prepare(
    `INSERT INTO goal_definition_versions
     (goal_id, version, parent_version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
      definition_hash, change_summary, created_by, approved_by, approval_id, created_at, approved_at)
     VALUES (?, ?, NULL, ?, '{}', '[]', '{}', '{}', '{}', 'hash', 'initial', 'user', ?, ?, ?, ?)`,
  ).run(
    goalId,
    version,
    status,
    status === 'approved' ? 'user' : null,
    approvalId,
    NOW,
    status === 'approved' ? NOW : null,
  );
}

function milestone(db: Db, id: string, goalId: string, key = id) {
  db.prepare(
    "INSERT INTO goal_milestones (id, goal_id, milestone_key, ordinal, status) VALUES (?, ?, ?, 0, 'pending')",
  ).run(id, goalId, key);
}

function cycle(
  db: Db,
  id: string,
  goalId: string,
  sequence: number,
  kind: string,
  definitionVersion: number | null,
  milestoneId: string | null = null,
) {
  // These tests exercise the schema's columns, not the cycle lifecycle, so fixtures insert finished cycles: migration 020
  // allows only one unfinished cycle per Goal.
  db.prepare(
    `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'test', 'cancelled', ?)`,
  ).run(id, goalId, definitionVersion, milestoneId, sequence, kind, NOW);
}

function run(db: Db, id: string, projectId: string, origin: Record<string, string | null> = {}) {
  db.prepare(
    `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at,
       goal_cycle_id, goal_run_purpose, goal_base_commit)
     VALUES (?, ?, ?, ?, '{}', 'task', 'economy', 'normal', 'queued', ?, ?, ?, ?)`,
  ).run(
    id,
    machineId(db),
    projectId,
    (db.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string }).id,
    NOW,
    origin.cycle ?? null,
    origin.purpose ?? null,
    origin.base ?? null,
  );
}

function seedGoalWithDefinition(db: Db, goalId: string, projectId: string) {
  goal(db, goalId, projectId);
  definition(db, goalId, 1, 'approved');
  milestone(db, `${goalId}-m1`, goalId);
  db.prepare('UPDATE goals SET current_definition_version = 1, active_milestone_id = ? WHERE id = ?').run(
    `${goalId}-m1`,
    goalId,
  );
}

const GOAL_TABLES = [
  'goals',
  'goal_definition_versions',
  'goal_milestones',
  'goal_runtime',
  'goal_cycles',
  'goal_integration_ops',
];

describe('migration 015_goal_core', () => {
  it('creates the Goal schema on a fresh database with foreign keys enabled', () => {
    const db = fresh();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '015_goal_core.sql'").get(),
    ).toBeTruthy();
    for (const table of GOAL_TABLES)
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      ).toBeTruthy();
    const columns = (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toEqual(
      expect.arrayContaining(['goal_cycle_id', 'goal_run_purpose', 'goal_base_commit']),
    );
    expect(columns).not.toContain('goal_id');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades an exact RC2 database in place, keeping history and enforcing foreign keys', () => {
    const root = rc2Directory();
    const before = new Database(join(root, 'turing.sqlite'), { readonly: true });
    expect(before.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 14 });
    expect(
      (before.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).some((c) =>
        c.name.startsWith('goal'),
      ),
    ).toBe(false);
    before.close();

    const db = openDatabase(root);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(
      db
        .prepare("SELECT status, goal_cycle_id, goal_run_purpose, goal_base_commit FROM runs WHERE id = 'r1'")
        .get(),
    ).toEqual({
      status: 'completed',
      goal_cycle_id: null,
      goal_run_purpose: null,
      goal_base_commit: null,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // ALTER TABLE ADD COLUMN ... REFERENCES is enforced on the migrated runs table.
    expect(() => run(db, 'bad', 'p1', { cycle: 'missing-cycle', purpose: 'execution' })).toThrow(
      /FOREIGN KEY/,
    );
    // The pre-existing run still accepts ordinary updates.
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = 'r1'").run();
    db.close();
  });

  it('is idempotent across reopen', () => {
    const root = tempRoot();
    openDatabase(root).close();
    const db = openDatabase(root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    db.close();
  });
});

describe('Goal foreign keys and deferred circular references', () => {
  it('defers the Goal to definition and milestone pointers until commit', () => {
    const db = fresh();
    project(db, 'p');
    const write = db.transaction(() => {
      goal(db, 'g', 'p', 'draft', { currentDefinitionVersion: 1, activeMilestoneId: 'm' });
      definition(db, 'g', 1, 'approved');
      milestone(db, 'm', 'g');
    });
    write();
    expect(
      db.prepare('SELECT current_definition_version AS v, active_milestone_id AS m FROM goals').get(),
    ).toEqual({
      v: 1,
      m: 'm',
    });
    db.close();
  });

  it('rejects a dangling current definition or active milestone at commit', () => {
    const db = fresh();
    project(db, 'p');
    expect(db.transaction(() => goal(db, 'g1', 'p', 'draft', { currentDefinitionVersion: 7 }))).toThrow(
      /FOREIGN KEY/,
    );
    expect(db.transaction(() => goal(db, 'g2', 'p', 'draft', { activeMilestoneId: 'nope' }))).toThrow(
      /FOREIGN KEY/,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM goals').get()).toEqual({ n: 0 });
    db.close();
  });

  it('allows a draft Goal with NULL pointers', () => {
    const db = fresh();
    project(db, 'p');
    goal(db, 'g', 'p');
    expect(db.prepare('SELECT current_definition_version AS v FROM goals').get()).toEqual({ v: null });
    db.close();
  });

  it('protects project, machine and ownership references', () => {
    const db = fresh();
    expect(() => goal(db, 'g', 'no-project')).toThrow(/FOREIGN KEY/);
    project(db, 'p');
    goal(db, 'g', 'p');
    expect(() => definition(db, 'missing-goal', 1)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("DELETE FROM goals WHERE id = 'g'").run()).not.toThrow();
    db.close();
  });

  it('does not delete a Goal that has history', () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    expect(() => db.prepare("DELETE FROM goals WHERE id = 'g'").run()).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

describe('Goal definition invariants', () => {
  it('permits only one approved definition per Goal', () => {
    const db = fresh();
    project(db, 'p');
    goal(db, 'g', 'p');
    definition(db, 'g', 1, 'approved');
    expect(() => definition(db, 'g', 2, 'approved')).toThrow(/UNIQUE/);
    definition(db, 'g', 2, 'proposed');
    const approval2 = boundApproval(db, 'g', 2, 'hash', 'definition', 'appr-g-2b');
    expect(() =>
      db
        .prepare(
          "UPDATE goal_definition_versions SET status = 'approved', approved_by = 'user', approved_at = ?, approval_id = ? WHERE goal_id = 'g' AND version = 2",
        )
        .run(NOW, approval2),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('supports an atomic amendment: N superseded, N+1 approved, pointer moved', () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    definition(db, 'g', 2, 'proposed');
    db.prepare(
      "UPDATE goal_definition_versions SET parent_version = 1 WHERE goal_id = 'g' AND version = 2",
    ).run();
    const approval2 = boundApproval(db, 'g', 2, 'hash', 'amendment');
    db.transaction(() => {
      db.prepare(
        "UPDATE goal_definition_versions SET status = 'superseded' WHERE goal_id = 'g' AND version = 1",
      ).run();
      db.prepare(
        "UPDATE goal_definition_versions SET status = 'approved', approved_by = 'user', approved_at = ?, approval_id = ? WHERE goal_id = 'g' AND version = 2",
      ).run(NOW, approval2);
      db.prepare("UPDATE goals SET current_definition_version = 2 WHERE id = 'g'").run();
    })();
    expect(db.prepare('SELECT version, status FROM goal_definition_versions ORDER BY version').all()).toEqual(
      [
        { version: 1, status: 'superseded' },
        { version: 2, status: 'approved' },
      ],
    );
    expect(db.prepare("SELECT current_definition_version AS v FROM goals WHERE id = 'g'").get()).toEqual({
      v: 2,
    });
    db.close();
  });

  it('rolls back an amendment that points at a missing version', () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    expect(
      db.transaction(() => {
        db.prepare("UPDATE goals SET current_definition_version = 9 WHERE id = 'g'").run();
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT current_definition_version AS v FROM goals WHERE id = 'g'").get()).toEqual({
      v: 1,
    });
    db.close();
  });

  it('keeps decided definitions immutable and enforces status transitions', () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    for (const column of [
      'contract_json',
      'milestones_json',
      'routing_json',
      'review_json',
      'limits_json',
      'definition_hash',
    ])
      expect(() =>
        db
          .prepare(
            `UPDATE goal_definition_versions SET ${column} = 'changed' WHERE goal_id = 'g' AND version = 1`,
          )
          .run(),
      ).toThrow(/immutable/);
    expect(() =>
      db.prepare("DELETE FROM goal_definition_versions WHERE goal_id = 'g' AND version = 1").run(),
    ).toThrow(/cannot be deleted/);
    expect(() =>
      db
        .prepare(
          "UPDATE goal_definition_versions SET status = 'proposed' WHERE goal_id = 'g' AND version = 1",
        )
        .run(),
    ).toThrow(/illegal|immutable/);
    // A proposed version stays editable and may be rejected, after which it is terminal.
    definition(db, 'g', 2, 'proposed');
    db.prepare(
      "UPDATE goal_definition_versions SET contract_json = '{\"a\":1}' WHERE goal_id = 'g' AND version = 2",
    ).run();
    db.prepare(
      "UPDATE goal_definition_versions SET status = 'rejected' WHERE goal_id = 'g' AND version = 2",
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE goal_definition_versions SET status = 'proposed' WHERE goal_id = 'g' AND version = 2",
        )
        .run(),
    ).toThrow(/illegal|immutable/);
    db.close();
  });

  it('only lets the user approve a definition', () => {
    const db = fresh();
    project(db, 'p');
    goal(db, 'g', 'p');
    definition(db, 'g', 1, 'proposed');
    const bound = boundApproval(db, 'g', 1);
    expect(() =>
      db
        .prepare(
          "UPDATE goal_definition_versions SET status = 'approved', approval_id = ? WHERE goal_id = 'g' AND version = 1",
        )
        .run(bound),
    ).toThrow(/approved by the user/);
    expect(() =>
      db
        .prepare(
          "UPDATE goal_definition_versions SET approved_by = 'authoring_run' WHERE goal_id = 'g' AND version = 1",
        )
        .run(),
    ).toThrow(/CHECK/);
    const bound2 = boundApproval(db, 'g', 2, 'h');
    expect(() =>
      db
        .prepare(
          `INSERT INTO goal_definition_versions (goal_id, version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
            definition_hash, change_summary, created_by, approval_id, created_at) VALUES ('g', 2, 'approved', '{}', '[]', '{}', '{}', '{}', 'h', 's', 'authoring_run', ?, ?)`,
        )
        .run(bound2, NOW),
    ).toThrow(/approved by the user/);
    db.close();
  });
});

describe('Goal cycle invariants', () => {
  it('allows a NULL definition version only for authoring cycles', () => {
    const db = fresh();
    project(db, 'p');
    goal(db, 'g', 'p');
    cycle(db, 'c0', 'g', 0, 'authoring', null);
    for (const [index, kind] of (['execution', 'remediation', 'review', 'verification'] as const).entries())
      expect(() => cycle(db, `bad-${kind}`, 'g', index + 1, kind, null)).toThrow(/CHECK/);
    db.close();
  });

  it('keeps the foreign key on non-null definition versions', () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    cycle(db, 'ok', 'g', 1, 'execution', 1);
    expect(() => cycle(db, 'dangling', 'g', 2, 'execution', 5)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('rejects cross-Goal definition versions, milestones and active milestones', () => {
    const db = fresh();
    project(db, 'p1');
    project(db, 'p2');
    seedGoalWithDefinition(db, 'g1', 'p1');
    seedGoalWithDefinition(db, 'g2', 'p2');
    definition(db, 'g1', 2, 'proposed');
    // Goal 2 has no version 2 even though Goal 1 does.
    expect(() => cycle(db, 'x1', 'g2', 1, 'execution', 2)).toThrow(/FOREIGN KEY/);
    // A cycle may not use another Goal's milestone.
    expect(() => cycle(db, 'x2', 'g2', 1, 'execution', 1, 'g1-m1')).toThrow(/FOREIGN KEY/);
    cycle(db, 'ok', 'g2', 1, 'execution', 1, 'g2-m1');
    // A Goal may not activate another Goal's milestone.
    expect(() => db.prepare("UPDATE goals SET active_milestone_id = 'g1-m1' WHERE id = 'g2'").run()).toThrow(
      /FOREIGN KEY/,
    );
    // Nor point at another Goal's definition version.
    expect(() => db.prepare("UPDATE goals SET current_definition_version = 2 WHERE id = 'g2'").run()).toThrow(
      /FOREIGN KEY/,
    );
    db.close();
  });

  it('enforces a unique sequence per Goal and the same-owner target keys', () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    cycle(db, 'c1', 'g', 1, 'execution', 1);
    expect(() => cycle(db, 'c2', 'g', 1, 'execution', 1)).toThrow(/UNIQUE/);
    expect(() => milestone(db, 'dup', 'g', 'g-m1')).toThrow(/UNIQUE/);
    db.close();
  });
});

describe('Goal integration operation invariants', () => {
  const op = (db: Db, id: string, goalId: string, cycleId: string | null, runId: string | null) =>
    db
      .prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, run_id, op, new_commit, status, checks_json, created_at)
         VALUES (?, ?, ?, ?, 'advance', ?, 'planned', '[]', ?)`,
      )
      .run(id, goalId, cycleId, runId, SHA, NOW);

  it('requires the cycle and run to belong to the same Goal', () => {
    const db = fresh();
    project(db, 'p1');
    project(db, 'p2');
    seedGoalWithDefinition(db, 'g1', 'p1');
    seedGoalWithDefinition(db, 'g2', 'p2');
    cycle(db, 'c1', 'g1', 1, 'execution', 1);
    cycle(db, 'c2', 'g2', 1, 'execution', 1);
    run(db, 'r1', 'p1', { cycle: 'c1', purpose: 'execution', base: SHA });
    run(db, 'r2', 'p2', { cycle: 'c2', purpose: 'execution', base: SHA });
    op(db, 'ok', 'g1', 'c1', 'r1');
    // The 016 audit hardening allows one unresolved op per Goal, so resolve it before the next.
    db.prepare("UPDATE goal_integration_ops SET status = 'applied' WHERE id = 'ok'").run();
    op(db, 'no-run', 'g1', null, null);
    db.prepare("UPDATE goal_integration_ops SET status = 'aborted' WHERE id = 'no-run'").run();
    expect(() => op(db, 'cross-cycle', 'g1', 'c2', null)).toThrow(/FOREIGN KEY/);
    expect(() => op(db, 'cross-run', 'g1', 'c1', 'r2')).toThrow(/does not belong/);
    expect(() => op(db, 'run-without-cycle', 'g1', null, 'r1')).toThrow(/does not belong/);
    db.close();
  });
});

describe('project lease', () => {
  it('allows one active Goal per project and many inactive ones', () => {
    const db = fresh();
    project(db, 'p');
    project(db, 'q');
    goal(db, 'draft1', 'p', 'draft');
    goal(db, 'draft2', 'p', 'draft');
    goal(db, 'ready1', 'p', 'ready');
    goal(db, 'done', 'p', 'completed');
    goal(db, 'running', 'p', 'running');
    for (const status of ['reviewing', 'needs_user', 'blocked', 'paused', 'running'])
      expect(() => goal(db, `second-${status}`, 'p', status)).toThrow(/UNIQUE/);
    goal(db, 'other-project', 'q', 'running');
    db.prepare("UPDATE goals SET status = 'completed' WHERE id = 'running'").run();
    goal(db, 'next', 'p', 'needs_user');
    db.close();
  });
});

describe('Goal-origin run metadata', () => {
  const seeded = () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    cycle(db, 'c1', 'g', 1, 'execution', 1);
    cycle(db, 'c0', 'g', 0, 'authoring', null);
    return db;
  };

  it('keeps ordinary runs entirely NULL and rejects partial origin', () => {
    const db = seeded();
    run(db, 'ordinary', 'p');
    expect(() => run(db, 'p1', 'p', { purpose: 'execution' })).toThrow(/inconsistent/);
    expect(() => run(db, 'p2', 'p', { base: SHA })).toThrow(/inconsistent/);
    expect(() => run(db, 'p3', 'p', { cycle: 'c1' })).toThrow(/inconsistent/);
    db.close();
  });

  it('allows a NULL base commit for authoring but validates the shape of a present one', () => {
    const db = seeded();
    run(db, 'authoring', 'p', { cycle: 'c0', purpose: 'authoring' });
    run(db, 'exec', 'p', { cycle: 'c1', purpose: 'execution', base: SHA });
    for (const [index, bad] of ['abc', 'A'.repeat(40), 'g'.repeat(40), `${SHA}0`].entries())
      expect(() => run(db, `bad${index}`, 'p', { cycle: 'c1', purpose: 'proposal', base: bad })).toThrow(
        /CHECK/,
      );
    run(db, 'sha256', 'p', { cycle: 'c1', purpose: 'review', base: 'b'.repeat(64) });
    expect(() => run(db, 'purpose', 'p', { cycle: 'c1', purpose: 'bogus', base: SHA })).toThrow(/CHECK/);
    db.close();
  });

  it('makes (cycle, purpose) unique so a duplicate launch cannot create a second run', () => {
    const db = seeded();
    run(db, 'first', 'p', { cycle: 'c1', purpose: 'execution', base: SHA });
    expect(() => run(db, 'second', 'p', { cycle: 'c1', purpose: 'execution', base: SHA })).toThrow(/UNIQUE/);
    run(db, 'review', 'p', { cycle: 'c1', purpose: 'review', base: SHA });
    expect(
      db.prepare('SELECT run_id, goal_id, cycle_id, purpose FROM goal_runs ORDER BY run_id').all(),
    ).toEqual([
      { run_id: 'first', goal_id: 'g', cycle_id: 'c1', purpose: 'execution' },
      { run_id: 'review', goal_id: 'g', cycle_id: 'c1', purpose: 'review' },
    ]);
    db.close();
  });

  it('makes origin immutable once the run exists', () => {
    const db = seeded();
    run(db, 'ordinary', 'p');
    run(db, 'exec', 'p', { cycle: 'c1', purpose: 'execution', base: SHA });
    expect(() =>
      db
        .prepare("UPDATE runs SET goal_cycle_id = 'c1', goal_run_purpose = 'review' WHERE id = 'ordinary'")
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare("UPDATE runs SET goal_base_commit = ? WHERE id = 'exec'").run('c'.repeat(40)),
    ).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE runs SET goal_cycle_id = NULL WHERE id = 'exec'").run()).toThrow(
      /immutable/,
    );
    // Ordinary updates are unaffected.
    db.prepare("UPDATE runs SET status = 'running' WHERE id = 'exec'").run();
    db.prepare("UPDATE runs SET status = 'running' WHERE id = 'ordinary'").run();
    db.close();
  });
});

describe('migration 016_goal_integration_op_audit', () => {
  it('upgrades a database that already holds 015 data, preserving integration ops', () => {
    const root = rc2Directory('016');
    const raw = new Database(join(root, 'turing.sqlite'));
    raw.pragma('foreign_keys = ON');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 15 });
    raw
      .prepare(
        "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES ('g','m1','p1','G','draft',?,?)",
      )
      .run(NOW, NOW);
    for (const [id, status] of [
      ['op-applied', 'applied'],
      ['op-planned', 'planned'],
    ] as const)
      raw
        .prepare(
          `INSERT INTO goal_integration_ops (id, goal_id, op, new_commit, status, checks_json, created_at)
           VALUES (?, 'g', 'init_ref', ?, ?, '[]', ?)`,
        )
        .run(id, SHA, status, NOW);
    raw.close();

    const db = openDatabase(root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(
      db.prepare('SELECT id, status, recovery_json FROM goal_integration_ops ORDER BY id').all(),
    ).toEqual([
      { id: 'op-applied', status: 'applied', recovery_json: null },
      { id: 'op-planned', status: 'planned', recovery_json: null },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // The new protection applies to rows that existed before the upgrade.
    expect(() =>
      db.prepare("UPDATE goal_integration_ops SET status = 'planned' WHERE id = 'op-applied'").run(),
    ).toThrow(/immutable/);
    db.prepare("UPDATE goal_integration_ops SET status = 'aborted' WHERE id = 'op-planned'").run();
    db.close();
  });
});

describe('goal integration op audit protection', () => {
  const insertOp = (db: Db, id = 'op1', extra: Partial<Record<string, string | null>> = {}) =>
    db
      .prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, op, expected_old, new_commit, status, checks_json, created_at)
         VALUES (?, 'g', ?, 'advance', ?, ?, ?, '[{"check":"c1","ok":true}]', ?)`,
      )
      .run(
        id,
        extra.cycle ?? null,
        extra.expectedOld ?? SHA,
        extra.newCommit ?? 'b'.repeat(40),
        extra.status ?? 'planned',
        NOW,
      );

  const seeded = () => {
    const db = fresh();
    project(db, 'p');
    seedGoalWithDefinition(db, 'g', 'p');
    cycle(db, 'c1', 'g', 1, 'execution', 1);
    cycle(db, 'c2', 'g', 2, 'execution', 1);
    return db;
  };

  it('rejects changes to every identity field and to the authorised checks', () => {
    const db = seeded();
    run(db, 'r1', 'p', { cycle: 'c1', purpose: 'execution', base: SHA });
    run(db, 'r2', 'p', { cycle: 'c2', purpose: 'execution', base: SHA });
    db.prepare(
      `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, run_id, op, expected_old, new_commit, status, checks_json, created_at)
       VALUES ('op1', 'g', 'c1', 'r1', 'advance', ?, ?, 'planned', '[]', ?)`,
    ).run(SHA, 'b'.repeat(40), NOW);
    const attempts: Array<[string, unknown]> = [
      ['id', 'other'],
      ['cycle_id', 'c2'],
      ['run_id', 'r2'],
      ['op', 'init_ref'],
      ['expected_old', 'c'.repeat(40)],
      ['new_commit', 'c'.repeat(40)],
      ['created_at', '2027-01-01T00:00:00.000Z'],
      ['checks_json', '[{"check":"c1","ok":false}]'],
    ];
    for (const [column, value] of attempts)
      expect(() =>
        db.prepare(`UPDATE goal_integration_ops SET ${column} = ? WHERE id = 'op1'`).run(value),
      ).toThrow(/immutable/);
    expect(() =>
      db.prepare("UPDATE goal_integration_ops SET goal_id = 'other' WHERE id = 'op1'").run(),
    ).toThrow();
    expect(() => db.prepare("DELETE FROM goal_integration_ops WHERE id = 'op1'").run()).toThrow(
      /cannot be deleted/,
    );
    db.close();
  });

  it('allows planned to become applied, aborted or failed with result fields only', () => {
    const db = seeded();
    for (const [index, status] of (['applied', 'aborted', 'failed'] as const).entries()) {
      insertOp(db, `op-${status}`, { newCommit: String(index).repeat(40) });
      db.prepare(
        'UPDATE goal_integration_ops SET status = ?, error_code = ?, finished_at = ?, recovery_json = \'{"observed":1}\' WHERE id = ?',
      ).run(status, status === 'failed' ? 'goal_ref_conflict' : null, NOW, `op-${status}`);
    }
    expect(db.prepare('SELECT id, status FROM goal_integration_ops ORDER BY id').all()).toEqual([
      { id: 'op-aborted', status: 'aborted' },
      { id: 'op-applied', status: 'applied' },
      { id: 'op-failed', status: 'failed' },
    ]);
    db.close();
  });

  it('treats applied, aborted and failed as terminal and never returns to planned', () => {
    const db = seeded();
    for (const terminal of ['applied', 'aborted', 'failed']) {
      insertOp(db, `op-${terminal}`);
      db.prepare('UPDATE goal_integration_ops SET status = ? WHERE id = ?').run(terminal, `op-${terminal}`);
      for (const next of ['planned', 'applied', 'aborted', 'failed'])
        if (next !== terminal)
          expect(() =>
            db.prepare('UPDATE goal_integration_ops SET status = ? WHERE id = ?').run(next, `op-${terminal}`),
          ).toThrow(/immutable/);
      for (const column of ['error_code', 'finished_at', 'recovery_json'])
        expect(() =>
          db.prepare(`UPDATE goal_integration_ops SET ${column} = 'x' WHERE id = ?`).run(`op-${terminal}`),
        ).toThrow(/immutable/);
    }
    db.close();
  });

  it('rejects an illegal status value and inserting a non-planned op', () => {
    const db = seeded();
    insertOp(db, 'op1');
    expect(() =>
      db.prepare("UPDATE goal_integration_ops SET status = 'bogus' WHERE id = 'op1'").run(),
    ).toThrow();
    expect(() => insertOp(db, 'op2', { status: 'applied' })).toThrow(/inserted as planned/);
    db.close();
  });

  it('allows only one unresolved operation per Goal until it is resolved', () => {
    const db = seeded();
    insertOp(db, 'op1');
    expect(() => insertOp(db, 'op2')).toThrow(/UNIQUE/);
    db.prepare("UPDATE goal_integration_ops SET status = 'applied', finished_at = ? WHERE id = 'op1'").run(
      NOW,
    );
    insertOp(db, 'op2');
    db.close();
  });

  it('lets recovery observations be recorded while planned without touching the authorised checks', () => {
    const db = seeded();
    insertOp(db, 'op1');
    db.prepare(
      'UPDATE goal_integration_ops SET recovery_json = \'{"ref":"absent"}\' WHERE id = \'op1\'',
    ).run();
    expect(
      db.prepare("SELECT checks_json, recovery_json FROM goal_integration_ops WHERE id = 'op1'").get(),
    ).toEqual({
      checks_json: '[{"check":"c1","ok":true}]',
      recovery_json: '{"ref":"absent"}',
    });
    db.close();
  });
});

describe('migration 017_goal_evidence_reviews', () => {
  const TABLES_017 = [
    'goal_evidence',
    'goal_reviews',
    'goal_findings',
    'goal_finding_observations',
    'goal_approvals',
    'goal_events',
    'route_validations',
  ];
  const TREE = 'b'.repeat(40);

  /** Two Goals on two projects, each with an approved v1, a milestone and an execution cycle, plus one run each. */
  function twoGoals(): Db {
    const db = fresh();
    project(db, 'p1');
    project(db, 'p2');
    for (const [g, p] of [
      ['g1', 'p1'],
      ['g2', 'p2'],
    ] as const) {
      seedGoalWithDefinition(db, g, p);
      cycle(db, `${g}-c`, g, 1, 'execution', 1, `${g}-m1`);
      run(db, `${g}-r`, p, { cycle: `${g}-c`, purpose: 'execution', base: SHA });
    }
    return db;
  }

  const evidence = (db: Db, id: string, goalId: string, over: Record<string, unknown> = {}) => {
    const v = {
      version: 1,
      milestone: `${goalId}-m1`,
      cycle: `${goalId}-c`,
      run: `${goalId}-r`,
      review: null,
      ...over,
    };
    db.prepare(
      `INSERT INTO goal_evidence (id, goal_id, definition_version, milestone_id, criterion_key, verifier_digest, kind, verdict,
         cycle_id, run_id, review_id, subject_tree, ref_json, recorded_at)
       VALUES (?, ?, ?, ?, 'k', 'd', 'test_result', 'satisfies', ?, ?, ?, ?, '{}', ?)`,
    ).run(id, goalId, v.version, v.milestone, v.cycle, v.run, v.review, TREE, NOW);
  };

  const review = (db: Db, id: string, goalId: string, over: Record<string, unknown> = {}) => {
    const v = { version: 1, milestone: `${goalId}-m1`, cycle: `${goalId}-c`, run: null, ...over };
    db.prepare(
      `INSERT INTO goal_reviews (id, goal_id, cycle_id, milestone_id, definition_version, run_id, review_kind, status,
         reviewed_to_commit, reviewed_to_tree, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'milestone', 'pending', ?, ?, ?)`,
    ).run(id, goalId, v.cycle, v.milestone, v.version, v.run, SHA, TREE, NOW);
  };

  const finding = (db: Db, id: string, goalId: string, reviewId: string, fingerprint = 'fp') =>
    db
      .prepare(
        `INSERT INTO goal_findings (id, goal_id, fingerprint, severity, category, description, status,
           first_seen_review_id, last_seen_review_id, created_at, updated_at)
         VALUES (?, ?, ?, 'high', 'bug', 'd', 'open', ?, ?, ?, ?)`,
      )
      .run(id, goalId, fingerprint, reviewId, reviewId, NOW, NOW);

  const approval = (db: Db, id: string, goalId: string) =>
    db
      .prepare(
        `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
         VALUES (?, ?, 'final_acceptance', 'high', 'why', 'supervisor', '{"a":1}', 'pending', ?)`,
      )
      .run(id, goalId, NOW);

  it('creates the structure on a fresh database', () => {
    const db = fresh();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of TABLES_017) expect(names).toContain(table);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades an exact RC2 database through 015 and 016 to 017', () => {
    const root = rc2Directory('015');
    const db = openDatabase(root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    for (const table of TABLES_017)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status FROM runs WHERE id = 'r1'").get()).toEqual({ status: 'completed' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades an existing 015/016 database with Goal data, preserving it', () => {
    const root = rc2Directory('017');
    const raw = new Database(join(root, 'turing.sqlite'));
    raw.pragma('foreign_keys = ON');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 16 });
    raw
      .prepare(
        "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES ('g','m1','p1','G','draft',?,?)",
      )
      .run(NOW, NOW);
    raw
      .prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, op, new_commit, status, checks_json, created_at)
         VALUES ('op', 'g', 'init_ref', ?, 'planned', '[]', ?)`,
      )
      .run(SHA, NOW);
    raw.close();
    const db = openDatabase(root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(db.prepare("SELECT status FROM goal_integration_ops WHERE id = 'op'").get()).toEqual({
      status: 'planned',
    });
    expect(db.prepare("SELECT status FROM goals WHERE id = 'g'").get()).toEqual({ status: 'draft' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    approval(db, 'a1', 'g');
    db.close();
  });

  describe('same-owner foreign keys', () => {
    it('accepts same-Goal references', () => {
      const db = twoGoals();
      review(db, 'rv', 'g1');
      evidence(db, 'e', 'g1', { review: 'rv' });
      finding(db, 'f', 'g1', 'rv');
      db.prepare(
        `INSERT INTO goal_finding_observations (id, goal_id, goal_finding_id, review_id, observation, basis, created_at)
         VALUES ('o', 'g1', 'f', 'rv', 'new', 'b', ?)`,
      ).run(NOW);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    });

    it('rejects evidence that points into another Goal', () => {
      const db = twoGoals();
      review(db, 'rv2', 'g2');
      db.prepare(
        "INSERT INTO goal_definition_versions (goal_id, version, parent_version, status, contract_json, milestones_json, routing_json, review_json, limits_json, definition_hash, change_summary, created_by, created_at) VALUES ('g2', 2, 1, 'proposed', '{}', '[]', '{}', '{}', '{}', 'h', 's', 'user', ?)",
      ).run(NOW);
      expect(() => evidence(db, 'e-milestone', 'g1', { milestone: 'g2-m1' })).toThrow(/FOREIGN KEY/);
      expect(() => evidence(db, 'e-cycle', 'g1', { cycle: 'g2-c', run: null })).toThrow(/FOREIGN KEY/);
      expect(() => evidence(db, 'e-version', 'g1', { version: 2 })).toThrow(/FOREIGN KEY/);
      expect(() => evidence(db, 'e-review', 'g1', { review: 'rv2' })).toThrow(/FOREIGN KEY/);
      expect(() => evidence(db, 'e-run', 'g1', { run: 'g2-r', cycle: null })).toThrow(/does not belong/);
      expect(() => evidence(db, 'e-run-cycle', 'g1', { run: 'g2-r' })).toThrow(/does not belong/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get()).toEqual({ n: 0 });
      db.close();
    });

    it('rejects an evidence stage that is not in the evidence run', () => {
      const db = twoGoals();
      db.prepare(
        "INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status) VALUES ('s2', 'g2-r', 'k', 'build', 'B', 0, 'passed')",
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_evidence (id, goal_id, definition_version, criterion_key, verifier_digest, kind, verdict, run_id, stage_id, ref_json, recorded_at)
             VALUES ('e', 'g1', 1, 'k', 'd', 'build_result', 'satisfies', 'g1-r', 's2', '{}', ?)`,
          )
          .run(NOW),
      ).toThrow(/does not belong/);
      db.close();
    });

    it('rejects reviews, findings and observations that cross Goals', () => {
      const db = twoGoals();
      review(db, 'rv1', 'g1');
      review(db, 'rv2', 'g2');
      expect(() => review(db, 'x1', 'g1', { cycle: 'g2-c' })).toThrow(/FOREIGN KEY/);
      expect(() => review(db, 'x2', 'g1', { milestone: 'g2-m1' })).toThrow(/FOREIGN KEY/);
      expect(() => review(db, 'x3', 'g1', { run: 'g2-r' })).toThrow(/does not belong/);
      expect(() => finding(db, 'f-x', 'g1', 'rv2')).toThrow(/FOREIGN KEY/);
      finding(db, 'f1', 'g1', 'rv1');
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_finding_observations (id, goal_id, goal_finding_id, review_id, observation, basis, created_at)
             VALUES ('o', 'g1', 'f1', 'rv2', 'new', 'b', ?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_finding_observations (id, goal_id, goal_finding_id, review_id, observation, basis, created_at)
             VALUES ('o2', 'g2', 'f1', 'rv2', 'new', 'b', ?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        db
          .prepare(
            "UPDATE goal_findings SET resolved_by_review_id = 'rv2', status = 'resolved' WHERE id = 'f1'",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
      db.close();
    });
  });

  describe('evidence', () => {
    it('is immutable and cannot be deleted', () => {
      const db = twoGoals();
      evidence(db, 'e', 'g1');
      expect(() =>
        db.prepare("UPDATE goal_evidence SET verdict = 'contradicts' WHERE id = 'e'").run(),
      ).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE goal_evidence SET criterion_key = 'x' WHERE id = 'e'").run()).toThrow(
        /immutable/,
      );
      expect(() => db.prepare("DELETE FROM goal_evidence WHERE id = 'e'").run()).toThrow(/cannot be deleted/);
      expect(db.prepare("SELECT verdict FROM goal_evidence WHERE id = 'e'").get()).toEqual({
        verdict: 'satisfies',
      });
      db.close();
    });

    it('validates its enumerations and JSON', () => {
      const db = twoGoals();
      const insert = (kind: string, verdict: string, refJson: string) =>
        db
          .prepare(
            `INSERT INTO goal_evidence (id, goal_id, definition_version, criterion_key, verifier_digest, kind, verdict, ref_json, recorded_at)
             VALUES (?, 'g1', 1, 'k', 'd', ?, ?, ?, ?)`,
          )
          .run(`e-${kind}-${verdict}`, kind, verdict, refJson, NOW);
      expect(() => insert('vibes', 'satisfies', '{}')).toThrow(/CHECK/);
      expect(() => insert('commit', 'maybe', '{}')).toThrow(/CHECK/);
      expect(() => insert('commit', 'satisfies', 'not json')).toThrow(/CHECK/);
      insert('commit', 'inconclusive', '{}');
      db.close();
    });
  });

  describe('reviews', () => {
    it('are created pending and complete exactly once with a full result', () => {
      const db = twoGoals();
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_reviews (id, goal_id, definition_version, review_kind, status, reviewed_to_commit, reviewed_to_tree, created_at)
             VALUES ('bad', 'g1', 1, 'final', 'completed', ?, ?, ?)`,
          )
          .run(SHA, TREE, NOW),
      ).toThrow(/created pending/);
      review(db, 'rv', 'g1');
      // Incomplete result: completed needs verdict, blocking, report and timestamp.
      expect(() =>
        db.prepare("UPDATE goal_reviews SET status = 'completed', verdict = 'pass' WHERE id = 'rv'").run(),
      ).toThrow(/CHECK/);
      db.prepare(
        "UPDATE goal_reviews SET status = 'completed', verdict = 'pass', blocking = 0, report_json = '{}', independence_json = '{}', completed_at = ? WHERE id = 'rv'",
      ).run(NOW);
      expect(db.prepare("SELECT status, verdict FROM goal_reviews WHERE id = 'rv'").get()).toEqual({
        status: 'completed',
        verdict: 'pass',
      });
      db.close();
    });

    it('never rewrite a completed report or its repository binding', () => {
      const db = twoGoals();
      review(db, 'rv', 'g1');
      db.prepare(
        "UPDATE goal_reviews SET status = 'completed', verdict = 'block', blocking = 1, report_json = '{}', completed_at = ? WHERE id = 'rv'",
      ).run(NOW);
      for (const sql of [
        "UPDATE goal_reviews SET verdict = 'pass' WHERE id = 'rv'",
        "UPDATE goal_reviews SET report_json = '{\"x\":1}' WHERE id = 'rv'",
        "UPDATE goal_reviews SET blocking = 0 WHERE id = 'rv'",
        `UPDATE goal_reviews SET reviewed_to_tree = '${'c'.repeat(40)}' WHERE id = 'rv'`,
        "UPDATE goal_reviews SET status = 'pending' WHERE id = 'rv'",
        "UPDATE goal_reviews SET status = 'failed', verdict = NULL, blocking = NULL, report_json = NULL WHERE id = 'rv'",
        "DELETE FROM goal_reviews WHERE id = 'rv'",
      ])
        expect(() => db.prepare(sql).run(), sql).toThrow();
      expect(db.prepare("SELECT verdict, blocking FROM goal_reviews WHERE id = 'rv'").get()).toEqual({
        verdict: 'block',
        blocking: 1,
      });
      db.close();
    });

    it('keep identity and binding fixed even while pending, and end terminally when failed or cancelled', () => {
      const db = twoGoals();
      review(db, 'rv', 'g1');
      for (const sql of [
        `UPDATE goal_reviews SET reviewed_to_commit = '${'d'.repeat(40)}' WHERE id = 'rv'`,
        `UPDATE goal_reviews SET reviewed_to_tree = '${'d'.repeat(40)}' WHERE id = 'rv'`,
        `UPDATE goal_reviews SET reviewed_from_commit = '${'d'.repeat(40)}' WHERE id = 'rv'`,
        "UPDATE goal_reviews SET review_kind = 'final' WHERE id = 'rv'",
        "UPDATE goal_reviews SET goal_id = 'g2' WHERE id = 'rv'",
        "UPDATE goal_reviews SET cycle_id = 'g1-c2' WHERE id = 'rv'",
        "UPDATE goal_reviews SET definition_version = 2 WHERE id = 'rv'",
      ])
        expect(() => db.prepare(sql).run(), sql).toThrow();
      db.prepare("UPDATE goal_reviews SET status = 'failed' WHERE id = 'rv'").run();
      expect(() => db.prepare("UPDATE goal_reviews SET status = 'cancelled' WHERE id = 'rv'").run()).toThrow(
        /immutable/,
      );
      db.close();
    });
  });

  describe('findings', () => {
    it('allow one open finding per fingerprint, fixed identity, and append-only observations', () => {
      const db = twoGoals();
      review(db, 'rv', 'g1');
      finding(db, 'f1', 'g1', 'rv');
      expect(() => finding(db, 'f2', 'g1', 'rv')).toThrow(/UNIQUE/);
      finding(db, 'f3', 'g1', 'rv', 'other');
      expect(() => db.prepare("UPDATE goal_findings SET fingerprint = 'z' WHERE id = 'f1'").run()).toThrow(
        /identity/,
      );
      expect(() => db.prepare("UPDATE goal_findings SET status = 'resolved' WHERE id = 'f1'").run()).toThrow(
        /CHECK/,
      );
      db.prepare(
        "UPDATE goal_findings SET status = 'resolved', resolved_by_review_id = 'rv' WHERE id = 'f1'",
      ).run();
      finding(db, 'f4', 'g1', 'rv'); // a resolved fingerprint can be reported again as a new finding
      db.prepare(
        `INSERT INTO goal_finding_observations (id, goal_id, goal_finding_id, review_id, observation, basis, created_at)
         VALUES ('o', 'g1', 'f1', 'rv', 'resolved', 'b', ?)`,
      ).run(NOW);
      expect(() =>
        db.prepare("UPDATE goal_finding_observations SET basis = 'x' WHERE id = 'o'").run(),
      ).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM goal_finding_observations WHERE id = 'o'").run()).toThrow(
        /append-only/,
      );
      expect(() => db.prepare("DELETE FROM goal_findings WHERE id = 'f1'").run()).toThrow(
        /cannot be deleted/,
      );
      db.close();
    });
  });

  describe('goal approvals', () => {
    it('move pending -> approved by the user and are then immutable', () => {
      const db = twoGoals();
      approval(db, 'a', 'g1');
      db.prepare(
        "UPDATE goal_approvals SET status = 'approved', decided_by = 'user', decision_note = 'ok', responded_at = ? WHERE id = 'a'",
      ).run(NOW);
      for (const sql of [
        "UPDATE goal_approvals SET status = 'denied' WHERE id = 'a'",
        "UPDATE goal_approvals SET decision_note = 'changed' WHERE id = 'a'",
        "UPDATE goal_approvals SET status = 'pending' WHERE id = 'a'",
        "DELETE FROM goal_approvals WHERE id = 'a'",
      ])
        expect(() => db.prepare(sql).run(), sql).toThrow();
      db.close();
    });

    it('can be denied by the user or the system, but approved only by the user', () => {
      const db = twoGoals();
      approval(db, 'a1', 'g1');
      approval(db, 'a2', 'g1');
      approval(db, 'a3', 'g1');
      expect(() =>
        db
          .prepare(
            "UPDATE goal_approvals SET status = 'approved', decided_by = 'system', responded_at = ? WHERE id = 'a1'",
          )
          .run(NOW),
      ).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE goal_approvals SET status = 'approved' WHERE id = 'a1'").run()).toThrow(
        /CHECK/,
      );
      expect(() =>
        db
          .prepare(
            "UPDATE goal_approvals SET status = 'approved', decided_by = 'model', responded_at = ? WHERE id = 'a1'",
          )
          .run(NOW),
      ).toThrow(/CHECK/);
      db.prepare(
        "UPDATE goal_approvals SET status = 'denied', decided_by = 'system', responded_at = ? WHERE id = 'a2'",
      ).run(NOW);
      db.prepare(
        "UPDATE goal_approvals SET status = 'denied', decided_by = 'user', responded_at = ? WHERE id = 'a3'",
      ).run(NOW);
      expect(db.prepare("SELECT status FROM goal_approvals WHERE id = 'a1'").get()).toEqual({
        status: 'pending',
      });
      db.close();
    });

    it('fix their identity, start pending and validate gate and risk', () => {
      const db = twoGoals();
      approval(db, 'a', 'g1');
      for (const column of ['gate', 'risk', 'reason', 'requested_by', 'detail_json', 'goal_id', 'created_at'])
        expect(
          () =>
            db
              .prepare(`UPDATE goal_approvals SET ${column} = ? WHERE id = 'a'`)
              .run(
                column === 'gate'
                  ? 'start'
                  : column === 'risk'
                    ? 'low'
                    : column === 'requested_by'
                      ? 'user'
                      : column === 'detail_json'
                        ? '{}'
                        : 'g2',
              ),
          column,
        ).toThrow();
      const insert = (gate: string, risk: string, status: string) =>
        db
          .prepare(
            `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, status, created_at) VALUES (?, 'g1', ?, ?, 'r', 'user', ?, ?)`,
          )
          .run(`x-${gate}-${risk}-${status}`, gate, risk, status, NOW);
      expect(() => insert('teleport', 'low', 'pending')).toThrow(/CHECK/);
      expect(() => insert('start', 'extreme', 'pending')).toThrow(/CHECK/);
      expect(() => insert('start', 'low', 'approved')).toThrow();
      insert('start', 'low', 'pending');
      db.close();
    });
  });

  describe('events and route validations', () => {
    it('keeps events append-only with bounded valid JSON payloads', () => {
      const db = twoGoals();
      const insert = (id: string, payload: string) =>
        db
          .prepare(
            "INSERT INTO goal_events (id, goal_id, type, payload_json, created_at) VALUES (?, 'g1', 't', ?, ?)",
          )
          .run(id, payload, NOW);
      insert('e1', '{"a":1}');
      expect(() => insert('e2', 'not json')).toThrow(/CHECK/);
      expect(() => insert('e3', JSON.stringify({ big: 'x'.repeat(17_000) }))).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE goal_events SET type = 'x' WHERE id = 'e1'").run()).toThrow(
        /append-only/,
      );
      expect(() => db.prepare("DELETE FROM goal_events WHERE id = 'e1'").run()).toThrow(/append-only/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO goal_events (id, goal_id, type, payload_json, created_at) VALUES ('e4', 'missing', 't', '{}', ?)",
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY/);
      db.close();
    });

    it('stores exact-route validation records with integrity and immutability', () => {
      const db = twoGoals();
      const insert = (id: string, over: Record<string, string | null> = {}) => {
        const v = {
          profile: 'review-json',
          status: 'pass',
          run: 'g1-r',
          tested: '2026-01-01T00:00:00.000Z',
          expires: '2026-01-08T00:00:00.000Z',
          checks: '[]',
          ...over,
        };
        db.prepare(
          `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, evidence_run_id, resolved_model_reported,
             checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
           VALUES (?, 'hash', '{"model":"m"}', ?, ?, ?, 'm-2026', ?, 'turing_probe_run', '1.0', 'fp', ?, ?)`,
        ).run(id, v.profile, v.status, v.run, v.checks, v.tested, v.expires);
      };
      insert('v1');
      expect(() => insert('v2', { run: 'missing-run' })).toThrow(/FOREIGN KEY/);
      expect(() => insert('v3', { profile: 'vibes' })).toThrow(/CHECK/);
      expect(() => insert('v4', { status: 'maybe' })).toThrow(/CHECK/);
      expect(() => insert('v5', { expires: '2025-01-01T00:00:00.000Z' })).toThrow(/CHECK/);
      expect(() => insert('v6', { checks: 'nope' })).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE route_validations SET status = 'fail' WHERE id = 'v1'").run()).toThrow(
        /immutable/,
      );
      expect(() => db.prepare("DELETE FROM route_validations WHERE id = 'v1'").run()).toThrow(
        /cannot be deleted/,
      );
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    });
  });
});

describe('migration 018_goal_stage2_integrity', () => {
  const TREE = 'b'.repeat(40);

  function twoGoals(): Db {
    const db = fresh();
    project(db, 'p1');
    project(db, 'p2');
    for (const [g, p] of [
      ['g1', 'p1'],
      ['g2', 'p2'],
    ] as const) {
      goal(db, g, p);
      definition(db, g, 1, 'proposed');
      milestone(db, `${g}-m1`, g);
      cycle(db, `${g}-c`, g, 1, 'execution', 1, `${g}-m1`);
      run(db, `${g}-r`, p, { cycle: `${g}-c`, purpose: 'execution', base: SHA });
    }
    return db;
  }

  /** Records a user-decided approval; `over` perturbs one property so each binding clause can fail alone. */
  function approval(
    db: Db,
    id: string,
    goalId: string,
    over: { gate?: string; detail?: unknown; decide?: 'approved' | 'denied' | 'pending'; by?: string } = {},
  ) {
    db.prepare(
      `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
       VALUES (?, ?, ?, 'low', 'r', 'user', ?, 'pending', ?)`,
    ).run(
      id,
      goalId,
      over.gate ?? 'definition',
      JSON.stringify(over.detail ?? { version: 1, definitionHash: 'hash' }),
      NOW,
    );
    const decide = over.decide ?? 'approved';
    if (decide !== 'pending')
      db.prepare('UPDATE goal_approvals SET status = ?, decided_by = ?, responded_at = ? WHERE id = ?').run(
        decide,
        over.by ?? 'user',
        NOW,
        id,
      );
  }

  const approveWith = (db: Db, goalId: string, approvalId: string | null) =>
    db
      .prepare(
        "UPDATE goal_definition_versions SET status = 'approved', approved_by = 'user', approved_at = ?, approval_id = ? WHERE goal_id = ? AND version = 1",
      )
      .run(NOW, approvalId, goalId);

  it('applies on a fresh database and keeps foreign keys clean', () => {
    const db = fresh();
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const name of [
      'trg_goal_definition_approval_binding',
      'trg_goal_definition_insert_approval_binding',
      'trg_goal_observation_run_finding',
      'trg_goal_observation_run_finding_has_run',
    ])
      expect(triggers).toContain(name);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades an exact RC2 database through 019 and an existing 017 database', () => {
    const root = rc2Directory('015');
    const db = openDatabase(root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
    const again = openDatabase(root);
    expect(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    again.close();
  });

  describe('definition approval binding', () => {
    it('accepts an approval bound to exactly this goal, version, hash and gate', () => {
      const db = twoGoals();
      approval(db, 'a', 'g1');
      approveWith(db, 'g1', 'a');
      expect(db.prepare("SELECT status FROM goal_definition_versions WHERE goal_id = 'g1'").get()).toEqual({
        status: 'approved',
      });
      db.close();
    });

    it('requires the amendment gate for a version with a parent', () => {
      const db = twoGoals();
      db.prepare("UPDATE goal_definition_versions SET parent_version = 7 WHERE goal_id = 'g1'").run();
      approval(db, 'wrong', 'g1');
      expect(() => approveWith(db, 'g1', 'wrong')).toThrow(/bound to this goal, version and hash/);
      approval(db, 'right', 'g1', { gate: 'amendment' });
      approveWith(db, 'g1', 'right');
      db.close();
    });

    const cases: Array<[string, (db: Db) => string | null]> = [
      ['no approval at all', () => null],
      ['an approval id that does not exist', () => 'ghost'],
      [
        "another Goal's approval",
        (db) => {
          approval(db, 'other', 'g2');
          return 'other';
        },
      ],
      [
        'the wrong gate',
        (db) => {
          approval(db, 'gate', 'g1', { gate: 'start' });
          return 'gate';
        },
      ],
      [
        'the wrong version',
        (db) => {
          approval(db, 'ver', 'g1', { detail: { version: 2, definitionHash: 'hash' } });
          return 'ver';
        },
      ],
      [
        'the wrong hash',
        (db) => {
          approval(db, 'hash', 'g1', { detail: { version: 1, definitionHash: 'other' } });
          return 'hash';
        },
      ],
      [
        'an approval with no hash',
        (db) => {
          approval(db, 'nohash', 'g1', { detail: { version: 1 } });
          return 'nohash';
        },
      ],
      [
        'a denied approval',
        (db) => {
          approval(db, 'denied', 'g1', { decide: 'denied' });
          return 'denied';
        },
      ],
      [
        'a pending approval',
        (db) => {
          approval(db, 'pending', 'g1', { decide: 'pending' });
          return 'pending';
        },
      ],
      [
        'a system-decided approval',
        (db) => {
          approval(db, 'sys', 'g1', { decide: 'denied', by: 'system' });
          return 'sys';
        },
      ],
    ];
    for (const [name, setup] of cases)
      it(`refuses to approve with ${name}`, () => {
        const db = twoGoals();
        const id = setup(db);
        expect(() => approveWith(db, 'g1', id)).toThrow(/bound to this goal, version and hash/);
        expect(db.prepare("SELECT status FROM goal_definition_versions WHERE goal_id = 'g1'").get()).toEqual({
          status: 'proposed',
        });
        db.close();
      });

    it('applies the same binding to an INSERT of an already-approved definition', () => {
      const db = twoGoals();
      const insert = (goalId: string, version: number, approvalId: string | null) =>
        db
          .prepare(
            `INSERT INTO goal_definition_versions (goal_id, version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
              definition_hash, change_summary, created_by, approved_by, approval_id, created_at, approved_at)
             VALUES (?, ?, 'approved', '{}', '[]', '{}', '{}', '{}', 'hash', 's', 'user', 'user', ?, ?, ?)`,
          )
          .run(goalId, version, approvalId, NOW, NOW);
      expect(() => insert('g1', 2, null)).toThrow(/bound to this goal/);
      approval(db, 'x', 'g2', { detail: { version: 2, definitionHash: 'hash' } });
      expect(() => insert('g1', 2, 'x')).toThrow(/bound to this goal/);
      approval(db, 'y', 'g1', { detail: { version: 3, definitionHash: 'hash' } });
      expect(() => insert('g1', 2, 'y')).toThrow(/bound to this goal/);
      approval(db, 'z', 'g1', { detail: { version: 2, definitionHash: 'hash' }, gate: 'amendment' });
      // Version 2 with no parent needs the 'definition' gate, so an amendment-gate approval is refused.
      expect(() => insert('g1', 2, 'z')).toThrow(/bound to this goal/);
      approval(db, 'ok', 'g1', { detail: { version: 4, definitionHash: 'hash' } });
      insert('g1', 4, 'ok');
      db.close();
    });
  });

  describe('run finding ownership', () => {
    function seed(): Db {
      const db = twoGoals();
      db.prepare(
        "INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, goal_cycle_id, goal_run_purpose, goal_base_commit) SELECT 'g1-r2', machine_id, project_id, workflow_id, '{}', 'task', 'economy', 'normal', 'queued', ?, 'g1-c', 'review', ? FROM runs WHERE id = 'g1-r'",
      ).run(NOW, SHA);
      for (const run of ['g1-r', 'g1-r2', 'g2-r'])
        db.prepare(
          "INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status) VALUES (?, ?, 'k', 'review', 'R', 0, 'passed')",
        ).run(`s-${run}`, run);
      for (const run of ['g1-r', 'g1-r2', 'g2-r'])
        db.prepare(
          `INSERT INTO review_findings (id, run_id, stage_id, reviewer, severity, category, description, evidence, recommended_remediation, created_at)
           VALUES (?, ?, ?, 'x', 'high', 'bug', 'd', 'e', 'r', ?)`,
        ).run(`rf-${run}`, run, `s-${run}`, NOW);
      const review = (id: string, goalId: string, runId: string | null) =>
        db
          .prepare(
            `INSERT INTO goal_reviews (id, goal_id, cycle_id, milestone_id, definition_version, run_id, review_kind, status,
               reviewed_to_commit, reviewed_to_tree, created_at)
             VALUES (?, ?, ?, ?, 1, ?, 'milestone', 'pending', ?, ?, ?)`,
          )
          .run(id, goalId, `${goalId}-c`, `${goalId}-m1`, runId, SHA, TREE, NOW);
      review('rev1', 'g1', 'g1-r');
      review('rev-norun', 'g1', null);
      db.prepare(
        `INSERT INTO goal_findings (id, goal_id, fingerprint, severity, category, description, status,
           first_seen_review_id, last_seen_review_id, created_at, updated_at)
         VALUES ('f1', 'g1', 'fp', 'high', 'bug', 'd', 'open', 'rev1', 'rev1', ?, ?)`,
      ).run(NOW, NOW);
      return db;
    }
    const observe = (db: Db, id: string, reviewId: string, runFinding: string | null) =>
      db
        .prepare(
          `INSERT INTO goal_finding_observations (id, goal_id, goal_finding_id, review_id, run_finding_id, observation, basis, created_at)
           VALUES (?, 'g1', 'f1', ?, ?, 'new', 'b', ?)`,
        )
        .run(id, reviewId, runFinding, NOW);

    it('accepts a run finding produced by the Goal review run', () => {
      const db = seed();
      observe(db, 'o1', 'rev1', 'rf-g1-r');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    });

    it('accepts an observation with no run finding, even without a review run', () => {
      const db = seed();
      observe(db, 'o1', 'rev-norun', null);
      db.close();
    });

    it('rejects a run finding from another Goal', () => {
      const db = seed();
      expect(() => observe(db, 'o1', 'rev1', 'rf-g2-r')).toThrow(/belong to the Goal review/);
      db.close();
    });

    it('rejects a run finding from a different review run of the same Goal', () => {
      const db = seed();
      expect(() => observe(db, 'o1', 'rev1', 'rf-g1-r2')).toThrow(/belong to the Goal review/);
      db.close();
    });

    it('rejects a run finding when the Goal review has no run', () => {
      const db = seed();
      expect(() => observe(db, 'o1', 'rev-norun', 'rf-g1-r')).toThrow(/run finding/);
      db.close();
    });

    it('rejects a run finding that does not exist', () => {
      const db = seed();
      expect(() => observe(db, 'o1', 'rev1', 'ghost')).toThrow();
      db.close();
    });
  });
});

describe('migration 019_goal_finding_decision_authority', () => {
  const TREE = 'b'.repeat(40);

  /** One Goal with an approved v1 (hash 'hash'), a review, and two open findings. */
  function seed(): Db {
    const db = fresh();
    project(db, 'p1');
    project(db, 'p2');
    for (const [g, p] of [
      ['g1', 'p1'],
      ['g2', 'p2'],
    ] as const) {
      seedGoalWithDefinition(db, g, p);
      cycle(db, `${g}-c`, g, 1, 'execution', 1, `${g}-m1`);
      db.prepare(
        `INSERT INTO goal_reviews (id, goal_id, cycle_id, milestone_id, definition_version, review_kind, status,
           reviewed_to_commit, reviewed_to_tree, created_at)
         VALUES (?, ?, ?, ?, 1, 'milestone', 'pending', ?, ?, ?)`,
      ).run(`${g}-rev`, g, `${g}-c`, `${g}-m1`, SHA, TREE, NOW);
    }
    for (const id of ['f1', 'f2'])
      db.prepare(
        `INSERT INTO goal_findings (id, goal_id, fingerprint, severity, category, description, status,
           first_seen_review_id, last_seen_review_id, created_at, updated_at)
         VALUES (?, 'g1', ?, 'high', 'bug', 'd', 'open', 'g1-rev', 'g1-rev', ?, ?)`,
      ).run(id, `fp-${id}`, NOW, NOW);
    return db;
  }

  let sequence = 0;
  /** A decided finding_decision approval for g1 that is correct unless `over` perturbs one property. */
  function decision(
    db: Db,
    over: {
      goalId?: string;
      gate?: string;
      outcome?: 'approved' | 'denied';
      by?: string;
      detail?: Record<string, unknown>;
    } = {},
  ): string {
    const id = `fa-${sequence++}`;
    db.prepare(
      `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
       VALUES (?, ?, ?, 'low', 'r', 'user', ?, 'pending', ?)`,
    ).run(
      id,
      over.goalId ?? 'g1',
      over.gate ?? 'finding_decision',
      JSON.stringify({
        findingId: 'f1',
        decision: 'accepted_by_user',
        definitionVersion: 1,
        definitionHash: 'hash',
        ...over.detail,
      }),
      NOW,
    );
    db.prepare('UPDATE goal_approvals SET status = ?, decided_by = ?, responded_at = ? WHERE id = ?').run(
      over.outcome ?? 'approved',
      over.by ?? 'user',
      NOW,
      id,
    );
    return id;
  }
  const decide = (db: Db, approvalId: string | null, status = 'accepted_by_user', findingId = 'f1') =>
    db
      .prepare('UPDATE goal_findings SET status = ?, decision_approval_id = ? WHERE id = ?')
      .run(status, approvalId, findingId);
  const statusOf = (db: Db, id = 'f1') =>
    db.prepare('SELECT status, decision_approval_id AS approval FROM goal_findings WHERE id = ?').get(id);

  it('applies on a fresh database, adds the column and the triggers, and keeps foreign keys clean', () => {
    const db = fresh();
    const columns = (db.pragma('table_info(goal_findings)') as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('decision_approval_id');
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const name of [
      'trg_goal_finding_insert_open',
      'trg_goal_finding_user_decision',
      'trg_goal_finding_decision_sticky',
      'trg_goal_finding_approval_pointer',
    ])
      expect(triggers).toContain(name);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades an exact RC2 database and an existing 018 database to 019', () => {
    for (const through of ['015', '019']) {
      const root = rc2Directory(through);
      const db = openDatabase(root);
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
      const again = openDatabase(root);
      expect(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 20 });
      again.close();
    }
  });

  it('keeps a finding decided before 019 (no approval pointer) intact, and sticky once upgraded', () => {
    const root = rc2Directory('019'); // exactly migrations 001-018
    const old = new Database(join(root, 'turing.sqlite'));
    old.pragma('foreign_keys = ON');
    seedGoalWithDefinition(old, 'g1', 'p1');
    cycle(old, 'c1', 'g1', 1, 'execution', 1, 'g1-m1');
    old
      .prepare(
        `INSERT INTO goal_reviews (id, goal_id, cycle_id, milestone_id, definition_version, review_kind, status,
           reviewed_to_commit, reviewed_to_tree, created_at)
         VALUES ('rev', 'g1', 'c1', 'g1-m1', 1, 'milestone', 'pending', ?, ?, ?)`,
      )
      .run(SHA, TREE, NOW);
    old
      .prepare(
        `INSERT INTO goal_findings (id, goal_id, fingerprint, severity, category, description, status,
           first_seen_review_id, last_seen_review_id, created_at, updated_at)
         VALUES ('legacy', 'g1', 'fp', 'high', 'bug', 'd', 'accepted_by_user', 'rev', 'rev', ?, ?)`,
      )
      .run(NOW, NOW);
    old.close();
    const db = openDatabase(root);
    expect(statusOf(db, 'legacy')).toEqual({ status: 'accepted_by_user', approval: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.prepare("UPDATE goal_findings SET status = 'open' WHERE id = 'legacy'").run()).toThrow(
      /user finding decision cannot be changed/,
    );
    db.close();
  });

  it('accepts and dismisses an open finding with a bound user approval and records the pointer', () => {
    const db = seed();
    const accept = decision(db);
    decide(db, accept);
    expect(statusOf(db)).toEqual({ status: 'accepted_by_user', approval: accept });
    const dismiss = decision(db, { detail: { findingId: 'f2', decision: 'dismissed_by_user' } });
    decide(db, dismiss, 'dismissed_by_user', 'f2');
    expect(statusOf(db, 'f2')).toEqual({ status: 'dismissed_by_user', approval: dismiss });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  describe('a user decision needs an approval bound to this finding, decision and current definition', () => {
    const cases: Array<[string, (db: Db) => string | null]> = [
      ['no approval id', () => null],
      ['an approval id that does not exist', () => 'ghost'],
      ['an approval of another Goal', (db) => decision(db, { goalId: 'g2' })],
      ['the wrong gate', (db) => decision(db, { gate: 'review_decision' })],
      ['a denied approval', (db) => decision(db, { outcome: 'denied', by: 'user' })],
      ['a system-decided (denied) approval', (db) => decision(db, { outcome: 'denied', by: 'system' })],
      ['an approval for another finding', (db) => decision(db, { detail: { findingId: 'f2' } })],
      [
        'an approval for the opposite decision',
        (db) => decision(db, { detail: { decision: 'dismissed_by_user' } }),
      ],
      ['an old definition version', (db) => decision(db, { detail: { definitionVersion: 0 } })],
      ['a different definition hash', (db) => decision(db, { detail: { definitionHash: 'old' } })],
      [
        'an approval without a definition binding',
        (db) => decision(db, { detail: { definitionVersion: null, definitionHash: null } }),
      ],
    ];
    it.each(cases)('rejects %s', (_name, make) => {
      const db = seed();
      expect(() => decide(db, make(db))).toThrow(/finding decision needs a user approval/);
      expect(statusOf(db)).toEqual({ status: 'open', approval: null });
      db.close();
    });

    it('rejects an approval bound to a superseded definition after an amendment becomes current', () => {
      const db = seed();
      const stale = decision(db);
      db.prepare(
        "UPDATE goal_definition_versions SET status = 'superseded' WHERE goal_id = 'g1' AND version = 1",
      ).run();
      db.prepare(
        `INSERT INTO goal_definition_versions
         (goal_id, version, parent_version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
          definition_hash, change_summary, created_by, approved_by, approval_id, created_at, approved_at)
         VALUES ('g1', 2, 1, 'approved', '{}', '[]', '{}', '{}', '{}', 'hash2', 'amend', 'user', 'user', ?, ?, ?)`,
      ).run(boundApproval(db, 'g1', 2, 'hash2', 'amendment'), NOW, NOW);
      db.prepare('UPDATE goals SET current_definition_version = 2 WHERE id = ?').run('g1');
      expect(() => decide(db, stale)).toThrow(/finding decision needs a user approval/);
      db.close();
    });

    it('rejects a decision when the current definition is not approved', () => {
      const db = seed();
      const approvalId = decision(db);
      db.prepare('UPDATE goals SET current_definition_version = NULL WHERE id = ?').run('g1');
      expect(() => decide(db, approvalId)).toThrow(/finding decision needs a user approval/);
      db.close();
    });

    it('only moves a finding that is open', () => {
      const db = seed();
      db.prepare(
        "UPDATE goal_findings SET status = 'resolved', resolved_by_review_id = 'g1-rev' WHERE id = 'f1'",
      ).run();
      expect(() => decide(db, decision(db))).toThrow(/finding decision needs a user approval/);
      db.close();
    });

    it('rejects an approval id on a finding that is not user-decided, and a finding born decided', () => {
      const db = seed();
      const approvalId = decision(db);
      expect(() =>
        db.prepare('UPDATE goal_findings SET decision_approval_id = ? WHERE id = ?').run(approvalId, 'f1'),
      ).toThrow(/set only with a user decision/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO goal_findings (id, goal_id, fingerprint, severity, category, description, status,
               first_seen_review_id, last_seen_review_id, created_at, updated_at)
             VALUES ('born', 'g1', 'fp-born', 'high', 'bug', 'd', 'accepted_by_user', 'g1-rev', 'g1-rev', ?, ?)`,
          )
          .run(NOW, NOW),
      ).toThrow(/created without a user decision/);
      db.close();
    });
  });

  describe('a user decision is sticky', () => {
    function decided(): { db: Db; approvalId: string } {
      const db = seed();
      const approvalId = decision(db);
      decide(db, approvalId);
      return { db, approvalId };
    }

    it('cannot go back to open, to resolved or to the opposite decision', () => {
      const { db } = decided();
      for (const status of ['open', 'dismissed_by_user'])
        expect(() =>
          db.prepare('UPDATE goal_findings SET status = ? WHERE id = ?').run(status, 'f1'),
        ).toThrow(/user finding decision cannot be changed/);
      expect(() =>
        db
          .prepare(
            "UPDATE goal_findings SET status = 'resolved', resolved_by_review_id = 'g1-rev' WHERE id = 'f1'",
          )
          .run(),
      ).toThrow(/user finding decision cannot be changed/);
      // Even with a perfectly valid approval for the opposite decision.
      expect(() =>
        decide(db, decision(db, { detail: { decision: 'dismissed_by_user' } }), 'dismissed_by_user'),
      ).toThrow(/cannot be changed|never changed/);
      expect(statusOf(db)).toMatchObject({ status: 'accepted_by_user' });
      db.close();
    });

    it('keeps its approval pointer immutable (changed, cleared or swapped)', () => {
      const { db, approvalId } = decided();
      const other = decision(db);
      for (const value of [other, null])
        expect(() =>
          db.prepare('UPDATE goal_findings SET decision_approval_id = ? WHERE id = ?').run(value, 'f1'),
        ).toThrow(/cannot be changed|never changed/);
      expect(statusOf(db)).toEqual({ status: 'accepted_by_user', approval: approvalId });
      db.close();
    });

    it('still lets the review lifecycle record that the finding was seen again', () => {
      const { db } = decided();
      db.prepare(
        "UPDATE goal_findings SET last_seen_review_id = 'g1-rev', updated_at = ? WHERE id = 'f1'",
      ).run(NOW);
      expect(statusOf(db)).toMatchObject({ status: 'accepted_by_user' });
      db.close();
    });
  });
});

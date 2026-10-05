import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GOAL_BUILTIN_WORKFLOWS } from '../shared/goalWorkflows.js';
import { DEFAULT_WORKFLOWS } from '../shared/workflows.js';

export type Db = InstanceType<typeof Database>;

export function openDatabase(dataDir = process.env.TT_DATA_DIR ?? join(homedir(), '.turing-terminal')): Db {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* ACLs on Windows provide the platform equivalent. */
  }
  const dbPath = join(directory, 'turing.sqlite');
  const db = new Database(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* ACLs on Windows provide the platform equivalent. */
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedMachine(db);
  seedWorkflows(db);
  seedGoalBuiltinWorkflows(db);
  return db;
}

function runMigrations(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const name of readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    if (applied.has(name)) continue;
    const sql = readMigration(migrationDir, name);
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      );
    })();
  }
}

function readMigration(directory: string, file: string): string {
  // The migration directory is application-owned and contains SQL only.
  return readFileSync(join(directory, file), 'utf8');
}

function seedMachine(db: Db): void {
  const existing = db.prepare('SELECT id FROM machines LIMIT 1').get() as { id: string } | undefined;
  if (existing) return;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO machines (id, name, hostname, os, status, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, hostname(), hostname(), platform(), 'online', now);
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'local_machine_id',
    id,
    now,
  );
}

function seedWorkflows(db: Db): void {
  const count = (db.prepare('SELECT COUNT(*) AS count FROM workflows').get() as { count: number }).count;
  if (count > 0) return;
  const insert = db.prepare(
    'INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  const seed = db.transaction(() => {
    for (const workflow of DEFAULT_WORKFLOWS) {
      const { id, name, description, template, version, isDefault, ...configuration } = workflow;
      insert.run(
        id,
        name,
        description,
        template,
        JSON.stringify(configuration),
        version,
        isDefault ? 1 : 0,
        now,
        now,
      );
    }
  });
  seed();
}

export const GOAL_BUILTIN_CONFLICTS_KEY = 'goal_builtin_workflow_conflicts';

/** The stored, comparable form of a reserved Goal workflow: everything that defines it, nothing volatile. */
export function canonicalGoalBuiltin(workflow: (typeof GOAL_BUILTIN_WORKFLOWS)[number]): string {
  const { id, name, description, template, version, isDefault, ...configuration } = workflow;
  return JSON.stringify({ id, name, description, template, version, isDefault, configuration });
}

export function canonicalStoredWorkflow(row: Record<string, unknown>): string {
  let configuration: unknown = null;
  try {
    configuration = JSON.parse(String(row.config_json));
  } catch {
    /* an unparsable row can never equal a built-in */
  }
  return JSON.stringify({
    id: row.id,
    name: row.name,
    description: row.description,
    template: row.template,
    version: row.version,
    isDefault: Boolean(row.is_default),
    configuration,
  });
}

/**
 * Seeds each reserved Goal workflow that is absent (so an existing RC database gains them). A reserved id that already
 * exists and materially differs is never overwritten: it is reported through `settings` and the return value, and the
 * Goal executor refuses to use it. Ordinary user workflows are never touched.
 */
export function seedGoalBuiltinWorkflows(db: Db): { seeded: string[]; conflicts: string[] } {
  const now = new Date().toISOString();
  const seeded: string[] = [];
  const conflicts: string[] = [];
  db.transaction(() => {
    for (const workflow of GOAL_BUILTIN_WORKFLOWS) {
      const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id) as
        Record<string, unknown> | undefined;
      if (existing) {
        if (canonicalStoredWorkflow(existing) !== canonicalGoalBuiltin(workflow)) conflicts.push(workflow.id);
        continue;
      }
      const { id, name, description, template, version, isDefault, ...configuration } = workflow;
      db.prepare(
        'INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        name,
        description,
        template,
        JSON.stringify(configuration),
        version,
        isDefault ? 1 : 0,
        now,
        now,
      );
      seeded.push(id);
    }
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(GOAL_BUILTIN_CONFLICTS_KEY, JSON.stringify(conflicts), now);
  })();
  if (conflicts.length)
    console.warn(
      `Reserved Goal workflow(s) ${conflicts.join(', ')} differ from Turing's built-in definition and were left unchanged; Goal execution will refuse them.`,
    );
  return { seeded, conflicts };
}

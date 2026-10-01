import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { resolveEffectiveRules, rulesForStage } from './rules.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('effective run rules', () => {
  it('resolves enabled global and project rules with deterministic precedence and stage filtering', () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-rules-'));
    roots.push(root);
    const db = openDatabase(root);
    const now = new Date().toISOString();
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    db.prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'project-a',
      machineId,
      'Project A',
      join(root, 'project-a'),
      now,
    );
    db.prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'project-b',
      machineId,
      'Project B',
      join(root, 'project-b'),
      now,
    );
    const insert = db.prepare(
      `INSERT INTO rules
       (id, scope, project_id, name, description, content, enabled, priority, mandatory, stage_kinds_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('global', 'global', null, 'Global', 'global instruction', 1, 0, 1, '[]', now, now);
    insert.run(
      'project-low',
      'project',
      'project-a',
      'Project low',
      'project instruction',
      1,
      1,
      0,
      '[]',
      now,
      now,
    );
    insert.run(
      'project-high',
      'project',
      'project-a',
      'Project high',
      'review only',
      1,
      9,
      0,
      '[]',
      now,
      now,
    );
    insert.run(
      'disabled',
      'project',
      'project-a',
      'Disabled',
      'disabled instruction',
      0,
      99,
      1,
      '[]',
      now,
      now,
    );
    insert.run(
      'project-b-only',
      'project',
      'project-b',
      'Other project',
      'wrong project',
      1,
      99,
      1,
      '[]',
      now,
      now,
    );
    insert.run(
      'review-only',
      'project',
      'project-a',
      'Review only',
      'review instruction',
      1,
      0,
      0,
      '["reviewer"]',
      now,
      now,
    );

    const resolved = resolveEffectiveRules(db, 'project-a');
    expect(resolved.map((rule) => rule.id)).toEqual(['global', 'project-high', 'project-low', 'review-only']);
    expect(rulesForStage(resolved, 'implementer').map((rule) => rule.id)).toEqual([
      'global',
      'project-high',
      'project-low',
    ]);
    expect(rulesForStage(resolved, 'reviewer').map((rule) => rule.id)).toEqual([
      'global',
      'project-high',
      'project-low',
      'review-only',
    ]);
    expect(resolveEffectiveRules(db, 'project-b').map((rule) => rule.id)).toEqual([
      'project-b-only',
      'global',
    ]);
    db.close();
  });
});

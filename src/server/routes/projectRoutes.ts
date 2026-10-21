import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROBE_FIXTURE } from '../../shared/routeProbe.js';
import { isSafeProjectCommand } from '../commandPolicy.js';
import { scanProject } from '../projectScanner.js';
import { localMachine, toProject } from '../serialize.js';
import { jsonOrNull, message, type RouteContext } from './routeUtils.js';

const projectSchema = z.object({ path: z.string().trim().min(1).max(2_000) });
const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  buildCommand: z.array(z.string().max(100)).length(3).nullable().optional(),
  testCommand: z.array(z.string().max(100)).length(3).nullable().optional(),
  lintCommand: z.array(z.string().max(100)).length(3).nullable().optional(),
});

/** Project registration, settings and rescans. */
export function registerProjectRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get('/api/projects', async () => ({
    projects: (
      db
        .prepare('SELECT * FROM projects WHERE id <> ? ORDER BY name COLLATE NOCASE')
        .all(PROBE_FIXTURE.projectId) as Array<Record<string, unknown>>
    ).map(toProject),
  }));
  app.post('/api/projects', async (request, reply) => {
    const parsed = projectSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid project folder.' });
    let scanned;
    try {
      scanned = await scanProject(parsed.data.path);
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
    const machineId = String(localMachine(db).id);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO projects (id, machine_id, name, path, git_root, branch, dirty, package_manager, languages_json, frameworks_json,
        build_command_json, test_command_json, lint_command_json, readme_path, instruction_files_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        machineId,
        scanned.name,
        scanned.path,
        scanned.gitRoot,
        scanned.branch,
        scanned.dirty === null ? null : Number(scanned.dirty),
        scanned.packageManager,
        JSON.stringify(scanned.languages),
        JSON.stringify(scanned.frameworks),
        jsonOrNull(scanned.buildCommand),
        jsonOrNull(scanned.testCommand),
        jsonOrNull(scanned.lintCommand),
        scanned.readmePath,
        JSON.stringify(scanned.instructionFiles),
        now,
      );
    } catch (error) {
      return reply
        .code(409)
        .send({ error: `Project is already registered or could not be saved: ${message(error)}` });
    }
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>;
    return reply.code(201).send({ project: toProject(row) });
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const parsed = projectPatchSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid project settings.' });
    const current = db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get((request.params as { id: string }).id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ error: 'Project was not found.' });
    for (const key of ['buildCommand', 'testCommand', 'lintCommand'] as const) {
      const command = parsed.data[key];
      if (command && !isSafeProjectCommand(command))
        return reply.code(400).send({ error: `Only a detected package script can be used for ${key}.` });
    }
    db.prepare(
      `UPDATE projects SET name = ?, build_command_json = ?, test_command_json = ?, lint_command_json = ? WHERE id = ?`,
    ).run(
      parsed.data.name ?? current.name,
      parsed.data.buildCommand === undefined
        ? current.build_command_json
        : jsonOrNull(parsed.data.buildCommand),
      parsed.data.testCommand === undefined ? current.test_command_json : jsonOrNull(parsed.data.testCommand),
      parsed.data.lintCommand === undefined ? current.lint_command_json : jsonOrNull(parsed.data.lintCommand),
      current.id,
    );
    return {
      project: toProject(
        db.prepare('SELECT * FROM projects WHERE id = ?').get(current.id) as Record<string, unknown>,
      ),
    };
  });

  app.post('/api/projects/:id/refresh', async (request, reply) => {
    const current = db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get((request.params as { id: string }).id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ error: 'Project was not found.' });
    try {
      const scanned = await scanProject(String(current.path));
      db.prepare(
        `UPDATE projects SET git_root = ?, branch = ?, dirty = ?, package_manager = ?, languages_json = ?, frameworks_json = ?, readme_path = ?, instruction_files_json = ? WHERE id = ?`,
      ).run(
        scanned.gitRoot,
        scanned.branch,
        scanned.dirty === null ? null : Number(scanned.dirty),
        scanned.packageManager,
        JSON.stringify(scanned.languages),
        JSON.stringify(scanned.frameworks),
        scanned.readmePath,
        JSON.stringify(scanned.instructionFiles),
        current.id,
      );
      return {
        project: toProject(
          db.prepare('SELECT * FROM projects WHERE id = ?').get(current.id) as Record<string, unknown>,
        ),
      };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });
}

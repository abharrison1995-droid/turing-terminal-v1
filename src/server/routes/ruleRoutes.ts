import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StageKind } from '../../shared/types.js';
import { listRules } from '../rules.js';
import type { RouteContext } from './routeUtils.js';

const STAGE_KINDS = [
  'planner',
  'promptRefinement',
  'implementer',
  'build',
  'test',
  'reviewer',
  'parallelReview',
  'consolidate',
  'orchestrator',
  'remediation',
  'finalGate',
  'gitCheckpoint',
  'gitCommit',
  'gitPush',
  'gitMerge',
  'gitRollback',
  'conditionalBranch',
  'shellCommand',
  'notification',
  'humanApproval',
  'decisionGate',
] as const satisfies readonly StageKind[];

const ruleSchema = z.object({
  scope: z.enum(['global', 'project']),
  projectId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
  content: z.string().trim().min(1).max(8_000),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
  mandatory: z.boolean().default(false),
  appliesTo: z.array(z.enum(STAGE_KINDS)).max(STAGE_KINDS.length).default([]),
});

/** Global and project rules. */
export function registerRuleRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get('/api/rules', async (request) => {
    const { projectId } = request.query as { projectId?: string };
    const rules = listRules(db).filter(
      (rule) => rule.scope === 'global' || !projectId || rule.projectId === projectId,
    );
    return { rules };
  });

  app.post('/api/rules', async (request, reply) => {
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid rule.' });
    const value = parsed.data;
    if (
      value.scope === 'project' &&
      (!value.projectId || !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(value.projectId))
    )
      return reply.code(400).send({ error: 'Choose a registered project for a project rule.' });
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO rules (id, scope, project_id, name, description, content, enabled, priority, mandatory, stage_kinds_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      value.scope,
      value.scope === 'project' ? value.projectId : null,
      value.name,
      value.description,
      value.content,
      Number(value.enabled),
      value.priority,
      Number(value.mandatory),
      JSON.stringify(value.appliesTo),
      now,
      now,
    );
    return reply.code(201).send({ rule: listRules(db).find((rule) => rule.id === id) });
  });

  app.put('/api/rules/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!db.prepare('SELECT 1 FROM rules WHERE id = ?').get(id))
      return reply.code(404).send({ error: 'Rule was not found.' });
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid rule.' });
    const value = parsed.data;
    if (
      value.scope === 'project' &&
      (!value.projectId || !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(value.projectId))
    )
      return reply.code(400).send({ error: 'Choose a registered project for a project rule.' });
    db.prepare(
      `UPDATE rules SET scope = ?, project_id = ?, name = ?, description = ?, content = ?, enabled = ?, priority = ?, mandatory = ?, stage_kinds_json = ?, updated_at = ? WHERE id = ?`,
    ).run(
      value.scope,
      value.scope === 'project' ? value.projectId : null,
      value.name,
      value.description,
      value.content,
      Number(value.enabled),
      value.priority,
      Number(value.mandatory),
      JSON.stringify(value.appliesTo),
      new Date().toISOString(),
      id,
    );
    return { rule: listRules(db).find((rule) => rule.id === id) };
  });

  app.delete('/api/rules/:id', async (request, reply) => {
    const result = db.prepare('DELETE FROM rules WHERE id = ?').run((request.params as { id: string }).id);
    if (!result.changes) return reply.code(404).send({ error: 'Rule was not found.' });
    return reply.code(204).send();
  });
}

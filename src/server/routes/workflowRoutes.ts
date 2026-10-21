import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolveBillingMode } from '../../shared/billing.js';
import { isReservedGoalWorkflowId } from '../../shared/goalWorkflows.js';
import { toWorkflow } from '../serialize.js';
import { validateWorkflow } from '../workflowValidation.js';
import { slug, type RouteContext } from './routeUtils.js';
import { workflowSchema } from './workflowSchemas.js';

/** Saved workflows: list, create, update and duplicate. */
export function registerWorkflowRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get('/api/workflows', async () => ({
    workflows: (
      db.prepare('SELECT * FROM workflows ORDER BY is_default DESC, name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    ).map(toWorkflow),
  }));

  app.post('/api/workflows', async (request, reply) => {
    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid workflow.' });
    const validationErrors = validateWorkflow({
      stages: parsed.data.stages,
      maxParallelAgents: parsed.data.maxParallelAgents,
      maxRemediationRounds: parsed.data.maxRemediationRounds,
      isolatedWorktree: parsed.data.isolatedWorktree,
      promptRefinementDefault: parsed.data.promptRefinementDefault,
    });
    if (validationErrors.length) return reply.code(400).send({ error: validationErrors.join(' ') });
    const id = slug(parsed.data.name) || randomUUID();
    if (db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(id))
      return reply
        .code(409)
        .send({ error: 'A workflow with this name already exists. Duplicate it and choose another name.' });
    const now = new Date().toISOString();
    const { name, description, template, ...config } = normalizeWorkflowBilling(parsed.data);
    db.prepare(
      'INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
    ).run(id, name, description, template, JSON.stringify(config), now, now);
    return reply.code(201).send({
      workflow: toWorkflow(
        db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown>,
      ),
    });
  });
  app.put('/api/workflows/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!existing) return reply.code(404).send({ error: 'Workflow was not found.' });
    if (isReservedGoalWorkflowId(id))
      return reply
        .code(403)
        .send({ error: 'This workflow is reserved for the Goal Engine. Duplicate it to customise.' });
    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid workflow.' });
    const errors = validateWorkflow({
      stages: parsed.data.stages,
      maxParallelAgents: parsed.data.maxParallelAgents,
      maxRemediationRounds: parsed.data.maxRemediationRounds,
      isolatedWorktree: parsed.data.isolatedWorktree,
      promptRefinementDefault: parsed.data.promptRefinementDefault,
    });
    if (errors.length) return reply.code(400).send({ error: errors.join(' ') });
    const { name, description, template, ...config } = normalizeWorkflowBilling(parsed.data);
    db.prepare(
      'UPDATE workflows SET name = ?, description = ?, template = ?, config_json = ?, version = version + 1, updated_at = ? WHERE id = ?',
    ).run(name, description, template, JSON.stringify(config), new Date().toISOString(), id);
    return {
      workflow: toWorkflow(
        db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown>,
      ),
    };
  });
  app.post('/api/workflows/:id/duplicate', async (request, reply) => {
    const existing = db
      .prepare('SELECT * FROM workflows WHERE id = ?')
      .get((request.params as { id: string }).id) as Record<string, unknown> | undefined;
    if (!existing) return reply.code(404).send({ error: 'Workflow was not found.' });
    const source = toWorkflow(existing);
    const now = new Date().toISOString();
    const id = `${slug(source.name) || 'workflow'}-${randomUUID().slice(0, 6)}`;
    const config = {
      executionProfile: source.executionProfile,
      permissionMode: source.permissionMode,
      subscriptionOnly: source.subscriptionOnly,
      billingMode: source.billingMode,
      customAllowedLanes: source.customAllowedLanes,
      meteredBudget: source.meteredBudget,
      externalDecisionDataPolicy: source.externalDecisionDataPolicy,
      lockProviders: source.lockProviders,
      defaultModelConfiguration: source.defaultModelConfiguration,
      stageDefaults: source.stageDefaults,
      globalInstructions: source.globalInstructions,
      contextPolicy: source.contextPolicy,
      promptRefinementDefault: source.promptRefinementDefault,
      maxRemediationRounds: source.maxRemediationRounds,
      maxParallelAgents: source.maxParallelAgents,
      maxDurationMinutes: source.maxDurationMinutes,
      retryPolicy: source.retryPolicy,
      isolatedWorktree: source.isolatedWorktree,
      stages: source.stages,
    };
    db.prepare(
      'INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
    ).run(id, `${source.name} copy`, source.description, source.template, JSON.stringify(config), now, now);
    return reply.code(201).send({
      workflow: toWorkflow(
        db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown>,
      ),
    });
  });
}

function normalizeWorkflowBilling<
  T extends { billingMode?: import('../../shared/types.js').BillingMode; subscriptionOnly: boolean },
>(value: T): T {
  const billingMode = resolveBillingMode(value);
  return { ...value, billingMode, subscriptionOnly: billingMode !== 'custom' };
}

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { WorkflowDefinition } from '../../shared/types.js';
import { listDecisionResults } from '../decisionEngines.js';
import { readGitDiff } from '../git.js';
import { buildPreview, cancelOrdinaryQueuedRun, createRun } from '../runLauncher.js';
import { redactSecrets } from '../security.js';
import { getRunRow, runCancellationOwner, toApproval, toRun, toRuns, toWorkflow } from '../serialize.js';
import { parseJson, safeJson, slug, type RouteContext } from './routeUtils.js';
import { PERMISSIONS, PROFILES } from './workflowSchemas.js';

const runInputSchema = z.object({
  task: z.string().trim().min(1).max(12_000),
  projectId: z.string().min(1),
  workflowId: z.string().min(1),
  profile: z.enum(PROFILES).optional(),
  permissionMode: z.enum(PERMISSIONS).optional(),
  enigmaConfirmed: z.boolean().optional(),
  refinePrompt: z.boolean().optional(),
  subscriptionOnly: z.boolean().optional(),
  billingMode: z.enum(['subscriptions-only', 'subscriptions-plus-decision-budget', 'custom']).optional(),
  lockProviders: z.boolean().optional(),
});

/** Runs and their controls, the provider tool broker and run approvals. */
export function registerRunRoutes(app: FastifyInstance, { db, engine }: RouteContext): void {
  app.post('/api/internal/provider-tools', async (request, reply) => {
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token) return reply.code(403).send({ error: 'Provider broker authorization is missing.' });
    const parsed = z
      .object({ toolName: z.string().trim().min(1).max(120), input: z.record(z.string(), z.unknown()) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid provider broker request.' });
    if (!engine.isProviderToolSessionActive(token))
      return reply.code(403).send({ error: 'The provider tool session is no longer active.' });
    const result = await engine.handleProviderToolRequest(token, parsed.data.toolName, parsed.data.input);
    return result.error ? { error: result.error } : { result: result.result ?? '' };
  });

  app.get('/api/runs/:id/execution-operations', async (request, reply) => {
    const runId = (request.params as { id: string }).id;
    if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId))
      return reply.code(404).send({ error: 'Run was not found.' });
    const rows = db
      .prepare('SELECT * FROM execution_operations WHERE run_id = ? ORDER BY created_at, id LIMIT 2000')
      .all(runId) as Array<Record<string, unknown>>;
    return {
      operations: rows.map((row) => ({
        id: row.id,
        stageId: row.stage_id,
        backendId: row.backend_id,
        providerId: row.provider_id,
        modelId: row.model_id,
        role: row.role,
        operationType: row.operation_type,
        action: safeJson(row.action_json, {}),
        cwd: row.cwd,
        projectRoot: row.project_root,
        classification: row.classification,
        approvalRequired: Boolean(row.approval_required),
        approvalId: row.approval_id,
        status: row.status,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        exitCode: row.exit_code,
        result: safeJson(row.result_json, null),
        stdout: row.stdout,
        stderr: row.stderr,
      })),
    };
  });

  app.post('/api/runs/preview', async (request, reply) => {
    const parsed = runInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid run request.' });
    const result = await buildPreview(db, parsed.data);
    if (!result) return reply.code(404).send({ error: 'Select a registered project and saved workflow.' });
    return { preview: result };
  });

  app.post('/api/runs', async (request, reply) => {
    const parsed = runInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid run request.' });
    if (parsed.data.permissionMode === 'enigma' && !parsed.data.enigmaConfirmed)
      return reply.code(400).send({ error: 'Enigma requires deliberate activation for this run.' });
    const preview = await buildPreview(db, parsed.data);
    if (!preview) return reply.code(404).send({ error: 'Select a registered project and saved workflow.' });
    if (preview.branchStrategy === 'worktree' && preview.project.dirty !== false)
      return reply.code(409).send({
        error:
          preview.project.dirty === true
            ? 'The selected project has uncommitted changes. Commit or stash them before creating an isolated worktree.'
            : 'Git status could not be verified. Refresh the project profile and try again.',
      });
    if (!preview.canStart)
      return reply.code(400).send({
        error: [
          ...preview.warnings,
          'Configure every active AI stage with a detected provider and an explicit model before starting.',
        ].join(' '),
      });
    const run = createRun(db, engine, preview);
    return reply.code(202).send({ run });
  });

  app.post('/api/runs/:id/replay', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const source = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!source) return reply.code(404).send({ error: 'Run was not found.' });
    if (
      source.permission_mode === 'enigma' &&
      !(request.body as { enigmaConfirmed?: boolean } | undefined)?.enigmaConfirmed
    )
      return reply
        .code(400)
        .send({ error: 'ENIGMA replay requires deliberate confirmation for this new run.' });
    const historicalWorkflow = JSON.parse(String(source.workflow_snapshot_json)) as WorkflowDefinition;
    const preview = await buildPreview(
      db,
      {
        task: String(source.prompt),
        projectId: String(source.project_id),
        workflowId: String(source.workflow_id),
        profile: String(source.profile) as WorkflowDefinition['executionProfile'],
        permissionMode: String(source.permission_mode) as WorkflowDefinition['permissionMode'],
        refinePrompt: Boolean(source.refinement_requested),
        subscriptionOnly: historicalWorkflow.subscriptionOnly,
        lockProviders: historicalWorkflow.lockProviders,
      },
      historicalWorkflow,
    );
    if (!preview)
      return reply.code(404).send({ error: 'Historical project or workflow is no longer available.' });
    if (!preview.canStart)
      return reply.code(409).send({
        error: `Historical configuration cannot be replayed as saved: ${preview.warnings.join(' ')}`,
        warnings: preview.warnings,
        providerAssignments: preview.providerAssignments,
      });
    if (preview.branchStrategy === 'worktree' && preview.project.dirty !== false)
      return reply
        .code(409)
        .send({ error: 'The project must be clean before an isolated replay can start.' });
    const replay = createRun(db, engine, preview, {
      rulesSnapshot: safeJson(source.rules_snapshot_json, []),
      eventType: 'run_replayed',
      eventDetails: { sourceRunId: id, configurationLocked: preview.lockProviders },
    });
    return reply.code(202).send({ run: replay });
  });

  app.post('/api/runs/:id/duplicate-workflow', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const source = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!source) return reply.code(404).send({ error: 'Run was not found.' });
    const snapshot = JSON.parse(String(source.workflow_snapshot_json)) as WorkflowDefinition;
    const preview = await buildPreview(
      db,
      {
        task: String(source.prompt),
        projectId: String(source.project_id),
        workflowId: String(source.workflow_id),
        profile: snapshot.executionProfile,
        permissionMode: snapshot.permissionMode,
        subscriptionOnly: snapshot.subscriptionOnly,
        lockProviders: snapshot.lockProviders,
      },
      snapshot,
    );
    if (!preview)
      return reply.code(404).send({ error: 'Historical project or workflow is no longer available.' });
    const name = `${snapshot.name} copy`;
    const workflowId = `${slug(snapshot.name) || 'workflow'}-history-${randomUUID().slice(0, 6)}`;
    const excludedWorkflowFields = new Set(['id', 'name', 'version', 'isDefault', 'createdAt', 'updatedAt']);
    const configuration = Object.fromEntries(
      Object.entries(preview.workflow).filter(([key]) => !excludedWorkflowFields.has(key)),
    );
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
    ).run(workflowId, name, snapshot.description, snapshot.template, JSON.stringify(configuration), now, now);
    return reply.code(201).send({
      workflow: toWorkflow(
        db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as Record<string, unknown>,
      ),
      providerAssignments: preview.providerAssignments,
    });
  });

  app.get('/api/runs', async (request) => {
    const query = request.query as {
      projectId?: string;
      status?: string;
      from?: string;
      to?: string;
      providerId?: string;
      modelId?: string;
      workflowId?: string;
    };
    const conditions: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of [
      ['r.project_id', query.projectId],
      ['r.status', query.status],
      ['r.workflow_id', query.workflowId],
    ] as Array<[string, string | undefined]>) {
      if (value) {
        conditions.push(`${field} = ?`);
        values.push(value);
      }
    }
    if (query.from) {
      conditions.push('r.created_at >= ?');
      values.push(query.from);
    }
    if (query.to) {
      conditions.push('r.created_at <= ?');
      values.push(query.to);
    }
    if (query.providerId) {
      conditions.push('EXISTS (SELECT 1 FROM stages s WHERE s.run_id = r.id AND s.provider_id = ?)');
      values.push(query.providerId);
    }
    if (query.modelId) {
      conditions.push('EXISTS (SELECT 1 FROM stages s WHERE s.run_id = r.id AND s.model_id = ?)');
      values.push(query.modelId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT r.*, p.name AS project_name, w.name AS workflow_name FROM runs r JOIN projects p ON p.id = r.project_id JOIN workflows w ON w.id = r.workflow_id ${where} ORDER BY r.created_at DESC LIMIT 100`,
      )
      .all(...values) as Array<Record<string, unknown>>;
    return { runs: toRuns(db, rows) };
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const row = getRunRow(db, (request.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'Run was not found.' });
    const findings = db
      .prepare('SELECT * FROM review_findings WHERE run_id = ? ORDER BY created_at')
      .all(row.id);
    const events = db
      .prepare('SELECT type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY created_at')
      .all(row.id) as Array<{ type: string; payload_json: string; created_at: string }>;
    const gitOperations = db
      .prepare('SELECT * FROM git_operations WHERE run_id = ? ORDER BY created_at')
      .all(row.id) as Array<Record<string, unknown>>;
    return {
      run: toRun(db, row),
      effectiveRules: safeJson(row.rules_snapshot_json, []),
      findings,
      decisions: listDecisionResults(db, String(row.id)),
      gitOperations: gitOperations.map((operation) => ({
        id: operation.id,
        runId: operation.run_id,
        stageId: operation.stage_id,
        operation: operation.operation,
        branch: operation.branch,
        target: operation.target,
        approvalId: operation.approval_id,
        approvalRequired: Boolean(operation.approval_required),
        status: operation.status,
        beforeCommit: operation.before_commit,
        afterCommit: operation.after_commit,
        result: safeJson(operation.result_json, null),
        createdAt: operation.created_at,
        finishedAt: operation.finished_at,
      })),
      events: events.map(({ type, payload_json, created_at }) => ({
        type,
        payload: parseJson(payload_json),
        createdAt: created_at,
      })),
    };
  });

  app.get('/api/runs/:id/diff', async (request, reply) => {
    const row = getRunRow(db, (request.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'Run was not found.' });
    const project = db.prepare('SELECT path, git_root FROM projects WHERE id = ?').get(row.project_id) as {
      path: string;
      git_root: string | null;
    };
    const worktreeRoot = typeof row.worktree_path === 'string' ? String(row.worktree_path) : null;
    const startingCommit = typeof row.starting_commit === 'string' ? String(row.starting_commit) : null;
    const projectSubpath = project.git_root ? relative(project.git_root, project.path) : '';
    const cwd = worktreeRoot
      ? projectSubpath
        ? join(worktreeRoot, projectSubpath)
        : worktreeRoot
      : project.path;
    const diff = await readGitDiff(cwd, 1_000_000, worktreeRoot ? startingCommit : null);
    return {
      diff,
      truncated: diff.length >= 1_000_000,
      cwd,
      ...(diff ? {} : { message: 'No tracked or untracked changes are present in this working copy.' }),
    };
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!getRunRow(db, id)) return reply.code(404).send({ error: 'Run was not found.' });
    // An owned run that is still queued is refused: its owner starts it. An owned run that is executing stays stoppable
    // through RunEngine, because the Goal supervisor has no other cancel path and a wedged Goal run must be stoppable.
    const queued = cancelOrdinaryQueuedRun(db, engine, id);
    if (queued.cancelled) return { accepted: true, status: 'cancelled' };
    if (queued.reason === 'goal-owned')
      return reply.code(409).send({
        error:
          'This run belongs to a Grand Project, which starts and retires it. It cannot be cancelled here.',
      });
    if (queued.reason === 'route-probe')
      return reply.code(409).send({ error: 'This run is a route validation probe. Its reconciler owns it.' });
    // A repeated Stop on a run that is already cancelled is idempotent, unless something is still executing it.
    if (getRunRow(db, id)?.status === 'cancelled' && !engine.isActive(id))
      return { accepted: true, status: 'cancelled' };
    if (!engine.cancel(id)) return reply.code(409).send({ error: 'This run is not active.' });
    return { accepted: true };
  });

  app.post('/api/runs/:id/refinement/confirm', async (request, reply) => {
    const parsed = z
      .object({
        specification: z.string().trim().min(1).max(12_000),
        clarification: z.string().trim().max(4_000).optional().default(''),
      })
      .safeParse(request.body);
    const id = (request.params as { id: string }).id;
    if (!parsed.success)
      return reply.code(400).send({ error: 'Enter a refined specification of at most 12,000 characters.' });
    const run = db.prepare('SELECT status, refinement_requested FROM runs WHERE id = ?').get(id) as
      { status: string; refinement_requested: number } | undefined;
    if (!run) return reply.code(404).send({ error: 'Run was not found.' });
    if (run.status !== 'waiting_for_user' || !run.refinement_requested)
      return reply.code(409).send({ error: 'This run is not waiting for prompt refinement confirmation.' });
    const stage = db
      .prepare(
        "SELECT id, output_json FROM stages WHERE run_id = ? AND kind = 'promptRefinement' AND status = 'waiting_for_user'",
      )
      .get(id) as { id: string; output_json: string | null } | undefined;
    if (!stage)
      return reply
        .code(409)
        .send({ error: 'The prompt refinement stage is no longer awaiting confirmation.' });
    const specification = redactSecrets(parsed.data.specification).slice(0, 12_000);
    const clarification = redactSecrets(parsed.data.clarification).slice(0, 4_000);
    const output = JSON.parse(stage.output_json ?? '{}') as Record<string, unknown>;
    const now = new Date().toISOString();
    const transaction = db.transaction(() => {
      db.prepare('UPDATE runs SET refined_specification = ?, status = ?, summary = NULL WHERE id = ?').run(
        specification,
        'queued',
        id,
      );
      db.prepare(
        "UPDATE stages SET status = 'passed', output_json = ?, finished_at = ?, error = NULL WHERE id = ?",
      ).run(
        JSON.stringify({ ...output, confirmedSpecification: specification, clarification }),
        now,
        stage.id,
      );
      db.prepare(
        'INSERT INTO run_events (id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        randomUUID(),
        id,
        'prompt_refinement_confirmed',
        JSON.stringify({ stageId: stage.id, clarification }),
        now,
      );
    });
    transaction();
    engine.start(id, true);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/runs/:id/resume', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Run was not found.' });
    // A Goal-owned or route-probe run is started and retired by its owner, the same rule the cancel route applies.
    // The check runs before any stage is reset or the engine is started.
    const owner = runCancellationOwner(db, id);
    if (owner === 'goal-owned')
      return reply.code(409).send({
        error: 'This run belongs to a Grand Project, which starts and retires it. It cannot be resumed here.',
      });
    if (owner === 'route-probe')
      return reply.code(409).send({ error: 'This run is a route validation probe. Its reconciler owns it.' });
    if (row.status !== 'paused' && row.status !== 'failed')
      return reply.code(409).send({ error: 'Only paused or failed runs can be resumed.' });
    db.prepare(
      "UPDATE stages SET status = 'pending', finished_at = NULL, error = NULL WHERE run_id = ? AND status IN ('failed','cancelled')",
    ).run(id);
    engine.start(id, true);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/runs/:id/interventions', async (request, reply) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(4_000) }).safeParse(request.body);
    const id = (request.params as { id: string }).id;
    if (!parsed.success) return reply.code(400).send({ error: 'Enter an intervention message.' });
    if (!getRunRow(db, id)) return reply.code(404).send({ error: 'Run was not found.' });
    const activeStage = db
      .prepare("SELECT id FROM stages WHERE run_id = ? AND status = 'running' ORDER BY sequence DESC LIMIT 1")
      .get(id) as { id: string } | undefined;
    db.prepare(
      'INSERT INTO interventions (id, run_id, message, affected_stages_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      id,
      parsed.data.message,
      JSON.stringify(activeStage ? [activeStage.id] : []),
      new Date().toISOString(),
    );
    db.prepare(
      'INSERT INTO run_events (id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      id,
      'user_intervention',
      JSON.stringify({ message: parsed.data.message, affectedStageId: activeStage?.id ?? null }),
      new Date().toISOString(),
    );
    return {
      recorded: true,
      requiresResume: engine.intervene(id, parsed.data.message),
      affectedStageId: activeStage?.id ?? null,
    };
  });

  app.get('/api/approvals', async () => ({
    approvals: (
      db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all() as Array<
        Record<string, unknown>
      >
    ).map(toApproval),
  }));
  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const parsed = z.object({ approved: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose approve or deny.' });
    if (!engine.decideApproval((request.params as { id: string }).id, parsed.data.approved))
      return reply.code(404).send({ error: 'Approval is no longer pending.' });
    return { decided: true, approved: parsed.data.approved };
  });
}

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./providers.js', () => ({
  discoverProviders: vi.fn(async () => [
    {
      id: 'opencode',
      name: 'OpenCode',
      cli: 'opencode',
      detected: true,
      version: 'test',
      authentication: 'connected',
      authMechanism: 'test',
      note: 'test provider',
      checkedAt: new Date().toISOString(),
      capabilities: {
        authentication: true,
        subscriptionAuth: true,
        modelDiscovery: true,
        execution: true,
        streaming: true,
        cancellation: true,
        usageTelemetry: true,
        remainingAllowance: false,
        resetTelemetry: false,
        structuredOutput: false,
        sessionResume: true,
        toolMediation: true,
      },
      models: [
        {
          id: 'openai-codex/gpt-6-luna',
          name: 'Test model',
          providerId: 'openai-codex',
          subscriptionBacked: true,
        },
      ],
    },
  ]),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in API tests.');
  }),
}));

import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { executeProvider } from './providers.js';
import { RunEngine } from './runEngine.js';

describe('local API', () => {
  let root = '';
  let projectPath = '';
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let engine: RunEngine;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'turing-api-'));
    projectPath = join(root, 'project');
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    db = openDatabase(join(root, 'state'));
    engine = new RunEngine(db, () => undefined);
    app = createApp({ database: db, engine });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves health and persists a project profile that can be refreshed', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, localOnly: true });
    expect(health.headers['access-control-allow-origin']).toBe('*');

    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    expect(added.statusCode).toBe(201);
    const id = added.json().project.id as string;
    expect(added.json().project.buildCommand).toEqual(['npm', 'run', 'build']);
    mkdirSync(join(projectPath, 'src'));
    writeFileSync(join(projectPath, 'src', 'worker.py'), 'print("ready")');

    const refreshed = await app.inject({ method: 'POST', url: `/api/projects/${id}/refresh` });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().project.languages).toContain('Python');
    expect(refreshed.json().project.buildCommand).toEqual(['npm', 'run', 'build']);
  });

  it('previews missing provider assignments without selecting a substitute', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const projectId = added.json().project.id as string;
    const preview = await app.inject({
      method: 'POST',
      url: '/api/runs/preview',
      payload: { task: 'Add a feature', projectId, workflowId: 'quick-fix' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview.canStart).toBe(false);
    expect(preview.json().preview.expectedAiStages).toBe(0);
    expect(preview.json().preview.providerAssignments.every((item: { ready: boolean }) => !item.ready)).toBe(
      true,
    );
  });

  it('skips an unconfigured prompt refiner when refinement is off and requires it when enabled', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const projectId = added.json().project.id as string;
    const workflowResponse = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Optional refinement preview',
        description: 'Check the prompt refinement override.',
        template: 'test',
        executionProfile: 'balanced',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: false,
        stages: [
          { id: 'refine', label: 'Refine task', kind: 'promptRefinement', role: 'prompt-refinement' },
          { id: 'notice', label: 'Notify', kind: 'notification' },
        ],
      },
    });
    expect(workflowResponse.statusCode).toBe(201);
    const workflowId = workflowResponse.json().workflow.id as string;
    const direct = await app.inject({
      method: 'POST',
      url: '/api/runs/preview',
      payload: { task: 'Run directly', projectId, workflowId, refinePrompt: false },
    });
    expect(direct.json().preview).toMatchObject({ refinePrompt: false, canStart: true });
    expect(direct.json().preview.providerAssignments).toEqual([]);

    const refined = await app.inject({
      method: 'POST',
      url: '/api/runs/preview',
      payload: { task: 'Refine first', projectId, workflowId, refinePrompt: true },
    });
    expect(refined.json().preview).toMatchObject({ refinePrompt: true, canStart: false });
    expect(refined.json().preview.providerAssignments[0]).toMatchObject({ ready: false });
  });

  it('persists prompt refinement confirmation and resumes with redacted user input', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const projectId = added.json().project.id as string;
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    const runId = 'prompt-refinement-test-run';
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, refinement_requested, status, created_at)
       VALUES (?, ?, ?, 'quick-fix', '{}', 'Build a feature', 'balanced', 'normal', 1, 'waiting_for_user', ?)`,
    ).run(runId, machineId, projectId, now);
    db.prepare(
      `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, output_json, logs)
       VALUES ('prompt-refinement-stage', ?, 'refine', 'promptRefinement', 'Refine task', 0, 'waiting_for_user', ?, '')`,
    ).run(runId, JSON.stringify({ specification: 'Build a small feature', ambiguities: [], questions: [] }));
    vi.spyOn(engine, 'start').mockImplementation(() => {});

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/refinement/confirm`,
      payload: {
        specification: 'Build a feature with token=ghp_123456789012345678901234',
        clarification: 'Use the existing screen.',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(
      db.prepare('SELECT status, refined_specification FROM runs WHERE id = ?').get(runId),
    ).toMatchObject({
      status: 'queued',
      refined_specification: 'Build a feature with token=[REDACTED]',
    });
    const savedStage = db
      .prepare('SELECT status, output_json FROM stages WHERE id = ?')
      .get('prompt-refinement-stage') as { status: string; output_json: string };
    expect(savedStage.status).toBe('passed');
    expect(JSON.parse(savedStage.output_json)).toMatchObject({
      confirmedSpecification: 'Build a feature with token=[REDACTED]',
      clarification: 'Use the existing screen.',
    });
    expect(engine.start).toHaveBeenCalledWith(runId, true);
  });

  it('requires desktop approval and a Tailscale-bound device token for remote API access', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/pairing/requests' });
    expect(created.statusCode).toBe(201);
    const { id: requestId, code } = created.json().request as { id: string; code: string };
    expect(code).toMatch(/^[A-F0-9]{16}$/);

    const tailscaleHeaders = { 'tailscale-user-login': 'alex@example.com' };
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim',
      headers: tailscaleHeaders,
      payload: { code, deviceName: 'Alex phone' },
    });
    expect(claimed.statusCode).toBe(202);
    expect(claimed.json()).toMatchObject({ requestId, status: 'awaiting_desktop_approval' });

    const unpaired = await app.inject({ method: 'GET', url: '/api/dashboard', headers: tailscaleHeaders });
    expect(unpaired.statusCode).toBe(401);
    const remoteAdmin = await app.inject({
      method: 'GET',
      url: '/api/pairing/devices',
      headers: tailscaleHeaders,
    });
    expect(remoteAdmin.statusCode).toBe(403);
    const claimedByOtherUser = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim',
      headers: { 'tailscale-user-login': 'other@example.com' },
      payload: { code, deviceName: 'Other phone' },
    });
    expect(claimedByOtherUser.statusCode).toBe(404);

    const pending = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: tailscaleHeaders,
      payload: { requestId, code },
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ status: 'waiting_for_desktop_approval' });

    const requests = await app.inject({ method: 'GET', url: '/api/pairing/requests' });
    expect(requests.json().requests[0]).toMatchObject({
      id: requestId,
      deviceName: 'Alex phone',
      tailscaleLogin: 'alex@example.com',
      status: 'awaiting_approval',
    });
    const approved = await app.inject({ method: 'POST', url: `/api/pairing/requests/${requestId}/approve` });
    expect(approved.statusCode).toBe(200);

    const completed = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: tailscaleHeaders,
      payload: { requestId, code },
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json()).not.toHaveProperty('token');
    const credential = completed.json() as { deviceId: string; machineId: string };
    const sessionCookie = completed.headers['set-cookie'] as string;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    const cookie = sessionCookie.split(';')[0]!;
    expect(cookie).toMatch(/^__Host-turing-device=ttd_/);
    expect(
      db
        .prepare('SELECT token_hash, tailscale_login FROM device_sessions WHERE id = ?')
        .get(credential.deviceId),
    ).toMatchObject({ tailscale_login: 'alex@example.com' });

    const paired = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { ...tailscaleHeaders, cookie },
    });
    expect(paired.statusCode).toBe(200);
    const differentUser = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { 'tailscale-user-login': 'other@example.com', cookie },
    });
    expect(differentUser.statusCode).toBe(401);

    await app.inject({ method: 'DELETE', url: `/api/pairing/devices/${credential.deviceId}` });
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { ...tailscaleHeaders, cookie },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('executes a notification stage and persists a browser-delivery event', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const projectId = added.json().project.id as string;
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Notification stage test',
        description: 'Deliver a configured local browser notice.',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: false,
        stages: [
          {
            id: 'notice',
            label: 'Notify the operator',
            kind: 'notification',
            notificationMessage: 'The workflow reached its checkpoint.',
          },
        ],
      },
    });
    expect(workflow.statusCode).toBe(201);
    const runResponse = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        task: 'Exercise the configured local notification stage.',
        projectId,
        workflowId: workflow.json().workflow.id,
      },
    });
    expect(runResponse.statusCode).toBe(202);
    const runId = runResponse.json().run.id as string;
    let status = 'preparing';
    for (let attempt = 0; attempt < 100 && status !== 'completed'; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
      status = row.status;
    }
    expect(status).toBe('completed');
    expect(db.prepare('SELECT status FROM stages WHERE run_id = ?').get(runId)).toMatchObject({
      status: 'passed',
    });
    const event = db
      .prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'notification_requested'")
      .get(runId) as { payload_json: string };
    expect(JSON.parse(event.payload_json)).toMatchObject({
      title: 'Turing workflow notice',
      message: 'The workflow reached its checkpoint.',
    });
  });

  it('starts YOLO with a detected provider whose tools are mediated by Turing', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const projectId = added.json().project.id as string;
    const row = db.prepare("SELECT config_json FROM workflows WHERE id = 'quick-fix'").get() as {
      config_json: string;
    };
    const config = JSON.parse(row.config_json) as { stages: Array<Record<string, unknown>> };
    config.stages = config.stages.map((stage) =>
      stage.kind === 'implementer' || stage.kind === 'reviewer'
        ? { ...stage, backendId: 'opencode', providerId: 'openai-codex', modelId: 'openai-codex/gpt-6-luna' }
        : stage,
    );
    db.prepare("UPDATE workflows SET config_json = ? WHERE id = 'quick-fix'").run(JSON.stringify(config));

    const result = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { task: 'Add a feature', projectId, workflowId: 'quick-fix', permissionMode: 'yolo' },
    });
    expect(result.statusCode).toBe(202);
    expect(result.json().run.permissionMode).toBe('yolo');
  });

  it('keeps the internal provider broker closed to stale or guessed session tokens', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/internal/provider-tools',
      headers: { authorization: 'Bearer guessed-token' },
      payload: { toolName: 'read_file', input: { path: 'package.json' } },
    });
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toContain('session is no longer active');
    expect(db.prepare('SELECT COUNT(*) AS count FROM execution_operations').get()).toMatchObject({
      count: 0,
    });
  });

  it('executes an authorized provider file write through the broker and records its audit row', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const projectId = added.json().project.id as string;
    const row = db.prepare("SELECT config_json FROM workflows WHERE id = 'quick-fix'").get() as {
      config_json: string;
    };
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    config.isolatedWorktree = false;
    config.stages = [
      {
        id: 'implement',
        label: 'Implement',
        kind: 'implementer',
        role: 'implementer',
        backendId: 'opencode',
        providerId: 'openai-codex',
        modelId: 'openai-codex/gpt-6-luna',
      },
    ];
    db.prepare("UPDATE workflows SET config_json = ? WHERE id = 'quick-fix'").run(JSON.stringify(config));
    const globalRuleResponse = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        scope: 'global',
        name: 'Global convention',
        description: 'Shared rule',
        content: 'Use clear names in new code.',
        mandatory: true,
        priority: 10,
        appliesTo: [],
      },
    });
    const globalRuleId = globalRuleResponse.json().rule.id as string;
    const projectRuleResponse = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        scope: 'project',
        projectId,
        name: 'Project convention',
        description: 'Fixture-specific rule',
        content: 'Keep generated fixtures small.',
        mandatory: false,
        priority: 5,
        appliesTo: ['implementer'],
      },
    });
    const projectRuleId = projectRuleResponse.json().rule.id as string;
    vi.mocked(executeProvider).mockImplementationOnce(async (request) => {
      expect(request.prompt).toContain('Use clear names in new code.');
      expect(request.prompt).toContain('Keep generated fixtures small.');
      const result = await app.inject({
        method: 'POST',
        url: '/api/internal/provider-tools',
        headers: { authorization: `Bearer ${request.toolBroker.token}` },
        payload: {
          toolName: 'write_file',
          input: { path: 'generated.txt', content: 'brokered output' },
        },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().result).toContain('Wrote generated.txt');
      return {
        text: 'Implementation complete.',
        inputTokens: null,
        outputTokens: null,
        usageProvenance: 'unavailable',
        exitCode: 0,
        stdout: 'Implementation complete.',
      };
    });

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { task: 'Create generated.txt', projectId, workflowId: 'quick-fix' },
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    await vi.waitFor(() => {
      expect(
        (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status,
      ).toBe('completed');
    });
    expect(existsSync(join(projectPath, 'generated.txt'))).toBe(true);
    const operations = await app.inject({ method: 'GET', url: `/api/runs/${runId}/execution-operations` });
    expect(operations.json().operations).toMatchObject([
      { operationType: 'file_write', status: 'completed', approvalRequired: false },
    ]);
    const savedRun = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(savedRun.json().effectiveRules).toMatchObject([
      { id: globalRuleId, content: 'Use clear names in new code.' },
      { id: projectRuleId, content: 'Keep generated fixtures small.' },
    ]);
    await app.inject({
      method: 'PUT',
      url: `/api/rules/${globalRuleId}`,
      payload: {
        scope: 'global',
        name: 'Global convention',
        description: 'Updated rule',
        content: 'Updated global instruction.',
        enabled: true,
        mandatory: true,
        priority: 10,
        appliesTo: [],
      },
    });
    await app.inject({ method: 'DELETE', url: `/api/rules/${projectRuleId}` });
    const historicalRun = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(historicalRun.json().effectiveRules).toMatchObject([
      { id: globalRuleId, content: 'Use clear names in new code.' },
      { id: projectRuleId, content: 'Keep generated fixtures small.' },
    ]);
  });
});

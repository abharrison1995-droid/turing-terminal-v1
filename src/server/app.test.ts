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
import { APP_VERSION } from '../shared/version.js';
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
    expect(health.json()).toMatchObject({ ok: true, localOnly: true, version: APP_VERSION });
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

  it('allows only the packaged desktop origin to preflight the loopback API', async () => {
    const desktop = await app.inject({
      method: 'OPTIONS',
      url: '/api/dashboard',
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'GET' },
    });
    expect(desktop.statusCode).toBe(204);
    expect(desktop.headers['access-control-allow-origin']).toBe('tauri://localhost');

    const windowsDesktop = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { origin: 'http://tauri.localhost' },
    });
    expect(windowsDesktop.statusCode).toBe(200);
    expect(windowsDesktop.headers['access-control-allow-origin']).toBe('http://tauri.localhost');

    const unrelated = await app.inject({
      method: 'OPTIONS',
      url: '/api/dashboard',
      headers: { origin: 'https://example.invalid', 'access-control-request-method': 'GET' },
    });
    expect(unrelated.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reports only the local Tailscale node and this request identity state', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/readiness' });
    expect(response.statusCode).toBe(200);
    expect(response.json().tailscale).toMatchObject({
      identityHeaderPresent: false,
      masterLoopbackOnly: true,
    });
    expect([
      'unavailable',
      'needs_tailscale',
      'needs_serve',
      'serve_status_unknown',
      'awaiting_remote_identity_check',
      'ready',
    ]).toContain(response.json().tailscale.connectionHealth);
    expect(JSON.stringify(response.json())).not.toContain('Peer');
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

  it('validates user-configured quota envelopes, forecasts measured usage, and prices exact public models only', async () => {
    const now = new Date();
    const effectiveAt = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const resetAt = new Date(now.getTime() + 4 * 86_400_000).toISOString();
    db.prepare(
      `INSERT INTO usage_events (id, occurred_at, provider_id, model_id, backend, role, input_tokens,
       output_tokens, duration_ms, request_count, provenance)
       VALUES ('usage-price', ?, 'openai-codex', 'gpt-6-luna', 'codex-cli', 'implementer', 1000000, 100000, 1000, 1, 'provider_reported')`,
    ).run(now.toISOString());

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/usage/quotas',
      payload: {
        providerId: 'openai-codex',
        quotaName: 'Weekly allowance',
        windowLabel: 'Weekly',
        effectiveAt,
        resetAt,
        allowance: -1,
        unit: 'total_tokens',
      },
    });
    expect(invalid.statusCode).toBe(400);

    const saved = await app.inject({
      method: 'POST',
      url: '/api/usage/quotas',
      payload: {
        providerId: 'openai-codex',
        quotaName: 'Weekly allowance',
        windowLabel: 'Weekly',
        effectiveAt,
        resetAt,
        allowance: 2_000_000,
        unit: 'total_tokens',
        notes: 'Entered from provider account manually.',
        subscriptionCostUsd: 20,
      },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().quota).toMatchObject({
      provenance: 'user_configured',
      forecast: {
        provenance: 'user_configured',
        usageProvenance: 'provider_measured',
        observedUsed: 1_100_000,
        remaining: 900_000,
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM quota_envelopes').get()).toMatchObject({ count: 1 });

    const usage = await app.inject({ method: 'GET', url: '/api/usage?window=30d' });
    const model = usage.json().models.find((item: { key: string }) => item.key === 'gpt-6-luna');
    expect(model.costProvenance).toBe('estimated');
    expect(model.estimatedCostUsd).toBeCloseTo(0.15);
    expect(model.pricingSource).toContain('developers.openai.com');

    const removed = await app.inject({ method: 'DELETE', url: `/api/usage/quotas/${saved.json().quota.id}` });
    expect(removed.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS count FROM quota_envelopes').get()).toMatchObject({ count: 0 });
  });

  it('validates Web Push subscriptions, blocks abuse endpoints, and caps stored subscriptions', async () => {
    const prior = {
      publicKey: process.env.TT_WEB_PUSH_PUBLIC_KEY,
      privateKey: process.env.TT_WEB_PUSH_PRIVATE_KEY,
      subject: process.env.TT_WEB_PUSH_SUBJECT,
    };
    process.env.TT_WEB_PUSH_PUBLIC_KEY = 'A'.repeat(87);
    process.env.TT_WEB_PUSH_PRIVATE_KEY = 'B'.repeat(43);
    process.env.TT_WEB_PUSH_SUBJECT = 'mailto:operator@example.test';
    try {
      const config = await app.inject({ method: 'GET', url: '/api/notifications/config' });
      expect(config.json()).toMatchObject({ enabled: true, publicKey: 'A'.repeat(87) });
      expect(JSON.stringify(config.json())).not.toContain('B'.repeat(43));

      const remoteWithoutPairedSession = await app.inject({
        method: 'POST',
        url: '/api/notifications/subscriptions',
        headers: {
          origin: 'https://desktop.tailnet-example.ts.net',
          'tailscale-user-login': 'alex@example.com',
        },
        payload: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint',
          keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
        },
      });
      expect(remoteWithoutPairedSession.statusCode).toBe(401);

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/notifications/subscriptions',
        payload: {
          endpoint: 'https://127.0.0.1:4317/api/health',
          keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
        },
      });
      expect(invalid.statusCode).toBe(400);

      for (let index = 0; index < 20; index += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/notifications/subscriptions',
          payload: {
            endpoint: `https://fcm.googleapis.com/fcm/send/test-${index}`,
            keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
          },
        });
        expect(response.statusCode).toBe(201);
        expect(JSON.stringify(response.json())).not.toContain('test-');
      }
      const overflow = await app.inject({
        method: 'POST',
        url: '/api/notifications/subscriptions',
        payload: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/test-overflow',
          keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
        },
      });
      expect(overflow.statusCode).toBe(429);
      expect(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get()).toMatchObject({
        count: 20,
      });
    } finally {
      if (prior.publicKey === undefined) delete process.env.TT_WEB_PUSH_PUBLIC_KEY;
      else process.env.TT_WEB_PUSH_PUBLIC_KEY = prior.publicKey;
      if (prior.privateKey === undefined) delete process.env.TT_WEB_PUSH_PRIVATE_KEY;
      else process.env.TT_WEB_PUSH_PRIVATE_KEY = prior.privateKey;
      if (prior.subject === undefined) delete process.env.TT_WEB_PUSH_SUBJECT;
      else process.env.TT_WEB_PUSH_SUBJECT = prior.subject;
    }
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

  it('enforces QR pairing expiry, denial, single-use claiming, desktop approval, and device revocation', async () => {
    const tailscaleHeaders = { 'tailscale-user-login': 'alex@example.com' };
    const expired = await app.inject({ method: 'POST', url: '/api/pairing/requests' });
    const expiredId = expired.json().request.id as string;
    db.prepare('UPDATE pairing_requests SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1_000).toISOString(),
      expiredId,
    );
    const expiredClaim = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim-request',
      headers: tailscaleHeaders,
      payload: { requestId: expiredId, deviceName: 'Expired phone' },
    });
    expect(expiredClaim.statusCode).toBe(404);

    const denied = await app.inject({ method: 'POST', url: '/api/pairing/requests' });
    const deniedId = denied.json().request.id as string;
    const deniedClaim = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim-request',
      headers: tailscaleHeaders,
      payload: { requestId: deniedId, deviceName: 'Unrecognized phone' },
    });
    expect(deniedClaim.statusCode).toBe(202);
    expect(
      (await app.inject({ method: 'POST', url: `/api/pairing/requests/${deniedId}/deny` })).statusCode,
    ).toBe(200);
    const deniedCompletion = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: tailscaleHeaders,
      payload: { requestId: deniedId },
    });
    expect(deniedCompletion.statusCode).toBe(404);

    const created = await app.inject({ method: 'POST', url: '/api/pairing/requests' });
    const requestId = created.json().request.id as string;
    const withoutIdentity = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim-request',
      payload: { requestId, deviceName: 'Phone' },
    });
    expect(withoutIdentity.statusCode).toBe(401);
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim-request',
      headers: tailscaleHeaders,
      payload: { requestId, deviceName: 'QR phone' },
    });
    expect(claimed.statusCode).toBe(202);
    expect(claimed.json()).not.toHaveProperty('code');
    const replay = await app.inject({
      method: 'POST',
      url: '/api/pairing/claim-request',
      headers: tailscaleHeaders,
      payload: { requestId, deviceName: 'Second phone' },
    });
    expect(replay.statusCode).toBe(404);
    const crossIdentity = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: { 'tailscale-user-login': 'other@example.com' },
      payload: { requestId },
    });
    expect(crossIdentity.statusCode).toBe(404);
    const pending = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: tailscaleHeaders,
      payload: { requestId },
    });
    expect(pending.statusCode).toBe(202);
    expect(
      (await app.inject({ method: 'POST', url: `/api/pairing/requests/${requestId}/approve` })).statusCode,
    ).toBe(200);
    const completed = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: tailscaleHeaders,
      payload: { requestId },
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json()).not.toHaveProperty('token');
    const deviceId = completed.json().deviceId as string;
    const cookie = (completed.headers['set-cookie'] as string).split(';')[0]!;
    const completedReplay = await app.inject({
      method: 'POST',
      url: '/api/pairing/complete',
      headers: tailscaleHeaders,
      payload: { requestId },
    });
    expect(completedReplay.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/dashboard',
          headers: { ...tailscaleHeaders, cookie },
        })
      ).statusCode,
    ).toBe(200);
    db.prepare(
      `INSERT INTO push_subscriptions (id, device_session_id, endpoint, p256dh, auth, created_at, last_seen_at)
       VALUES ('push-revocation', ?, 'https://fcm.googleapis.com/fcm/send/revocation-test', ?, ?, ?, ?)`,
    ).run(deviceId, 'A'.repeat(87), 'B'.repeat(22), new Date().toISOString(), new Date().toISOString());
    await app.inject({ method: 'DELETE', url: `/api/pairing/devices/${deviceId}` });
    expect(
      db.prepare("SELECT id FROM push_subscriptions WHERE id = 'push-revocation'").get(),
    ).toBeUndefined();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/dashboard',
          headers: { ...tailscaleHeaders, cookie },
        })
      ).statusCode,
    ).toBe(401);
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

  it('keeps a master-owned approval run alive while the browser is disconnected and serves it on reconnect', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Reconnect acceptance',
        description: 'Single approval gate to check master-owned state.',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: false,
        stages: [{ id: 'approval', label: 'Reconnect gate', kind: 'humanApproval' }],
      },
    });
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        task: 'Verify the master continues while no browser is polling.',
        projectId: added.json().project.id,
        workflowId: workflow.json().workflow.id,
      },
    });
    const runId = started.json().run.id as string;
    await vi.waitFor(() => {
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({
        status: 'waiting_for_approval',
      });
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({
      status: 'waiting_for_approval',
    });
    const reconnected = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(reconnected.statusCode).toBe(200);
    expect(reconnected.json().run.status).toBe('waiting_for_approval');

    const approvalId = (db.prepare('SELECT id FROM approvals WHERE run_id = ?').get(runId) as { id: string })
      .id;
    const decision = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/decision`,
      payload: { approved: true },
    });
    expect(decision.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({
        status: 'completed',
      });
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

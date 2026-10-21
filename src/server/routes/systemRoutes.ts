import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROBE_FIXTURE } from '../../shared/routeProbe.js';
import { APP_VERSION } from '../../shared/version.js';
import { dashboardGoals } from '../goals/readModel.js';
import { allProviders } from '../modelCatalog.js';
import { localMachine, toApproval, toProject, toRuns, toWorkflow } from '../serialize.js';
import { probeTailscale } from '../tailscaleReadiness.js';
import { getTailscaleLogin } from './requestIdentity.js';
import type { RouteContext } from './routeUtils.js';

/** Health, Tailscale readiness, the dashboard and the machine name. */
export function registerSystemRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get('/api/health', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*');
    return {
      ok: true,
      service: 'turing-terminal',
      version: APP_VERSION,
      localOnly: true,
    };
  });

  app.get('/api/system/readiness', async (request) => {
    const tailscale = await probeTailscale();
    const identityHeaderPresent = getTailscaleLogin(request.headers['tailscale-user-login']) !== null;
    const masterLoopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(process.env.TT_HOST ?? '127.0.0.1');
    const connectionHealth = !tailscale.installed
      ? 'unavailable'
      : !tailscale.running
        ? 'needs_tailscale'
        : !masterLoopbackOnly
          ? 'unsafe_master_binding'
          : tailscale.serveConfigured === false
            ? 'needs_serve'
            : tailscale.serveConfigured === null
              ? 'serve_status_unknown'
              : identityHeaderPresent
                ? 'ready'
                : 'awaiting_remote_identity_check';
    return {
      tailscale: {
        installed: tailscale.installed,
        running: tailscale.running,
        hostname: tailscale.hostname,
        ips: tailscale.ips,
        serveConfigured: tailscale.serveConfigured,
        identityHeaderPresent,
        identityObservation: identityHeaderPresent
          ? 'Tailscale Serve identity header present on this request.'
          : 'No Tailscale identity header on this request; verify from a paired phone through Serve.',
        masterLoopbackOnly,
        connectionHealth,
        message: !tailscale.installed
          ? 'Tailscale not detected — remote phone validation unavailable.'
          : !tailscale.running
            ? 'Tailscale is installed but not running.'
            : connectionHealth === 'needs_serve'
              ? `Tailscale is running; configure Serve to proxy HTTPS to 127.0.0.1:${process.env.TT_PORT ?? '4317'}.`
              : connectionHealth === 'ready'
                ? 'Tailscale Serve and its identity header are available on this request.'
                : 'Check Serve status and verify the identity header from a paired remote phone.',
      },
      dataSource: 'local Tailscale CLI; only this machine identity is returned',
    };
  });

  app.get('/api/dashboard', async () => {
    const machineRow = localMachine(db);
    const now = new Date().toISOString();
    db.prepare('UPDATE machines SET status = ?, last_seen_at = ? WHERE id = ?').run(
      'online',
      now,
      machineRow.id,
    );
    const machine = {
      id: String(machineRow.id),
      name: String(machineRow.name),
      hostname: String(machineRow.hostname),
      os: String(machineRow.os),
      status: 'online' as const,
      lastSeenAt: now,
    };
    const projects = (
      db
        .prepare('SELECT * FROM projects WHERE id <> ? ORDER BY name COLLATE NOCASE')
        .all(PROBE_FIXTURE.projectId) as Array<Record<string, unknown>>
    ).map(toProject);
    const workflows = (
      db.prepare('SELECT * FROM workflows ORDER BY is_default DESC, name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    ).map(toWorkflow);
    const providers = await allProviders(db);
    const runRows = db
      .prepare(
        `SELECT r.*, p.name AS project_name, w.name AS workflow_name FROM runs r
      JOIN projects p ON p.id = r.project_id JOIN workflows w ON w.id = r.workflow_id ORDER BY r.created_at DESC LIMIT 15`,
      )
      .all() as Array<Record<string, unknown>>;
    const approvals = (
      db
        .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20")
        .all() as Array<Record<string, unknown>>
    ).map(toApproval);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const usage = db
      .prepare(
        `SELECT COUNT(*) AS events, COALESCE(SUM(duration_ms), 0) AS duration_ms,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
      FROM usage_events WHERE occurred_at >= ?`,
      )
      .get(startOfToday.toISOString()) as {
      events: number;
      duration_ms: number;
      input_tokens: number | null;
      output_tokens: number | null;
    };
    return {
      machine,
      projects,
      workflows,
      providers,
      runs: toRuns(db, runRows),
      approvals,
      usage: {
        events: usage.events,
        localMinutesToday: Math.round(usage.duration_ms / 60_000),
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        provenance: 'Locally observed process events; provider quota unavailable unless explicitly reported.',
      },
      ...dashboardGoals(db),
    };
  });

  app.patch('/api/settings/machine', async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a machine name up to 80 characters.' });
    const machine = localMachine(db);
    db.prepare('UPDATE machines SET name = ?, last_seen_at = ? WHERE id = ?').run(
      parsed.data.name,
      new Date().toISOString(),
      machine.id,
    );
    return { machine: { ...machine, name: parsed.data.name } };
  });
}

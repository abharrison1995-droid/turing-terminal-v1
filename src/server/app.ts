import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { relative, resolve, join } from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { StageKind, WorkflowDefinition, WorkflowStage } from '../shared/types.js';
import { applyExecutionProfile, validateWorkflow } from './workflowValidation.js';
import type { Db } from './db.js';
import { getRunRow, localMachine, toApproval, toProject, toRun, toWorkflow } from './serialize.js';
import { scanProject } from './projectScanner.js';
import { discoverProviders } from './providers.js';
import { RunEngine } from './runEngine.js';
import { readGitDiff } from './git.js';
import { isSafeProjectCommand } from './commandPolicy.js';
import { listRules, resolveEffectiveRules } from './rules.js';
import { redactSecrets } from './security.js';
import { calculateQuotaForecast, type QuotaUnit, type QuotaUsageSample } from './quotaForecast.js';
import { estimateApiEquivalent } from './pricing.js';
import { probeTailscale } from './tailscaleReadiness.js';
import { getWebPushConfiguration, isAllowedPushEndpoint } from './webPush.js';
import { APP_VERSION } from '../shared/version.js';

const execFile = promisify(callbackExecFile);
const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1_000;
const DEVICE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const PROFILES = ['economy', 'balanced', 'maximum'] as const;
const PERMISSIONS = ['supervised', 'normal', 'yolo', 'enigma'] as const;
const STAGE_KINDS = [
  'planner',
  'promptRefinement',
  'implementer',
  'build',
  'test',
  'reviewer',
  'parallelReview',
  'consolidate',
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
] as const satisfies readonly StageKind[];
const AI_KINDS = new Set<WorkflowStage['kind']>([
  'planner',
  'promptRefinement',
  'implementer',
  'reviewer',
  'parallelReview',
  'consolidate',
  'remediation',
  'finalGate',
]);
const stageSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  kind: z.enum([
    'planner',
    'promptRefinement',
    'implementer',
    'build',
    'test',
    'reviewer',
    'parallelReview',
    'consolidate',
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
  ]),
  role: z.string().max(80).optional(),
  backendId: z.string().max(80).optional(),
  providerId: z.string().max(80).optional(),
  modelId: z.string().max(180).optional(),
  reasoning: z.string().max(40).optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  timeoutMinutes: z.number().int().min(1).max(360).optional(),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().min(0).max(5).optional(),
      initialDelayMs: z.number().int().min(100).max(30_000).optional(),
      maxDelayMs: z.number().int().min(100).max(120_000).optional(),
    })
    .optional(),
  parallelism: z.number().int().min(1).max(8).optional(),
  command: z.array(z.string().max(200)).length(3).optional(),
  condition: z
    .object({
      path: z.enum([
        'build.success',
        'tests.failed',
        'review.openCritical',
        'review.openHigh',
        'finalGate.status',
      ]),
      operator: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan']),
      value: z.union([z.boolean(), z.number(), z.string().max(80)]),
    })
    .optional(),
  skipStageIds: z.array(z.string().min(1).max(80)).max(50).optional(),
  notificationMessage: z.string().max(1_000).optional(),
  commitMessage: z.string().trim().min(1).max(120).optional(),
  pushRemote: z.string().trim().min(1).max(61).optional(),
  pushBranch: z.string().trim().min(1).max(100).optional(),
  rollbackTarget: z.enum(['runStart', 'latestCheckpoint']).optional(),
  continueOnFailure: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const workflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  template: z.string().max(80),
  executionProfile: z.enum(PROFILES),
  permissionMode: z.enum(PERMISSIONS),
  promptRefinementDefault: z.boolean().default(false),
  maxRemediationRounds: z.number().int().min(0).max(5),
  maxParallelAgents: z.number().int().min(1).max(8),
  maxDurationMinutes: z.number().int().min(1).max(1_440).default(120),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().min(0).max(5).default(1),
      initialDelayMs: z.number().int().min(100).max(30_000).default(1_000),
      maxDelayMs: z.number().int().min(100).max(120_000).default(30_000),
    })
    .default({ maxRetries: 1, initialDelayMs: 1_000, maxDelayMs: 30_000 })
    .refine((policy) => policy.maxDelayMs >= policy.initialDelayMs, {
      message: 'Maximum retry delay must be at least the initial delay.',
    }),
  isolatedWorktree: z.boolean(),
  stages: z.array(stageSchema).min(1).max(50),
});
const projectSchema = z.object({ path: z.string().trim().min(1).max(2_000) });
const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  buildCommand: z.array(z.string().max(100)).length(3).nullable().optional(),
  testCommand: z.array(z.string().max(100)).length(3).nullable().optional(),
  lintCommand: z.array(z.string().max(100)).length(3).nullable().optional(),
});
const runInputSchema = z.object({
  task: z.string().trim().min(1).max(12_000),
  projectId: z.string().min(1),
  workflowId: z.string().min(1),
  profile: z.enum(PROFILES).optional(),
  permissionMode: z.enum(PERMISSIONS).optional(),
  enigmaConfirmed: z.boolean().optional(),
  refinePrompt: z.boolean().optional(),
});
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
const quotaEnvelopeSchema = z
  .object({
    providerId: z.string().trim().min(1).max(80),
    quotaName: z.string().trim().min(1).max(100),
    windowLabel: z.string().trim().min(1).max(80),
    resetAt: z.string().datetime({ offset: true }),
    effectiveAt: z.string().datetime({ offset: true }),
    allowance: z.number().finite().positive().max(1_000_000_000_000_000),
    unit: z.enum(['input_tokens', 'output_tokens', 'total_tokens', 'requests', 'minutes']),
    notes: z.string().max(1_000).default(''),
    subscriptionCostUsd: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  })
  .refine((value) => Date.parse(value.resetAt) > Date.parse(value.effectiveAt), {
    message: 'The reset date must be later than the effective date.',
  });
const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2_048).url(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,120}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  }),
});

export interface AppOptions {
  database: Db;
  engine: RunEngine;
}

export function createApp({ database: db, engine }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.TT_LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.tailscale-user-login',
          'req.body.password',
          'req.body.token',
          'req.body.apiKey',
          'req.body.code',
          'req.body.endpoint',
          'req.body.keys.auth',
          'req.body.keys.p256dh',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1_000_000,
  });

  // Only the packaged Tauri UI receives cross-origin access to the loopback
  // Master. Mobile PWA requests remain same-origin through Tailscale Serve.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== 'tauri://localhost' && origin !== 'http://tauri.localhost') return;
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('vary', 'Origin');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });

  app.addHook('preHandler', async (request, reply) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    if (path === '/api/health') return;
    const tailscaleLogin = getTailscaleLogin(request.headers['tailscale-user-login']);
    const remote = isRemoteRequest(request.headers, tailscaleLogin);
    if (!remote) return;
    if (!tailscaleLogin) return reply.code(401).send({ error: 'Tailscale Serve user identity is required.' });
    if (
      path === '/api/pairing/claim' ||
      path === '/api/pairing/claim-request' ||
      path === '/api/pairing/complete'
    )
      return;
    if (path.startsWith('/api/pairing/'))
      return reply
        .code(403)
        .send({ error: 'Device pairing administration is available on the desktop only.' });
    const token = readCookie(request.headers.cookie, '__Host-turing-device');
    const session = token
      ? (db
          .prepare(
            'SELECT id, expires_at, last_seen_at FROM device_sessions WHERE token_hash = ? AND tailscale_login = ? AND revoked_at IS NULL',
          )
          .get(hashPairingSecret(token), tailscaleLogin) as
          { id: string; expires_at: string; last_seen_at: string | null } | undefined)
      : undefined;
    const now = new Date();
    if (!session || Date.parse(session.expires_at) <= now.getTime())
      return reply.code(401).send({ error: 'Pair this device with the desktop before using it.' });
    if (!session.last_seen_at || Date.parse(session.last_seen_at) < now.getTime() - 60_000)
      db.prepare('UPDATE device_sessions SET last_seen_at = ? WHERE id = ?').run(
        now.toISOString(),
        session.id,
      );
  });

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

  app.post('/api/pairing/requests', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Create pairing requests from the desktop master.' });
    const code = randomBytes(8).toString('hex').toUpperCase();
    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + PAIRING_REQUEST_TTL_MS);
    db.prepare('DELETE FROM pairing_requests WHERE expires_at < ?').run(
      new Date(createdAt.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
    );
    db.prepare(
      'INSERT INTO pairing_requests (id, code_hash, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, hashPairingSecret(code), 'Waiting for phone', createdAt.toISOString(), expiresAt.toISOString());
    return reply.code(201).send({
      request: {
        id,
        code,
        status: 'waiting_for_phone',
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  app.get('/api/pairing/requests', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Pairing requests are managed on the desktop master.' });
    const now = new Date().toISOString();
    const rows = db.prepare('SELECT * FROM pairing_requests ORDER BY created_at DESC').all() as Array<{
      id: string;
      device_name: string;
      tailscale_login: string | null;
      created_at: string;
      expires_at: string;
      claimed_at: string | null;
      approved_at: string | null;
      denied_at: string | null;
      completed_at: string | null;
    }>;
    return {
      requests: rows.map((row) => ({
        id: row.id,
        deviceName: row.device_name,
        tailscaleLogin: row.tailscale_login,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        claimedAt: row.claimed_at,
        status: row.completed_at
          ? 'completed'
          : Date.parse(row.expires_at) <= Date.parse(now)
            ? 'expired'
            : row.denied_at
              ? 'denied'
              : row.approved_at
                ? 'approved'
                : row.claimed_at
                  ? 'awaiting_approval'
                  : 'waiting_for_phone',
      })),
    };
  });

  app.post('/api/pairing/requests/:id/approve', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Approve pairing requests from the desktop master.' });
    const result = db
      .prepare(
        'UPDATE pairing_requests SET approved_at = ? WHERE id = ? AND claimed_at IS NOT NULL AND approved_at IS NULL AND denied_at IS NULL AND completed_at IS NULL AND expires_at > ?',
      )
      .run(new Date().toISOString(), id, new Date().toISOString());
    if (!result.changes)
      return reply.code(409).send({ error: 'This request is unclaimed, expired, or already approved.' });
    return { approved: true };
  });

  app.post('/api/pairing/requests/:id/deny', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Deny pairing requests from the desktop master.' });
    const result = db
      .prepare(
        'UPDATE pairing_requests SET denied_at = ? WHERE id = ? AND claimed_at IS NOT NULL AND approved_at IS NULL AND denied_at IS NULL AND completed_at IS NULL AND expires_at > ?',
      )
      .run(new Date().toISOString(), id, new Date().toISOString());
    if (!result.changes)
      return reply.code(409).send({ error: 'This request is no longer awaiting a decision.' });
    return { denied: true };
  });

  app.get('/api/pairing/devices', async (request, reply) => {
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Paired devices are managed on the desktop master.' });
    const devices = db
      .prepare(
        'SELECT id, name, tailscale_login, created_at, last_seen_at, expires_at FROM device_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC',
      )
      .all() as Array<Record<string, unknown>>;
    return {
      devices: devices.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        tailscaleLogin: row.tailscale_login ? String(row.tailscale_login) : null,
        createdAt: String(row.created_at),
        lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
        expiresAt: String(row.expires_at),
        status: Date.parse(String(row.expires_at)) > Date.now() ? 'active' : 'expired',
      })),
    };
  });

  app.delete('/api/pairing/devices/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])))
      return reply.code(403).send({ error: 'Revoke paired devices from the desktop master.' });
    const result = db
      .prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Paired device was not found.' });
    db.prepare('DELETE FROM push_subscriptions WHERE device_session_id = ?').run(id);
    return { revoked: true };
  });

  app.post('/api/pairing/claim', async (request, reply) => {
    const parsed = z
      .object({ code: z.string().trim().min(1).max(32), deviceName: z.string().trim().min(1).max(80) })
      .safeParse(request.body);
    const tailscaleLogin = getTailscaleLogin(request.headers['tailscale-user-login']);
    if (!tailscaleLogin)
      return reply.code(401).send({ error: 'Open this page through Tailscale Serve to pair it.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the pairing code and a device name.' });
    const now = new Date().toISOString();
    const codeHash = hashPairingSecret(parsed.data.code.toUpperCase());
    const existing = db
      .prepare(
        'SELECT id, expires_at, tailscale_login, claimed_at, completed_at, denied_at FROM pairing_requests WHERE code_hash = ?',
      )
      .get(codeHash) as
      | {
          id: string;
          expires_at: string;
          tailscale_login: string | null;
          claimed_at: string | null;
          completed_at: string | null;
          denied_at: string | null;
        }
      | undefined;
    if (
      !existing ||
      Date.parse(existing.expires_at) <= Date.parse(now) ||
      existing.completed_at ||
      existing.denied_at
    )
      return reply.code(404).send({ error: 'The pairing code is invalid or expired.' });
    if (existing.claimed_at) {
      if (existing.tailscale_login !== tailscaleLogin)
        return reply.code(404).send({ error: 'The pairing code is invalid or expired.' });
      return reply.code(202).send({
        requestId: existing.id,
        status: 'awaiting_desktop_approval',
        expiresAt: existing.expires_at,
      });
    }
    const result = db
      .prepare(
        'UPDATE pairing_requests SET device_name = ?, tailscale_login = ?, claimed_at = ? WHERE code_hash = ? AND claimed_at IS NULL AND approved_at IS NULL AND denied_at IS NULL AND completed_at IS NULL AND expires_at > ?',
      )
      .run(parsed.data.deviceName, tailscaleLogin, now, codeHash, now);
    if (!result.changes) return reply.code(404).send({ error: 'The pairing code is invalid or expired.' });
    return reply
      .code(202)
      .send({ requestId: existing.id, status: 'awaiting_desktop_approval', expiresAt: existing.expires_at });
  });

  app.post('/api/pairing/claim-request', async (request, reply) => {
    const parsed = z
      .object({ requestId: z.string().uuid(), deviceName: z.string().trim().min(1).max(80) })
      .safeParse(request.body);
    const tailscaleLogin = getTailscaleLogin(request.headers['tailscale-user-login']);
    if (!tailscaleLogin)
      return reply.code(401).send({ error: 'Open this page through Tailscale Serve to pair it.' });
    if (!parsed.success) return reply.code(400).send({ error: 'The QR pairing request is invalid.' });
    const now = new Date().toISOString();
    const claimed = db
      .prepare(
        'UPDATE pairing_requests SET device_name = ?, tailscale_login = ?, claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND approved_at IS NULL AND denied_at IS NULL AND completed_at IS NULL AND expires_at > ?',
      )
      .run(parsed.data.deviceName, tailscaleLogin, now, parsed.data.requestId, now);
    if (!claimed.changes)
      return reply
        .code(404)
        .send({ error: 'This QR request is expired, already used, or no longer available.' });
    const expiresAt = (
      db.prepare('SELECT expires_at FROM pairing_requests WHERE id = ?').get(parsed.data.requestId) as {
        expires_at: string;
      }
    ).expires_at;
    return reply.code(202).send({
      requestId: parsed.data.requestId,
      status: 'awaiting_desktop_approval',
      expiresAt,
    });
  });

  app.post('/api/pairing/complete', async (request, reply) => {
    const parsed = z
      .object({ requestId: z.string().uuid(), code: z.string().trim().min(1).max(32).optional() })
      .safeParse(request.body);
    const tailscaleLogin = getTailscaleLogin(request.headers['tailscale-user-login']);
    if (!tailscaleLogin)
      return reply.code(401).send({ error: 'Open this page through Tailscale Serve to pair it.' });
    if (!parsed.success) return reply.code(400).send({ error: 'The pairing request is invalid.' });
    const now = new Date();
    const nowText = now.toISOString();
    const row = (
      parsed.data.code
        ? db
            .prepare('SELECT * FROM pairing_requests WHERE id = ? AND code_hash = ?')
            .get(parsed.data.requestId, hashPairingSecret(parsed.data.code.toUpperCase()))
        : db
            .prepare('SELECT * FROM pairing_requests WHERE id = ? AND claimed_at IS NOT NULL')
            .get(parsed.data.requestId)
    ) as
      | {
          id: string;
          device_name: string;
          tailscale_login: string | null;
          expires_at: string;
          approved_at: string | null;
          denied_at: string | null;
          completed_at: string | null;
        }
      | undefined;
    if (!row || row.tailscale_login !== tailscaleLogin || row.denied_at)
      return reply.code(404).send({ error: 'The pairing request was not found for this Tailscale user.' });
    if (Date.parse(row.expires_at) <= now.getTime())
      return reply
        .code(410)
        .send({ error: 'The pairing request expired. Start a new request on the desktop.' });
    if (row.completed_at)
      return reply.code(409).send({ error: 'This pairing request was already completed.' });
    if (!row.approved_at) return reply.code(202).send({ status: 'waiting_for_desktop_approval' });
    const token = `ttd_${randomBytes(32).toString('base64url')}`;
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS).toISOString();
    const transaction = db.transaction(() => {
      db.prepare(
        'INSERT INTO device_sessions (id, machine_id, name, token_hash, created_at, expires_at, tailscale_login, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        sessionId,
        String(localMachine(db).id),
        row.device_name,
        hashPairingSecret(token),
        nowText,
        expiresAt,
        tailscaleLogin,
        nowText,
      );
      const completed = db
        .prepare(
          'UPDATE pairing_requests SET completed_at = ? WHERE id = ? AND approved_at IS NOT NULL AND denied_at IS NULL AND completed_at IS NULL AND expires_at > ?',
        )
        .run(nowText, row.id, nowText);
      if (!completed.changes) throw new Error('This pairing request was already completed.');
    });
    transaction();
    reply.header(
      'set-cookie',
      `__Host-turing-device=${token}; Path=/; Max-Age=${Math.floor(DEVICE_SESSION_TTL_MS / 1_000)}; Secure; HttpOnly; SameSite=Strict`,
    );
    return reply.code(201).send({ deviceId: sessionId, machineId: String(localMachine(db).id), expiresAt });
  });

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
      db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    ).map(toProject);
    const workflows = (
      db.prepare('SELECT * FROM workflows ORDER BY is_default DESC, name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    ).map(toWorkflow);
    const providers = await discoverProviders();
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
      runs: runRows.map((row) => toRun(db, row)),
      approvals,
      usage: {
        events: usage.events,
        localMinutesToday: Math.round(usage.duration_ms / 60_000),
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        provenance: 'Locally observed process events; provider quota unavailable unless explicitly reported.',
      },
    };
  });

  app.get('/api/providers', async () => ({ providers: await discoverProviders() }));
  app.get('/api/projects', async () => ({
    projects: (
      db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
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
    const { name, description, template, ...config } = parsed.data;
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
    const { name, description, template, ...config } = parsed.data;
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

  app.post('/api/runs/preview', async (request, reply) => {
    const parsed = runInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid run request.' });
    const result = await makePreview(db, parsed.data);
    if (!result) return reply.code(404).send({ error: 'Select a registered project and saved workflow.' });
    return { preview: result };
  });

  app.post('/api/runs', async (request, reply) => {
    const parsed = runInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid run request.' });
    if (parsed.data.permissionMode === 'enigma' && !parsed.data.enigmaConfirmed)
      return reply.code(400).send({ error: 'Enigma requires deliberate activation for this run.' });
    const preview = await makePreview(db, parsed.data);
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
    const id = randomUUID();
    const now = new Date().toISOString();
    const workflowSnapshot = preview.workflow;
    const stageRows = workflowSnapshot.stages;
    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
         permission_mode, refinement_requested, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(
        id,
        preview.machine.id,
        preview.project.id,
        preview.workflow.id,
        JSON.stringify(workflowSnapshot),
        preview.task,
        preview.profile,
        preview.permissionMode,
        Number(preview.refinePrompt),
        now,
      );
      db.prepare('UPDATE runs SET rules_snapshot_json = ? WHERE id = ?').run(
        JSON.stringify(preview.effectiveRules),
        id,
      );
      const insert =
        db.prepare(`INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, backend_id, provider_id, model_id, status, input_json, logs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`);
      stageRows.forEach((stage, sequence) =>
        insert.run(
          randomUUID(),
          id,
          stage.id,
          stage.kind,
          stage.label,
          sequence,
          stage.backendId ?? null,
          stage.providerId ?? null,
          stage.modelId ?? null,
          stage.enabled === false || (stage.kind === 'promptRefinement' && !preview.refinePrompt)
            ? 'skipped'
            : 'pending',
          JSON.stringify({ role: stage.role ?? null }),
        ),
      );
      db.prepare(
        'INSERT INTO run_events (id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        randomUUID(),
        id,
        'run_queued',
        JSON.stringify({
          projectId: preview.project.id,
          workflowId: preview.workflow.id,
          machineId: preview.machine.id,
          refinePrompt: preview.refinePrompt,
        }),
        now,
      );
    });
    create();
    engine.start(id);
    const row = getRunRow(db, id)!;
    return reply.code(202).send({ run: toRun(db, row) });
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
    return { runs: rows.map((row) => toRun(db, row)) };
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

  app.get('/api/usage', async (request) => {
    const { window = '7d' } = request.query as { window?: string };
    const days = window === 'today' ? 1 : window === '30d' ? 30 : 7;
    const start = new Date();
    if (window === 'today') start.setHours(0, 0, 0, 0);
    else start.setTime(Date.now() - days * 86_400_000);
    const since = start.toISOString();
    const events = db
      .prepare('SELECT * FROM usage_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT 5000')
      .all(since) as Array<Record<string, unknown>>;
    const providers = groupUsage(events, 'provider_id');
    const models = groupUsage(events, 'model_id');
    const projects = db
      .prepare(
        `SELECT p.name, COUNT(u.id) AS events, COALESCE(SUM(u.duration_ms),0) AS duration_ms
      FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id WHERE u.occurred_at >= ? GROUP BY u.project_id ORDER BY events DESC`,
      )
      .all(since);
    const daily = db
      .prepare(
        `SELECT date(occurred_at) AS day, COUNT(*) AS events, COALESCE(SUM(duration_ms),0) AS duration_ms,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM usage_events WHERE occurred_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(since);
    return {
      window,
      days,
      since,
      provenance:
        'Locally measured activity; subscription allowance and reset telemetry unavailable unless directly reported.',
      quotas: listQuotaEnvelopes(db),
      providers,
      models,
      projects,
      daily,
      eventCount: events.length,
      raw: events,
    };
  });

  app.get('/api/usage/quotas', async () => ({ quotas: listQuotaEnvelopes(db) }));
  app.post('/api/usage/quotas', async (request, reply) => {
    const parsed = quotaEnvelopeSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid quota envelope.' });
    const value = parsed.data;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO quota_envelopes (id, provider_id, quota_name, window_label, reset_at, allowance, unit, notes,
       effective_at, subscription_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET quota_name = excluded.quota_name,
       window_label = excluded.window_label, reset_at = excluded.reset_at, allowance = excluded.allowance,
       unit = excluded.unit, notes = excluded.notes, effective_at = excluded.effective_at,
       subscription_cost_usd = excluded.subscription_cost_usd, updated_at = excluded.updated_at`,
    ).run(
      randomUUID(),
      value.providerId,
      value.quotaName,
      value.windowLabel,
      new Date(value.resetAt).toISOString(),
      value.allowance,
      value.unit,
      redactSecrets(value.notes).slice(0, 1_000),
      new Date(value.effectiveAt).toISOString(),
      value.subscriptionCostUsd,
      now,
      now,
    );
    const saved = db
      .prepare('SELECT id FROM quota_envelopes WHERE provider_id = ?')
      .get(value.providerId) as {
      id: string;
    };
    return reply.code(201).send({ quota: listQuotaEnvelopes(db).find((item) => item.id === saved.id) });
  });
  app.delete('/api/usage/quotas/:id', async (request, reply) => {
    const result = db
      .prepare('DELETE FROM quota_envelopes WHERE id = ?')
      .run((request.params as { id: string }).id);
    if (!result.changes) return reply.code(404).send({ error: 'Quota envelope was not found.' });
    return { deleted: true };
  });

  app.get('/api/notifications/config', async () => {
    const config = getWebPushConfiguration();
    return {
      enabled: config.enabled,
      publicKey: config.enabled ? config.publicKey : null,
      reason: config.enabled
        ? null
        : 'Configure a VAPID public/private key pair and subject on the master to enable closed-client Web Push.',
    };
  });
  app.post('/api/notifications/subscriptions', async (request, reply) => {
    const config = getWebPushConfiguration();
    if (!config.enabled) return reply.code(503).send({ error: 'Web Push is not configured on this master.' });
    const parsed = pushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Unsupported or invalid browser push subscription.' });
    if (!isAllowedPushEndpoint(parsed.data.endpoint))
      return reply.code(400).send({ error: 'Unsupported or invalid browser push subscription.' });
    const value = parsed.data;
    const tailscaleLogin = getTailscaleLogin(request.headers['tailscale-user-login']);
    const deviceToken = readCookie(request.headers.cookie, '__Host-turing-device');
    const session =
      tailscaleLogin && deviceToken
        ? (db
            .prepare(
              'SELECT id FROM device_sessions WHERE token_hash = ? AND tailscale_login = ? AND revoked_at IS NULL AND expires_at > ?',
            )
            .get(hashPairingSecret(deviceToken), tailscaleLogin, new Date().toISOString()) as
            { id: string } | undefined)
        : undefined;
    if (isRemoteRequest(request.headers, tailscaleLogin) && !session)
      return reply.code(401).send({ error: 'Pair this device with the desktop before enabling Web Push.' });
    const existing = db
      .prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?')
      .get(value.endpoint) as { id: string } | undefined;
    if (!existing) {
      const count = (
        db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }
      ).count;
      if (count >= 20)
        return reply.code(429).send({ error: 'This master already has the maximum 20 push subscriptions.' });
    }
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO push_subscriptions (id, device_session_id, endpoint, p256dh, auth, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET device_session_id = excluded.device_session_id,
       p256dh = excluded.p256dh, auth = excluded.auth, last_seen_at = excluded.last_seen_at`,
    ).run(id, session?.id ?? null, value.endpoint, value.keys.p256dh, value.keys.auth, now, now);
    return reply.code(existing ? 200 : 201).send({ id, subscribed: true });
  });
  app.delete('/api/notifications/subscriptions/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    const result = db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
    return { deleted: result.changes > 0 };
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

  const outputDir = resolve(process.cwd(), 'dist');
  if (existsSync(outputDir)) {
    app.register(fastifyStatic, { root: outputDir, prefix: '/', decorateReply: true });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        request.headers.accept?.includes('text/html') &&
        !request.url.startsWith('/api/')
      )
        return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Route was not found.' });
    });
  }
  return app;
}

function getTailscaleLogin(value: string | string[] | undefined): string | null {
  const login = Array.isArray(value) ? value[0] : value;
  return typeof login === 'string' && login.trim() ? login.trim().toLowerCase() : null;
}

function isRemoteRequest(headers: FastifyRequest['headers'], tailscaleLogin: string | null): boolean {
  if (tailscaleLogin) return true;
  const candidate = headers.origin ?? headers.referer;
  if (typeof candidate === 'string') {
    try {
      if (!isLoopbackHostname(new URL(candidate).hostname)) return true;
    } catch {
      return true;
    }
  }
  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!host) return true;
  try {
    return !isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return true;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', 'tauri.localhost'].includes(normalized);
}

function hashPairingSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function makePreview(db: Db, input: z.infer<typeof runInputSchema>) {
  let projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as
    Record<string, unknown> | undefined;
  const workflowRow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(input.workflowId) as
    Record<string, unknown> | undefined;
  if (!projectRow || !workflowRow) return null;
  if (typeof projectRow.git_root === 'string') {
    try {
      const status = await execFile('git', ['status', '--porcelain'], {
        cwd: String(projectRow.path),
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 250_000,
      });
      const branch = await execFile('git', ['branch', '--show-current'], {
        cwd: String(projectRow.path),
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 250_000,
      });
      db.prepare('UPDATE projects SET dirty = ?, branch = ? WHERE id = ?').run(
        Number(status.stdout.trim().length > 0),
        branch.stdout.trim() || null,
        projectRow.id,
      );
    } catch {
      db.prepare('UPDATE projects SET dirty = NULL WHERE id = ?').run(projectRow.id);
    }
    projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as Record<
      string,
      unknown
    >;
  }
  const project = toProject(projectRow);
  const source = toWorkflow(workflowRow);
  const profile = input.profile ?? source.executionProfile;
  const permissionMode = input.permissionMode ?? source.permissionMode;
  const refinePrompt = input.refinePrompt ?? source.promptRefinementDefault;
  const workflow: WorkflowDefinition = {
    ...source,
    executionProfile: profile,
    permissionMode,
    stages: applyExecutionProfile(source.stages, profile, source.maxParallelAgents),
  };
  const effectiveRules = resolveEffectiveRules(db, project.id);
  const providers = await discoverProviders();
  const providerAssignments = workflow.stages
    .filter(
      (stage) =>
        AI_KINDS.has(stage.kind) &&
        stage.enabled !== false &&
        (stage.kind !== 'promptRefinement' || refinePrompt),
    )
    .map((stage) => {
      const provider = providers.find((candidate) => candidate.id === stage.backendId);
      const modelExists = provider?.models.length
        ? provider.models.some((model) => model.id === stage.modelId)
        : true;
      const selectedModel = provider?.models.find((model) => model.id === stage.modelId);
      const subscriptionReady =
        provider?.id === 'claude-code'
          ? provider.subscriptionAuthenticated === true
          : provider?.id === 'codex-cli'
            ? provider.subscriptionAuthenticated === true && selectedModel?.subscriptionBacked === true
            : provider?.id === 'opencode'
              ? selectedModel?.subscriptionBacked === true
              : provider?.id === 'cline'
                ? ['openai-codex', 'cline-pass'].includes(stage.providerId ?? '')
                : false;
      return {
        stage: stage.label,
        backendId: stage.backendId ?? null,
        providerId: stage.providerId ?? null,
        modelId: stage.modelId ?? null,
        ready: Boolean(
          provider?.detected &&
          provider.capabilities.toolMediation &&
          subscriptionReady &&
          stage.providerId?.trim() &&
          stage.modelId?.trim() &&
          modelExists,
        ),
      };
    });
  const hasPromptRefinementStage = workflow.stages.some(
    (stage) => stage.kind === 'promptRefinement' && stage.enabled !== false,
  );
  const warnings: string[] = [];
  if (refinePrompt && !hasPromptRefinementStage)
    warnings.push('Prompt refinement is enabled, but this workflow has no enabled prompt refinement stage.');
  if (!input.task.trim()) warnings.push('Enter a task description.');
  if (project.dirty && workflow.isolatedWorktree)
    warnings.push('Project has uncommitted changes; commit or stash before isolated execution.');
  if (project.gitRoot && project.dirty === null && workflow.isolatedWorktree)
    warnings.push(
      'Git status could not be verified; isolated execution is blocked until the project refresh succeeds.',
    );
  if (!project.gitRoot && workflow.isolatedWorktree)
    warnings.push('This folder is not a Git repository; execution will use the project folder directly.');
  if (providerAssignments.some((assignment) => assignment.backendId && !assignment.ready))
    warnings.push(
      'One or more execution backends are missing, have no explicit provider/model, or no longer report the configured model.',
    );
  const machineRow = localMachine(db);
  const machine = {
    id: String(machineRow.id),
    name: String(machineRow.name),
    hostname: hostname(),
    os: platform(),
    status: 'online' as const,
    lastSeenAt: new Date().toISOString(),
  };
  const hasRunnableStage = workflow.stages.some((stage) => stage.enabled !== false);
  return {
    project,
    workflow,
    machine,
    task: input.task,
    profile,
    permissionMode,
    refinePrompt,
    effectiveRules,
    branchStrategy:
      workflow.isolatedWorktree && project.gitRoot ? ('worktree' as const) : ('current-branch' as const),
    expectedAiStages: providerAssignments.filter((assignment) => assignment.ready).length,
    canStart:
      Boolean(input.task.trim()) &&
      hasRunnableStage &&
      (!refinePrompt || hasPromptRefinementStage) &&
      providerAssignments.every((assignment) => assignment.ready) &&
      !(workflow.isolatedWorktree && project.gitRoot && project.dirty !== false),
    warnings,
    providerAssignments,
  };
}

function groupUsage(events: Array<Record<string, unknown>>, field: string) {
  const grouped = new Map<
    string,
    {
      key: string;
      events: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      tokenEvents: number;
      usageSamples: number;
      estimatedCostUsd: number;
      pricedEvents: number;
      priceSources: Set<string>;
      effectiveDates: Set<string>;
      cachedInputAssumedZero: boolean;
    }
  >();
  for (const event of events) {
    const key = typeof event[field] === 'string' ? String(event[field]) : 'unavailable';
    const current = grouped.get(key) ?? {
      key,
      events: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokenEvents: 0,
      usageSamples: 0,
      estimatedCostUsd: 0,
      pricedEvents: 0,
      priceSources: new Set(),
      effectiveDates: new Set(),
      cachedInputAssumedZero: false,
    };
    current.events += Number(event.request_count ?? 1);
    current.usageSamples += 1;
    current.durationMs += Number(event.duration_ms ?? 0);
    if (typeof event.input_tokens === 'number') {
      current.inputTokens += event.input_tokens;
      current.tokenEvents += 1;
    }
    if (typeof event.output_tokens === 'number') current.outputTokens += event.output_tokens;
    if (typeof event.input_tokens === 'number' && typeof event.output_tokens === 'number') {
      const estimate = estimateApiEquivalent({
        providerId: typeof event.provider_id === 'string' ? event.provider_id : null,
        modelId: typeof event.model_id === 'string' ? event.model_id : null,
        inputTokens: event.input_tokens,
        outputTokens: event.output_tokens,
        cachedInputTokens: typeof event.cached_input_tokens === 'number' ? event.cached_input_tokens : null,
      });
      if (estimate) {
        current.estimatedCostUsd += estimate.amount;
        current.pricedEvents += 1;
        current.priceSources.add(estimate.pricing.source);
        current.effectiveDates.add(estimate.pricing.effectiveDate);
        current.cachedInputAssumedZero ||= estimate.cachedInputAssumedZero;
      }
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].map(
    ({
      key,
      events: count,
      durationMs,
      inputTokens,
      outputTokens,
      tokenEvents,
      usageSamples,
      estimatedCostUsd,
      pricedEvents,
      priceSources,
      effectiveDates,
      cachedInputAssumedZero,
    }) => ({
      key,
      events: count,
      durationMs,
      inputTokens: tokenEvents ? inputTokens : null,
      outputTokens: tokenEvents ? outputTokens : null,
      estimatedCostUsd: pricedEvents === usageSamples && usageSamples > 0 ? estimatedCostUsd : null,
      costProvenance: pricedEvents === usageSamples && usageSamples > 0 ? 'estimated' : 'unavailable',
      pricingSource: priceSources.size === 1 ? [...priceSources][0] : null,
      pricingEffectiveDate: effectiveDates.size === 1 ? [...effectiveDates][0] : null,
      cachedInputAssumedZero: pricedEvents > 0 && cachedInputAssumedZero,
      quota: null,
    }),
  );
}

function listQuotaEnvelopes(db: Db) {
  const rows = db.prepare('SELECT * FROM quota_envelopes ORDER BY provider_id').all() as Array<
    Record<string, unknown>
  >;
  const now = Date.now();
  return rows.map((row) => {
    const samples = db
      .prepare(
        'SELECT occurred_at, input_tokens, output_tokens, duration_ms, request_count, provenance FROM usage_events WHERE provider_id = ? AND occurred_at >= ? AND occurred_at < ? AND occurred_at <= ? ORDER BY occurred_at LIMIT 50000',
      )
      .all(row.provider_id, row.effective_at, row.reset_at, new Date(now).toISOString()) as Array<
      Record<string, unknown>
    >;
    const forecast = calculateQuotaForecast({
      allowance: Number(row.allowance),
      unit: String(row.unit) as QuotaUnit,
      effectiveAt: String(row.effective_at),
      resetAt: String(row.reset_at),
      now,
      samples: samples.map((sample): QuotaUsageSample => ({
        occurredAt: String(sample.occurred_at),
        inputTokens: typeof sample.input_tokens === 'number' ? sample.input_tokens : null,
        outputTokens: typeof sample.output_tokens === 'number' ? sample.output_tokens : null,
        durationMs: Number(sample.duration_ms ?? 0),
        requestCount: Number(sample.request_count ?? 1),
        provenance: String(sample.provenance ?? 'unavailable'),
      })),
    });
    return {
      id: String(row.id),
      providerId: String(row.provider_id),
      quotaName: String(row.quota_name),
      windowLabel: String(row.window_label),
      resetAt: String(row.reset_at),
      allowance: Number(row.allowance),
      unit: String(row.unit),
      notes: String(row.notes ?? ''),
      effectiveAt: String(row.effective_at),
      subscriptionCostUsd: typeof row.subscription_cost_usd === 'number' ? row.subscription_cost_usd : null,
      provenance: 'user_configured' as const,
      forecast,
    };
  });
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

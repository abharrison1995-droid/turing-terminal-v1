import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localMachine } from '../serialize.js';
import { getTailscaleLogin, hashPairingSecret, isRemoteRequest } from './requestIdentity.js';
import type { RouteContext } from './routeUtils.js';

const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1_000;
const DEVICE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

/** Phone pairing: the desktop creates and decides requests; a phone claims and completes them through Serve. */
export function registerPairingRoutes(app: FastifyInstance, { db }: RouteContext): void {
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
}

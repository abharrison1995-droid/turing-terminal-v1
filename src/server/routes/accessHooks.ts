import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { getTailscaleLogin, hashPairingSecret, isRemoteRequest, readCookie } from './requestIdentity.js';

/** The Tauri CORS allowance and the remote-device gate that every /api/ request passes. */
export function registerAccessHooks(app: FastifyInstance, db: Db): void {
  // Only the packaged Tauri UI receives cross-origin access to the loopback
  // Master. Mobile PWA requests remain same-origin through Tailscale Serve.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== 'tauri://localhost' && origin !== 'http://tauri.localhost') return;
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type, if-match');
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
}

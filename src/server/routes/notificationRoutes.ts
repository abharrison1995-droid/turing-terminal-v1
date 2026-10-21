import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getWebPushConfiguration, isAllowedPushEndpoint } from '../webPush.js';
import { getTailscaleLogin, hashPairingSecret, isRemoteRequest, readCookie } from './requestIdentity.js';
import type { RouteContext } from './routeUtils.js';

const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2_048).url(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,120}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  }),
});

/** Web Push configuration and browser subscriptions. */
export function registerNotificationRoutes(app: FastifyInstance, { db }: RouteContext): void {
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
}

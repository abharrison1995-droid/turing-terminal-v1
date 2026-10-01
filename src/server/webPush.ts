import webPush from 'web-push';
import type { Db } from './db.js';

export interface WebPushConfiguration {
  enabled: boolean;
  publicKey: string | null;
  subject: string | null;
}

export interface PushNotice {
  key: string;
  title: string;
  body: string;
  url: string;
}

export function getWebPushConfiguration(env: NodeJS.ProcessEnv = process.env): WebPushConfiguration {
  const publicKey = env.TT_WEB_PUSH_PUBLIC_KEY?.trim() || null;
  const privateKey = env.TT_WEB_PUSH_PRIVATE_KEY?.trim() || null;
  const subject = env.TT_WEB_PUSH_SUBJECT?.trim() || null;
  const validSubject = subject !== null && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject);
  return {
    enabled:
      Boolean(publicKey && privateKey && validSubject) &&
      /^[A-Za-z0-9_-]{80,120}$/.test(publicKey!) &&
      /^[A-Za-z0-9_-]{40,80}$/.test(privateKey!),
    publicKey,
    subject,
  };
}

export function isAllowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'fcm.googleapis.com' ||
      hostname === 'web.push.apple.com' ||
      hostname.endsWith('.push.services.mozilla.com') ||
      hostname.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}

export function noticeForMasterEvent(event: string, payload: Record<string, unknown>): PushNotice | null {
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) return null;
  const status = payload.status;
  if (event === 'approval_requested') {
    const id = typeof payload.approvalId === 'string' ? payload.approvalId : runId;
    return {
      key: `approval:${id}`,
      title: 'Approval required',
      body: 'Open Turing Terminal to review the requested action.',
      url: '/',
    };
  }
  if (event === 'run_updated' && status === 'waiting_for_user')
    return {
      key: `run:${runId}:clarification`,
      title: 'Clarification required',
      body: 'Open Turing Terminal to review the task clarification.',
      url: '/',
    };
  if (event === 'run_completed')
    return {
      key: `run:${runId}:completed`,
      title: 'Workflow completed',
      body: 'Open Turing Terminal to inspect the run.',
      url: '/',
    };
  if (event === 'run_failed')
    return {
      key: `run:${runId}:failed`,
      title: 'Workflow failed',
      body: 'Open Turing Terminal to inspect the run and its error.',
      url: '/',
    };
  if (event === 'provider_auth_expired')
    return {
      key: `provider:${String(payload.providerId ?? 'unknown')}:auth:${runId}`,
      title: 'Provider sign-in needs attention',
      body: 'A provider could not authenticate. Open Turing Terminal settings to check sign-in.',
      url: '/',
    };
  if (event === 'usage_threshold')
    return {
      key: `quota:${String(payload.quotaId ?? 'unknown')}:${String(payload.resetAt ?? 'unknown')}`,
      title: 'Usage envelope threshold reached',
      body: 'A user-configured quota envelope has reached its alert threshold.',
      url: '/',
    };
  return null;
}

export async function deliverPushNotice(
  db: Db,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const notice = noticeForMasterEvent(event, payload);
  const config = getWebPushConfiguration();
  if (!notice || !config.enabled) return;
  const subscriptions = db
    .prepare(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
       LEFT JOIN device_sessions ds ON ds.id = ps.device_session_id
       WHERE ps.device_session_id IS NULL OR (ds.revoked_at IS NULL AND ds.expires_at > ?)`,
    )
    .all(new Date().toISOString()) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
  if (!subscriptions.length) return;
  const inserted = db
    .prepare('INSERT INTO push_delivery_keys (delivery_key, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .run(notice.key, new Date().toISOString());
  if (!inserted.changes) return;
  db.prepare("DELETE FROM push_delivery_keys WHERE created_at < datetime('now', '-30 days')").run();
  try {
    webPush.setVapidDetails(config.subject!, config.publicKey!, process.env.TT_WEB_PUSH_PRIVATE_KEY!.trim());
  } catch {
    return;
  }
  const payloadText = JSON.stringify({
    title: notice.title,
    body: notice.body,
    url: notice.url,
    tag: notice.key,
  });
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payloadText,
          { TTL: 60 },
        );
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410)
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(subscription.id);
      }
    }),
  );
}

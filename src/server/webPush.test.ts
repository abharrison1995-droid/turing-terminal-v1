import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import {
  deliverPushNotice,
  getWebPushConfiguration,
  isAllowedPushEndpoint,
  noticeForMasterEvent,
} from './webPush.js';

const sendNotification = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification },
}));

describe('Web Push boundary', () => {
  it('requires a complete VAPID configuration and never returns the private key', () => {
    const config = getWebPushConfiguration({
      TT_WEB_PUSH_PUBLIC_KEY: 'A'.repeat(87),
      TT_WEB_PUSH_PRIVATE_KEY: 'B'.repeat(43),
      TT_WEB_PUSH_SUBJECT: 'mailto:operator@example.test',
    });
    expect(config).toEqual({
      enabled: true,
      publicKey: 'A'.repeat(87),
      subject: 'mailto:operator@example.test',
    });
    expect(JSON.stringify(config)).not.toContain('B'.repeat(43));
  });

  it('rejects endpoints that could turn push delivery into an SSRF primitive', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/token')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/token')).toBe(true);
    expect(isAllowedPushEndpoint('https://127.0.0.1:4317/api/health')).toBe(false);
    expect(isAllowedPushEndpoint('https://attacker.example/push')).toBe(false);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/send/token')).toBe(false);
  });

  it('creates generic event notices without copying task text, error details, or credentials', () => {
    const notice = noticeForMasterEvent('approval_requested', {
      runId: 'run-a',
      approvalId: 'approval-a',
      reason: 'Authorization: Bearer supersecret',
    });
    expect(notice).toMatchObject({ title: 'Approval required', key: 'approval:approval-a' });
    expect(JSON.stringify(notice)).not.toContain('supersecret');
    expect(noticeForMasterEvent('stage_log', { runId: 'run-a', line: 'secret' })).toBeNull();
  });

  it('maps persisted Goal attention to safe exact-Goal notices and stable event keys', () => {
    const base = { goalId: 'goal-a', goalEventId: 'event-a' };
    const approval = noticeForMasterEvent('approval_requested', { ...base, approvalId: 'approval-a' });
    expect(approval).toEqual({
      key: 'goal-approval:approval-a',
      title: 'Grand Project needs approval',
      body: 'Open Turing Terminal to review the Goal gate.',
      url: '/?page=goals&goalId=goal-a',
    });
    expect(
      noticeForMasterEvent('state_changed', {
        ...base,
        to: 'needs_user',
        reasonCode: 'gate_pending',
      }),
    ).toBeNull();
    expect(
      noticeForMasterEvent('state_changed', {
        ...base,
        to: 'needs_user',
        reasonCode: 'scope_violation',
      }),
    ).toMatchObject({
      key: 'goal:goal-a:needs-you:scope_violation:event-a',
      title: 'Grand Project needs you',
    });
    const blocked = noticeForMasterEvent('state_changed', {
      ...base,
      to: 'blocked',
      reasonCode: 'scope_violation',
      detail: { content: 'must never appear' },
    });
    expect(blocked).toMatchObject({
      key: 'goal:goal-a:blocked:scope_violation:event-a',
      title: 'Grand Project blocked',
      body: 'The Goal is blocked by work outside the approved scope.',
      url: '/?page=goals&goalId=goal-a',
    });
    expect(JSON.stringify(blocked)).not.toContain('must never appear');
    expect(noticeForMasterEvent('state_changed', { ...base, to: 'completed' })).toMatchObject({
      key: 'goal:goal-a:completed',
      title: 'Grand Project completed',
    });
    expect(
      noticeForMasterEvent('review_completed', { ...base, reviewId: 'review-a', blocking: true }),
    ).toMatchObject({ key: 'goal-review:review-a:blocked', title: 'Grand Project review found a blocker' });
    expect(
      noticeForMasterEvent('review_completed', { ...base, reviewId: 'review-b', blocking: false }),
    ).toBeNull();
    expect(
      noticeForMasterEvent('completion_evaluated', {
        ...base,
        definitionHash: 'd'.repeat(64),
        integrationHead: 'head-a',
        failureCodes: ['final_apply_required'],
      }),
    ).toMatchObject({ key: `goal:goal-a:final-apply:${'d'.repeat(64)}:head-a` });
    expect(
      noticeForMasterEvent('completion_evaluated', {
        ...base,
        definitionHash: 'd'.repeat(64),
        integrationHead: 'head-a',
        failureCodes: ['final_apply_required', 'final_acceptance_missing'],
      }),
    ).toBeNull();
    expect(noticeForMasterEvent('evidence_recorded', { ...base })).toBeNull();
    expect(noticeForMasterEvent('cycle_finished', { ...base })).toBeNull();
  });

  it('keeps every existing run notification mapping unchanged', () => {
    expect(
      noticeForMasterEvent('approval_requested', { runId: 'run-a', approvalId: 'approval-a' }),
    ).toMatchObject({
      key: 'approval:approval-a',
      title: 'Approval required',
      url: '/',
    });
    expect(noticeForMasterEvent('run_updated', { runId: 'run-a', status: 'waiting_for_user' })).toMatchObject(
      {
        key: 'run:run-a:clarification',
      },
    );
    expect(noticeForMasterEvent('run_completed', { runId: 'run-a' })).toMatchObject({
      key: 'run:run-a:completed',
    });
    expect(noticeForMasterEvent('run_failed', { runId: 'run-a' })).toMatchObject({ key: 'run:run-a:failed' });
    expect(
      noticeForMasterEvent('provider_auth_expired', { runId: 'run-a', providerId: 'codex' }),
    ).toMatchObject({ key: 'provider:codex:auth:run-a' });
    expect(
      noticeForMasterEvent('usage_threshold', { runId: 'run-a', quotaId: 'weekly', resetAt: '2026-10-10' }),
    ).toMatchObject({ key: 'quota:weekly:2026-10-10' });
  });
});

describe('Web Push delivery', () => {
  let root = '';
  let db: ReturnType<typeof openDatabase>;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'turing-webpush-'));
    db = openDatabase(join(root, 'state'));
    previousEnv = {
      TT_WEB_PUSH_PUBLIC_KEY: process.env.TT_WEB_PUSH_PUBLIC_KEY,
      TT_WEB_PUSH_PRIVATE_KEY: process.env.TT_WEB_PUSH_PRIVATE_KEY,
      TT_WEB_PUSH_SUBJECT: process.env.TT_WEB_PUSH_SUBJECT,
    };
    process.env.TT_WEB_PUSH_PUBLIC_KEY = 'A'.repeat(87);
    process.env.TT_WEB_PUSH_PRIVATE_KEY = 'B'.repeat(43);
    process.env.TT_WEB_PUSH_SUBJECT = 'mailto:operator@example.test';
    db.prepare(
      `INSERT INTO push_subscriptions (id, device_session_id, endpoint, p256dh, auth, created_at, last_seen_at)
       VALUES ('push-a', NULL, 'https://fcm.googleapis.com/fcm/send/delivery-test', ?, ?, ?, ?)`,
    ).run('A'.repeat(87), 'B'.repeat(22), new Date().toISOString(), new Date().toISOString());
    sendNotification.mockReset();
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const keyRows = () =>
    (
      db
        .prepare("SELECT delivery_key FROM push_delivery_keys WHERE delivery_key = 'run:run-retry:failed'")
        .all() as unknown[]
    ).length;

  it('lets a later retry deliver a notice whose send failed transiently, then dedupes the success', async () => {
    sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('upstream unavailable'), { statusCode: 503 }),
    );
    await deliverPushNotice(db, 'run_failed', { runId: 'run-retry' });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    // A transient failure must not leave the key recorded as delivered.
    expect(keyRows()).toBe(0);

    sendNotification.mockResolvedValueOnce({});
    await deliverPushNotice(db, 'run_failed', { runId: 'run-retry' });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(keyRows()).toBe(1);

    // Delivered once: the recorded key suppresses any further send for the same notice.
    await deliverPushNotice(db, 'run_failed', { runId: 'run-retry' });
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('keeps the key recorded when the subscription is gone, because that failure is not transient', async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await deliverPushNotice(db, 'run_failed', { runId: 'run-retry' });
    expect(db.prepare("SELECT id FROM push_subscriptions WHERE id = 'push-a'").get()).toBeUndefined();
    expect(keyRows()).toBe(1);
    await deliverPushNotice(db, 'run_failed', { runId: 'run-retry' });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import { getWebPushConfiguration, isAllowedPushEndpoint, noticeForMasterEvent } from './webPush.js';

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
});

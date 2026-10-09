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

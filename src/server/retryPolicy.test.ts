import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowStage } from '../shared/types.js';
import {
  classifyProviderFailure,
  providerFailureMessage,
  resolveRetryPolicy,
  retryDelayMs,
} from './retryPolicy.js';

const workflow = {
  retryPolicy: { maxRetries: 4, initialDelayMs: 500, maxDelayMs: 2_000 },
} as WorkflowDefinition;
const stage = { id: 'review' } as WorkflowStage;

describe('bounded provider retry policy', () => {
  it('uses workflow defaults with a per-stage override and clamps values', () => {
    expect(resolveRetryPolicy(workflow, stage)).toEqual({
      maxRetries: 4,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
    });
    expect(
      resolveRetryPolicy(workflow, {
        ...stage,
        retryPolicy: { maxRetries: 99, initialDelayMs: 1, maxDelayMs: 1 },
      }),
    ).toEqual({ maxRetries: 5, initialDelayMs: 100, maxDelayMs: 100 });
  });

  it('classifies transient errors and refuses automatic retries for auth, denial, and exhausted quota', () => {
    expect(classifyProviderFailure('temporary service unavailable (503)')).toBe('provider_transient');
    expect(classifyProviderFailure('Claude weekly usage limit reached')).toBe('allowance_exhausted');
    expect(classifyProviderFailure('Provider is not authenticated')).toBe('authentication');
    expect(classifyProviderFailure('Approval was denied')).toBe('user_denial');
    expect(classifyProviderFailure('Build failed')).toBe('provider_failure');
    expect(providerFailureMessage('Claude weekly usage limit reached')).toContain(
      'Subscription allowance reached. Reset time is unknown.',
    );
    expect(providerFailureMessage('Claude weekly limit reached; resets on 12 October')).toContain(
      'Reset timing reported by the provider: 12 October.',
    );
  });

  it('applies exponential backoff with a configured ceiling', () => {
    const policy = { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 1_200 };
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(policy, attempt))).toEqual([500, 1_000, 1_200, 1_200]);
  });
});

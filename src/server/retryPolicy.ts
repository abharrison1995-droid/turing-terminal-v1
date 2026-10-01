import type { RetryPolicy, WorkflowDefinition, WorkflowStage } from '../shared/types.js';

export type ProviderFailureCategory =
  'authentication' | 'user_denial' | 'allowance_exhausted' | 'provider_transient' | 'provider_failure';

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export function resolveRetryPolicy(workflow: WorkflowDefinition, stage: WorkflowStage): RetryPolicy {
  const merged = { ...DEFAULT_RETRY_POLICY, ...workflow.retryPolicy, ...stage.retryPolicy };
  const maxRetries = Math.max(0, Math.min(5, Math.floor(merged.maxRetries)));
  const initialDelayMs = Math.max(100, Math.min(30_000, Math.floor(merged.initialDelayMs)));
  const maxDelayMs = Math.max(initialDelayMs, Math.min(120_000, Math.floor(merged.maxDelayMs)));
  return { maxRetries, initialDelayMs, maxDelayMs };
}

export function classifyProviderFailure(message: string): ProviderFailureCategory {
  const normalized = message.toLowerCase();
  if (/approval (?:was )?denied|user denied|permission denied|not approved/.test(normalized))
    return 'user_denial';
  if (/not authenticated|authentication|sign in|login|api key|credentials/.test(normalized))
    return 'authentication';
  if (
    /weekly (?:usage )?limit|allowance (?:is )?(?:reached|exhausted)|quota exceeded|usage limit/.test(
      normalized,
    )
  )
    return 'allowance_exhausted';
  if (
    /temporar(?:y|ily)|try again|overloaded|service unavailable|\b5\d\d\b|econnreset|econnrefused|etimedout|eai_again|network error|connection reset|rate limit/.test(
      normalized,
    )
  )
    return 'provider_transient';
  return 'provider_failure';
}

export function retryDelayMs(policy: RetryPolicy, retryNumber: number): number {
  const exponent = Math.max(0, Math.min(20, retryNumber - 1));
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
}

export function providerFailureMessage(message: string): string {
  if (classifyProviderFailure(message) !== 'allowance_exhausted') return message;
  const reset = message.match(/(?:reset(?:s)?|available again)(?: at| on)?\s+([^\n.;]{3,80})/i)?.[1]?.trim();
  return `Subscription allowance reached. ${reset ? `Reset timing reported by the provider: ${reset}.` : 'Reset time is unknown.'} Turing will not retry an exhausted allowance or switch to API billing.`;
}

export function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Retry cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Retry cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

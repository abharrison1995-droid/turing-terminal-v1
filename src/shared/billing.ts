import type { BillingLane, BillingMode, WorkloadType } from './types.js';

export const SUBSCRIPTION_LANES: readonly BillingLane[] = [
  'opencode-go-subscription',
  'clinepass-subscription',
  'chatgpt-subscription',
  'claude-subscription',
];

export const METERED_LANES: readonly BillingLane[] = [
  'openrouter-metered',
  'opencode-metered',
  'cline-usage-billing',
  'openai-api',
  'anthropic-api',
];

export const ALL_BILLING_LANES: readonly BillingLane[] = [...SUBSCRIPTION_LANES, ...METERED_LANES, 'unknown'];

export const BILLING_MODES: readonly BillingMode[] = ['subscriptions-only', 'subscriptions-plus-decision-budget', 'custom'];

export function isSubscriptionLane(lane: string | null | undefined): boolean {
  return SUBSCRIPTION_LANES.includes(lane as BillingLane);
}

export function isMeteredLane(lane: string | null | undefined): boolean {
  return METERED_LANES.includes(lane as BillingLane);
}

export function billingLaneLabel(lane: string): string {
  return (
    (
      {
        'opencode-go-subscription': 'OpenCode Go subscription',
        'opencode-metered': 'OpenCode metered / Console balance',
        'clinepass-subscription': 'ClinePass subscription',
        'cline-usage-billing': 'Cline usage-billing',
        'chatgpt-subscription': 'ChatGPT subscription',
        'claude-subscription': 'Claude subscription',
        'openai-api': 'OpenAI API',
        'anthropic-api': 'Anthropic API',
        'openrouter-metered': 'OpenRouter metered',
        unknown: 'Unknown billing lane',
        'not-used': 'Not used',
      } as Record<string, string>
    )[lane] ?? lane
  );
}

export function billingModeLabel(mode: BillingMode): string {
  return mode === 'subscriptions-only'
    ? 'Subscriptions Only'
    : mode === 'subscriptions-plus-decision-budget'
      ? 'Subscriptions + Decision Budget'
      : 'Custom';
}

/**
 * Resolve the effective run billing mode from a saved workflow and an optional run override.
 * The legacy `subscriptionOnly: false` flag maps to Custom; `true` never widens a stricter mode.
 */
export function resolveBillingMode(
  saved: { billingMode?: BillingMode; subscriptionOnly?: boolean },
  override: { billingMode?: BillingMode; subscriptionOnly?: boolean } = {},
): BillingMode {
  const base: BillingMode =
    saved.billingMode ?? (saved.subscriptionOnly === false ? 'custom' : 'subscriptions-only');
  if (override.billingMode) return override.billingMode;
  if (override.subscriptionOnly === false) return 'custom';
  if (override.subscriptionOnly === true && base === 'custom') return 'subscriptions-only';
  return base;
}

export interface BillingDecision {
  allowed: boolean;
  metered: boolean;
  reason: string | null;
}

/**
 * The single billing gate used by Run Preview, the run engine, and the Decision Layer.
 * It never substitutes a lane; it only allows or blocks the explicitly configured one.
 */
export function evaluateBillingLane(args: {
  mode: BillingMode;
  lane: BillingLane | null | undefined;
  workload: WorkloadType;
  customAllowedLanes?: readonly BillingLane[];
}): BillingDecision {
  const lane = args.lane ?? 'unknown';
  if (args.workload === 'deterministic') return { allowed: true, metered: false, reason: null };
  if (isSubscriptionLane(lane)) return { allowed: true, metered: false, reason: null };
  const label = billingLaneLabel(lane);
  if (lane === 'unknown')
    return {
      allowed: false,
      metered: false,
      reason: 'The billing lane is unknown. Select an explicit subscription or metered lane.',
    };
  if (args.mode === 'subscriptions-only')
    return { allowed: false, metered: true, reason: `${label} is blocked by Subscriptions Only.` };
  if (args.mode === 'subscriptions-plus-decision-budget') {
    if (lane === 'openrouter-metered' && args.workload === 'decision')
      return { allowed: true, metered: true, reason: null };
    return {
      allowed: false,
      metered: true,
      reason:
        args.workload === 'decision'
          ? `${label} is not a permitted Decision Engine lane in Subscriptions + Decision Budget.`
          : `${label} generative use is blocked by Subscriptions + Decision Budget; only Decision Gates may spend.`,
    };
  }
  if (args.customAllowedLanes && !args.customAllowedLanes.includes(lane))
    return { allowed: false, metered: true, reason: `${label} is not in this workflow's Custom allowed lanes.` };
  return { allowed: true, metered: true, reason: null };
}

/**
 * Provider-side PAYG fallback is controlled in each provider's account, not by Turing. None of the
 * supported subscription routes exposes a documented, read-only check, so every subscription lane is
 * reported as unknown. A metered lane is metered by definition and has no "fallback".
 */
export function providerSideFallbackStatus(lane: BillingLane): {
  status: 'known-disabled' | 'known-enabled' | 'unknown';
  message: string;
} | null {
  switch (lane) {
    case 'opencode-go-subscription':
      return {
        status: 'unknown',
        message:
          'Provider-side PAYG fallback status cannot be verified by Turing Terminal. OpenCode Go can use Console balance after its limits when “Use balance” is enabled in the OpenCode console.',
      };
    case 'clinepass-subscription':
      return {
        status: 'unknown',
        message:
          'Provider-side PAYG fallback status cannot be verified by Turing Terminal. Turing never switches ClinePass to Cline usage-billing.',
      };
    case 'chatgpt-subscription':
      return {
        status: 'unknown',
        message:
          'Provider-side PAYG fallback status cannot be verified by Turing Terminal. Any purchased ChatGPT/Codex credits are governed by your OpenAI account.',
      };
    case 'claude-subscription':
      return {
        status: 'unknown',
        message:
          'Provider-side PAYG fallback status cannot be verified by Turing Terminal. Claude extra-usage settings are governed by your Anthropic account.',
      };
    default:
      return null;
  }
}

export const PROVIDER_FALLBACK_UNVERIFIABLE = 'Provider-side PAYG fallback status cannot be verified by Turing Terminal.';

/** Infer the lane a backend/provider route bills through. Used only when no lane was saved. */
export function inferBillingLane(backendId?: string, providerId?: string): BillingLane {
  if (backendId === 'opencode')
    return providerId === 'opencode-go'
      ? 'opencode-go-subscription'
      : providerId === 'openai-codex'
        ? 'chatgpt-subscription'
        : providerId === 'openai'
          ? 'openai-api'
          : providerId === 'anthropic'
            ? 'anthropic-api'
            : 'opencode-metered';
  if (backendId === 'cline')
    return providerId === 'cline-pass'
      ? 'clinepass-subscription'
      : providerId === 'openai-codex'
        ? 'chatgpt-subscription'
        : providerId === 'openai'
          ? 'openai-api'
          : providerId === 'anthropic'
            ? 'anthropic-api'
            : 'cline-usage-billing';
  if (backendId === 'codex-cli') return 'chatgpt-subscription';
  if (backendId === 'claude-code') return 'claude-subscription';
  if (backendId === 'openrouter') return 'openrouter-metered';
  return 'unknown';
}

/** A route may only execute through the exact lane its provider bills through. */
export function routeMatchesBillingLane(backendId?: string, providerId?: string, lane?: string | null): boolean {
  if (!backendId || !providerId) return false;
  if (backendId === 'codex-cli') return providerId === 'openai-codex' && lane === 'chatgpt-subscription';
  if (backendId === 'claude-code') return providerId === 'anthropic-subscription' && lane === 'claude-subscription';
  if (backendId === 'openrouter') return providerId === 'openrouter' && lane === 'openrouter-metered';
  if (backendId === 'opencode' || backendId === 'cline') return inferBillingLane(backendId, providerId) === lane;
  return false;
}

export function billingLanesForBackend(backendId?: string): BillingLane[] {
  if (backendId === 'opencode') return ['opencode-go-subscription', 'chatgpt-subscription', 'opencode-metered', 'openai-api', 'anthropic-api'];
  if (backendId === 'cline') return ['clinepass-subscription', 'chatgpt-subscription', 'cline-usage-billing', 'openai-api', 'anthropic-api'];
  if (backendId === 'codex-cli') return ['chatgpt-subscription'];
  if (backendId === 'claude-code') return ['claude-subscription'];
  if (backendId === 'openrouter') return ['openrouter-metered'];
  return ['unknown'];
}

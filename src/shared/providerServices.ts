import { routeMatchesBillingLane } from './billing.js';
import type { BillingLane, ConnectionProfile, ProviderStatus } from './types.js';

/**
 * The four subscription services Turing can reuse through a provider's own official command line. Each one is a
 * fixed, existing route (backend, provider, billing lane); choosing a service derives those three fields so nobody
 * has to type them. A saved connection stores only the route and a user-typed label. It is a reusable reference, not
 * a sign-in: it does not authenticate anyone and does not switch the account a CLI is signed in to.
 *
 * `instructions` were checked against each vendor's official documentation on VERIFIED_ON. Commands are only ever
 * displayed; Turing never runs them. Re-verify them whenever a provider adapter changes (docs/PROVIDERS.md).
 */
export const PROVIDER_INSTRUCTIONS_VERIFIED_ON = '2026-10-20';

export type ProviderServiceId = 'opencode-go' | 'codex-chatgpt' | 'claude-subscription' | 'clinepass';

export interface InstructionCommand {
  /** What the command does, in a few words. */
  label: string;
  command: string;
}

export interface ProviderService {
  id: ProviderServiceId;
  /** The recognisable name shown on the chooser. */
  label: string;
  /** One line on what the service is. */
  summary: string;
  backendId: string;
  providerId: string;
  billingLane: BillingLane;
  /** Default name offered when saving a connection. */
  defaultConnectionName: string;
  /** Placeholder for the optional plan label. The label is whatever the user types and is never verified. */
  planLabelExample: string;
  install: {
    /** Commands copied from the vendor's official install page. Empty when no command could be verified. */
    commands: InstructionCommand[];
    note: string;
    docsUrl: string;
  };
  signIn: {
    /** Plain steps on the Desktop Master. A command is never presented as something Turing runs. */
    steps: string[];
    commands: InstructionCommand[];
    note: string;
    docsUrl: string;
  };
  /** What Turing can and cannot read for this service, in plain words. */
  checks: {
    authentication: string;
    catalogue: string;
  };
  /** Honest limits that apply to the subscription lane. */
  limits: string[];
}

export const PROVIDER_SERVICES: readonly ProviderService[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    summary: 'OpenCode Go subscription through the OpenCode CLI.',
    backendId: 'opencode',
    providerId: 'opencode-go',
    billingLane: 'opencode-go-subscription',
    defaultConnectionName: 'OpenCode Go',
    planLabelExample: 'Go or Go Plus',
    install: {
      commands: [
        { label: 'Install script', command: 'curl -fsSL https://opencode.ai/install | bash' },
        { label: 'or npm', command: 'npm install -g opencode-ai' },
      ],
      note: 'From the official OpenCode docs. Read a script before you run it. OpenCode 1 and OpenCode 2 installs can conflict, so keep only one.',
      docsUrl: 'https://opencode.ai/docs/',
    },
    signIn: {
      steps: [
        'Sign in to the OpenCode Console, subscribe to Go, and copy your API key.',
        'Start OpenCode on the Desktop Master, run /connect, choose OpenCode Go and paste the key into OpenCode itself.',
        'Run /models in OpenCode to confirm a Go model is listed.',
      ],
      commands: [{ label: 'Start OpenCode', command: 'opencode' }],
      note: 'Paste the key only into OpenCode on the Desktop Master. Turing never asks for it and never stores it.',
      docsUrl: 'https://opencode.ai/docs/go/',
    },
    checks: {
      authentication:
        'Turing reads opencode auth list. It shows that OpenCode holds some credential, not that the credential is OpenCode Go or that the plan is active.',
      catalogue:
        'Turing reads opencode models --verbose and counts models whose provider is opencode-go. Listed models still depend on your plan limits.',
    },
    limits: [
      'OpenCode can use your Console balance after Go limits when “Use balance” is on in the OpenCode console. Turing cannot read or change that setting.',
    ],
  },
  {
    id: 'codex-chatgpt',
    label: 'Codex — ChatGPT subscription',
    summary: 'Codex CLI signed in with your ChatGPT plan.',
    backendId: 'codex-cli',
    providerId: 'openai-codex',
    billingLane: 'chatgpt-subscription',
    defaultConnectionName: 'Codex — ChatGPT',
    planLabelExample: 'Pro',
    install: {
      commands: [],
      note: 'No install command could be verified for the Codex CLI. Follow the official Codex instructions. Turing needs Codex CLI 0.155 or later.',
      docsUrl: 'https://learn.chatgpt.com/docs/developer-commands',
    },
    signIn: {
      steps: [
        'On the Desktop Master, run codex login and finish the browser sign-in with your ChatGPT account.',
        'On a machine with no browser, codex login --device-auth uses a device code (device-code login must be enabled in your ChatGPT security settings).',
        'Run codex login status to see the active sign-in method.',
      ],
      commands: [
        { label: 'Sign in with ChatGPT', command: 'codex login' },
        { label: 'No browser on this machine', command: 'codex login --device-auth' },
        { label: 'Check sign-in', command: 'codex login status' },
      ],
      note: 'Signing in with an API key bills API usage instead of your ChatGPT plan. Turing forces ChatGPT sign-in and never uses an API key for this route.',
      docsUrl: 'https://learn.chatgpt.com/docs/auth',
    },
    checks: {
      authentication:
        'Turing reads codex login status and reports ChatGPT sign-in only when the CLI says so.',
      catalogue:
        'Turing reads the models visible to the signed-in Codex app server. A visible model is not a promise of remaining allowance.',
    },
    limits: [
      'Turing cannot read remaining ChatGPT allowance, reset time, or whether purchased credits can be used after plan limits.',
    ],
  },
  {
    id: 'claude-subscription',
    label: 'Claude Pro / Max',
    summary: 'Claude Code signed in with your Claude subscription.',
    backendId: 'claude-code',
    providerId: 'anthropic-subscription',
    billingLane: 'claude-subscription',
    defaultConnectionName: 'Claude Code — subscription',
    planLabelExample: 'Pro or Max',
    install: {
      commands: [
        { label: 'macOS, Linux, WSL', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
        { label: 'Homebrew', command: 'brew install --cask claude-code' },
      ],
      note: 'From the official Claude Code docs. Read a script before you run it. Turing needs Claude Code 2.1.248 or later.',
      docsUrl: 'https://code.claude.com/docs/en/setup',
    },
    signIn: {
      steps: [
        'On the Desktop Master, run claude auth login and finish the browser sign-in with your Claude account.',
        'Run claude auth status to confirm the sign-in method.',
      ],
      commands: [
        { label: 'Sign in', command: 'claude auth login' },
        { label: 'Check sign-in', command: 'claude auth status' },
      ],
      note: 'Do not add --console: that signs in for API billing instead of your Claude subscription.',
      docsUrl: 'https://code.claude.com/docs/en/cli-usage',
    },
    checks: {
      authentication:
        'Turing reads claude auth status and reports a subscription only when the CLI names the claude.ai sign-in method.',
      catalogue:
        'Claude Code reports no model list. Enter the exact model alias your installed CLI accepts; Turing cannot validate it.',
    },
    limits: [
      'Turing cannot read remaining Claude allowance or whether extra usage is enabled in your Anthropic account.',
    ],
  },
  {
    id: 'clinepass',
    label: 'ClinePass',
    summary: 'ClinePass subscription through the Cline CLI.',
    backendId: 'cline',
    providerId: 'cline-pass',
    billingLane: 'clinepass-subscription',
    defaultConnectionName: 'ClinePass',
    planLabelExample: 'ClinePass',
    install: {
      commands: [{ label: 'npm', command: 'npm install -g cline' }],
      note: 'From the official Cline CLI README.',
      docsUrl: 'https://github.com/cline/cline/blob/main/apps/cli/README.md',
    },
    signIn: {
      steps: [
        'Subscribe to ClinePass from your Cline account.',
        'On the Desktop Master, run cline auth and finish the sign-in.',
        'In the Cline CLI, choose ClinePass as the provider, following the ClinePass guide.',
      ],
      commands: [{ label: 'Sign in', command: 'cline auth' }],
      note: 'The official ClinePass page and CLI README describe the provider step differently, so follow the ClinePass guide for your installed version.',
      docsUrl: 'https://github.com/cline/cline/blob/main/docs/getting-started/clinepass.mdx',
    },
    checks: {
      authentication:
        'The Cline CLI has no read-only sign-in check, so Turing always shows sign-in as Unknown for this service.',
      catalogue: 'Turing infers no Cline model catalogue. Enter the exact model ID your Cline setup accepts.',
    },
    limits: [
      'ClinePass allowance and the 5-hour, weekly and monthly limits are shown in your Cline dashboard. Turing never switches ClinePass to Cline usage billing.',
    ],
  },
];

export function providerServiceById(id: string): ProviderService | undefined {
  return PROVIDER_SERVICES.find((service) => service.id === id);
}

/** The service a saved route belongs to, or undefined for a custom route. */
export function providerServiceForRoute(
  backendId: string | undefined,
  providerId: string | undefined,
  billingLane: string | undefined,
): ProviderService | undefined {
  return PROVIDER_SERVICES.find(
    (service) =>
      service.backendId === backendId &&
      service.providerId === providerId &&
      service.billingLane === billingLane,
  );
}

/** A connection profile body for a known service. Every route field is derived; none is typed by the user. */
export function connectionProfileForService(
  service: ProviderService,
  input: { name: string; planLabel?: string },
): Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> {
  const planLabel = input.planLabel?.trim();
  return {
    name: input.name.trim(),
    backendId: service.backendId,
    providerId: service.providerId,
    billingLane: service.billingLane,
    credentialStoreRef: null,
    metadata: {
      serviceId: service.id,
      ...(planLabel ? { planLabel } : {}),
    },
  };
}

/** The user's own plan label from a connection, never presented as a verified fact. */
export function planLabelOf(profile: Pick<ConnectionProfile, 'metadata'>): string | null {
  const label = profile.metadata?.planLabel;
  return typeof label === 'string' && label.trim() ? label.trim() : null;
}

export type CheckState = 'ok' | 'attention' | 'unknown' | 'missing';

export interface CheckLine {
  state: CheckState;
  /** Short value shown beside the check name. */
  label: string;
  /** What the check does and does not prove. */
  detail: string;
}

export interface RouteReadiness {
  installation: CheckLine;
  authentication: CheckLine;
  catalogue: CheckLine;
  lastCheck: CheckLine;
  /** A connection may be saved only when the CLI was detected. Unknown sign-in never blocks saving. */
  canSave: boolean;
  saveBlocker: string | null;
}

function relativeTime(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < 0) return new Date(iso).toLocaleString();
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Installation, authentication, catalogue and last check, reported separately. A detected CLI proves only that it can
 * be launched. Unknown stays Unknown, and nothing here claims a subscription or an exact model is usable.
 */
export function routeReadiness(
  backendId: string,
  providerId: string,
  provider: ProviderStatus | undefined,
  now: number = Date.now(),
): RouteReadiness {
  if (!provider) {
    const unknown = (detail: string): CheckLine => ({ state: 'unknown', label: 'Unknown', detail });
    return {
      installation: unknown('Turing has no status for this provider yet. Use Check again.'),
      authentication: unknown('Cannot be checked until the provider status is known.'),
      catalogue: unknown('Cannot be checked until the provider status is known.'),
      lastCheck: { state: 'unknown', label: 'Never', detail: 'This provider has not been checked.' },
      canSave: false,
      saveBlocker: 'Turing has no status for this provider yet. Use Check again.',
    };
  }

  const installation: CheckLine = provider.detected
    ? {
        state: 'ok',
        label: provider.version ? `Detected · ${provider.version}` : 'Detected',
        detail: 'The command line program can be launched. This does not show that you are signed in.',
      }
    : {
        state: 'missing',
        label: 'Not detected',
        detail: `Turing could not launch “${provider.cli}” on this Desktop Master.`,
      };

  let authentication: CheckLine;
  if (!provider.detected) {
    authentication = {
      state: 'unknown',
      label: 'Unknown',
      detail: 'Sign-in cannot be checked while the CLI is not installed.',
    };
  } else if (backendId === 'cline') {
    authentication = {
      state: 'unknown',
      label: 'Unknown',
      detail:
        'The Cline CLI has no read-only sign-in check. Turing cannot confirm sign-in or a ClinePass subscription.',
    };
  } else if (backendId === 'codex-cli') {
    authentication =
      provider.subscriptionAuthenticated === true
        ? {
            state: 'ok',
            label: 'Signed in with ChatGPT',
            detail: 'Reported by codex login status. Plan limits and remaining allowance are not checked.',
          }
        : provider.subscriptionAuthenticated === false || provider.authentication === 'disconnected'
          ? {
              state: 'missing',
              label: 'Not signed in with ChatGPT',
              detail: 'Codex reports no ChatGPT sign-in. An API-key sign-in is not used by this connection.',
            }
          : { state: 'unknown', label: 'Unknown', detail: 'Codex did not report a sign-in method.' };
  } else if (backendId === 'claude-code') {
    authentication =
      provider.subscriptionAuthenticated === true
        ? {
            state: 'ok',
            label: 'Signed in with a Claude subscription',
            detail: 'Reported by claude auth status. Plan limits and remaining allowance are not checked.',
          }
        : provider.subscriptionAuthenticated === false || provider.authentication === 'disconnected'
          ? {
              state: 'missing',
              label: 'No Claude subscription sign-in',
              detail:
                'Claude Code reports no claude.ai sign-in. It may be signed in another way, such as API billing, which this connection does not use.',
            }
          : { state: 'unknown', label: 'Unknown', detail: 'Claude Code did not report a sign-in method.' };
  } else if (backendId === 'opencode') {
    authentication =
      provider.authentication === 'connected'
        ? {
            state: 'attention',
            label: 'A credential exists',
            detail:
              'OpenCode lists a stored credential. Turing cannot tell which provider it belongs to or whether your plan is active.',
          }
        : provider.authentication === 'disconnected'
          ? {
              state: 'missing',
              label: 'No credential listed',
              detail: 'OpenCode lists no stored credential.',
            }
          : { state: 'unknown', label: 'Unknown', detail: 'OpenCode did not report credentials.' };
  } else {
    authentication =
      provider.authentication === 'connected'
        ? { state: 'ok', label: 'Connected', detail: 'Reported by the provider.' }
        : provider.authentication === 'disconnected'
          ? { state: 'missing', label: 'Not connected', detail: 'The provider reports no connection.' }
          : { state: 'unknown', label: 'Unknown', detail: 'The provider did not report a sign-in state.' };
  }

  let catalogue: CheckLine;
  if (!provider.capabilities.modelDiscovery) {
    catalogue = {
      state: 'unknown',
      label: 'No catalogue',
      detail:
        'This provider reports no model list. Enter the exact model ID; Turing cannot validate it before a run.',
    };
  } else {
    const relevant =
      backendId === 'opencode'
        ? provider.models.filter((model) => model.providerId === providerId)
        : provider.models;
    const source =
      provider.catalogSource === 'cache'
        ? 'last known (live refresh failed)'
        : provider.catalogSource === 'none'
          ? 'unavailable'
          : 'current';
    catalogue =
      relevant.length > 0
        ? {
            state: provider.catalogSource === 'cache' ? 'attention' : 'ok',
            label: `${relevant.length} ${relevant.length === 1 ? 'model' : 'models'} listed`,
            detail: `Catalogue ${source}. A listed model is not a promise that your plan can use it.`,
          }
        : provider.models.length > 0
          ? {
              state: 'attention',
              label: `No ${providerId} models`,
              detail: `The catalogue lists models for other providers only. Check that ${providerId} is connected in the provider CLI.`,
            }
          : {
              state: 'attention',
              label: 'Empty',
              detail:
                'The CLI was detected but its model list is empty or could not be read. Use Check again, or enter an exact model ID.',
            };
  }

  const lastCheck: CheckLine = provider.checkedAt
    ? {
        state: 'ok',
        label: relativeTime(provider.checkedAt, now),
        detail: provider.catalogRefreshedAt
          ? `Status checked ${new Date(provider.checkedAt).toLocaleString()}; catalogue refreshed ${new Date(provider.catalogRefreshedAt).toLocaleString()}.`
          : `Status checked ${new Date(provider.checkedAt).toLocaleString()}. No generation prompt is sent by a check.`,
      }
    : { state: 'unknown', label: 'Never', detail: 'This provider has not been checked.' };

  return {
    installation,
    authentication,
    catalogue,
    lastCheck,
    canSave: provider.detected,
    saveBlocker: provider.detected
      ? null
      : `${provider.name} was not detected on this Desktop Master. Install it, then use Check again.`,
  };
}

/** True when a saved route is one of the four recognised service routes, so it can be shown by its friendly name. */
export function isKnownServiceRoute(backendId: string, providerId: string, billingLane: string): boolean {
  return (
    providerServiceForRoute(backendId, providerId, billingLane) !== undefined &&
    routeMatchesBillingLane(backendId, providerId, billingLane)
  );
}

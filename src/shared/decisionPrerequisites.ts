import { evaluateBillingLane } from './billing.js';
import { decisionEngineInfo } from './decisions.js';
import { classifyModelIdentity } from './modelSettings.js';
import type {
  BillingLane,
  BillingMode,
  DecisionEngineId,
  ExternalDataPolicy,
  ProviderStatus,
} from './types.js';

/**
 * What an optional Decision Gate needs before it can run, gathered in one place. This only reads configuration and
 * the last known provider status. It never enables spending, authorises external data, picks a model or changes a
 * workflow: each prerequisite names the explicit action that would resolve it, and the person takes that action.
 */
export type PrerequisiteId = 'connection' | 'model' | 'cap' | 'billing' | 'external-data';
export type PrerequisiteStatus = 'met' | 'missing' | 'attention' | 'unknown';

export type PrerequisiteFix =
  | { kind: 'open-openrouter-settings' }
  | { kind: 'choose-connection' }
  | { kind: 'choose-model' }
  | { kind: 'set-cap' }
  | { kind: 'use-decision-budget' }
  | { kind: 'edit-allowed-lanes' }
  | { kind: 'set-external-policy' };

export interface Prerequisite {
  id: PrerequisiteId;
  label: string;
  status: PrerequisiteStatus;
  /** One line a person can read at a glance. */
  summary: string;
  /** What the status does and does not prove. */
  detail?: string;
  /** The explicit action that would resolve it. Absent when nothing needs doing. */
  fix?: PrerequisiteFix;
}

export interface PrerequisiteProfile {
  id: string;
  name: string;
  backendId: string;
  billingLane: BillingLane;
  /** Whether an inference key is stored. The key itself never reaches the browser. */
  credentials?: { inference: boolean; management: boolean };
}

export interface PrerequisiteInput {
  engine: DecisionEngineId;
  modelId?: string;
  connectionProfileId?: string;
  profiles: readonly PrerequisiteProfile[];
  openRouter?: Pick<ProviderStatus, 'models' | 'catalogSource' | 'checkedAt' | 'detected'>;
  billingMode: BillingMode;
  perRunUsd: number | null;
  customAllowedLanes?: readonly BillingLane[];
  externalDataPolicy: ExternalDataPolicy;
}

const money = (value: number) => `$${value.toFixed(2)}`;

function connectionPrerequisite(input: PrerequisiteInput): Prerequisite {
  const label = 'OpenRouter connection';
  const openRouterProfiles = input.profiles.filter((profile) => profile.backendId === 'openrouter');
  if (!input.connectionProfileId)
    return openRouterProfiles.length
      ? {
          id: 'connection',
          label,
          status: 'missing',
          summary: 'No connection selected.',
          detail: 'Choose which OpenRouter connection this gate may use. Turing never picks one for you.',
          fix: { kind: 'choose-connection' },
        }
      : {
          id: 'connection',
          label,
          status: 'missing',
          summary: 'No OpenRouter connection exists yet.',
          detail:
            'Adding one in Settings does not add a gate, enable spending or send anything. Your workflow draft is kept while you are there.',
          fix: { kind: 'open-openrouter-settings' },
        };
  const profile = input.profiles.find((item) => item.id === input.connectionProfileId);
  if (!profile)
    return {
      id: 'connection',
      label,
      status: 'missing',
      summary: 'The selected connection no longer exists.',
      detail: 'It was deleted or belongs to another machine. Choose an existing connection.',
      fix: openRouterProfiles.length ? { kind: 'choose-connection' } : { kind: 'open-openrouter-settings' },
    };
  if (profile.backendId !== 'openrouter')
    return {
      id: 'connection',
      label,
      status: 'missing',
      summary: `“${profile.name}” is not an OpenRouter connection.`,
      fix: openRouterProfiles.length ? { kind: 'choose-connection' } : { kind: 'open-openrouter-settings' },
    };
  if (profile.credentials && !profile.credentials.inference)
    return {
      id: 'connection',
      label,
      status: 'missing',
      summary: `“${profile.name}” has no inference key stored on the Desktop Master.`,
      detail: 'Store the key in Settings. It stays on the Desktop Master and never reaches this browser.',
      fix: { kind: 'open-openrouter-settings' },
    };
  return {
    id: 'connection',
    label,
    status: 'met',
    summary: `“${profile.name}” with an inference key stored.`,
    detail: 'Turing cannot tell whether the OpenRouter account has credit without sending a request.',
  };
}

function modelPrerequisite(input: PrerequisiteInput): Prerequisite {
  const label = 'Exact compatible model';
  const modelId = input.modelId?.trim();
  if (!modelId)
    return {
      id: 'model',
      label,
      status: 'missing',
      summary: 'No model chosen.',
      detail: 'Choose an exact model version. Turing does not pick a “latest” alias for you.',
      fix: { kind: 'choose-model' },
    };
  const wantsDecisionFamily = input.engine === 'jev-openrouter';
  const catalogue = input.openRouter?.models ?? [];
  const catalogueKnown =
    Boolean(input.openRouter?.detected) && input.openRouter?.catalogSource !== 'none' && catalogue.length > 0;
  const identity = classifyModelIdentity('openrouter', modelId);
  const floatingNote =
    identity === 'floating'
      ? ' This is a floating or routed alias, so the model behind it can change without a new saved version.'
      : '';
  if (!catalogueKnown)
    return {
      id: 'model',
      label,
      status: 'unknown',
      summary: `${modelId} is saved but cannot be checked.`,
      detail: `No OpenRouter catalogue is available, so compatibility is not verified. The saved exact ID is kept and sent unchanged; Turing will not move it to a newer version.${floatingNote}`,
    };
  const found = catalogue.find((model) => model.id === modelId);
  if (!found)
    return {
      id: 'model',
      label,
      status: 'attention',
      summary: `${modelId} is not in the current catalogue.`,
      detail: `Turing keeps the saved version and will not substitute a newer one. Choose a listed model if this one has been retired.${floatingNote}`,
      fix: { kind: 'choose-model' },
    };
  const isDecision = found.family === 'decision';
  if (wantsDecisionFamily && !isDecision)
    return {
      id: 'model',
      label,
      status: 'missing',
      summary: `${modelId} is not a Jev decision model.`,
      detail: 'JEV needs a model from the decision family. Choose one from the list.',
      fix: { kind: 'choose-model' },
    };
  if (!wantsDecisionFamily && isDecision)
    return {
      id: 'model',
      label,
      status: 'missing',
      summary: `${modelId} is a Jev decision model, not a generative judge.`,
      fix: { kind: 'choose-model' },
    };
  return {
    id: 'model',
    label,
    status: identity === 'floating' ? 'attention' : 'met',
    summary: `${found.name || modelId} · ${modelId}${identity === 'floating' ? ' · floating alias' : ' · pinned'}`,
    detail: `Listed in the OpenRouter catalogue${input.openRouter?.catalogSource === 'cache' ? ' (last known; a live refresh failed)' : ''}.${floatingNote}`,
  };
}

function billingPrerequisite(input: PrerequisiteInput): Prerequisite {
  const label = 'Billing mode';
  const decision = evaluateBillingLane({
    mode: input.billingMode,
    lane: 'openrouter-metered',
    workload: 'decision',
    customAllowedLanes: input.customAllowedLanes,
  });
  if (decision.allowed)
    return {
      id: 'billing',
      label,
      status: 'met',
      summary:
        input.billingMode === 'subscriptions-plus-decision-budget'
          ? 'Subscriptions + Decision Budget: only decision gates may spend.'
          : 'Custom: explicitly configured metered lanes may run.',
      detail: 'Generative OpenRouter stages stay blocked in Subscriptions + Decision Budget.',
    };
  return {
    id: 'billing',
    label,
    status: 'missing',
    summary:
      input.billingMode === 'subscriptions-only'
        ? 'Subscriptions Only blocks every metered request, including this gate.'
        : (decision.reason ?? 'This billing mode does not permit the gate.'),
    detail:
      input.billingMode === 'subscriptions-only'
        ? 'Nothing changes until you choose a mode that permits decision spending.'
        : undefined,
    fix: input.billingMode === 'custom' ? { kind: 'edit-allowed-lanes' } : { kind: 'use-decision-budget' },
  };
}

function capPrerequisite(input: PrerequisiteInput): Prerequisite {
  const label = 'Decision spending cap';
  const required = input.billingMode === 'subscriptions-plus-decision-budget';
  if (input.perRunUsd === null)
    return {
      id: 'cap',
      label,
      status: required ? 'missing' : 'attention',
      summary: required ? 'A per-run cap is required and none is set.' : 'No per-run cap is set.',
      detail: required
        ? 'Subscriptions + Decision Budget will not run decisions without a per-run cap. Daily and monthly caps from Settings still apply.'
        : 'Daily and monthly caps from Settings still apply. Set a per-run cap to bound one run.',
      fix: { kind: 'set-cap' },
    };
  if (input.perRunUsd === 0)
    return {
      id: 'cap',
      label,
      status: 'attention',
      summary: `Per-run cap is ${money(0)}, so every metered decision request will be blocked.`,
      fix: { kind: 'set-cap' },
    };
  return {
    id: 'cap',
    label,
    status: 'met',
    summary: `${money(input.perRunUsd)} per run, reserved before each request.`,
    detail: 'A Turing-side hard cap. It is separate from any OpenRouter key limit.',
  };
}

function externalDataPrerequisite(input: PrerequisiteInput): Prerequisite {
  const label = 'External-data permission';
  if (input.externalDataPolicy === 'block')
    return {
      id: 'external-data',
      label,
      status: 'missing',
      summary: 'This workflow blocks sending project state to external engines.',
      detail: 'Run Preview will block the run. Change the policy only if you want this gate to receive data.',
      fix: { kind: 'set-external-policy' },
    };
  return input.externalDataPolicy === 'allow'
    ? {
        id: 'external-data',
        label,
        status: 'met',
        summary: 'Allowed for configured external engines.',
        detail: 'Only the evidence categories chosen below are sent.',
      }
    : {
        id: 'external-data',
        label,
        status: 'met',
        summary: 'Asks you before the first external send.',
        detail:
          'Not yet authorised. One approval is requested per project and engine, and nothing is sent before it.',
      };
}

/** The prerequisites a gate needs, in the order they are explained. Empty for a gate that needs none. */
export function decisionPrerequisites(input: PrerequisiteInput): Prerequisite[] {
  const info = decisionEngineInfo(input.engine);
  if (!info.external) return [];
  if (input.engine === 'subscription-llm-judge') return [externalDataPrerequisite(input)];
  return [
    connectionPrerequisite(input),
    modelPrerequisite(input),
    capPrerequisite(input),
    billingPrerequisite(input),
    externalDataPrerequisite(input),
  ];
}

export function unmetPrerequisites(items: readonly Prerequisite[]): Prerequisite[] {
  return items.filter((item) => item.status === 'missing');
}

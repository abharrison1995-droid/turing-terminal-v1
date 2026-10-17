/*
 * FIXTURE DATA (UI.4). Every value in this file is invented for deterministic evidence. Names carry a "Fixture" marker,
 * machine origins use the reserved `.invalid` domain, and no value is a real key, cookie, token, device or spend figure.
 * Each object is checked with `satisfies` against the shared or client types, so a drifting shape fails the typecheck.
 *
 * `ui4Routes` is `populatedRoutes` with the Settings, Usage and pairing endpoints replaced. `populated.ts` is not
 * changed, so the UI.1c, UI.2 and UI.3 captures keep the inputs they were taken with.
 */
import type {
  BudgetStatus,
  ConnectionProfileWithCredentials,
  MetricTotal,
  UsageAggregate,
  UsageAnalytics,
  UsageGroupRow,
} from '../../src/client/api';
import type { MachineProfile } from '../../src/client/machineProfiles';
import type { MeteredBudgetSettings } from '../../src/shared/types';
import { FIXED_NOW } from './dashboard';
import { populatedRoutes } from './populated';

const NOW_MS = Date.parse(FIXED_NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysBeforeNow: number): string => new Date(NOW_MS - daysBeforeNow * DAY_MS).toISOString();
const ahead = (daysAfterNow: number): string => new Date(NOW_MS + daysAfterNow * DAY_MS).toISOString();

/** The QR pairing request id a phone opens with: a fixture UUID, valid for the pairing page's parser. */
export const UI4_QR_REQUEST = '3f2c9a10-5b7e-4d2a-9c1e-8a7b6c5d4e3f';

/** The three machine origins seeded into localStorage. They use the reserved `.invalid` domain and are never reached. */
export const UI4_ORIGINS = {
  online: 'https://desk.fixture.invalid',
  offline: 'https://laptop.fixture.invalid',
  checking: 'https://studio.fixture.invalid',
} as const;

/** Machine profiles for the Machines page. Probes are stubbed per origin in the spec: online answers, offline fails, checking never answers. */
export const UI4_MACHINE_PROFILES = [
  {
    origin: UI4_ORIGINS.online,
    machineId: 'fixture-machine-desk',
    name: 'Fixture desk master',
    hostname: 'fixture-desk-host',
    os: 'linux',
    lastSeenAt: at(0),
    reachability: 'online',
  },
  {
    origin: UI4_ORIGINS.offline,
    machineId: null,
    name: 'Fixture laptop master',
    hostname: null,
    os: null,
    lastSeenAt: at(3),
    reachability: 'offline',
  },
  {
    origin: UI4_ORIGINS.checking,
    machineId: 'fixture-machine-studio-0000-4000-8000-00000000002a-with-a-long-identifier',
    name: 'Fixture studio master with a long display name',
    hostname: 'fixture-studio-host.tailnet-long-name.invalid',
    os: 'darwin',
    lastSeenAt: null,
    reachability: 'unknown',
  },
] satisfies MachineProfile[];

/** The dashboard error a device gets before it is paired. The spec answers `/api/dashboard` with this status. */
export const UI4_PAIRING_REQUIRED = {
  status: 401,
  body: { error: 'Pair this device with the desktop before using it.' },
} satisfies { status: number; body: { error: string } };

// ---- Usage analytics -----------------------------------------------------------------------------------------------

const metric = (value: number | null, reported: number): MetricTotal => ({
  value,
  reported,
  missing: value === null ? reported : 0,
});

function aggregate(
  events: number,
  inputTokens: number,
  outputTokens: number,
  tokenProvenance: Record<string, number>,
): UsageAggregate {
  return {
    events,
    requests: events,
    durationMs: events * 3_900,
    inputTokens: metric(inputTokens, events),
    outputTokens: metric(outputTokens, events),
    // A null metric on purpose: no provider reported cached input for these calls, so the tile reads Unavailable.
    cachedInputTokens: metric(null, events),
    cacheWriteTokens: metric(null, events),
    reasoningTokens: metric(null, events),
    totalTokens: metric(inputTokens + outputTokens, events),
    actualMeteredCostUsd: metric(0, events),
    equivalentValueUsd: metric(null, events),
    tokenProvenance,
  };
}

function group(
  key: string,
  label: string,
  billingLane: string,
  modelId: string | null,
  totals: UsageAggregate,
): UsageGroupRow {
  return {
    ...totals,
    key,
    label,
    billingLane,
    providerId: 'anthropic-subscription',
    modelId,
    roles: {},
    projects: {},
    reasoning: {},
    upstreamProviders: {},
  };
}

/** Mixed provenance: provider and local counts, plus a count of calls with no usable provenance. */
const totals = aggregate(128, 1_234_567, 234_567, {
  locally_measured: 96,
  provider_measured: 32,
  unavailable: 4,
});
const dayBuckets = [
  '2026-01-09',
  '2026-01-10',
  '2026-01-11',
  '2026-01-12',
  '2026-01-13',
  '2026-01-14',
  '2026-01-15',
];

const usageAnalytics = {
  filter: { from: at(7), to: FIXED_NOW, timeZone: 'UTC' },
  granularity: 'day',
  totals,
  activeModels: 2,
  activeBillingLanes: 2,
  series: dayBuckets.map((bucket, index) => ({
    bucket,
    ...aggregate(14 + index * 2, 150_000 + index * 9_000, 25_000 + index * 1_500, {
      locally_measured: 14 + index * 2,
    }),
  })),
  byBillingLane: [
    group(
      'subscription',
      'Subscription (fixture)',
      'subscription',
      null,
      aggregate(96, 900_000, 170_000, {
        locally_measured: 96,
      }),
    ),
    group(
      'openrouter-metered',
      'OpenRouter metered (fixture)',
      'openrouter-metered',
      null,
      aggregate(32, 334_567, 64_567, {
        provider_measured: 32,
      }),
    ),
  ],
  byModel: [
    group(
      'fixture-model-1',
      'Fixture model 1',
      'subscription',
      'fixture-model-1',
      aggregate(96, 900_000, 170_000, {
        locally_measured: 96,
      }),
    ),
    group(
      'fixture-model-2',
      'Fixture model 2',
      'openrouter-metered',
      'fixture-model-2',
      aggregate(32, 334_567, 64_567, {
        provider_measured: 32,
      }),
    ),
  ],
  byProvider: [],
  byRole: [],
  byProject: [
    group(
      'fixture-project-atlas',
      'Fixture Atlas API',
      'subscription',
      null,
      aggregate(54, 510_000, 96_000, {
        locally_measured: 54,
      }),
    ),
    group(
      'fixture-project-ledger',
      'Fixture Ledger UI',
      'subscription',
      null,
      aggregate(48, 460_000, 88_000, {
        locally_measured: 42,
        unavailable: 4,
        provider_measured: 2,
      }),
    ),
  ],
  byWorkflow: [],
  byMachine: [],
  byWorkload: [],
  byReasoning: [],
  decisions: {
    decisions: 0,
    byType: {},
    byOutcome: {},
    autoRouted: 0,
    escalated: 0,
    costUsd: metric(null, 0),
    inputTokens: metric(null, 0),
    outputTokens: metric(null, 0),
    averageBooleanProbability: null,
    averageChoiceConfidence: null,
    averageScoreConfidence: null,
    byEngineModel: [],
  },
  events: [],
  eventCount: totals.events,
} satisfies UsageAnalytics;

// ---- Budgets (non-zero committed spend; one cap set, one not, so the meter and the "No cap" row both render) ----------

export const ui4BudgetStatus = {
  timeZone: 'UTC',
  run: { committedUsd: 0, capUsd: null },
  daily: { committedUsd: 4.2, capUsd: 10 },
  monthly: { committedUsd: 31.6, capUsd: null },
  warningRatio: 0.8,
} satisfies BudgetStatus;

const budgetSettings = {
  dailyUsd: 10,
  monthlyUsd: null,
  warningRatio: 0.8,
  timezone: 'UTC',
  updatedAt: at(3),
} satisfies MeteredBudgetSettings;

// ---- Quota envelopes (a forecast with values, and one whose forecast is unavailable) --------------------------------

interface QuotaEnvelopeView {
  id: string;
  providerId: string;
  quotaName: string;
  windowLabel: string;
  effectiveAt: string;
  resetAt: string;
  allowance: number;
  unit: 'total_tokens' | 'requests';
  notes: string;
  subscriptionCostUsd: number | null;
  forecast: {
    observedUsed: number | null;
    usageProvenance: string;
    remaining: number | null;
    averagePerDay: number | null;
    projectedExhaustionAt: string | null;
    likelyBeforeReset: boolean | null;
    confidence: string;
    sampleCount: number;
  };
}

const quotas = [
  {
    id: 'fixture-quota-weekly',
    providerId: 'anthropic-subscription',
    quotaName: 'Fixture weekly allowance',
    windowLabel: 'Weekly',
    effectiveAt: at(2),
    resetAt: ahead(4),
    allowance: 5_000_000,
    unit: 'total_tokens',
    notes: 'Fixture: typed by the owner from the provider account page.',
    subscriptionCostUsd: 20,
    forecast: {
      observedUsed: 1_412_000,
      usageProvenance: 'locally_measured',
      remaining: 3_588_000,
      averagePerDay: 201_714.3,
      projectedExhaustionAt: ahead(2),
      likelyBeforeReset: true,
      confidence: 'medium',
      sampleCount: 37,
    },
  },
  {
    id: 'fixture-quota-monthly-requests',
    providerId: 'openai-codex',
    quotaName: 'Fixture monthly requests',
    windowLabel: 'Monthly',
    effectiveAt: at(10),
    resetAt: ahead(20),
    allowance: 1_000,
    unit: 'requests',
    notes: '',
    subscriptionCostUsd: null,
    forecast: {
      observedUsed: null,
      usageProvenance: 'unavailable',
      remaining: null,
      averagePerDay: null,
      projectedExhaustionAt: null,
      likelyBeforeReset: null,
      confidence: 'unavailable',
      sampleCount: 0,
    },
  },
] satisfies QuotaEnvelopeView[];

const usageLegacy = {
  window: '30d',
  days: 30,
  since: at(30),
  provenance: 'FIXTURE: locally measured activity, invented for screenshot evidence.',
  quotas,
  providers: [
    {
      key: 'anthropic-subscription',
      label: 'Fixture Claude lane',
      events: 96,
      costProvenance: 'estimated',
      estimatedCostUsd: 12.5,
    },
  ],
  models: [{ key: 'fixture-model-1', events: 96 }],
  projects: [
    { name: 'Fixture Atlas API', events: 54, duration_ms: 210_600 },
    { name: 'Fixture Ledger UI', events: 48, duration_ms: 187_200 },
  ],
  daily: [],
  eventCount: totals.events,
  raw: [],
} satisfies Record<string, unknown>;

// ---- Connections and pairing (Settings) -------------------------------------------------------------------------

const openRouterConnection = {
  id: 'fixture-profile-openrouter',
  name: 'Fixture OpenRouter connection',
  backendId: 'openrouter',
  providerId: 'openrouter',
  billingLane: 'openrouter-metered',
  credentialStoreRef: null,
  metadata: { note: 'FIXTURE: no key value is shown.' },
  createdAt: at(12),
  updatedAt: at(12),
  credentials: { inference: true, management: false },
} satisfies ConnectionProfileWithCredentials;

const pairingRequests = {
  requests: [
    {
      id: 'fixture-request-awaiting',
      deviceName: 'Fixture tablet',
      tailscaleLogin: null,
      createdAt: at(0.01),
      expiresAt: ahead(0.003),
      claimedAt: at(0.005),
      status: 'awaiting_approval',
    },
    {
      id: 'fixture-request-expired',
      deviceName: 'Fixture laptop browser',
      tailscaleLogin: null,
      createdAt: at(2),
      expiresAt: at(1.99),
      claimedAt: null,
      status: 'expired',
    },
  ],
} satisfies { requests: Array<Record<string, unknown>> };

/*
 * The page has only two device statuses, `active` and `expired`. The server leaves revoked devices out of this list
 * altogether (`revoked_at IS NULL`), so no revoked device reaches the page. The "Fixture retired phone" below is an
 * expired session, not a revocation: it stands in for a session whose lifetime has ended.
 * `pairingRequests` and `pairedDevices` are weakly typed: `satisfies` checks them against Record shapes only, so a field
 * rename in the pairing API would not fail the typecheck. Keep them in step with `api.ts` by hand.
 */
const pairedDevices = {
  devices: [
    {
      id: 'fixture-device-001',
      name: 'Fixture phone',
      tailscaleLogin: null,
      createdAt: at(5),
      lastSeenAt: at(0.05),
      expiresAt: ahead(85),
      status: 'active',
    },
    {
      id: 'fixture-device-retired',
      name: 'Fixture retired phone',
      tailscaleLogin: null,
      createdAt: at(60),
      lastSeenAt: at(40),
      expiresAt: at(20),
      status: 'expired',
    },
  ],
} satisfies { devices: Array<Record<string, unknown>> };

/**
 * The Usage, Settings and pairing endpoints that UI.4 replaces. Everything else is `populatedRoutes`.
 * `/api/usage` and the pairing endpoints are weakly typed (see `usageLegacy` and `pairedDevices`), so their shapes are
 * checked only by the page that reads them, not by the typecheck.
 */
export const ui4Routes: Record<string, unknown> = {
  ...populatedRoutes,
  '/api/usage': usageLegacy,
  '/api/usage/analytics': usageAnalytics,
  '/api/budgets': { settings: budgetSettings, status: ui4BudgetStatus, systemTimeZone: 'UTC' },
  '/api/connection-profiles': { profiles: [openRouterConnection] },
  '/api/pairing/requests': pairingRequests,
  '/api/pairing/devices': pairedDevices,
};

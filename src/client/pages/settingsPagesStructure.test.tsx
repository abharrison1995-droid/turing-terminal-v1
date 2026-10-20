// @vitest-environment jsdom

// UI.4 structure tests (UI4_SCOPE sections 4 and 5; matrix P1, P2, B1 and B2). GUARD tests characterise what the four
// pages already do: heading and control inventories, the Machines Connect and Remove rules, the billing copy that must
// not gain a fallback, and the UsageExplorer figures. RED tests need the approved presentational hooks in usage/UsageExplorer.tsx.
// Nothing here renders the full SettingsPage; Settings is covered by source inventories.
//
// Expectations the implementer must match (UI4_SCOPE gives the rules, these are the exact forms chosen for the tests):
// - ProvenanceBadge (usage/UsageExplorer.tsx, rendered in the UsageExplorer summary): one element with the class `provenance-badge`
//   for each tokenProvenance key whose count is above zero. Its text is the word, one space, then the count. The words:
//   provider_measured -> "Provider measured", locally_measured -> "Locally measured", user_configured -> "User configured",
//   estimated -> "Estimated", unavailable -> "Unavailable". (humanize() keeps underscores, so it is not used.)
//   Example: "Locally measured 128". With no counted provenance, one badge reads exactly "Unavailable", never "0".
//   The class is the one className hook for this: the same words recur across cards, so a class is the only stable scope.
// - Budget meter (usage/UsageExplorer.tsx, "Metered spend and budgets" in the UsageExplorer): when budget.<window>.capUsd is non-null,
//   an element with role="img" whose aria-label is exactly "Daily budget: $0.42 of $2.00 committed" (or "Monthly budget:"),
//   with committedUsd and capUsd each to two decimal places. The visible text "$0.42 of $2.00 committed" sits in the same
//   parent element as the meter. When capUsd is null, the row reads "No cap" and no budget meter is rendered.
// - The existing "left of" budget text and the existing "Unavailable" for a null metric already hold; they are GUARDed.
//
// Machines and the UsageExplorer render without a SettingsPage. The api and machineProfiles modules are mocked, and no
// test waits on real time: effects are flushed with act, and the 2 s and 20 s intervals are cleared on unmount.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../../shared/types';
import type { BudgetStatus, MetricTotal, UsageAggregate, UsageAnalytics } from '../api';
import type { MachineProfile } from '../machineProfiles';
import { UsageExplorer } from './usage/UsageExplorer';
import { MachinesPage } from './MachinesPage';

const usageAnalytics = vi.hoisted(() => vi.fn());
const budgets = vi.hoisted(() => vi.fn());
vi.mock('../api', async (importActual) => ({
  ...(await importActual<typeof import('../api')>()),
  api: { usageAnalytics, budgets, usageExportUrl: vi.fn(() => '/api/usage/export') },
}));

vi.mock('../machineProfiles', async (importActual) => ({
  ...(await importActual<typeof import('../machineProfiles')>()),
  probeMachine: vi.fn(async () => 'offline' as const),
}));

const pagesDir = dirname(fileURLToPath(import.meta.url));
const pageSource = (file: string) => readFileSync(join(pagesDir, file), 'utf8');
const meteredSource = pageSource('settings/MeteredProviderSettings.tsx');
const usageSource = pageSource('usage/UsageExplorer.tsx');

/** The source from one marker up to (not including) the next stop marker, or to the end of the file. */
function sectionOf(source: string, marker: string, stop?: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const end = stop ? source.indexOf(stop, start + marker.length) : -1;
  return source.slice(start, end < 0 ? undefined : end);
}

/** Static heading literals (no interpolation) of one tag, in source order. */
const headings = (source: string, tag: 'h1' | 'h2') =>
  [...source.matchAll(new RegExp(`<${tag}>([^<{]+)</${tag}>`, 'g'))].map((match) => match[1]!.trim());

/** PageHeading titles in source order. */
const pageTitles = (source: string) =>
  [...source.matchAll(/<PageHeading\s+title="([^"]+)"/g)].map((m) => m[1]!);

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Lets the resolved mock promises in UsageExplorer's effects settle, without waiting on real time. */
async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {});
  }
}

afterEach(cleanup);

describe('heading and control inventories (UI4 section 4, B2)', () => {
  it('[GUARD] each of the four pages has one h1: the PageHeading title, or the pairing page heading', () => {
    const titles = (file: string) => {
      const source = pageSource(file);
      return [...pageTitles(source), ...headings(source, 'h1')];
    };

    expect(titles('SettingsPage.tsx')).toEqual(['Settings']);
    expect(titles('UsagePage.tsx')).toEqual(['Usage']);
    expect(titles('MachinesPage.tsx')).toEqual(['Machines']);
    expect(titles('DevicePairingPage.tsx')).toEqual(['Connect this device']);
  });

  it('[GUARD] the Settings h2 inventory is unchanged, including the OpenRouter and budget sections', () => {
    // The old 'Provider integrations' card is replaced by 'Providers & connections', which lives in
    // settings/ProviderSetup.tsx (covered by settings/ProviderSetup.test.tsx and the card inventory in
    // settingsDropdownsStructure.test.ts).
    expect(headings(pageSource('SettingsPage.tsx'), 'h2')).toEqual([
      'Machine identity',
      'Permission modes',
      'Notifications',
      'Desktop application',
      'Tailscale readiness',
      'Paired devices',
      'Global and project rules',
    ]);
    expect(headings(pageSource('settings/ProviderSetup.tsx'), 'h2')).toEqual(['Providers &amp; connections']);
    expect(headings(sectionOf(meteredSource, 'export function OpenRouterSettings'), 'h2')).toEqual([
      'OpenRouter (optional, metered)',
      'Turing metered budgets',
    ]);
  });

  it('[GUARD] the Usage and Machines h2 inventories are unchanged', () => {
    expect(headings(pageSource('UsagePage.tsx'), 'h2')).toEqual(['User-configured quota envelopes']);
    expect(headings(sectionOf(usageSource, 'export function UsageExplorer'), 'h2')).toEqual([
      'By provider / billing lane',
      'By model',
      'Metered spend and budgets',
      'Decisions',
      'By role',
      'By project',
    ]);
    expect(headings(pageSource('MachinesPage.tsx'), 'h2')).toEqual([
      'Machine profiles',
      'Add a desktop master',
      'Direct machine selection',
    ]);
  });

  // 19 buttons: the 18 that remain after the provider controls moved to settings/ProviderSetup.tsx, plus the one
  // "Back to Workflows" button shown only when Settings was opened from the workflow editor. The provider setup
  // controls are exercised by settings/ProviderSetup.test.tsx.
  it('[GUARD] SettingsPage.tsx adds no control: 19 buttons, 9 inputs, 2 selects and 1 textarea', () => {
    const source = pageSource('SettingsPage.tsx');
    const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;

    expect({
      button: count(/<button\b/g),
      input: count(/<input\b/g),
      select: count(/<select\b/g),
      textarea: count(/<textarea\b/g),
    }).toEqual({ button: 19, input: 9, select: 2, textarea: 1 });
  });
});

describe('no fallback or auto-paid control (UI4 section 3, B1)', () => {
  it('[GUARD] no billing fallback or auto-paid wording in the four pages or the Settings and Usage billing helpers', () => {
    // "fallback code" is the pairing code and is allowed; only billing fallback wording is forbidden.
    const billing =
      /PAYG|API fallback|provider-side fallback|paid fallback|automatic fallback|auto(?:matic(?:ally)?)?[ -]?(?:paid|pay)\b/i;
    const sources = {
      'SettingsPage.tsx': pageSource('SettingsPage.tsx'),
      'MachinesPage.tsx': pageSource('MachinesPage.tsx'),
      'UsagePage.tsx': pageSource('UsagePage.tsx'),
      'DevicePairingPage.tsx': pageSource('DevicePairingPage.tsx'),
      'settings/MeteredProviderSettings.tsx': sectionOf(meteredSource, 'export function OpenRouterSettings'),
      'usage/UsageExplorer.tsx': sectionOf(usageSource, 'const SERIES'),
    };

    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(billing);
    }
  });

  it('[GUARD] the OpenRouter "unused until you explicitly select it" notice is unchanged', () => {
    const openRouter = sectionOf(
      meteredSource,
      'export function OpenRouterSettings',
      'export function MeteredBudgetSettingsPanel',
    );

    expect(openRouter).toContain('It is unused until you explicitly select it on a stage or Decision Gate.');
  });
});

describe('Machines Connect and Remove rules (UI4 section 2, GUARD)', () => {
  const origin = window.location.origin;
  const profiles = (): MachineProfile[] => [
    {
      origin,
      machineId: 'machine-desk',
      name: 'Desk master',
      hostname: 'desk',
      os: 'linux',
      lastSeenAt: null,
      reachability: 'online',
    },
    {
      origin: 'https://laptop.example.ts.net',
      machineId: null,
      name: 'Laptop master',
      hostname: null,
      os: null,
      lastSeenAt: null,
      reachability: 'offline',
    },
  ];
  const snapshot = { machine: {}, projects: [], providers: [], runs: [] } as unknown as DashboardSnapshot;

  const renderMachines = () => {
    const handlers = {
      onAddProfile: vi.fn(() => true),
      onRemoveProfile: vi.fn(),
      onReachability: vi.fn(),
      onSelectProfile: vi.fn(),
    };
    const all = profiles();
    render(<MachinesPage snapshot={snapshot} profiles={all} {...handlers} />);
    return { ...handlers, profiles: all };
  };

  it('[GUARD] the selected profile reads "Selected", its button is disabled, and it has no Remove control', () => {
    renderMachines();

    expect((screen.getByRole('button', { name: 'Selected' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Desk master · selected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Desk master' })).toBeNull();
  });

  it('[GUARD] a non-selected profile has an enabled Connect and a Remove button, which call back with its profile or origin', () => {
    const { onRemoveProfile, onSelectProfile, profiles: all } = renderMachines();

    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(onSelectProfile).toHaveBeenCalledWith(all[1]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Laptop master' }));
    expect(onRemoveProfile).toHaveBeenCalledWith('https://laptop.example.ts.net');
  });
});

describe('usage provenance and the budget meter (UI4 section 2, P1 and P2)', () => {
  const metric = (value: number | null, missing = 0): MetricTotal => ({
    value,
    reported: value === null ? 0 : 1,
    missing,
  });
  const aggregate = (overrides: Partial<UsageAggregate> = {}): UsageAggregate => ({
    events: 4,
    requests: 4,
    durationMs: 0,
    inputTokens: metric(1280),
    outputTokens: metric(640),
    cachedInputTokens: metric(null, 4),
    cacheWriteTokens: metric(null, 4),
    reasoningTokens: metric(null, 4),
    totalTokens: metric(1920),
    actualMeteredCostUsd: metric(null, 4),
    equivalentValueUsd: metric(null, 4),
    tokenProvenance: { locally_measured: 128, provider_measured: 3 },
    ...overrides,
  });
  const analytics = (totals: UsageAggregate): UsageAnalytics =>
    ({
      filter: { from: '2026-10-10', to: '2026-10-17', timeZone: 'UTC' },
      granularity: 'day',
      totals,
      activeModels: 1,
      activeBillingLanes: 1,
      series: [],
      byBillingLane: [],
      byModel: [],
      byProvider: [],
      byRole: [],
      byProject: [],
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
        costUsd: metric(null),
        inputTokens: metric(null),
        outputTokens: metric(null),
        averageBooleanProbability: null,
        averageChoiceConfidence: null,
        averageScoreConfidence: null,
        byEngineModel: [],
      },
      events: [],
      eventCount: 4,
    }) as UsageAnalytics;
  const budgetStatus = (daily: BudgetStatus['daily'], monthly: BudgetStatus['monthly']): BudgetStatus => ({
    timeZone: 'UTC',
    run: { committedUsd: 0, capUsd: null },
    daily,
    monthly,
    warningRatio: 0.8,
  });
  const renderUsage = async (totals: UsageAggregate, status: BudgetStatus) => {
    usageAnalytics.mockResolvedValue(analytics(totals));
    budgets.mockResolvedValue({ status, settings: {}, systemTimeZone: 'UTC' });
    render(<UsageExplorer />);
    await settle();
  };
  const badges = () => [...document.querySelectorAll<HTMLElement>('.provenance-badge')].map((el) => text(el));
  const figure = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('.usage-metric')].find(
      (el) => text(el.querySelector('dt')) === label,
    );

  it('[RED] a provenance badge reads the word and count for locally measured tokens: "Locally measured 128"', async () => {
    await renderUsage(
      aggregate(),
      budgetStatus({ committedUsd: 0, capUsd: null }, { committedUsd: 0, capUsd: null }),
    );

    expect(badges()).toContain('Locally measured 128');
  });

  it('[RED] a provenance badge reads the word and count for provider measured tokens: "Provider measured 3"', async () => {
    await renderUsage(
      aggregate(),
      budgetStatus({ committedUsd: 0, capUsd: null }, { committedUsd: 0, capUsd: null }),
    );

    expect(badges()).toContain('Provider measured 3');
  });

  it('[RED] with no counted provenance, one badge reads exactly "Unavailable" and no badge reads 0', async () => {
    await renderUsage(
      aggregate({ tokenProvenance: {}, inputTokens: metric(null, 4), outputTokens: metric(null, 4) }),
      budgetStatus({ committedUsd: 0, capUsd: null }, { committedUsd: 0, capUsd: null }),
    );

    expect(badges()).toEqual(['Unavailable']);
    expect(badges().join(' ')).not.toMatch(/\b0\b/);
  });

  it('[GUARD] a null metric figure reads "Unavailable" and never 0', async () => {
    await renderUsage(
      aggregate(),
      budgetStatus({ committedUsd: 0, capUsd: null }, { committedUsd: 0, capUsd: null }),
    );

    const cached = figure('Cached input');
    expect(text(cached?.querySelector('dd'))).toBe('Unavailable');
    expect(text(cached)).not.toMatch(/\b0\b/);
  });

  it('[RED] with a daily cap, a meter with role img reads "Daily budget: $0.42 of $2.00 committed"', async () => {
    await renderUsage(
      aggregate(),
      budgetStatus({ committedUsd: 0.42, capUsd: 2 }, { committedUsd: 3.1, capUsd: null }),
    );

    expect(
      screen.queryByRole('img', { name: 'Daily budget: $0.42 of $2.00 committed' }),
      'daily meter',
    ).not.toBeNull();
  });

  it('[RED] the daily meter sits beside its visible value "$0.42 of $2.00 committed" in the same parent', async () => {
    await renderUsage(
      aggregate(),
      budgetStatus({ committedUsd: 0.42, capUsd: 2 }, { committedUsd: 3.1, capUsd: null }),
    );

    const meter = screen.queryByRole('img', { name: 'Daily budget: $0.42 of $2.00 committed' });
    expect(text(meter?.parentElement)).toContain('$0.42 of $2.00 committed');
  });

  it('[GUARD] with no cap, each budget row reads "No cap" and no budget meter is rendered', async () => {
    await renderUsage(
      aggregate(),
      budgetStatus({ committedUsd: 0.42, capUsd: null }, { committedUsd: 3.1, capUsd: null }),
    );

    expect(screen.queryAllByText('No cap')).toHaveLength(2);
    expect(screen.queryAllByRole('img', { name: /budget/i })).toHaveLength(0);
  });
});

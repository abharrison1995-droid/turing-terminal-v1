// @vitest-environment node

// UI.9a structure pins for the Settings dropdowns (UI9_SCOPE, "UI.9a: Settings dropdowns"). Source scans only, read the
// same way settingsPagesStructure.test.tsx reads SettingsPage.tsx; that file is not edited. [GUARD] tests hold today. [RED] tests
// need each card wrapped in SettingsCard, so they fail until the cards are converted.
//
// Contract the implementer must match (the scope gives the rules; these are the forms the scans read):
// - Each card is one `<SettingsCard ...>` opening tag, then its body, then `</SettingsCard>`. The card's `<h2>` is a literal,
//   attribute-free `<h2>Name</h2>` between those two tags. Props are read from the first occurrence in the card's source,
//   which is the opening tag. A bare `defaultOpen` counts as true.
// - Every card has `id="..."` and `summary="..."`. The four cards named in the scope also have `attention={...}`.
// - Ids are unique across SettingsPage.tsx and settings/MeteredProviderSettings.tsx, since both write one localStorage map.
// - The ten cards are the eight Settings cards in SettingsPage.tsx, then OpenRouter and Turing metered budgets in settings/MeteredProviderSettings.tsx.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pagesDir = dirname(fileURLToPath(import.meta.url));
const pageSource = (file: string) => readFileSync(join(pagesDir, file), 'utf8');
const meteredSource = pageSource('settings/MeteredProviderSettings.tsx');

/** Static heading literals (no interpolation, no attributes) of one tag, in source order. */
const headings = (source: string, tag: 'h1' | 'h2') =>
  [...source.matchAll(new RegExp(`<${tag}>([^<{]+)</${tag}>`, 'g'))].map((match) => match[1]!.trim());

interface Card {
  file: string;
  name: string | undefined;
  id: string | undefined;
  defaultOpen: 'true' | 'false' | undefined;
  hasSummary: boolean;
  hasAttention: boolean;
  h2Count: number;
}

/** Every `<SettingsCard` in a file, read up to its closing tag. Props are matched on the first occurrence in the card. */
function cardsIn(file: string, source: string): Card[] {
  return [...source.matchAll(/<SettingsCard\b/g)].map((match) => {
    const start = match.index!;
    const end = source.indexOf('</SettingsCard>', start);
    const slice = source.slice(start, end < 0 ? undefined : end);
    const defaultOpen = /\bdefaultOpen(?:=\{(true|false)\})?/.exec(slice);
    const id = /\sid=(?:"([^"]+)"|\{\s*"([^"]+)"\s*\})/.exec(slice);
    return {
      file,
      name: headings(slice, 'h2')[0],
      id: id?.[1] ?? id?.[2],
      defaultOpen: defaultOpen ? ((defaultOpen[1] as 'true' | 'false' | undefined) ?? 'true') : undefined,
      hasSummary: /\ssummary=/.test(slice),
      hasAttention: /\sattention(?:=|\s|\/?>)/.test(slice),
      h2Count: headings(slice, 'h2').length,
    };
  });
}

const settingsCards = () => cardsIn('SettingsPage.tsx', pageSource('SettingsPage.tsx'));
const providerCards = () => cardsIn('settings/ProviderSetup.tsx', pageSource('settings/ProviderSetup.tsx'));
const meteredCards = () => cardsIn('settings/MeteredProviderSettings.tsx', meteredSource);
const allCards = () => [...settingsCards(), ...providerCards(), ...meteredCards()];

// The 'Provider integrations' card moved to settings/ProviderSetup.tsx and became 'Providers & connections' (provider and
// workflow redesign). It is scanned separately below; it is the one card whose default is open, because connecting a
// service is the first thing a new user needs.
const SETTINGS_HEADINGS = [
  'Machine identity',
  'Permission modes',
  'Notifications',
  'Desktop application',
  'Tailscale readiness',
  'Paired devices',
  'Global and project rules',
];

/** The scope's default table, keyed by the h2 text each card keeps. */
const DEFAULTS: Record<string, 'true' | 'false'> = {
  'Machine identity': 'true',
  'Providers &amp; connections': 'true',
  'Permission modes': 'false',
  Notifications: 'false',
  'Desktop application': 'false',
  'Tailscale readiness': 'false',
  'Paired devices': 'true',
  'Global and project rules': 'true',
  'OpenRouter (optional, metered)': 'true',
  'Turing metered budgets': 'false',
};

describe('Settings structure before and after the card conversion (UI9 UI.9a)', () => {
  it('[GUARD] the Settings h2 literals keep their order and attribute-free form, and the eight sections keep their classes', () => {
    const source = pageSource('SettingsPage.tsx');

    expect(headings(source, 'h2')).toEqual(SETTINGS_HEADINGS);
    expect(source.match(/<h2\b/g)?.length ?? 0).toBe(SETTINGS_HEADINGS.length);
    expect(source.match(/<section className="surface-panel settings-section/g)?.length ?? 0).toBe(8);
    expect(meteredSource).toContain('aria-label="OpenRouter"');
    expect(meteredSource).toContain('aria-label="Metered budgets"');
  });

  it('[RED] the ten cards are SettingsCard elements, each with an id, and the ids are unique across both files', () => {
    const cards = allCards();

    expect(settingsCards()).toHaveLength(7);
    expect(providerCards()).toHaveLength(1);
    expect(meteredCards()).toHaveLength(2);
    expect(cards.every((card) => card.id && card.id.length > 0)).toBe(true);
    expect(new Set(cards.map((card) => card.id)).size).toBe(10);
    expect(cards).toHaveLength(10);
  });

  it('[RED] each card holds exactly one h2 literal, and those h2s keep their original order', () => {
    expect(settingsCards().map((card) => card.name)).toEqual(SETTINGS_HEADINGS);
    expect(providerCards().map((card) => card.name)).toEqual(['Providers &amp; connections']);
    expect(meteredCards().map((card) => card.name)).toEqual([
      'OpenRouter (optional, metered)',
      'Turing metered budgets',
    ]);
    for (const card of allCards()) {
      expect(card.h2Count, `${card.file}: ${card.name}`).toBe(1);
    }
  });

  it('[RED] defaultOpen matches the scope table: Machine identity, OpenRouter, Global and project rules and Paired devices open; the rest closed', () => {
    expect(allCards()).toHaveLength(10);
    const defaults = Object.fromEntries(allCards().map((card) => [card.name, card.defaultOpen]));

    expect(defaults).toEqual(DEFAULTS);
  });

  it('[RED] every card has a summary, and Notifications, Desktop application, Tailscale readiness and Paired devices also have attention', () => {
    const cards = allCards();
    const attentionCards = ['Notifications', 'Desktop application', 'Tailscale readiness', 'Paired devices'];

    expect(cards).toHaveLength(10);
    expect(cards.filter((card) => !card.hasSummary).map((card) => card.name)).toEqual([]);
    expect(
      cards
        .filter((card) => attentionCards.includes(card.name ?? '') && !card.hasAttention)
        .map((card) => card.name),
    ).toEqual([]);
  });
});

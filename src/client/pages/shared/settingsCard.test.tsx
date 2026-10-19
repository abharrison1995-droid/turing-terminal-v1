// @vitest-environment jsdom

// UI.9a SettingsCard tests (UI9_SCOPE, "UI.9a: Settings dropdowns"). Every test is [RED] until ./SettingsCard exists:
// the import below fails, so the file fails as a whole with a module-resolution error. The source-scan tests read
// SettingsCard.tsx, which is missing for the same reason.
//
// API under test, src/client/pages/shared/SettingsCard.tsx (not written yet):
//   export function SettingsCard(props: {
//     id: string; head: ReactNode; summary: string; defaultOpen: boolean; attention?: boolean; children: ReactNode;
//   }): JSX.Element
//   - Renders <details class="settings-card"> whose first child is <summary>. The summary holds `head` and a
//     <span class="settings-card-summary"> with the one-line summary. `children` sit after the summary, in the body.
//   - Controlled `open`. A user toggle is written to localStorage['tt.settings.sections.v1'] as a JSON map id -> boolean.
//     onToggle ignores programmatic changes (attention and the stored value are not written back).
//   - Initial open: a stored boolean for `id` wins; otherwise defaultOpen. A corrupt or non-object stored value is ignored.
//   - attention === true forces the card open. It is not persisted, and a later user close still closes it.
//   - Every storage read and write is wrapped in try/catch, so a throwing Storage still renders and toggles.
//   - Children stay mounted while closed.
//   - Contains no <button, and no colour literal.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsCard } from './SettingsCard';

const STORAGE_KEY = 'tt.settings.sections.v1';
const here = dirname(fileURLToPath(import.meta.url));
const cardSource = () => readFileSync(join(here, 'SettingsCard.tsx'), 'utf8');

interface CardProps {
  id?: string;
  summary?: string;
  defaultOpen?: boolean;
  attention?: boolean;
  head?: ReactNode;
}

/** The card as the Settings page would render it: a heading in the head, and an input in the body. */
const card = ({
  id = 'machine',
  summary = '2 machines',
  defaultOpen = false,
  attention,
  head = <h2>Machine identity</h2>,
}: CardProps = {}) => (
  <SettingsCard id={id} head={head} summary={summary} defaultOpen={defaultOpen} attention={attention}>
    <input aria-label="Note" />
  </SettingsCard>
);

const detailsOf = (container: HTMLElement) =>
  container.querySelector('details.settings-card') as HTMLDetailsElement;
const summaryOf = (container: HTMLElement) =>
  container.querySelector('details.settings-card > summary') as HTMLElement;
const readStored = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('SettingsCard markup and open state (UI9 UI.9a)', () => {
  it('[RED] renders a native details.settings-card whose summary holds the head and a .settings-card-summary line, with children in the body', () => {
    const { container } = render(card({ summary: '2 machines' }));
    const details = detailsOf(container);
    const summary = summaryOf(container);

    expect(details).not.toBeNull();
    expect(details.firstElementChild).toBe(summary);
    expect(within(summary).getByRole('heading', { name: 'Machine identity' })).toBeTruthy();
    expect(summary.querySelector('.settings-card-summary')?.textContent).toBe('2 machines');
    expect(summary.contains(screen.getByLabelText('Note'))).toBe(false);
    expect(details.contains(screen.getByLabelText('Note'))).toBe(true);
  });

  it('[RED] defaultOpen true renders open and defaultOpen false renders closed when nothing is stored', () => {
    const open = render(card({ id: 'open-card', defaultOpen: true }));
    const closed = render(card({ id: 'closed-card', defaultOpen: false }));

    expect(detailsOf(open.container).open).toBe(true);
    expect(detailsOf(closed.container).open).toBe(false);
  });

  it('[RED] clicking the summary toggles open, persists the map under tt.settings.sections.v1, and the summary is focusable', async () => {
    const { container } = render(card({ id: 'machine', defaultOpen: false }));
    const details = detailsOf(container);
    const summary = summaryOf(container);

    summary.focus();
    expect(document.activeElement).toBe(summary);
    expect(summary.getAttribute('tabindex')).not.toBe('-1');

    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(true));
    await waitFor(() => expect(readStored()).toMatchObject({ machine: true }));

    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(false));
    await waitFor(() => expect(readStored()).toMatchObject({ machine: false }));
  });

  it('[RED] a stored value beats defaultOpen, in both directions', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'stored-open': true, 'stored-closed': false }));
    const stored = render(card({ id: 'stored-open', defaultOpen: false }));
    const closed = render(card({ id: 'stored-closed', defaultOpen: true }));

    expect(detailsOf(stored.container).open).toBe(true);
    expect(detailsOf(closed.container).open).toBe(false);
  });

  it('[RED] a corrupt or non-object stored value is ignored: the card renders at defaultOpen', () => {
    for (const raw of ['{not json', '[true]', '"open"', 'null']) {
      window.localStorage.setItem(STORAGE_KEY, raw);
      const { container, unmount } = render(card({ id: 'corrupt', defaultOpen: true }));
      expect(detailsOf(container).open, raw).toBe(true);
      expect(screen.getByRole('heading', { name: 'Machine identity' })).toBeTruthy();
      unmount();
    }
  });

  it('[RED] a throwing Storage still renders at defaultOpen and a click still toggles the card', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const { container } = render(card({ id: 'blocked', defaultOpen: true }));
    const details = detailsOf(container);

    expect(details.open).toBe(true);
    fireEvent.click(summaryOf(container));
    await waitFor(() => expect(details.open).toBe(false));
  });

  it('[RED] attention opens a closed card without persisting it, and a later user close still closes it', async () => {
    const { container, rerender } = render(card({ id: 'alerts', defaultOpen: false, attention: true }));
    const details = detailsOf(container);

    await waitFor(() => expect(details.open).toBe(true));
    expect(readStored()).not.toHaveProperty('alerts', true);

    fireEvent.click(summaryOf(container));
    await waitFor(() => expect(details.open).toBe(false));

    rerender(card({ id: 'alerts', defaultOpen: false, attention: true }));
    expect(detailsOf(container).open).toBe(false);
  });

  it('[RED] children stay mounted while closed, so a typed value survives a close and reopen', async () => {
    const { container } = render(card({ id: 'draft', defaultOpen: true }));
    const details = detailsOf(container);
    const summary = summaryOf(container);
    const input = screen.getByLabelText('Note') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'unsaved draft' } });
    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(false));
    expect(screen.getByLabelText('Note')).toBe(input);

    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(true));
    expect(screen.getByLabelText('Note')).toBe(input);
    expect(input.value).toBe('unsaved draft');
  });
});

describe('SettingsCard source pins (UI9 UI.9a)', () => {
  it('[RED] SettingsCard.tsx contains no <button (the summary is the control) and no colour literal', () => {
    const source = cardSource();

    expect(source).not.toMatch(/<button\b/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
  });
});

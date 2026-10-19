// @vitest-environment jsdom

// UI.9b R2 hook tests (UI9_SCOPE, "UI.9b: overlay hygiene"). Every test is [RED] until ./useDismissibleDetails exists:
// the import below fails, so the file fails as a whole with a module-resolution error. The RunsPage source pin is also
// [RED] until RunsPage.tsx calls the hook.
//
// API under test, src/client/pages/shared/useDismissibleDetails.ts (not written yet):
//   export function useDismissibleDetails(ref: RefObject<HTMLDetailsElement | null>): void
//   - Managed while the details is open. Closes it on:
//       pointerdown outside the details; Escape (focus returns to the summary); focusout to an element outside the details;
//       a click on an item inside it (button or a[role=menuitem]).
//   - A pointerdown inside the details does not close it.
//   - Opening one managed details closes any other managed details that is open.
//   - Its document/window listeners exist only while open: none remain after a close or an unmount.
//   Listener checks spy on document and window only, and ignore selectionchange, which React adds itself.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDismissibleDetails } from './useDismissibleDetails';

/** A details menu like the Run actions menu: a summary, a button and a menu item, all managed by the hook. */
function Menu({ name }: { name: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissibleDetails(ref);
  return (
    <details ref={ref} className="run-menu" data-testid={name}>
      <summary aria-label={`${name} actions`}>More</summary>
      <div className="run-menu-list">
        <button type="button">Run again</button>
        <a role="menuitem" href="#duplicate">
          Duplicate
        </a>
      </div>
    </details>
  );
}

/** Two managed menus and a plain button outside both. */
const Harness = ({ names = ['Run'] }: { names?: string[] }) => (
  <>
    <button type="button">Outside</button>
    {names.map((name) => (
      <Menu key={name} name={name} />
    ))}
  </>
);

const detailsFor = (name: string) => screen.getByTestId(name) as HTMLDetailsElement;
const summaryFor = (name: string) => within(detailsFor(name)).getByText('More');

/** Clicks the summary as a user would, then waits for the details to report open. */
async function openMenu(name: string) {
  fireEvent.click(summaryFor(name));
  await waitFor(() => expect(detailsFor(name).open).toBe(true));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDismissibleDetails closes an open menu (UI9 UI.9b, R2)', () => {
  it('[RED] while open, a pointerdown outside closes the details', async () => {
    render(<Harness />);
    await openMenu('Run');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));

    await waitFor(() => expect(detailsFor('Run').open).toBe(false));
  });

  it('[RED] Escape closes the details and moves focus to its summary', async () => {
    render(<Harness />);
    await openMenu('Run');
    const button = within(detailsFor('Run')).getByRole('button', { name: 'Run again' });
    button.focus();

    fireEvent.keyDown(button, { key: 'Escape' });

    await waitFor(() => expect(detailsFor('Run').open).toBe(false));
    expect(document.activeElement).toBe(summaryFor('Run'));
  });

  it('[RED] focus moving from an item inside to an element outside closes the details', async () => {
    render(<Harness />);
    await openMenu('Run');
    const item = within(detailsFor('Run')).getByRole('menuitem', { name: 'Duplicate' });

    fireEvent.focusOut(item, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });

    await waitFor(() => expect(detailsFor('Run').open).toBe(false));
  });

  it('[RED] a click on a button or a menuitem inside the details closes it', async () => {
    render(<Harness />);
    await openMenu('Run');
    fireEvent.click(within(detailsFor('Run')).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(detailsFor('Run').open).toBe(false));

    await openMenu('Run');
    fireEvent.click(within(detailsFor('Run')).getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(detailsFor('Run').open).toBe(false));
  });

  it('[RED] a pointerdown inside the details does not close it', async () => {
    render(<Harness />);
    await openMenu('Run');

    fireEvent.pointerDown(within(detailsFor('Run')).getByRole('menuitem', { name: 'Duplicate' }));
    await act(async () => {});

    expect(detailsFor('Run').open).toBe(true);
  });

  it('[RED] opening a second managed details closes the first one that is open', async () => {
    render(<Harness names={['Run', 'Project']} />);
    await openMenu('Run');

    await openMenu('Project');

    await waitFor(() => expect(detailsFor('Run').open).toBe(false));
    expect(detailsFor('Project').open).toBe(true);
  });

  it('[RED] its document and window listeners exist only while open: none remain after a close or an unmount', async () => {
    const live = new Map<EventTarget, Array<{ type: string; listener: unknown }>>();
    for (const target of [document, window] as const) {
      const realAdd = target.addEventListener.bind(target);
      const realRemove = target.removeEventListener.bind(target);
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type !== 'selectionchange') live.set(target, [...(live.get(target) ?? []), { type, listener }]);
        realAdd(type, listener, options);
      });
      vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        live.set(
          target,
          (live.get(target) ?? []).filter((entry) => !(entry.type === type && entry.listener === listener)),
        );
        realRemove(type, listener, options);
      });
    }
    const count = () => [...live.values()].reduce((total, entries) => total + entries.length, 0);

    const { unmount } = render(<Harness />);
    const baseline = count();

    await openMenu('Run');
    await waitFor(() => expect(count()).toBeGreaterThan(baseline));

    fireEvent.click(summaryFor('Run'));
    await waitFor(() => expect(detailsFor('Run').open).toBe(false));
    await waitFor(() => expect(count()).toBe(baseline));

    await openMenu('Run');
    await waitFor(() => expect(count()).toBeGreaterThan(baseline));
    unmount();
    expect(count()).toBe(baseline);
  });
});

describe('the Run actions menu uses the hook (UI9 UI.9b, R2)', () => {
  it('[RED] RunsPage.tsx imports useDismissibleDetails and calls it for the Run actions menu', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'RunsPage.tsx'), 'utf8');

    expect(source).toContain('useDismissibleDetails');
    expect(source).toMatch(/useDismissibleDetails\(/);
  });
});

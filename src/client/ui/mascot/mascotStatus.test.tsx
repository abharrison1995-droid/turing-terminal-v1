// @vitest-environment jsdom

// UI.6 A4 (UI6_SCOPE section 1 and 5; UI0 13.4 status-text rule). ./MascotStatus.tsx and ./index.ts do not exist yet.
// Each test loads its module first, so a missing file fails that test with "Cannot find module".
//
// Contract assumed for the implementer:
// - MascotStatus({ animation: 'idle' | 'thinking' | 'loading', size: 24 | 48 | 96, label: string }).
// - An empty or whitespace-only label throws during render.
// - Markup: <span class="mascot-status"><svg aria-hidden="true" focusable="false" data-mascot>...</svg>
//   <span class="mascot-status-label">{label}</span></span>. The label is the svg's next element sibling.
// - Fills are var(--tt-mascot-outline|body|shade|accent) only, with one merged <path> per colour.
// - ./index re-exports only MascotStatus (its types are erased at runtime).

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const loadStatus = () => import('./MascotStatus');

const ANIMATIONS = ['idle', 'thinking', 'loading'] as const;
const FILL_TOKEN = /^var\(--tt-mascot-(outline|body|shade|accent)\)$/;

describe('MascotStatus (UI6 A4)', () => {
  afterEach(() => {
    cleanup();
  });

  // [RED] a blank label is rejected: the component throws rather than render a mark with no status text.
  it('throws when the label is empty or only whitespace', async () => {
    const { MascotStatus } = await loadStatus();
    expect(() => render(<MascotStatus animation="idle" size={24} label="" />)).toThrow();
    expect(() => render(<MascotStatus animation="idle" size={24} label="   " />)).toThrow();
  });

  // [RED] the svg is hidden from assistive technology and carries no role, title or accessible name of its own.
  it('marks the svg aria-hidden with no role, title or aria-label', async () => {
    const { MascotStatus } = await loadStatus();
    const { container } = render(
      <MascotStatus animation="thinking" size={24} label="Preparing run preview…" />,
    );
    const svg = container.querySelector('svg[data-mascot]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.hasAttribute('role')).toBe(false);
    expect(svg!.hasAttribute('aria-label')).toBe(false);
    expect(svg!.hasAttribute('title')).toBe(false);
    expect(svg!.querySelector('title')).toBeNull();
  });

  // [RED] the label text sits in span.mascot-status-label, the svg's next sibling, inside span.mascot-status.
  it('renders the label in span.mascot-status-label beside the svg', async () => {
    const { MascotStatus } = await loadStatus();
    const { container } = render(
      <MascotStatus animation="loading" size={48} label="Connecting to the local master…" />,
    );
    const svg = container.querySelector('svg[data-mascot]');
    const label = container.querySelector('span.mascot-status-label');
    expect(label?.textContent).toBe('Connecting to the local master…');
    expect(svg?.nextElementSibling).toBe(label);
    expect(label?.parentElement?.classList.contains('mascot-status')).toBe(true);
  });

  // [RED] every fill is one of the four mascot tokens, there is one merged path per colour, and no colour literals.
  it('fills only with the four --tt-mascot tokens, one merged path per colour', async () => {
    const { MascotStatus } = await loadStatus();
    for (const animation of ANIMATIONS) {
      const { container, unmount } = render(
        <MascotStatus animation={animation} size={48} label={animation} />,
      );
      const svg = container.querySelector('svg[data-mascot]');
      expect(svg, animation).not.toBeNull();
      const paths = [...svg!.querySelectorAll('path')];
      expect(paths.length, animation).toBeGreaterThan(0);
      const fills = paths.map((path) => path.getAttribute('fill') || path.style.getPropertyValue('fill'));
      for (const fill of fills) expect(fill, animation).toMatch(FILL_TOKEN);
      expect(new Set(fills).size, animation).toBe(paths.length);
      expect(svg!.outerHTML, animation).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      unmount();
    }
  });

  // [RED] ./index exports only MascotStatus.
  it('index.ts re-exports only MascotStatus', async () => {
    const mod = await import('./index');
    expect(Object.keys(mod)).toEqual(['MascotStatus']);
  });
});

// @vitest-environment jsdom

// Owner request: the sidebar brand uses the static skull instead of the generic icon. It is a logo, so it must stay
// static (no timers, one frame), decorative (aria-hidden) and token-coloured, with the brand name as adjacent text.

import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandSkull } from './BrandSkull';

afterEach(cleanup);

describe('BrandSkull', () => {
  it('renders one static aria-hidden 24px svg with token fills only', () => {
    const { container } = render(<BrandSkull />);
    const svg = container.querySelector('svg[data-brand-skull]')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('24');
    const fills = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('fill'));
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) expect(fill).toMatch(/^var\(--tt-mascot-(outline|body|shade|accent)\)$/);
  });

  it('schedules no timers and does not change over time', () => {
    vi.useFakeTimers();
    const { container } = render(<BrandSkull />);
    const before = container.innerHTML;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(container.innerHTML).toBe(before);
    vi.useRealTimers();
  });

  it('is used by the sidebar brand lockup beside the brand name, replacing the generic icon', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Sidebar.tsx'), 'utf8');
    expect(source).toContain('<BrandSkull />');
    expect(source).not.toMatch(/import\s*\{[^}]*\bCommand\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(source).toContain('Turing Terminal</span>');
  });
});

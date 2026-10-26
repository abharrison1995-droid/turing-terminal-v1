// @vitest-environment node

// UI.9b z-index scale and overlay CSS (UI9_SCOPE, "UI.9b: overlay hygiene": R1, R4, R5 and R6). They read the CSS as text,
// the same way pagesSettingsCss.test.ts does, and prove that rules are declared, not how a browser stacks them. rulesIn is copied
// from pagesSettingsCss.test.ts so this file does not depend on a test file it cannot edit.
//
// Contract the implementer must match:
// - tokens.css declares --z-raised 1, --z-sticky 10, --z-menu 20, --z-topbar 30, --z-toast 40, --z-scrim 50, --z-drawer 60,
//   --z-palette 70 and --z-dialog 80, as plain integers.
// - No styles/*.css file except tokens.css contains a raw integer z-index. Each one uses var(--z-*).
// - The `.toast` rule in primitives.css uses var(--z-toast).
// - A rule in mobile.css whose selector is `.workflow-save-bar` pads its bottom with a calc() that includes
//   env(safe-area-inset-bottom). (The sticky `.studio-nav` section tabs this pin used to cover were removed by the workflow
//   editor redesign; the sticky element that replaces them is the save bar.)
// - A rule in billing-routing-usage.css whose selector is `.chart-tooltip` sets left to a clamp(). The inline left in pages/usage/UsageExplorer.tsx
//   (chart-tooltip) must move into a custom property for this to take effect, because an inline style beats a stylesheet.
// - A rule in mobile.css whose selector ends in `.composer` (for example `.home-column > .composer`) sets a max-height
//   with dvh and overflow-y: auto in the same rule.
//
// Every test is [RED] today: tokens.css has no --z-* tokens, and the other rules do not yet carry the new declarations.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
}

/** Flat rules, including ones nested in a media block. Selectors are split on commas and trimmed. */
function rulesIn(css: string): Rule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean),
    body: match[2]!,
  }));
}

/** The integer z tokens declared in tokens.css, keyed by name without the --z- prefix. */
function zTokens(css: string): Record<string, number> {
  return Object.fromEntries(
    [...stripComments(css).matchAll(/--z-([a-z]+)\s*:\s*(-?\d+)\s*;/g)].map((match) => [
      match[1]!,
      Number(match[2]),
    ]),
  );
}

describe('the z-index scale (UI9 UI.9b, R1)', () => {
  it('[RED] tokens.css declares the nine z tokens and they stack in the scope order: menu under topbar, toast under scrim, drawer, palette and dialog', () => {
    const z = zTokens(read('tokens.css'));

    expect(z).toEqual({
      raised: 1,
      sticky: 10,
      menu: 20,
      topbar: 30,
      toast: 40,
      scrim: 50,
      drawer: 60,
      palette: 70,
      dialog: 80,
    });
    expect(z.menu).toBeLessThan(z.topbar!);
    for (const [below, above] of [
      ['toast', 'scrim'],
      ['scrim', 'drawer'],
      ['drawer', 'palette'],
      ['palette', 'dialog'],
    ] as const) {
      expect(z[below]).toBeLessThan(z[above]!);
    }
  });

  it('[RED] no styles/*.css file except tokens.css holds a raw integer z-index', () => {
    const files = readdirSync(here).filter((name) => name.endsWith('.css') && name !== 'tokens.css');
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((name) => /z-index\s*:\s*-?\d/.test(stripComments(read(name))));

    expect(offenders).toEqual([]);
  });

  it('[RED] the toast rule in primitives.css uses var(--z-toast)', () => {
    const toast = rulesIn(read('primitives.css')).filter((rule) => rule.selectors.includes('.toast'));

    expect(toast.length).toBeGreaterThan(0);
    expect(toast.some((rule) => /z-index\s*:\s*var\(--z-toast\)/.test(rule.body))).toBe(true);
  });
});

describe('mobile and overlay rules (UI9 UI.9b, R4 to R6)', () => {
  it('[RED] the workflow save bar in mobile.css pads its bottom with calc() including env(safe-area-inset-bottom)', () => {
    const bar = rulesIn(read('mobile.css')).filter((rule) => rule.selectors.includes('.workflow-save-bar'));

    expect(bar.length).toBeGreaterThan(0);
    expect(
      bar.some((rule) =>
        /padding\s*:[^;]*calc\([^;]*env\(\s*safe-area-inset-bottom\s*\)[^;]*\)\s*;/.test(rule.body),
      ),
    ).toBe(true);
  });

  it('[RED] the chart tooltip in billing-routing-usage.css clamps its left offset with clamp()', () => {
    const tooltip = rulesIn(read('billing-routing-usage.css')).filter((rule) =>
      rule.selectors.includes('.chart-tooltip'),
    );

    expect(tooltip.length).toBeGreaterThan(0);
    expect(tooltip.some((rule) => /(?:^|[\s;])left\s*:\s*clamp\(/.test(rule.body))).toBe(true);
  });

  it('the compact home composer stays in document flow instead of covering content', () => {
    const composer = rulesIn(read('mobile.css')).filter((rule) =>
      rule.selectors.some((selector) => /(?:^|[\s>])\.composer$/.test(selector)),
    );

    expect(composer.length).toBeGreaterThan(0);
    expect(
      composer.some(
        (rule) =>
          /position\s*:\s*relative/.test(rule.body) && !/position\s*:\s*(?:fixed|sticky)/.test(rule.body),
      ),
    ).toBe(true);
  });
});

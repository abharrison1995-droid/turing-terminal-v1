// @vitest-environment node

// UI.5 tests for the mobile PWA stylesheet (UI5_SCOPE sections 2, 4 and 5; matrix M3 to M11 and M13). They read the CSS as
// text, the same way pagesSettingsCss.test.ts does. They prove that rules are declared, not how a browser lays them out. Layout is
// proven by Playwright (e2e/mobile.spec.ts), not here.
//
// [RED] tests need mobile-remote.css, which does not exist yet. Each one asserts the file exists first, so a missing file
// fails with a clear message. The viewport-unit test is RED on the layout stylesheets, which still hold vh and 100vh.
// [GUARD] tests characterise rules that already hold. A GUARD that scans mobile-remote.css passes vacuously while that file
// is absent, so the GUARDs that matter also scan the existing styles where those comply.
//
// Selector and value contract for the implementer (UI5_SCOPE gives no exact values, so these are the expectations):
// - Home (item 1): `.home-column > .launch-blockers` declares an integer `order` in mobile-remote.css. Its effective compact
//   order (later rules win; mobile-remote.css is imported last) is lower than `.home-column > .home-tasks`, which holds the
//   Recent list. It also declares scroll-margin-bottom, so the sticky composer does not hide it.
// - Toast (item 2): the exact selector `.toast` sets top from var(--topbar-h) with env(safe-area-inset-top) and bottom: auto.
//   The exact selector `.toast button` sets min-height var(--h-touch) or 44px. A rule naming toast sets line-clamp: 3.
// - Intervention box (item 3): a rule naming intervention-box sets max-height in dvh. scroll-padding-bottom is declared.
// - Diff pane (item 4): the exact selector `.run-diff-pane` sets overscroll-behavior: contain and max-height in dvh. A rule
//   naming run-diff-pane sets a scroll signal: linear-gradient, scrollbar-width or scrollbar-color, or a ::-webkit-scrollbar
//   selector.
// - Palette (item 5): the exact selector `.palette` sets max-height in dvh. `.palette-hint` sets flex 0 0 auto, so the
//   listbox gives way and the hint stays visible. The hint is a sibling of the listbox in CommandPalette.tsx, outside the
//   scroll area.
// - Safe area (item 7; M10): rules naming topbar, page-content and sidebar (the drawer) declare env(safe-area-inset-left)
//   and env(safe-area-inset-right). Rules naming composer or palette declare some env(safe-area-inset-*).
// - Viewport units (item 6; M9): a rule outside @supports that holds vh must have a dvh counterpart, either in its own body
//   or on the same selector inside an @supports (dvh) block.
// - Motion (item 9): animation or transition only under prefers-reduced-motion: no-preference.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.css');
const ui5Path = join(here, 'mobile-remote.css');
const mobilePath = join(here, 'mobile.css');
const palettePath = join(here, 'palette.css');
/** The layout stylesheets named in UI5_SCOPE item 6. They must not hold vh outside a dvh fallback. */
const layoutPaths = ['shell.css', 'pages.css', 'base.css', 'studio.css', 'palette.css', 'workspace.css'].map(
  (name) => join(here, name),
);
const COMPACT = /max-width\s*:\s*680px/;

const read = (path: string) => readFileSync(path, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
}

/** Flat rules, including ones nested in a block. Selectors are split on commas and trimmed. */
function rulesIn(css: string): Rule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean),
    body: match[2]!,
  }));
}

/** The index just past the brace that closes a block whose body starts at `from`. */
function blockEnd(source: string, from: number): number {
  let depth = 1;
  let index = from;
  while (index < source.length && depth > 0) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') depth -= 1;
    index += 1;
  }
  return index;
}

/** Each @media or @supports block with its query and body, nested blocks included. */
function blocksOf(css: string, keyword: 'media' | 'supports'): Array<{ query: string; body: string }> {
  const source = stripComments(css);
  const opener = new RegExp(`@${keyword}\\s*([^{]+)\\{`, 'g');
  const found: Array<{ query: string; body: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    const end = blockEnd(source, opener.lastIndex);
    found.push({ query: match[1]!.trim(), body: source.slice(opener.lastIndex, end - 1) });
  }
  return found;
}

/** The stylesheet with every top-level block of that keyword whose query passes `drop` removed. */
function withoutBlocks(css: string, keyword: 'media' | 'supports', drop: (query: string) => boolean): string {
  const source = stripComments(css);
  const opener = new RegExp(`@${keyword}\\s*([^{]+)\\{`, 'g');
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    if (!drop(match[1]!.trim())) continue;
    const end = blockEnd(source, opener.lastIndex);
    result += source.slice(cursor, match.index);
    cursor = end;
    opener.lastIndex = end;
  }
  return result + source.slice(cursor);
}

/** True when the selector names the class, and not a longer class such as .topbar-title. */
const names = (selector: string, className: string) => new RegExp(`\\.${className}(?![\\w-])`).test(selector);

/** Bodies of the rules whose selectors name the class. */
const bodiesNaming = (css: string, className: string): string[] =>
  rulesIn(css)
    .filter((rule) => rule.selectors.some((selector) => names(selector, className)))
    .map((rule) => rule.body);

/** Bodies of the rules whose selectors include this exact selector text. */
const bodiesFor = (css: string, selector: string): string[] =>
  rulesIn(css)
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body);

/** mobile-remote.css, which must exist for a [RED] test to reach its real assertion. */
const uiCss = (): string => {
  expect(existsSync(ui5Path), 'mobile-remote.css exists').toBe(true);
  return read(ui5Path);
};

/** mobile-remote.css when present, otherwise empty, for the GUARDs that must not fail on a missing file. */
const uiCssIfPresent = (): string => (existsSync(ui5Path) ? read(ui5Path) : '');

/**
 * The compact `order` each Home child ends with. Later rules win, so mobile.css is read before mobile-remote.css. Keys are
 * the child class names, for example `launch-blockers` for `.home-column > .launch-blockers`.
 */
function compactHomeOrders(files: string[]): Map<string, number> {
  const orders = new Map<string, number>();
  for (const file of files) {
    for (const block of blocksOf(read(file), 'media').filter((candidate) => COMPACT.test(candidate.query))) {
      for (const rule of rulesIn(block.body)) {
        const order = /(?:^|[\s;{])order\s*:\s*(-?\d+)\s*;/.exec(rule.body)?.[1];
        if (order === undefined) continue;
        for (const selector of rule.selectors) {
          const child = /^\.home-column\s*>\s*\.([\w-]+)$/.exec(selector)?.[1];
          if (child) orders.set(child, Number(order));
        }
      }
    }
  }
  return orders;
}

/** Rules in a layout stylesheet that hold vh or 100vh outside a dvh fallback. */
function unguardedViewportRules(css: string): Rule[] {
  const counterparts = new Set(
    blocksOf(css, 'supports')
      .filter((block) => /dvh/.test(block.query))
      .flatMap((block) => rulesIn(block.body))
      .flatMap((rule) => rule.selectors),
  );
  return rulesIn(withoutBlocks(css, 'supports', () => true)).filter(
    (rule) =>
      /\d(?:\.\d+)?vh\b/.test(rule.body) &&
      !/dvh/.test(rule.body) &&
      !rule.selectors.some((selector) => counterparts.has(selector)),
  );
}

describe('mobile-remote.css is wired last in the cascade (UI5 section 2)', () => {
  it('[RED] index.css imports ./mobile-remote.css as its final stylesheet', () => {
    const imports = [...read(indexPath).matchAll(/@import\s+['"]\.\/([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports[imports.length - 1]).toBe('mobile-remote.css');
  });

  it('[RED] every rule sits in the 680px block, a reduced-motion block or an @supports fallback', () => {
    const outside = rulesIn(
      withoutBlocks(
        withoutBlocks(
          uiCss(),
          'media',
          (query) => COMPACT.test(query) || /prefers-reduced-motion/.test(query),
        ),
        'supports',
        () => true,
      ),
    );

    expect(outside.flatMap((rule) => rule.selectors)).toEqual([]);
  });
});

describe('Home keeps content in normal flow on phones', () => {
  it('the composer cannot dock over approvals or setup actions', () => {
    const composer = bodiesFor(read(mobilePath), '.home-column > .composer').join('\n');
    expect(composer).toMatch(/position:\s*relative/);
    expect(composer).not.toMatch(/position:\s*(?:fixed|sticky)|bottom:/);
  });
  it('shared home children use natural reading order without CSS reordering', () => {
    const home = read(join(here, 'home.css'));
    const reordered = rulesIn(home).filter(
      (rule) =>
        rule.selectors.some((selector) => selector.startsWith('.home-column >')) &&
        /\border\s*:/.test(rule.body),
    );
    expect(reordered).toEqual([]);
  });
  it('compact rules never visually reorder shared home children', () => {
    expect(compactHomeOrders([mobilePath, ui5Path]).size).toBe(0);
  });
});

describe('toast on compact (item 2; matrix M4)', () => {
  it('[RED] on compact, .toast sits under the topbar with a safe-area inset and no bottom anchor', () => {
    const toast = bodiesFor(uiCss(), '.toast').join('\n');
    const top = /(?:^|[\s;{])top\s*:([^;]*);/.exec(toast)?.[1] ?? '';

    expect(top).toMatch(/var\(--topbar-h\)/);
    expect(top).toMatch(/env\(\s*safe-area-inset-top\s*\)/);
    expect(toast).toMatch(/(?:^|[\s;{])bottom\s*:\s*auto\b/);
  });

  it('[RED] on compact, the toast dismiss button is a 44px target', () => {
    expect(bodiesFor(uiCss(), '.toast button').join('\n')).toMatch(
      /min-height\s*:\s*(?:var\(--h-touch\)|44px)/,
    );
  });

  it('[RED] on compact, the toast text is clamped to three lines', () => {
    const clamped = rulesIn(uiCss())
      .filter((rule) => rule.selectors.some((selector) => names(selector, 'toast')))
      .some((rule) => /line-clamp\s*:\s*3\b/.test(rule.body));

    expect(clamped).toBe(true);
  });
});

describe('intervention box (item 3; matrix M6)', () => {
  it('[RED] on compact, the intervention textarea caps its height in dvh', () => {
    const capped = rulesIn(uiCss())
      .filter((rule) => rule.selectors.some((selector) => names(selector, 'intervention-box')))
      .some((rule) => /max-height\s*:[^;]*dvh\b/.test(rule.body));

    expect(capped).toBe(true);
  });

  it('[RED] mobile-remote.css reserves room for the last stage row with scroll-padding-bottom', () => {
    expect(uiCss()).toMatch(/scroll-padding-bottom\s*:/);
  });
});

describe('diff pane on compact (item 4; matrix M7)', () => {
  it('[RED] on compact, .run-diff-pane contains its overscroll', () => {
    expect(bodiesFor(uiCss(), '.run-diff-pane').join('\n')).toMatch(/overscroll-behavior\s*:\s*contain\b/);
  });

  it('[RED] the diff pane signals horizontal scroll with an edge fade or a visible thin track', () => {
    const rules = rulesIn(uiCss()).filter((rule) =>
      rule.selectors.some((selector) => names(selector, 'run-diff-pane')),
    );
    const fade = rules.some((rule) => /linear-gradient|scrollbar-(?:width|color)/.test(rule.body));
    const track = rules.some((rule) =>
      rule.selectors.some((selector) => /::-webkit-scrollbar/.test(selector)),
    );

    expect(fade || track).toBe(true);
  });

  it('[RED] on compact, .run-diff-pane caps its max-height in dvh', () => {
    expect(bodiesFor(uiCss(), '.run-diff-pane').join('\n')).toMatch(/max-height\s*:[^;]*dvh\b/);
  });
});

describe('command palette on compact (item 5; matrix M8)', () => {
  it('[RED] on compact, .palette caps its max-height in dvh', () => {
    expect(bodiesFor(uiCss(), '.palette').join('\n')).toMatch(/max-height\s*:[^;]*dvh\b/);
  });

  it('[RED] on compact, .palette-hint is flex 0 0 auto so the listbox gives way and the hint stays visible', () => {
    expect(bodiesFor(uiCss(), '.palette-hint').join('\n')).toMatch(/flex(?:-shrink)?\s*:\s*0\b/);
  });

  it('[GUARD] palette.css keeps 44px palette rows and the palette input on compact', () => {
    const compact = blocksOf(read(palettePath), 'media')
      .filter((block) => COMPACT.test(block.query))
      .flatMap((block) => rulesIn(block.body));

    for (const selector of ['.palette-option', '.palette-input']) {
      expect(
        compact.some((rule) => rule.selectors.includes(selector) && /min-height\s*:\s*44px/.test(rule.body)),
        selector,
      ).toBe(true);
    }
  });
});

describe('viewport units (item 6; matrix M9)', () => {
  it.each(layoutPaths.map((path) => [basename(path), path] as const))(
    '[RED] %s has no vh or 100vh layout rule outside a dvh @supports fallback',
    (_name, path) => {
      expect(unguardedViewportRules(read(path)).map((rule) => rule.selectors.join(', '))).toEqual([]);
    },
  );
});

describe('safe-area insets (item 7; matrix M10)', () => {
  it.each([
    ['topbar', 'topbar', ['left', 'right']],
    ['page content', 'page-content', ['left', 'right']],
    ['drawer (.sidebar)', 'sidebar', ['left', 'right']],
    ['home-column', 'home-column', []],
    ['palette', 'palette', []],
  ])('[RED] mobile-remote.css declares a safe-area env() on the %s', (_label, className, sides) => {
    const bodies = bodiesNaming(uiCss(), className).join('\n');

    if (sides.length === 0) expect(bodies).toMatch(/env\(\s*safe-area-inset-/);
    for (const side of sides) {
      expect(bodies).toMatch(new RegExp(`env\\(\\s*safe-area-inset-${side}\\s*\\)`));
    }
  });
});

describe('motion, colour and hidden content (item 9; matrix M11 and M13)', () => {
  it('[GUARD] any animation or transition in mobile-remote.css sits inside prefers-reduced-motion: no-preference', () => {
    const unguarded = withoutBlocks(uiCssIfPresent(), 'media', (query) =>
      /prefers-reduced-motion:\s*no-preference/.test(query),
    );

    expect(unguarded).not.toMatch(/\b(?:animation|transition)(?:-[a-z-]+)?\s*:/);
  });

  it('[GUARD] no colour literal in mobile-remote.css or the layout stylesheets', () => {
    const sources = [...layoutPaths, mobilePath, ui5Path]
      .filter((path) => existsSync(path))
      .map((path) => ({ file: basename(path), css: stripComments(read(path)) }));
    for (const { file, css } of sources) {
      expect(css, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, file).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|color)\(/i);
    }
  });

  it('[GUARD] mobile-remote.css uses no display face and hides nothing with display: none', () => {
    const css = stripComments(uiCssIfPresent());
    const hidden = rulesIn(css)
      .filter((rule) => /display\s*:\s*none\b/.test(rule.body))
      .flatMap((rule) => rule.selectors);

    expect(css).not.toMatch(/--font-display|UnifrakturCook/);
    expect(hidden).toEqual([]);
  });
});

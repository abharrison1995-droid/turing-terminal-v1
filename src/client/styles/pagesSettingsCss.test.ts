// @vitest-environment node

// UI.4 tests for the Settings, pairing, Machines and Usage stylesheet (UI4_SCOPE sections 2, 4 and 5; matrix S1 to S5).
// They read the CSS as text, the same way goalsCockpitCss.test.ts does. They prove that rules are declared, not how a browser lays
// them out.
//
// [RED] tests need pages-settings.css, which does not exist yet. Each one asserts the file exists first, so a missing file
// fails with a clear message. [GUARD] tests characterise rules that already hold. A GUARD that scans pages-settings.css passes
// vacuously while that file is absent, so the GUARDs that matter also scan the existing page styles where those comply.
//
// Selector and value contract for the implementer (UI4_SCOPE gives no exact values, so these are the expectations):
// - Compact targets (S2): a rule whose body is `min-height: var(--h-touch)` and whose selector names a control (button,
//   input, select, textarea, submit, action, link, a, summary) and one of the page words pairing, machine, settings, usage.
// - Settings grid (S3): `.settings-grid` declares two or more tracks inside a `(min-width: 1100px)` block, and one track in
//   a base rule or a `max-width` block.
// - Usage tiles (S3): `.usage-summary-grid` declares 4, 2 and 1 tracks across its rules. Tracks are counted from an
//   explicit `repeat(N, ...)` or a track list. `auto-fit` and `auto-fill` count as one track, so write the counts out.
// - Usage table (S4): `.usage-table` declares `overflow-x: auto` (or `scroll`).
// - Long strings (S4): a `.settings-readonly-*` or `.machine-card-*` rule declares `overflow-wrap: anywhere` or `break-word`,
//   or `word-break: break-all`.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.css');
const ui4Path = join(here, 'pages-settings.css');
/** Existing page styles that the Usage, Settings and Machines pages already use and that comply with the GUARDs. */
const existingPageStyles = ['billing-routing-usage.css', 'mobile.css'].map((name) => join(here, name));

const read = (path: string) => readFileSync(path, 'utf8');
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

/** Each @media block with its query and body. Braces are counted, so nested rules stay inside their block. */
function mediaBlocks(css: string): Array<{ query: string; body: string }> {
  const source = stripComments(css);
  const blocks: Array<{ query: string; body: string }> = [];
  const opener = /@media\s*([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ query: match[1]!.trim(), body: source.slice(opener.lastIndex, index - 1) });
  }
  return blocks;
}

/** The stylesheet with every @media block whose query matches removed, so what is left is unguarded. */
function withoutMediaBlocks(css: string, query: RegExp): string {
  const source = stripComments(css);
  let result = source;
  for (const match of source.matchAll(/@media\s*([^{]+)\{/g)) {
    if (!query.test(match[1]!)) continue;
    let depth = 1;
    let index = match.index! + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    result = result.replace(source.slice(match.index!, index), '');
  }
  return result;
}

/** The tracks in a grid-template-columns value. An explicit repeat(N, ...) counts N; otherwise each top-level track counts 1. */
function trackCount(value: string): number {
  const repeated = /^repeat\(\s*(\d+)\s*,/.exec(value.trim());
  if (repeated) return Number(repeated[1]);
  return (value.match(/minmax\((?:[^()]|\([^()]*\))*\)|repeat\((?:[^()]|\([^()]*\))*\)|\S+/g) ?? []).length;
}

/** The grid-template-columns value declared in a rule body, or null. */
const columnsOf = (body: string): string | null =>
  /(?:^|[\s;{])grid-template-columns\s*:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? null;

/** pages-settings.css, which must exist for a [RED] test to reach its real assertion. */
const uiCss = (): string => {
  expect(existsSync(ui4Path), 'pages-settings.css exists').toBe(true);
  return read(ui4Path);
};

/** pages-settings.css when present, otherwise empty, for the GUARDs that must not fail on a missing file. */
const uiCssIfPresent = (): string => (existsSync(ui4Path) ? read(ui4Path) : '');

/** Styles the GUARDs scan: the existing page styles, plus pages-settings.css when it exists. */
const guardSources = (): Array<{ file: string; css: string }> =>
  [...existingPageStyles, ui4Path]
    .filter((path) => existsSync(path))
    .map((path) => ({ file: basename(path), css: stripComments(read(path)) }));

describe('pages-settings.css is wired between billing-routing-usage.css and goals.css (UI4 section 2, S1)', () => {
  it('[RED] index.css imports ./pages-settings.css directly after ./billing-routing-usage.css and directly before ./goals.css', () => {
    const imports = [...read(indexPath).matchAll(/@import\s+['"]\.\/([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports, 'index.css imports pages-settings.css').toContain('pages-settings.css');
    expect(imports[imports.indexOf('billing-routing-usage.css') + 1]).toBe('pages-settings.css');
    expect(imports[imports.indexOf('pages-settings.css') + 1]).toBe('goals.css');
  });
});

describe('tokens only and no display face (S1)', () => {
  it('[RED] pages-settings.css holds no colour literal (hex, rgb, hsl, hwb, oklch, oklab or color())', () => {
    const source = stripComments(uiCss());
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|color)\(/i);
  });

  it('[RED] pages-settings.css uses no display face (--font-display or UnifrakturCook)', () => {
    expect(stripComments(uiCss())).not.toMatch(/--font-display|UnifrakturCook/);
  });

  it('[GUARD] the existing Usage, Settings and Machines styles hold no colour literal or display face', () => {
    for (const { file, css } of guardSources()) {
      expect(css, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, file).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|color)\(/i);
      expect(css, file).not.toMatch(/--font-display|UnifrakturCook/);
    }
  });
});

describe('compact targets (S2)', () => {
  it('[RED] pages-settings.css gives a control in each of the four pages a min-height of --h-touch', () => {
    const touchSelectors = rulesIn(uiCss())
      .filter((rule) => /min-height\s*:\s*var\(--h-touch\)/.test(rule.body))
      .flatMap((rule) => rule.selectors);
    const control = /button|input|select|textarea|submit|action|link|\ba\b|summary/;

    for (const page of ['pairing', 'machine', 'settings', 'usage']) {
      expect(
        touchSelectors.some((selector) => selector.includes(page) && control.test(selector)),
        `a ${page} control at --h-touch`,
      ).toBe(true);
    }
  });
});

describe('layout breakpoints (S3)', () => {
  it('settings stay in one bounded reading column at desktop widths', () => {
    const settings = rulesIn(uiCss()).filter((rule) => rule.selectors.includes('.settings-grid'));
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((rule) => /grid-template-columns:\s*minmax\(0, 1fr\)/.test(rule.body))).toBe(true);
    expect(settings.some((rule) => /max-width:\s*900px/.test(rule.body))).toBe(true);
  });

  it('[RED] below 1100px, .settings-grid declares a single track in a base or max-width rule', () => {
    const css = uiCss();
    const below = [
      ...rulesIn(withoutMediaBlocks(css, /./)),
      ...mediaBlocks(css)
        .filter((block) => /max-width/.test(block.query))
        .flatMap((block) => rulesIn(block.body)),
    ];
    const oneTrack = below.some((rule) => {
      const columns = columnsOf(rule.body);
      return rule.selectors.includes('.settings-grid') && columns !== null && trackCount(columns) === 1;
    });

    expect(oneTrack).toBe(true);
  });

  it('[RED] .usage-summary-grid declares 4, 2 and 1 tracks across its breakpoints', () => {
    const counts = rulesIn(uiCss())
      .filter((rule) => rule.selectors.includes('.usage-summary-grid'))
      .map((rule) => columnsOf(rule.body))
      .filter((columns): columns is string => columns !== null)
      .map(trackCount);

    expect(counts).toEqual(expect.arrayContaining([4, 2, 1]));
  });
});

describe('tables and long strings (S4)', () => {
  it('[RED] .usage-table scrolls horizontally', () => {
    const scrolls = rulesIn(uiCss()).some(
      (rule) =>
        rule.selectors.includes('.usage-table') && /overflow-x\s*:\s*(?:auto|scroll)\b/.test(rule.body),
    );

    expect(scrolls).toBe(true);
  });

  it('[RED] long Tailscale login, origin and machine id text wraps in Settings and Machines rows', () => {
    const wraps = rulesIn(uiCss()).some(
      (rule) =>
        rule.selectors.some((selector) => /settings-readonly|machine-card/.test(selector)) &&
        /overflow-wrap\s*:\s*(?:anywhere|break-word)\b|word-break\s*:\s*break-all\b/.test(rule.body),
    );

    expect(wraps).toBe(true);
  });
});

describe('motion, hidden text and glyphs (S5)', () => {
  it('[GUARD] motion in pages-settings.css sits only under prefers-reduced-motion: no-preference', () => {
    const unguarded = withoutMediaBlocks(uiCssIfPresent(), /prefers-reduced-motion:\s*no-preference/);

    expect(unguarded).not.toMatch(/\b(?:animation|transition)(?:-[a-z-]+)?\s*:/);
  });

  it('[GUARD] no pages-settings.css selector hides its content with display:none', () => {
    const hidden = rulesIn(uiCssIfPresent())
      .filter((rule) => /display\s*:\s*none\b/.test(rule.body))
      .flatMap((rule) => rule.selectors);

    expect(hidden).toEqual([]);
  });

  it('[GUARD] no content: declaration in the Usage, Settings or Machines styles adds a glyph, counter or word', () => {
    for (const { file, css } of guardSources()) {
      const values = [...css.matchAll(/(?:^|[^-\w])content\s*:\s*([^;}]+)/g)].map((match) =>
        match[1]!.trim(),
      );
      for (const value of values) {
        expect(value, file).toMatch(/^(?:none|normal|""|'')$/);
      }
    }
  });
});

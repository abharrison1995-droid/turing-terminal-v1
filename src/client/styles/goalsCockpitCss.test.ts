// @vitest-environment node

// UI.3 tests for the Goal cockpit stylesheet (UI3_SCOPE sections 4 and 5, matrix G1 to G9). They read the CSS as text,
// the same way homeWorkspaceCss.test.ts does. They prove that rules are declared, not how a browser lays them out.
// [RED] tests need goals-cockpit.css, which does not exist yet; each one asserts the file exists first, so a missing file
// fails with a clear message. [GUARD] tests characterise rules that already hold. A GUARD that scans goals-cockpit.css
// passes vacuously while that file is absent, so the goals.css half of each GUARD carries the signal until then.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.css');
const goalsPath = join(here, 'goals.css');
const cockpitPath = join(here, 'goals-cockpit.css');

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

/** The number of tracks in a grid-template-columns value. minmax() and repeat() count as one track, one level deep. */
const trackCount = (value: string) =>
  (value.match(/minmax\((?:[^()]|\([^()]*\))*\)|repeat\((?:[^()]|\([^()]*\))*\)|\S+/g) ?? []).length;

const cockpitCss = () => {
  expect(existsSync(cockpitPath), 'goals-cockpit.css exists').toBe(true);
  return read(cockpitPath);
};

/** Goal styles for the GUARD scans: goals.css, plus goals-cockpit.css when it exists. */
const goalStyleSources = (): Array<{ file: string; css: string }> => [
  { file: 'goals.css', css: read(goalsPath) },
  { file: 'goals-cockpit.css', css: existsSync(cockpitPath) ? read(cockpitPath) : '' },
];

describe('goals-cockpit.css is wired into the cascade after goals.css (UI3 section 2)', () => {
  it('[RED] index.css imports ./goals-cockpit.css directly after ./goals.css', () => {
    expect(existsSync(cockpitPath), 'goals-cockpit.css exists').toBe(true);
    const imports = [...read(indexPath).matchAll(/@import\s+['"]\.\/([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports[imports.indexOf('goals.css') + 1]).toBe('goals-cockpit.css');
  });
});

describe('compact targets (G3)', () => {
  it('[RED] on a compact viewport goals-cockpit.css gives .goal-row and .goal-tab a min-height of --h-touch', () => {
    const compact = mediaBlocks(cockpitCss())
      .filter((block) => /max-width/.test(block.query))
      .flatMap((block) => rulesIn(block.body));
    const touch = (selector: string) =>
      compact.some(
        (rule) => rule.selectors.includes(selector) && /min-height\s*:\s*var\(--h-touch\)/.test(rule.body),
      );

    expect(touch('.goal-row')).toBe(true);
    expect(touch('.goal-tab')).toBe(true);
  });

  it('[GUARD] goals.css already gives .goal-row and .goal-tab a min-height of --h-touch on a compact viewport', () => {
    const compact = mediaBlocks(read(goalsPath))
      .filter((block) => /max-width/.test(block.query))
      .flatMap((block) => rulesIn(block.body));
    const touch = (selector: string) =>
      compact.some(
        (rule) => rule.selectors.includes(selector) && /min-height\s*:\s*var\(--h-touch\)/.test(rule.body),
      );

    expect(touch('.goal-row')).toBe(true);
    expect(touch('.goal-tab')).toBe(true);
  });
});

describe('the layout breakpoints (G3, G4)', () => {
  it('[RED] at 1024px and up goals-cockpit.css gives a grid two or more tracks wide', () => {
    const wide = mediaBlocks(cockpitCss())
      .filter((block) => /min-width\s*:\s*1024px/.test(block.query))
      .flatMap((block) => rulesIn(block.body));
    const twoTracks = wide.some((rule) => {
      const columns = /(?:^|[\s;{])grid-template-columns\s*:\s*([^;]+);/.exec(rule.body);
      return columns !== null && trackCount(columns[1]!) >= 2;
    });

    expect(twoTracks).toBe(true);
  });

  it('[GUARD] goals.css collapses .goal-row to one column at 1024px and below', () => {
    const narrow = mediaBlocks(read(goalsPath))
      .filter((block) => /max-width\s*:\s*1024px/.test(block.query))
      .flatMap((block) => rulesIn(block.body))
      .filter((rule) => rule.selectors.includes('.goal-row'))
      .map((rule) => /(?:^|[\s;{])grid-template-columns\s*:\s*([^;]+);/.exec(rule.body)?.[1] ?? '');

    expect(narrow).toEqual(['minmax(0, 1fr)']);
    expect(trackCount(narrow[0]!)).toBe(1);
  });
});

describe('tabs (section 2, item 3)', () => {
  it('[RED] .goal-tabs scrolls horizontally on narrow screens in goals-cockpit.css', () => {
    const scrolls = rulesIn(cockpitCss()).some(
      (rule) => rule.selectors.includes('.goal-tabs') && /overflow-x\s*:\s*auto\b/.test(rule.body),
    );

    expect(scrolls).toBe(true);
  });
});

describe('long dynamic strings wrap (G8)', () => {
  it.each([
    ['title', ['.goal-cockpit-head h2', '.goal-row-main', '.goal-mobile-heading h1']],
    ['branch', ['.goal-mobile-integration code', '.goal-fact dd', '.goal-handoff-identity dd']],
    ['path', ['.goal-handoff-paths', '.goal-handoff-paths li', '.goal-handoff-code']],
  ])(
    '[RED] goals-cockpit.css lets a long %s container wrap with overflow-wrap:anywhere',
    (_name, selectors) => {
      const wraps = rulesIn(cockpitCss()).some(
        (rule) =>
          rule.selectors.some((selector) => selectors.includes(selector)) &&
          /overflow-wrap\s*:\s*anywhere\b/.test(rule.body),
      );

      expect(wraps).toBe(true);
    },
  );
});

describe('tokens only (G1)', () => {
  it('[GUARD] no Goal stylesheet holds a colour literal or the display face', () => {
    for (const { file, css } of goalStyleSources()) {
      const source = stripComments(css);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|color)\(/i);
      expect(source, file).not.toMatch(/--font-display|UnifrakturCook/);
    }
  });

  it('[GUARD] no rule whose selector names a Goal class uses the display face', () => {
    const offending = goalStyleSources().flatMap(({ css }) =>
      rulesIn(css)
        .filter(
          (rule) =>
            rule.selectors.some((selector) => selector.includes('goal')) && /--font-display/.test(rule.body),
        )
        .flatMap((rule) => rule.selectors),
    );

    expect(offending).toEqual([]);
  });
});

describe('status and copy carry no check glyph, completion word or stepper (G5, G6)', () => {
  it('[GUARD] no content: declaration in the Goal styles adds a glyph, a counter or a completion word', () => {
    for (const { file, css } of goalStyleSources()) {
      const values = [...stripComments(css).matchAll(/(?:^|[^-\w])content\s*:\s*([^;}]+)/g)].map((match) =>
        match[1]!.trim(),
      );
      for (const value of values) {
        expect(value, file).toMatch(/^(?:none|normal|""|'')$/);
      }
    }
  });

  it('[GUARD] the Goal styles hold no stepper, progress, meter or counter construct', () => {
    const pattern =
      /(?:^|[^\w-])(?:progress|meter)\b(?!-)|stepper|progress-?bar|role\s*=\s*['"]?(?:progressbar|meter)|counter-(?:reset|increment)/i;
    for (const { file, css } of goalStyleSources()) {
      // `cursor: progress` is the busy-cursor keyword (goals.css, in-flight write), not a progress construct.
      const source = stripComments(css).replace(/cursor\s*:\s*progress\b/g, 'cursor: wait');
      expect(source, file).not.toMatch(pattern);
    }
  });
});

describe('motion and hidden text (G4, G9)', () => {
  it('[GUARD] any animation or transition in the Goal styles sits inside a prefers-reduced-motion: no-preference guard', () => {
    for (const { file, css } of goalStyleSources()) {
      const unguarded = withoutMediaBlocks(css, /prefers-reduced-motion:\s*no-preference/);
      expect(unguarded, file).not.toMatch(/\b(?:animation|transition)(?:-[a-z-]+)?\s*:/);
    }
  });

  it('[GUARD] no .goal-* selector hides its text with display:none', () => {
    const hidden = goalStyleSources().flatMap(({ css }) =>
      rulesIn(css)
        .filter(
          (rule) =>
            rule.selectors.some((selector) => selector.includes('.goal-')) &&
            /display\s*:\s*none\b/.test(rule.body),
        )
        .flatMap((rule) => rule.selectors),
    );

    expect(hidden).toEqual([]);
  });
});

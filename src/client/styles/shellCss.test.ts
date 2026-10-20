// @vitest-environment node

// UI.1c RED tests for the shell and palette stylesheets (scope sections 1 and 3, matrix S5 and S6). They read the CSS as
// text, the same way colourLiterals.test.ts and typography.test.ts do, and check values that a visual test would not
// reliably catch: the active bar, the crimson budget, colour literals, focus rings, and 44px compact targets.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const palettePath = join(here, 'palette.css');
const shellPath = join(here, 'shell.css');
const indexPath = join(here, 'index.css');

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

const ruleFor = (rules: Rule[], selector: string) => rules.find((rule) => rule.selectors.includes(selector));

describe('the palette stylesheet is wired in (section 1)', () => {
  it('palette.css exists and index.css imports it', () => {
    expect(existsSync(palettePath)).toBe(true);
    expect(read(indexPath)).toMatch(/@import\s+['"]\.\/palette\.css['"]/);
  });
});

describe('active nav bar and brand tile (matrix S6)', () => {
  const shellRules = () => rulesIn(read(shellPath));

  it('.nav-link-active::before is a 2px bar in --accent', () => {
    const bar = ruleFor(shellRules(), '.nav-link-active::before');
    expect(bar, 'a .nav-link-active::before rule').toBeDefined();
    expect(bar!.body).toMatch(/width\s*:\s*2px\b/);
    expect(bar!.body).toMatch(/background(?:-color)?\s*:\s*var\(--accent\)/);
  });

  it('the brand tile is --surface-3 with an --accent-ink icon, not a crimson fill', () => {
    const brand = ruleFor(shellRules(), '.brand-mark');
    expect(brand).toBeDefined();
    expect(brand!.body).toMatch(/background(?:-color)?\s*:\s*var\(--surface-3\)/);
    expect(brand!.body).toMatch(/color\s*:\s*var\(--accent-ink\)/);
    expect(brand!.body).not.toMatch(/var\(--accent\)/);
  });

  it('--accent is used by the shell and palette only on the active bar', () => {
    const users = [shellPath, palettePath]
      .filter((path) => existsSync(path))
      .flatMap((path) => rulesIn(read(path)))
      .filter((rule) => /var\(--accent\)/.test(rule.body))
      .flatMap((rule) => rule.selectors);
    expect(users).toEqual(['.nav-link-active::before']);
  });
});

describe('colour literals (matrix S6)', () => {
  it('shell.css and palette.css hold no hex, rgb, hsl or colour() literal', () => {
    for (const path of [shellPath, palettePath].filter((file) => existsSync(file))) {
      const source = stripComments(read(path));
      expect(source, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, path).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|color)\(/i);
    }
  });
});

describe('palette focus and touch targets (matrix S5)', () => {
  const palette = () => (existsSync(palettePath) ? read(palettePath) : '');

  it('a :focus-visible rule gives a visible outline and no rule removes outlines', () => {
    const rules = rulesIn(palette());
    const focusRule = rules.find(
      (rule) =>
        rule.selectors.some((selector) => selector.includes(':focus-visible')) &&
        /outline\s*:/.test(rule.body),
    );
    expect(focusRule, 'a :focus-visible rule with an outline').toBeDefined();
    expect(focusRule!.body).not.toMatch(/outline\s*:\s*(?:none|0)\b/);
    expect(palette()).not.toMatch(/outline\s*:\s*(?:none|0)\b/);
  });

  it('on a narrow viewport the palette rows and trigger are 44px, the sheet is full width, and the safe area is respected', () => {
    const compact = mediaBlocks(palette()).filter((block) => /max-width/.test(block.query));
    expect(compact.length).toBeGreaterThan(0);
    const body = compact.map((block) => block.body).join('\n');
    expect(body).toMatch(/min-height\s*:\s*44px\b/);
    expect(body).toMatch(/min-width\s*:\s*44px\b/);
    expect(body).toMatch(/width\s*:\s*100%|inset-inline\s*:\s*0\b|left\s*:\s*0\b/);
    expect(palette()).toMatch(/env\(\s*safe-area-inset-bottom/);
  });
});

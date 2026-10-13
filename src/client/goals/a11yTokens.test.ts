import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Static checks on the stylesheets and the completion and correction sources. They read files and compute colour
 * contrast from the light-theme tokens. They prove that rules are declared; they do not prove how a browser renders them.
 */

const styles = (file: string) => readFileSync(new URL(`../styles/${file}`, import.meta.url), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
}

/** Top-level rules of a flat stylesheet block: `selector, selector { declarations }`. */
function rulesIn(css: string): Rule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean),
    body: match[2]!,
  }));
}

/** The inside of one `@media` block, found by brace matching. Empty when the block is absent. */
function mediaBlock(css: string, query: string): string {
  const source = stripComments(css);
  const start = source.indexOf(`@media ${query}`);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return '';
}

const tokensCss = styles('tokens.css');
const goalsCss = styles('goals.css');
const baseCss = styles('base.css');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss);
  if (!match) throw new Error(`token --${name} is not a six-digit hex colour`);
  return match[1]!;
}

/** WCAG 2.x relative luminance of a six-digit hex colour. */
function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** The colour declared by the first rule that selects `selector` and declares a colour. */
function colourOf(selector: string): string {
  const rule = rulesIn(goalsCss).find(
    (candidate) => candidate.selectors.includes(selector) && /(^|[^-])color\s*:/.test(candidate.body),
  );
  if (!rule) throw new Error(`no colour rule for ${selector}`);
  return /(?:^|[^-])color\s*:\s*([^;]+);/.exec(rule.body)![1]!.trim();
}

describe('colour contrast of the light-theme tokens (S1)', () => {
  it.each([
    ['ink-3', 'surface', 4.5],
    ['ink-2', 'surface', 4.5],
    ['amber', 'surface', 4.5],
    ['red', 'surface', 4.5],
    ['amber', 'amber-wash', 4.5],
    ['ink-3', 'amber-wash', 4.5],
    ['red', 'red-wash', 4.5],
    ['on-accent', 'accent-fill', 4.5],
    ['focus-ring', 'surface', 3],
    ['focus-ring', 'amber-wash', 3],
  ] as const)('--%s on --%s meets %s:1', (foreground, background, minimum) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(minimum);
  });

  it('the tokens are light-theme only: no dark, forced-colors or theme-attribute rule exists in any stylesheet', () => {
    const files = readdirSync(new URL('../styles/', import.meta.url)).filter((file) => file.endsWith('.css'));
    for (const file of files) {
      expect(stripComments(styles(file))).not.toMatch(/prefers-color-scheme|forced-colors|data-theme/);
    }
  });
});

describe('completion and correction layout rules (S2-S6)', () => {
  it('S2: the 680px block gives completion and correction controls the 44px touch height', () => {
    const block = mediaBlock(goalsCss, '(max-width: 680px)');
    expect(block.length).toBeGreaterThan(0);
    const touch = rulesIn(block)
      .filter((rule) => rule.body.includes('min-height: var(--h-touch)'))
      .flatMap((rule) => rule.selectors);
    expect(touch).toEqual(
      expect.arrayContaining([
        '.goal-completion-action button',
        '.goal-completion-refusal button',
        '.goal-completion-ack',
      ]),
    );
  });

  it('S3: a rule for buttons inside the completion panel lets their labels wrap', () => {
    const wraps = rulesIn(goalsCss).some(
      (rule) =>
        rule.selectors.includes('.goal-completion button') &&
        /white-space:\s*normal/.test(rule.body) &&
        /max-width:\s*100%/.test(rule.body) &&
        /min-width:\s*0/.test(rule.body),
    );
    expect(wraps).toBe(true);
  });

  it('S4: a rule for the completion and correction selects and textareas bounds their width', () => {
    const bounded = rulesIn(goalsCss).some(
      (rule) =>
        rule.selectors.includes('.goal-completion-action select') &&
        rule.selectors.includes('.goal-completion-action textarea') &&
        /(^|[^-])width:\s*100%/.test(rule.body) &&
        /max-width:\s*100%/.test(rule.body) &&
        /min-width:\s*0/.test(rule.body),
    );
    expect(bounded).toBe(true);
  });

  it('S5: the contested, invalid and legacy states each have their own colour rule, and no two share a colour', () => {
    const colours = ['.goal-completion-contested', '.goal-completion-invalid', '.goal-completion-legacy'].map(
      colourOf,
    );
    expect(new Set(colours).size).toBe(3);
  });

  it('S6: the .goal-confirm title rule matches every heading level from h2 to h6', () => {
    const rule = rulesIn(goalsCss).find((candidate) => candidate.selectors.includes('.goal-confirm h2'));
    expect(rule).toBeDefined();
    for (const level of [2, 3, 4, 5, 6]) {
      expect(rule!.selectors).toContain(`.goal-confirm h${level}`);
    }
    expect(rule!.body).toMatch(/font-size:/);
  });
});

describe('focus and motion (S7)', () => {
  it('S7: base.css keeps a visible focus outline and a reduced-motion block', () => {
    expect(stripComments(baseCss)).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    expect(stripComments(baseCss)).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('no modal, autofocus, positive tabindex or focus trap (S8)', () => {
  it.each(['GoalCompletion.tsx', 'GoalCorrection.tsx', 'DefinitionParts.tsx'])(
    '%s declares none of them',
    (file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/aria-modal|autoFocus|tabIndex=\{\s*[1-9]|focus-?[Tt]rap/);
    },
  );
});

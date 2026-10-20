import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Static checks on the stylesheets and the completion and correction sources. They read files and compute colour
 * contrast from the dark tokens in tokens.css (UI.1b, docs/history/ui/UI1B_SCOPE.md sections 2 and 5). They prove that rules
 * are declared; they do not prove how a browser renders them.
 *
 * Background rule: T1 checks each opaque surface token. T2 and T3 check every opaque surface and its hover and pressed
 * composites (the declared overlay tokens, alpha-composited onto the surface). The only exemption is the accepted
 * accent caveat on pressed selected rows (scope section 2). The disabled-text exemption is not tested.
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

/** The declared value of a token in tokens.css. Throws when the token is not declared, so a missing token fails. */
function tokenValue(name: string): string {
  const declaration = new RegExp(`(?:^|[\\s;{])--${name}:\\s*([^;]+);`).exec(stripComments(tokensCss));
  if (!declaration) throw new Error(`token --${name} is not declared in tokens.css`);
  return declaration[1]!.trim();
}

interface Colour {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** Parses #rrggbb, rgb(r g b) and rgb(r g b / a%) (or the comma forms). Anything else throws. */
function parseColour(value: string): Colour {
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    return {
      red: Number.parseInt(digits.slice(0, 2), 16),
      green: Number.parseInt(digits.slice(2, 4), 16),
      blue: Number.parseInt(digits.slice(4, 6), 16),
      alpha: 1,
    };
  }
  const functional =
    /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[/,]\s*(\d+(?:\.\d+)?)(%?)\s*)?\)$/.exec(
      text,
    );
  if (functional) {
    const alpha = functional[4] === undefined ? 1 : Number(functional[4]) / (functional[5] === '%' ? 100 : 1);
    return { red: Number(functional[1]), green: Number(functional[2]), blue: Number(functional[3]), alpha };
  }
  throw new Error(`unsupported colour value "${value}": use #rrggbb or rgb(r g b / a%)`);
}

function colourToken(name: string): Colour {
  return parseColour(tokenValue(name));
}

/** `top` alpha-composited over an opaque `below`. */
function composite(top: Colour, below: Colour): Colour {
  const a = top.alpha;
  return {
    red: a * top.red + (1 - a) * below.red,
    green: a * top.green + (1 - a) * below.green,
    blue: a * top.blue + (1 - a) * below.blue,
    alpha: 1,
  };
}

/** WCAG 2.x relative luminance. */
function luminance(colour: Colour): number {
  const [red, green, blue] = [colour.red, colour.green, colour.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** WCAG 2.x contrast ratio. The foreground must be opaque. */
function contrast(foreground: Colour, background: Colour): number {
  if (foreground.alpha < 1) throw new Error('a foreground colour must be opaque');
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Hue in degrees (0 to 360) of an opaque colour. */
function hueOf(colour: Colour): number {
  const [r, g, b] = [colour.red, colour.green, colour.blue].map((channel) => channel / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = 60 * (((g! - b!) / delta) % 6);
  else if (max === g) hue = 60 * ((b! - r!) / delta + 2);
  else hue = 60 * ((r! - g!) / delta + 4);
  return (hue + 360) % 360;
}

const SURFACES = [
  'canvas-top',
  'canvas-bottom',
  'canvas',
  'nav',
  'surface',
  'surface-2',
  'surface-3',
  'selected',
];

/** Every opaque surface, then its hover and pressed composites, each labelled for failure messages. */
function backgroundsWithOverlays(): Array<{ label: string; colour: Colour }> {
  const hover = colourToken('hover');
  const pressed = colourToken('pressed');
  return SURFACES.flatMap((surface) => {
    const base = colourToken(surface);
    return [
      { label: surface, colour: base },
      { label: `${surface}+hover`, colour: composite(hover, base) },
      { label: `${surface}+pressed`, colour: composite(pressed, base) },
    ];
  });
}

/** Labels of the backgrounds on which `foreground` falls below `minimum`, ignoring any labels in `exempt`. */
function shortfalls(foreground: Colour, minimum: number, exempt: readonly string[] = []): string[] {
  return backgroundsWithOverlays()
    .filter(({ label }) => !exempt.includes(label))
    .filter(({ colour }) => contrast(foreground, colour) < minimum)
    .map(({ label, colour }) => `${label} ${contrast(foreground, colour).toFixed(2)}`);
}

/** The colour declared by the first rule that selects `selector` and declares a colour. */
function colourOf(selector: string): string {
  const rule = rulesIn(goalsCss).find(
    (candidate) => candidate.selectors.includes(selector) && /(^|[^-])color\s*:/.test(candidate.body),
  );
  if (!rule) throw new Error(`no colour rule for ${selector}`);
  return /(?:^|[^-])color\s*:\s*([^;]+);/.exec(rule.body)![1]!.trim();
}

describe('dark premise (T1)', () => {
  it('declares one color-scheme, and it is dark', () => {
    const declared = readdirSync(new URL('../styles/', import.meta.url))
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) => [...stripComments(styles(file)).matchAll(/color-scheme\s*:\s*([^;]+);/g)])
      .map((match) => match[1]!.trim());
    expect(declared).toEqual(['dark']);
  });

  it('every opaque surface token has relative luminance below 0.05', () => {
    const bright = SURFACES.filter((surface) => luminance(colourToken(surface)) >= 0.05);
    expect(bright).toEqual([]);
  });

  it('no prefers-color-scheme, forced-colors or data-theme rule exists in any stylesheet', () => {
    const files = readdirSync(new URL('../styles/', import.meta.url)).filter((file) => file.endsWith('.css'));
    for (const file of files) {
      expect(stripComments(styles(file))).not.toMatch(/prefers-color-scheme|forced-colors|data-theme/);
    }
  });
});

describe('text contrast on the dark surfaces, hover and pressed composites included (T2)', () => {
  it.each(['ink', 'ink-2', 'ink-3', 'accent-ink', 'green', 'amber', 'red', 'info'])(
    '--%s meets 4.5:1 on every surface and hover/pressed composite',
    (name) => {
      expect(shortfalls(colourToken(name), 4.5)).toEqual([]);
    },
  );

  it.each([
    ['green', 'green-wash'],
    ['amber', 'amber-wash'],
    ['red', 'red-wash'],
    ['info', 'info-wash'],
    ['accent-ink', 'accent-wash'],
  ])('status text --%s meets 4.5:1 on its own wash --%s', (foreground, background) => {
    expect(contrast(colourToken(foreground), colourToken(background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['accent-fill', 'accent-fill-hover', 'accent-fill-pressed'])(
    '--on-accent meets 4.5:1 on --%s',
    (background) => {
      expect(contrast(colourToken('on-accent'), colourToken(background))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    ['diff-add-ink', 'diff-add-bg'],
    ['diff-del-ink', 'diff-del-bg'],
  ])('--%s meets 4.5:1 on --%s', (foreground, background) => {
    expect(contrast(colourToken(foreground), colourToken(background))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('non-text contrast (T3)', () => {
  it.each(['focus-ring', 'control-line', 'chart-1', 'chart-2', 'chart-3'])(
    '--%s meets 3:1 on every surface and hover/pressed composite',
    (name) => {
      expect(shortfalls(colourToken(name), 3)).toEqual([]);
    },
  );

  it('--accent meets 3:1 on every surface and composite except the accepted pressed selected row', () => {
    expect(shortfalls(colourToken('accent'), 3, ['selected+pressed'])).toEqual([]);
  });
});

describe('mascot tokens (T4)', () => {
  it.each([
    ['outline', [20, 20, 24]],
    ['body', [188, 188, 192]],
    ['shade', [164, 164, 170]],
    ['accent', [188, 48, 60]],
  ] as const)('--tt-mascot-%s equals the supplement value', (name, [red, green, blue]) => {
    expect(colourToken(`tt-mascot-${name}`)).toEqual({ red, green, blue, alpha: 1 });
  });

  it('the mascot accent meets 3:1 against the mascot body, its only neighbouring colour', () => {
    expect(contrast(colourToken('tt-mascot-accent'), colourToken('tt-mascot-body'))).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('the mascot body and shade meet 3:1 on every surface and composite', () => {
    expect(shortfalls(colourToken('tt-mascot-body'), 3)).toEqual([]);
    expect(shortfalls(colourToken('tt-mascot-shade'), 3)).toEqual([]);
  });

  // The outline is decorative (supplement section 13.2, item 1) and is deliberately not held to 3:1.
});

describe('failure red is distinct from accent ink (T2)', () => {
  it('--red and --accent-ink are different colours, at least 12 degrees of hue apart', () => {
    expect(tokenValue('red')).not.toEqual(tokenValue('accent-ink'));
    const gap = Math.abs(hueOf(colourToken('red')) - hueOf(colourToken('accent-ink')));
    expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(12);
  });
});

describe('reduced motion (T10, guard)', () => {
  it('the global reduced-motion rule is present and comes after every keyframes block in cascade order', () => {
    const cascade = stripComments(
      [...styles('index.css').matchAll(/@import\s+'\.\/([^']+)';/g)]
        .map((match) => styles(match[1]!))
        .join('\n'),
    );
    const reducedAt = cascade.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(reducedAt).toBeGreaterThan(-1);
    expect(reducedAt).toBeGreaterThan(cascade.lastIndexOf('@keyframes'));
    const block = mediaBlock(baseCss, '(prefers-reduced-motion: reduce)');
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(block).toMatch(/animation-duration:/);
    expect(block).toMatch(/transition-duration:/);
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

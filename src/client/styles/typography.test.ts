// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * T6 and T7 (UI.1b, docs/history/ui/UI1B_SCOPE.md sections 2, 3 and 5). The display face (UnifrakturCook) may appear only on five
 * fixed-title selectors (R-4: user-supplied titles must never use it). The type scale, the font stacks and the
 * dependency on Geist sans are pinned by value.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');

const read = (path: string) => readFileSync(path, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const normalise = (value: string) => value.replace(/\s+/g, ' ').trim();
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const cssFiles = walk(clientRoot, (path) => path.endsWith('.css'));
const sourceFiles = walk(clientRoot, (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
const tokensCss = stripComments(read(join(here, 'tokens.css')));

/** The declared value of a token in tokens.css. Throws when it is missing. */
function token(name: string): string {
  const match = new RegExp(`(?:^|[\\s;{])--${name}:\\s*([^;]+);`).exec(tokensCss);
  if (!match) throw new Error(`token --${name} is not declared in tokens.css`);
  return normalise(match[1]!);
}

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

/** The five fixed-title selectors allowed to use the display face (scope section 3). */
const DISPLAY_SELECTORS = [
  '.brand-name',
  '.page-heading h1',
  '.home-intro h1',
  '.pairing-panel h1',
  '.desktop-startup-card h1',
];

describe('the display face is confined to fixed titles (T6)', () => {
  it('font-family uses --font-display on exactly the five allow-listed selectors', () => {
    const selectors = cssFiles.flatMap((path) =>
      rulesIn(read(path))
        .filter((rule) => /font(?:-family)?\s*:[^;]*var\(\s*--font-display\s*\)/.test(rule.body))
        .flatMap((rule) => rule.selectors),
    );
    expect([...new Set(selectors)].sort()).toEqual([...DISPLAY_SELECTORS].sort());
  });

  it('no bare heading element, and no wildcard, receives the display face', () => {
    const bare = cssFiles.flatMap((path) =>
      rulesIn(read(path))
        .filter((rule) => /font(?:-family)?\s*:[^;]*--font-display/.test(rule.body))
        .flatMap((rule) => rule.selectors)
        .filter((selector) => /^(?:h[1-6]|\*|body|:where\(h[1-6]\))$/.test(selector)),
    );
    expect(bare).toEqual([]);
  });

  it('every PageHeading title is a static string literal, never an expression', () => {
    const offenders = sourceFiles.flatMap((path) => {
      const text = read(path);
      const opened = [...text.matchAll(/<PageHeading\b/g)].length;
      const literal = [...text.matchAll(/<PageHeading\s+title="[^"{]*"/g)].length;
      return opened === literal
        ? []
        : [`${relative(repoRoot, path)}: ${opened - literal} PageHeading without a literal title`];
    });
    expect(offenders).toEqual([]);
  });
});

describe('type scale, floors and font stacks (T7)', () => {
  it.each([
    ['--fs-body', '15px'],
    ['--fs-control', '14px'],
    ['--fs-meta', '13px'],
    ['--fs-micro', '12px'],
    ['--fs-section', '16px'],
    ['--fs-title', '24px'],
    ['--fs-display-brand', '15px'],
    ['--fs-display-title', '32px'],
    ['--fw-medium', '500'],
    ['--fw-semibold', '600'],
  ])('%s is %s', (name, value) => {
    expect(token(name.slice(2))).toBe(value);
  });

  it('body text is at least 14px, and meta and micro text at least 12px', () => {
    const px = (name: string) => Number.parseFloat(token(name));
    expect(px('fs-body')).toBeGreaterThanOrEqual(14);
    expect(px('fs-meta')).toBeGreaterThanOrEqual(12);
    expect(px('fs-micro')).toBeGreaterThanOrEqual(12);
  });

  it('no font-size literal in any stylesheet is below 12px', () => {
    const small = cssFiles.flatMap((path) => {
      const source = stripComments(read(path));
      return [...source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)]
        .filter((match) => Number(match[1]) < 12)
        .map((match) => `${relative(repoRoot, path)}:${lineOf(source, match.index ?? 0)} ${match[0]}`);
    });
    expect(small).toEqual([]);
  });

  it('interface text uses the native sans stack without a network font', () => {
    expect(token('font-sans')).toBe(
      "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    );
    expect(token('font-sans')).not.toMatch(/Geist/);
  });

  it('headings share the interface face', () => {
    expect(token('font-display')).toBe('var(--font-sans)');
  });

  it('--font-mono is unchanged (Geist Mono stays)', () => {
    expect(token('font-mono')).toBe(
      "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
    );
  });

  it('the Geist sans package and import are removed, and Geist Mono is still imported', () => {
    const pkg = read(join(repoRoot, 'package.json'));
    const lock = read(join(repoRoot, 'package-lock.json'));
    const main = read(join(clientRoot, 'main.tsx'));
    expect(pkg).not.toContain('"@fontsource-variable/geist"');
    expect(lock).not.toContain('"node_modules/@fontsource-variable/geist"');
    expect(main).not.toMatch(/import\s+'@fontsource-variable\/geist';/);
    expect(pkg).toContain('"@fontsource-variable/geist-mono"');
    expect(main).toMatch(/import\s+'@fontsource-variable\/geist-mono';/);
  });

  it('body keeps font-synthesis: none, to avoid synthetic faces', () => {
    expect(stripComments(read(join(clientRoot, 'styles', 'base.css')))).toMatch(
      /body\s*\{[^}]*font-synthesis:\s*none/,
    );
  });
});

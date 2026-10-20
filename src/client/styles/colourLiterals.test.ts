// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * T5 (UI.1b, docs/history/ui/UI1B_SCOPE.md section 5): tokens.css is the only place that holds colour literals. Scans the client
 * CSS, the client TypeScript and TSX (test files excluded, since they do not ship), and every SVG under src/client or
 * public. Also checks that every var(--name) without a fallback resolves to a declaration, and that the white tokens
 * retired by the dark theme are gone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');
const tokensPath = join(here, 'tokens.css');

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(path, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const lineText = (text: string, index: number) =>
  text.split('\n')[lineOf(text, index) - 1]!.trim().slice(0, 140);

const cssFiles = walk(clientRoot, (path) => path.endsWith('.css'));
const sourceFiles = walk(clientRoot, (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
/** The PWA/app icon is a standalone image: it cannot read page CSS variables, so it is the one allow-listed asset. */
const standaloneIcon = join(repoRoot, 'public', 'turing.svg');
const svgFiles = [standaloneIcon, ...walk(clientRoot, (path) => path.endsWith('.svg'))];

/** The CSS named colours (CSS Color 4, 148 keywords). A bare keyword in a declaration value is a literal. */
const NAMED_COLOURS = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
];
const NAMED = new RegExp(`(?<![-\\w])(?:${NAMED_COLOURS.join('|')})(?![-\\w])`, 'i');
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/;
const FUNCTIONAL = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(/i;

/** Every literal in one file, as `path:line: text`. `quoted` restricts hex to string literals (TS and SVG attributes). */
function literalsIn(path: string, text: string, quoted: boolean): string[] {
  const found: string[] = [];
  const report = (index: number) =>
    found.push(`${relative(repoRoot, path)}:${lineOf(text, index)}: ${lineText(text, index)}`);
  const hexPattern = quoted
    ? /(['"`])[^'"`\n]*?#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])[^'"`\n]*?\1/g
    : new RegExp(HEX.source, 'g');
  for (const match of text.matchAll(hexPattern)) report(match.index ?? 0);
  for (const match of text.matchAll(new RegExp(FUNCTIONAL.source, 'gi'))) report(match.index ?? 0);
  return found;
}

/** Every CSS declaration value that names a colour keyword, or holds a hex or functional literal. */
function cssLiteralsIn(path: string, css: string): string[] {
  const source = stripComments(css);
  const found = literalsIn(path, source, false);
  for (const match of source.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    if (NAMED.test(match[2]!))
      found.push(`${relative(repoRoot, path)}:${lineOf(source, match.index ?? 0)}: ${match[0].trim()}`);
  }
  return found;
}

/** A TSX or SVG named colour in a colour-bearing attribute or property, such as fill="red" or color: 'red'. */
function namedColourPropsIn(path: string, text: string): string[] {
  const pattern =
    /\b(?:color|backgroundColor|background|fill|stroke|stop-color|flood-color|borderColor|outlineColor)\s*[:=]\s*(['"`])([^'"`\n]*)\1/gi;
  return [...text.matchAll(pattern)]
    .filter((match) => NAMED.test(match[2]!))
    .map((match) => `${relative(repoRoot, path)}:${lineOf(text, match.index ?? 0)}: ${match[0].trim()}`);
}

const tokensCss = stripComments(read(tokensPath));

function tokenDeclared(name: string): string | undefined {
  return new RegExp(`(?:^|[\\s;{])--${name}:\\s*([^;]+);`).exec(tokensCss)?.[1]?.trim();
}

describe('colour literals are confined to tokens.css (T5)', () => {
  it('CSS outside tokens.css holds no hex, rgb, hsl, colour() or named colour', () => {
    const offenders = cssFiles
      .filter((path) => path !== tokensPath)
      .flatMap((path) => cssLiteralsIn(path, read(path)));
    expect(offenders).toEqual([]);
  });

  it('TypeScript and TSX outside the test files hold no colour literal', () => {
    const offenders = sourceFiles.flatMap((path) => {
      const text = read(path);
      return [...literalsIn(path, text, true), ...namedColourPropsIn(path, text)];
    });
    expect(offenders).toEqual([]);
  });

  it('every SVG under src/client holds no colour literal', () => {
    const offenders = svgFiles
      .filter((path) => path !== standaloneIcon)
      .flatMap((path) => {
        const text = read(path);
        return [...literalsIn(path, text, true), ...namedColourPropsIn(path, text)];
      });
    expect(offenders).toEqual([]);
  });

  it('the standalone icon turing.svg uses only hex values that equal declared tokens (full-text scan)', () => {
    const tokens = read(join(clientRoot, 'styles', 'tokens.css')).toLowerCase();
    const text = read(standaloneIcon);
    expect(text).not.toMatch(/<style|rgb\(|hsl\(/i);
    const hexes = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(tokens, `${hex} must be a tokens.css value`).toContain(hex);
  });

  it('every var(--name) without a fallback resolves to a declaration in a stylesheet or inline style', () => {
    const declared = new Set<string>();
    const references: Array<{ where: string; name: string }> = [];
    for (const path of new Set([...cssFiles, ...sourceFiles, ...svgFiles])) {
      const text = stripComments(read(path));
      for (const match of text.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)) declared.add(match[1]!);
      for (const match of text.matchAll(/['"`]--([a-zA-Z0-9-]+)['"`]/g)) declared.add(match[1]!);
      for (const match of text.matchAll(/var\(\s*--([a-zA-Z0-9-]+)\s*([,)])/g)) {
        if (match[2] === ')') references.push({ where: relative(repoRoot, path), name: match[1]! });
      }
    }
    const unresolved = references
      .filter(({ name }) => !declared.has(name))
      .map(({ where, name }) => `${where}: var(--${name})`);
    expect(unresolved).toEqual([]);
  });

  it('the white tokens are gone, and their replacements are declared; the QR paper stays #ffffff', () => {
    for (const retired of ['white', 'white-70', 'white-45']) {
      expect(tokenDeclared(retired), `--${retired} must be removed`).toBeUndefined();
    }
    for (const name of ['field-hover', 'on-accent', 'qr-paper', 'badge-bg', 'on-accent-line']) {
      expect(tokenDeclared(name), `--${name} must be declared`).toBeDefined();
    }
    expect(tokenDeclared('qr-paper')?.toLowerCase()).toBe('#ffffff');
    const retiredUses = [...cssFiles, ...sourceFiles].flatMap((path) =>
      [...stripComments(read(path)).matchAll(/var\(\s*--white(?:-70|-45)?\s*[,)]/g)].map(() => path),
    );
    expect(retiredUses.map((path) => relative(repoRoot, path))).toEqual([]);
  });
});

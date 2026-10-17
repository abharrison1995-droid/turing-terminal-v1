// @vitest-environment node

// UI.6 A7 (UI6_SCOPE sections 1 and 5): styles/mascot.css. The file does not exist yet, so every test asserts that first
// and fails with a clear message. The CSS is read as text, as in ui4Css.test.ts, so these tests check declarations,
// not layout.
//
// Contract assumed for the implementer:
// - index.css imports './mascot.css'.
// - No colour literals (#hex, rgb(), rgba(), hsl(), hsla()). Colour comes from tokens, and the svg fills use the
//   --tt-mascot-* tokens (checked in mascotStatus.test.tsx).
// - Size declarations (width, height and their min and max forms) use only 24px or 48px. 32px appears nowhere.
// - image-rendering: pixelated.
// - No animation declaration (other than animation: none) outside a prefers-reduced-motion @media block.
//
// All five tests are RED until mascot.css exists and index.css imports it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, 'mascot.css');
const indexPath = join(here, 'index.css');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The CSS with every @media block whose query matches removed. Brace depth is counted, so nested rules stay inside. */
function outsideMediaMatching(css: string, query: RegExp): string {
  const source = stripComments(css);
  const opener = /@media\s*([^{]+)\{/g;
  let result = '';
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    result += source.slice(index, match.index);
    let depth = 1;
    let end = opener.lastIndex;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    if (!query.test(match[1]!)) result += source.slice(match.index, end);
    index = end;
    opener.lastIndex = end;
  }
  return result + source.slice(index);
}

describe('mascot stylesheet (UI6 A7)', () => {
  // [RED] mascot.css exists and index.css imports it.
  it('mascot.css exists and index.css imports it', () => {
    expect(existsSync(cssPath)).toBe(true);
    expect(readFileSync(indexPath, 'utf8')).toMatch(/@import\s+['"]\.\/mascot\.css['"]/);
  });

  // [RED] no colour literals: hex, rgb(), rgba(), hsl() or hsla().
  it('contains no colour literals', () => {
    expect(existsSync(cssPath)).toBe(true);
    const css = stripComments(readFileSync(cssPath, 'utf8'));
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/i);
  });

  // [RED] sizes are 24px or 48px only; 32px appears nowhere (UI0 13.6: 32 px is a non-integer scale of the 24 px grid).
  it('uses only 24px and 48px for sizes and never 32px', () => {
    expect(existsSync(cssPath)).toBe(true);
    const css = stripComments(readFileSync(cssPath, 'utf8'));
    expect(css).not.toMatch(/\b32px\b/);
    const sizeDeclaration =
      /(?:^|[\s;{])(?:width|height|min-width|min-height|max-width|max-height|inline-size|block-size)\s*:\s*([^;}]+)/g;
    const sizes = [...css.matchAll(sizeDeclaration)].flatMap(([, value]) => [
      ...value!.matchAll(/\d+(?:\.\d+)?px/g),
    ]);
    expect(sizes.length).toBeGreaterThan(0);
    for (const [size] of sizes) expect(['24px', '48px']).toContain(size);
  });

  // [RED] the mascot renders pixelated, so the 24-grid stays crisp at integer scales.
  it('sets image-rendering: pixelated', () => {
    expect(existsSync(cssPath)).toBe(true);
    expect(stripComments(readFileSync(cssPath, 'utf8'))).toMatch(/image-rendering\s*:\s*pixelated/);
  });

  // [RED] no CSS animation runs outside a prefers-reduced-motion block (motion is frame-driven and reduced-motion aware).
  it('has no animation outside a prefers-reduced-motion block', () => {
    expect(existsSync(cssPath)).toBe(true);
    const outside = outsideMediaMatching(readFileSync(cssPath, 'utf8'), /prefers-reduced-motion/);
    expect(outside).not.toMatch(/(?:^|[\s;{])animation(?:-[\w-]+)?\s*:\s*(?!none\b)/);
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * UI.5 viewport meta (UI5_SCOPE section 2, item 7 and matrix M1). viewport-fit=cover lets iOS report the
 * env(safe-area-inset-*) values that mobile-ui5.css reads; without it every inset is 0. The theme colour stays on the dark
 * canvas, and no apple-mobile-web-app tags are added, because the manifest and standalone launch do not need them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
/** The theme colour as it stood when UI.5 started. It must not change in this phase. */
const UI5_THEME_COLOUR = '#08080a';

const read = (path: string) => readFileSync(path, 'utf8');
const html = () => read(join(repoRoot, 'index.html'));

/** The viewport meta's content, split into its comma-separated directives. */
const viewportDirectives = (): string[] =>
  (/<meta\s+name="viewport"\s+content="([^"]+)"/.exec(html())?.[1] ?? '')
    .split(',')
    .map((part) => part.trim());

/** The canvas token value from tokens.css, as a lowercase hex colour. */
function canvasToken(): string {
  const match = /(?:^|[\s;{])--canvas:\s*(#[0-9a-fA-F]{6})\s*;/.exec(
    read(join(here, 'styles', 'tokens.css')),
  );
  if (!match) throw new Error('--canvas must be a six-digit hex colour in tokens.css');
  return match[1]!.toLowerCase();
}

describe('the viewport meta exposes safe-area insets (UI5 section 2, item 7; matrix M1)', () => {
  it('[RED] index.html viewport meta contains viewport-fit=cover', () => {
    expect(viewportDirectives()).toContain('viewport-fit=cover');
  });

  it('[GUARD] the viewport meta keeps width=device-width and initial-scale=1.0', () => {
    expect(viewportDirectives()).toEqual(expect.arrayContaining(['width=device-width', 'initial-scale=1.0']));
  });

  it('[GUARD] theme-color is unchanged and still equals the dark canvas token', () => {
    const themeColour = /<meta\s+name="theme-color"\s+content="([^"]+)"/.exec(html())?.[1]?.toLowerCase();

    expect(themeColour).toBe(UI5_THEME_COLOUR);
    expect(themeColour).toBe(canvasToken());
  });

  it('[GUARD] index.html adds no apple-mobile-web-app tags', () => {
    expect(html()).not.toMatch(/apple-mobile-web-app/i);
  });
});

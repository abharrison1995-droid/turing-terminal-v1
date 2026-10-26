// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * T9 (UI.1b, docs/history/ui/UI1B_SCOPE.md section 5). The browser theme colour, the colour-scheme meta and the PWA manifest colours
 * follow the dark canvas token. The old light canvas (#dce8f4) must not survive in any of them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const OLD_LIGHT_CANVAS = '#dce8f4';

const read = (path: string) => readFileSync(path, 'utf8');

/** The canvas token value from tokens.css, as a lowercase hex colour. */
function canvasToken(): string {
  const match = /(?:^|[\s;{])--canvas:\s*(#[0-9a-fA-F]{6})\s*;/.exec(
    read(join(here, 'styles', 'tokens.css')),
  );
  if (!match) throw new Error('--canvas must be a six-digit hex colour in tokens.css');
  return match[1]!.toLowerCase();
}

describe('PWA meta colours follow the dark canvas (T9)', () => {
  it('the canvas token is no longer the old light colour', () => {
    expect(canvasToken()).not.toBe(OLD_LIGHT_CANVAS);
  });

  it('index.html theme-color equals the canvas token and is not the old light colour', () => {
    const html = read(join(repoRoot, 'index.html'));
    const themeColour = /<meta\s+name="theme-color"\s+content="([^"]+)"/.exec(html)?.[1]?.toLowerCase();
    expect(themeColour).toBeDefined();
    expect(themeColour).not.toBe(OLD_LIGHT_CANVAS);
    expect(themeColour).toBe(canvasToken());
  });

  it('index.html declares dark appearance', () => {
    expect(read(join(repoRoot, 'index.html'))).toMatch(/<meta\s+name="color-scheme"\s+content="dark"\s*\/?>/);
  });

  it.each(['theme_color', 'background_color'])(
    'the manifest %s (vite.config.ts) equals the canvas token and is not the old light colour',
    (key) => {
      const value = new RegExp(`${key}:\\s*'([^']+)'`)
        .exec(read(join(repoRoot, 'vite.config.ts')))?.[1]
        ?.toLowerCase();
      expect(value).toBeDefined();
      expect(value).not.toBe(OLD_LIGHT_CANVAS);
      expect(value).toBe(canvasToken());
    },
  );
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Owner request: the skull is the app icon and favicon. The standalone icon cannot use CSS variables, so its colours are
// the --tt-mascot-* hex tokens, and scripts/generate-brand-icons.py regenerates it from the first idle frame.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('brand icons', () => {
  it('turing.svg is the skull in the mascot token colours, not the old glyph', () => {
    const svg = read('public/turing.svg').toLowerCase();
    const tokens = read('src/client/styles/tokens.css').toLowerCase();
    for (const role of ['outline', 'body', 'shade']) {
      const hex = new RegExp(`--tt-mascot-${role}:\\s*(#[0-9a-f]{6});`).exec(tokens)?.[1];
      expect(hex, `--tt-mascot-${role} must be a hex token`).toBeDefined();
      expect(svg).toContain(`fill="${hex}"`);
    }
    expect(svg).not.toContain('stroke-linecap');
  });

  it('index.html declares the SVG favicon and the manifest still points at the same icon', () => {
    expect(read('index.html')).toMatch(
      /<link\s+rel="icon"\s+href="\/turing\.svg"\s+type="image\/svg\+xml"\s*\/?>/,
    );
    expect(read('vite.config.ts')).toContain("src: '/turing.svg'");
  });

  it('declares a 180 px opaque apple-touch-icon and precaches it', () => {
    expect(read('index.html')).toMatch(
      /<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"\s*\/?>/,
    );
    expect(read('vite.config.ts')).toContain("'apple-touch-icon.png'");
    const png = readFileSync(join(root, 'public/apple-touch-icon.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
    expect(png[25]).toBe(2); // colour type 2 = RGB, so no alpha channel for iOS to fill with black
  });

  it('the Tauri raster icons are regenerated at their declared sizes', () => {
    const png = (name: string) => readFileSync(join(root, 'src-tauri/icons', name));
    const size = (name: string) => [png(name).readUInt32BE(16), png(name).readUInt32BE(20)];
    expect(size('32x32.png')).toEqual([32, 32]);
    expect(size('128x128.png')).toEqual([128, 128]);
    expect(size('128x128@2x.png')).toEqual([256, 256]);
  });
});

// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * T8 (UI.1b, docs/history/ui/UI1B_SCOPE.md section 3 and 5). The shipped fonts are the unchanged upstream files, pinned by SHA-256
 * to the supplement's font-provenance.json (verified 2026-10-15). No subsetting, no WOFF, no Italic. Each file is
 * served from the app itself (no CDN), within the Workbox per-file limit, and the Tauri CSP is left as it is.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');
const fontsDir = join(clientRoot, 'assets', 'fonts');
const TWO_MIB = 2 * 1024 * 1024;

/** SHA-256 of each shipped file, copied from the supplement's font-provenance.json and re-checked against it. */
const PINNED_SHA256: Record<string, string> = {
  'UnifrakturCook-Bold.ttf': 'ea002fa9c65f1a612af100e00d87ab65f16381f450020ec3d021f3dbf79a6dcd',
  'OFL.txt': '99d2f30e282d6174af8ff68597f58bb53c0dcb2b104a4c1b8d19da49021d00d3',
  'LinLibertine_Rah.ttf': '06e2b67aa9a899e71f78b91da21cd0bba0fb1c5791fd3b58752ea25a4b9b79d7',
  'LinLibertine_RBah.ttf': 'b044e2233db4f1a792e8422827679f3bc3b573c164597e9d3b03a63f123b4cdf',
  'OFL-1.1.txt': '3fc6b39399fa6ca1311bb233a6be549bc0ab212f93dd791658f247fe1ac92f33',
  'GPL.txt': 'de694db5ca6a8995ab115aa9d4bb0c4bd6f617921088ca786c9e746e02777c03',
  'LICENCE.txt': '73e4f0243fc4fd7a1bafaf13439e708c7194ac154942f52c86f30339c5395470',
  README: '4ab3e892db52874dd9aa002c4a766165102f72de9ca0b866f9ecf3c6818f4eca',
};
const FONT_FILES = ['UnifrakturCook-Bold.ttf', 'LinLibertine_Rah.ttf', 'LinLibertine_RBah.ttf'];

const read = (path: string) => readFileSync(path, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('bundled font files (T8)', () => {
  it('the fonts directory holds exactly the shipped files: no Italic, no WOFF, no subset', () => {
    const expected = [...Object.keys(PINNED_SHA256), 'font-provenance.json'].sort();
    expect(readdirSync(fontsDir).sort()).toEqual(expected);
  });

  it.each(Object.entries(PINNED_SHA256))('%s matches its pinned SHA-256', (file, digest) => {
    expect(existsSync(join(fontsDir, file))).toBe(true);
    expect(sha256(join(fontsDir, file))).toBe(digest);
  });

  it('font-provenance.json lists each shipped file with the pinned SHA-256 and an upstream source', () => {
    const entries = JSON.parse(read(join(fontsDir, 'font-provenance.json'))) as Array<{
      file: string;
      sha256: string;
      source_url?: string;
      upstream_commit?: string;
    }>;
    expect(entries.map((entry) => entry.file).sort()).toEqual(Object.keys(PINNED_SHA256).sort());
    for (const entry of entries) {
      const name = entry.file.split('/').pop()!;
      expect(entry.sha256, name).toBe(PINNED_SHA256[name]);
      expect(entry.source_url, name).toMatch(/^https:\/\//);
    }
    const unifraktur = entries.find((entry) => entry.file.endsWith('UnifrakturCook-Bold.ttf'));
    expect(unifraktur?.upstream_commit).toBe('fa02673f3b360ca4b9a8ba4f6d5a4aeb59eecd32');
  });

  it('the licence texts ship with the fonts', () => {
    expect(read(join(fontsDir, 'OFL.txt'))).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(read(join(fontsDir, 'OFL-1.1.txt'))).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(read(join(fontsDir, 'GPL.txt'))).toMatch(/GNU GENERAL PUBLIC LICENSE/);
    expect(read(join(fontsDir, 'LICENCE.txt')).trim().length).toBeGreaterThan(0);
    expect(read(join(fontsDir, 'README')).trim().length).toBeGreaterThan(0);
  });

  it('each font file is under 2 MiB, the Workbox per-file precache limit', () => {
    for (const file of FONT_FILES) {
      expect(statSync(join(fontsDir, file)).size, file).toBeLessThan(TWO_MIB);
    }
  });
});

/** The inside of every @font-face block in fonts.css. Read per test, so a missing file fails only those tests. */
function fontFaceBlocks(): string[] {
  const fontsCss = stripComments(read(join(clientRoot, 'styles', 'fonts.css')));
  return [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]!);
}

describe('@font-face rules (T8)', () => {
  it('fonts.css is imported first by index.css, before tokens.css', () => {
    const imports = [
      ...stripComments(read(join(clientRoot, 'styles', 'index.css'))).matchAll(/@import\s+'\.\/([^']+)';/g),
    ];
    expect(imports[0]?.[1]).toBe('fonts.css');
    expect(imports[1]?.[1]).toBe('tokens.css');
  });

  it('there are exactly three @font-face blocks, each with font-display: swap', () => {
    const blocks = fontFaceBlocks();
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).toMatch(/font-display:\s*swap/);
    }
  });

  it('each src is a relative url that resolves to a shipped font file, and no block is italic', () => {
    for (const block of fontFaceBlocks()) {
      const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(block)?.[1];
      expect(url, block).toBeDefined();
      expect(url!.startsWith('../assets/fonts/')).toBe(true);
      expect(existsSync(resolve(clientRoot, 'styles', url!))).toBe(true);
      expect(block).not.toMatch(/font-style:\s*italic/);
      expect(block).not.toMatch(/\.woff2?['"]/);
    }
  });

  it('the families are UnifrakturCook and Linux Libertine only', () => {
    const families = fontFaceBlocks().map((block) =>
      /font-family:\s*['"]?([^'";]+)/.exec(block)?.[1]?.trim(),
    );
    expect(families.sort()).toEqual(['Linux Libertine', 'Linux Libertine', 'UnifrakturCook']);
  });
});

describe('build, offline and CSP (T8)', () => {
  it('the PWA precache glob includes ttf, alongside the existing types', () => {
    const config = read(join(repoRoot, 'vite.config.ts'));
    expect(config).toMatch(/globPatterns:\s*\[\s*'\*\*\/\*\.\{[^}]*\bttf\b[^}]*\}'/);
  });

  it('no font is loaded from a CDN or a Google font host', () => {
    const offenders = [
      join(repoRoot, 'index.html'),
      join(clientRoot, 'styles', 'fonts.css'),
      join(clientRoot, 'main.tsx'),
    ]
      .filter((path) => existsSync(path))
      .filter((path) => /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  it("the Tauri CSP keeps font-src 'self' data: and declares font-src once", () => {
    const csp = JSON.parse(read(join(repoRoot, 'src-tauri', 'tauri.conf.json'))).app.security.csp as string;
    expect(csp).toContain("font-src 'self' data:");
    expect(csp.match(/font-src/g)).toHaveLength(1);
  });
});

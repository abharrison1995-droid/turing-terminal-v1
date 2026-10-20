// @vitest-environment node

// UI.6 A1 (UI6_SCOPE section 1 and 5): generated frame data, its provenance header, the size budget and the provenance
// record. Neither frames.generated.ts nor docs/ui/MASCOT_PROVENANCE.json exists yet.
//
// Contract assumed for the implementer:
// - frames.generated.ts exports MASCOT_ANIMATIONS = { idle, thinking, loading } and MASCOT_DATA_SHA256 (lowercase hex).
//   Each animation is { frameMs, loop, frames }: frames is six frames of 24 rows of 24 characters over '.obsa'.
//   frameMs is 300 for idle and 150 for thinking and loading.
// - The leading comment (text before the first export) names the sha256 provenance and that the file is generated.
// - docs/ui/MASCOT_PROVENANCE.json has a `wipes` object whose mask-count arrays strictly decrease, and a row-4 note.
//
// Every test is RED. The module is loaded inside each test, so each one fails on its own with "Cannot find module" (or
// the missing file) until the generator has run. The file-level checks do not depend on the module loading.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const framesPath = join(here, 'frames.generated.ts');
const provenancePath = join(repoRoot, 'docs/ui/MASCOT_PROVENANCE.json');

const EXPECTED_FRAME_MS = { idle: 300, thinking: 150, loading: 150 } as const;
const NAMES = ['idle', 'thinking', 'loading'] as const;
/** Raw size budget for the generated module (UI0 13, UI6 scope section 1). */
const MAX_BYTES = 20480;

const loadFrames = () => import('./frames.generated');

/** Every array of numbers inside a parsed JSON value, with the key path that leads to it. */
function numberArrays(node: unknown, path: string[] = []): Array<{ path: string; values: number[] }> {
  if (Array.isArray(node)) {
    if (node.every((value) => typeof value === 'number'))
      return [{ path: path.join('.'), values: node as number[] }];
    return node.flatMap((value, index) => numberArrays(value, [...path, String(index)]));
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => numberArrays(value, [...path, key]));
  }
  return [];
}

describe('mascot frame data (UI6 A1)', () => {
  // [RED] the module exports the three status loops with the spec timings and loop flags.
  it('exports idle, thinking and loading with 300, 150 and 150 ms looping timings', async () => {
    const { MASCOT_ANIMATIONS } = await loadFrames();
    expect(Object.keys(MASCOT_ANIMATIONS).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(MASCOT_ANIMATIONS[name]).toMatchObject({ frameMs: EXPECTED_FRAME_MS[name], loop: true });
    }
  });

  // [RED] six frames each of 24 rows of 24 cells, every cell drawn from the .obsa alphabet.
  it('has 6 frames of 24 rows x 24 characters, each character one of .obsa', async () => {
    const { MASCOT_ANIMATIONS } = await loadFrames();
    for (const name of NAMES) {
      const { frames } = MASCOT_ANIMATIONS[name];
      expect(frames, name).toHaveLength(6);
      for (const frame of frames) {
        expect(frame, name).toHaveLength(24);
        for (const row of frame) expect(row, name).toMatch(/^[.obsa]{24}$/);
      }
    }
  });

  // [RED] the digest constant is a lowercase sha256 hex string.
  it('exports MASCOT_DATA_SHA256 as a lowercase 64-character hex digest', async () => {
    const { MASCOT_DATA_SHA256 } = await loadFrames();
    expect(MASCOT_DATA_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  // [RED] the generated module stays within the raw size budget (A8 precache input).
  it('keeps frames.generated.ts at or under 20480 bytes', () => {
    expect(existsSync(framesPath)).toBe(true);
    expect(statSync(framesPath).size).toBeLessThanOrEqual(MAX_BYTES);
  });

  // [RED] the provenance header names the sha256 source and says the file is generated.
  it('has a leading header that names sha256 provenance and the generated status', () => {
    expect(existsSync(framesPath)).toBe(true);
    const source = readFileSync(framesPath, 'utf8');
    const header = source.slice(0, source.indexOf('export'));
    expect(header).toMatch(/sha256/i);
    expect(header).toMatch(/generated/i);
  });

  // [RED] the provenance record exists and every wipe mask-count array strictly decreases across the wipe.
  it('has provenance wipe mask counts that strictly decrease within each wipe', () => {
    expect(existsSync(provenancePath)).toBe(true);
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as { wipes?: unknown };
    const masks = numberArrays(provenance.wipes).filter(({ path }) => /mask/i.test(path));
    expect(masks.length).toBeGreaterThan(0);
    for (const { path, values } of masks) {
      values.forEach((value, index) => {
        if (index > 0) expect(value, `${path}[${index}]`).toBeLessThan(values[index - 1]!);
      });
    }
  });

  // [RED] the provenance record keeps the row-4 wipe glitch note (UI0 13.2 item 5).
  it('records the row-4 wipe glitch note in the provenance record', () => {
    expect(existsSync(provenancePath)).toBe(true);
    expect(readFileSync(provenancePath, 'utf8')).toMatch(/row[ _-]?4/i);
  });
});

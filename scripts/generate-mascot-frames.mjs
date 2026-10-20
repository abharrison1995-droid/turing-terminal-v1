#!/usr/bin/env node
// Developer tool (not part of the validation gate). Builds the runtime mascot frame data and its provenance record from
// the owner-approved supplement directory.
//
// Usage: node scripts/generate-mascot-frames.mjs <supplement-dir>
//
// Reads mascot/animation-manifest.json and the frame SVGs under the supplement, then writes:
//   - src/client/ui/mascot/frames.generated.ts  (idle, thinking and loading only, 24x24 frames over .obsa)
//   - docs/ui/MASCOT_PROVENANCE.json            (sha256 of every source file, wipe mask counts, row-4 note)
// Both outputs are formatted with the repository prettier configuration. Paths in the outputs are repo or supplement
// relative, never absolute.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = 'scripts/generate-mascot-frames.mjs';
const FRAMES_OUT = join(repoRoot, 'src/client/ui/mascot/frames.generated.ts');
const PROVENANCE_OUT = join(repoRoot, 'docs/ui/MASCOT_PROVENANCE.json');

/** Runtime states, with the timings the manifest must agree with (UI6 scope section 1). */
const RUNTIME = [
  { name: 'idle', frameMs: 300 },
  { name: 'thinking', frameMs: 150 },
  { name: 'loading', frameMs: 150 },
];
/** Wipes are deferred (UI6 scope section 3). They are read only to record their mask counts. */
const WIPES = [
  'wipe-left-to-right',
  'wipe-right-to-left',
  'wipe-top-to-bottom',
  'wipe-bottom-to-top',
  'wipe-center-out-horizontal',
  'wipe-center-out-vertical',
];
const ROLE_CHAR = { outline: 'o', body: 'b', shade: 's', accent: 'a' };
const RECT =
  /<rect x="(\d+)" y="(\d+)" width="1" height="1" fill="var\(--tt-mascot-(outline|body|shade|accent)\)"\/>/g;
const ROW4_NOTE =
  'Known glitch, aesthetic only: wipe row 4 (wipe-bottom-to-top, atlasRow 3 zero-based) frames 3 and 4 look glitchy in ' +
  'preview.png, with a comb-shaped intermediate (REVIEW-FINDINGS-MAP item 5). Visual acceptance is an owner item. ' +
  'Wipes are not shipped at runtime (UI6 scope section 3), so the glitch is not visible in the product.';

function fail(message) {
  console.error(`generate-mascot-frames: ${message}`);
  process.exit(1);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));

/** Every .svg file under a directory, sorted, as paths relative to the supplement root. */
function svgFilesUnder(root, dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return svgFilesUnder(root, path);
      return entry.name.endsWith('.svg') ? [path] : [];
    })
    .sort();
}

/** Parse one frame SVG into 24 rows of 24 characters over .obsa. Rejects anything that is not a 1x1 token-filled rect. */
function parseFrame(path) {
  const svg = readFileSync(path, 'utf8');
  if (!svg.includes('viewBox="0 0 24 24"') || !svg.includes('width="96" height="96"'))
    fail(`${path}: expected viewBox 0 0 24 24 and 96x96 size`);
  const grid = Array.from({ length: 24 }, () => Array.from({ length: 24 }, () => '.'));
  let parsed = 0;
  for (const match of svg.matchAll(RECT)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (x > 23 || y > 23) fail(`${path}: rect (${x},${y}) is outside the 24x24 grid`);
    if (grid[y][x] !== '.') fail(`${path}: two rects cover (${x},${y})`);
    grid[y][x] = ROLE_CHAR[match[3]];
    parsed += 1;
  }
  const rectCount = (svg.match(/<rect /g) ?? []).length;
  if (rectCount !== parsed) fail(`${path}: ${rectCount - parsed} rect(s) do not match the token-fill form`);
  return grid.map((row) => row.join(''));
}

const visibleCount = (rows) => rows.join('').replace(/\./g, '').length;

const supplementArg = process.argv[2];
if (!supplementArg) fail('usage: node scripts/generate-mascot-frames.mjs <supplement-dir>');
const supplementDir = resolve(supplementArg);
const mascotDir = join(supplementDir, 'mascot');
const manifestPath = join(mascotDir, 'animation-manifest.json');
if (!existsSync(manifestPath)) fail(`missing ${relative(supplementDir, manifestPath)} under the supplement`);

const manifestBytes = readFileSync(manifestPath);
const manifestSha = sha256(manifestBytes);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const animationEntry = (name) => {
  const entry = manifest.animations.find((animation) => animation.name === name);
  if (!entry) fail(`manifest has no animation named ${name}`);
  return entry;
};

/** Runtime frames for idle, thinking and loading. Each is checked against the manifest counts and timings. */
const runtime = {};
for (const { name, frameMs } of RUNTIME) {
  const entry = animationEntry(name);
  if (entry.frameDurationMs !== frameMs)
    fail(`${name}: manifest frameDurationMs ${entry.frameDurationMs} != ${frameMs}`);
  if (entry.loop !== true) fail(`${name}: runtime loops must be loop: true`);
  if (entry.svgFrames.length !== 6)
    fail(`${name}: expected 6 frames, manifest lists ${entry.svgFrames.length}`);
  const frames = entry.svgFrames.map((path) => parseFrame(join(mascotDir, path)));
  const counts = frames.map(visibleCount);
  if (JSON.stringify(counts) !== JSON.stringify(entry.visibleSourcePixels))
    fail(`${name}: parsed pixel counts ${counts} differ from manifest ${entry.visibleSourcePixels}`);
  runtime[name] = { frameMs, loop: true, frames };
}

/** Wipe mask counts are recorded from the parsed SVGs and must strictly decrease across the six poses. */
const wipes = {};
for (const name of WIPES) {
  const entry = animationEntry(name);
  const frames = entry.svgFrames.map((path) => parseFrame(join(mascotDir, path)));
  const maskPixelCounts = frames.map(visibleCount);
  if (JSON.stringify(maskPixelCounts) !== JSON.stringify(entry.visibleSourcePixels))
    fail(`${name}: parsed mask counts ${maskPixelCounts} differ from manifest ${entry.visibleSourcePixels}`);
  maskPixelCounts.forEach((value, index) => {
    if (index > 0 && !(value < maskPixelCounts[index - 1]))
      fail(`${name}: mask count does not strictly decrease`);
  });
  wipes[name] = { atlasRow: entry.atlasRow, durationMs: entry.durationMs, maskPixelCounts };
}

const dataPayload = Object.fromEntries(RUNTIME.map(({ name }) => [name, runtime[name]]));
const dataSha = sha256(JSON.stringify(dataPayload));
const supplementName = basename(supplementDir);

const header = [
  '// Generated by scripts/generate-mascot-frames.mjs. Do not edit by hand.',
  `// Supplement: ${supplementName} (mascot/animation-manifest.json, status ${manifest.status}).`,
  `// Manifest sha256: ${manifestSha}`,
  `// Data sha256: ${dataSha} (canonical JSON of the idle, thinking and loading frames).`,
  '// Runtime states only: idle, thinking and loading. Wipes and phase-transition are deferred (UI6 scope section 3).',
  '// Provenance record: docs/ui/MASCOT_PROVENANCE.json.',
  '',
].join('\n');

const body = [
  `export const MASCOT_DATA_SHA256 = '${dataSha}';`,
  '',
  'export const MASCOT_ANIMATIONS = {',
  ...RUNTIME.map(({ name }) => {
    const { frameMs, loop, frames } = runtime[name];
    return [
      `  ${name}: {`,
      `    frameMs: ${frameMs},`,
      `    loop: ${loop},`,
      '    frames: [',
      ...frames.map((rows) => ['      [', ...rows.map((row) => `        '${row}',`), '      ],'].join('\n')),
      '    ],',
      '  },',
    ].join('\n');
  }),
  '} as const;',
  '',
].join('\n');

const sourceSvgs = svgFilesUnder(supplementDir, mascotDir).map((path) => ({
  path: relative(supplementDir, path).split(sep).join('/'),
  sha256: sha256File(path),
}));
const rebuildScript = join(supplementDir, 'tools', 'rebuild_mascot.py');
const skullSource = join(mascotDir, 'skull-source.json');
const relPath = (path) => relative(supplementDir, path).split(sep).join('/');

const provenance = {
  schema: 1,
  generator: GENERATOR,
  supplement: supplementName,
  supplementStatus: manifest.status,
  approval:
    'D-4 approved skull art (UI0 section 13); owner to confirm licence before merge (UI6 scope section 7)',
  manifest: { path: relPath(manifestPath), sha256: manifestSha },
  dataSha256: dataSha,
  runtime: {
    states: RUNTIME.map(({ name }) => name),
    frameMs: Object.fromEntries(RUNTIME.map(({ name, frameMs }) => [name, frameMs])),
    frameCount: 6,
    gridSize: [24, 24],
    alphabet: '.obsa',
  },
  deferred: {
    states: ['phase-transition', ...WIPES],
    reason: 'No truthful trigger; risk of reading as completion; extra precache (UI6 scope section 3).',
  },
  sources: {
    skullSource: { path: relPath(skullSource), sha256: sha256File(skullSource) },
    rebuildScript: existsSync(rebuildScript)
      ? { path: relPath(rebuildScript), sha256: sha256File(rebuildScript) }
      : null,
  },
  sourceSvgs,
  wipes: {
    order: WIPES,
    row4Note: ROW4_NOTE,
    ...wipes,
  },
};

const outputOptions = async (path) => ({ ...((await prettier.resolveConfig(path)) ?? {}), filepath: path });

const framesText = await prettier.format(header + body, await outputOptions(FRAMES_OUT));
const provenanceText = await prettier.format(JSON.stringify(provenance), await outputOptions(PROVENANCE_OUT));

mkdirSync(dirname(FRAMES_OUT), { recursive: true });
mkdirSync(dirname(PROVENANCE_OUT), { recursive: true });
writeFileSync(FRAMES_OUT, framesText);
writeFileSync(PROVENANCE_OUT, provenanceText);

const bytes = Buffer.byteLength(framesText);
console.log(`wrote ${relative(repoRoot, FRAMES_OUT)} (${bytes} bytes, data sha256 ${dataSha})`);
console.log(`wrote ${relative(repoRoot, PROVENANCE_OUT)} (${sourceSvgs.length} source svgs)`);

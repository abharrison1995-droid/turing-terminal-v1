import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseArtifactNames } from './release-artifact-names.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const release = join(root, 'dist', 'release', version);
const names = releaseArtifactNames(version);
await mkdir(release, { recursive: true });

const bundles = [
  {
    source: join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis'),
    match: /\.exe$/i,
    name: names.windows,
  },
  {
    source: join(root, 'src-tauri', 'target', 'release', 'bundle', 'deb'),
    match: /\.deb$/i,
    name: names.deb,
  },
  {
    source: join(root, 'src-tauri', 'target', 'release', 'bundle', 'appimage'),
    match: /\.AppImage$/i,
    name: names.appimage,
  },
];

const produced = [];
for (const bundle of bundles) {
  let files = [];
  try {
    files = await readdir(bundle.source);
  } catch {
    continue;
  }
  const source = files.find((file) => bundle.match.test(file));
  if (!source) continue;
  const destination = join(release, bundle.name);
  await copyFile(join(bundle.source, source), destination);
  produced.push(destination);
}

if (produced.length === 0) throw new Error('No Tauri installer artifacts were found to collect.');

const sums = [];
for (const artifact of produced) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  sums.push(`${hash.digest('hex')}  ${basename(artifact)}`);
}
await writeFile(join(release, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
const notes = await readFile(join(root, 'docs', 'RELEASE_NOTES_1.0.0-rc1.md'), 'utf8');
await writeFile(join(release, 'RELEASE_NOTES.md'), notes);
console.log(`Collected ${produced.length} artifact(s) in ${release}`);

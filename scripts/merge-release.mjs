import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseArtifactNames } from './release-artifact-names.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const release = join(root, 'dist', 'release', version);
const staging = join(release, 'staging');
const names = new Set(Object.values(releaseArtifactNames(version)));
await mkdir(release, { recursive: true });

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(path)));
    else result.push(path);
  }
  return result;
}

const artifacts = (await filesUnder(staging)).filter((path) => /\.(?:exe|deb|AppImage)$/i.test(path));
if (artifacts.length !== 3) throw new Error(`Expected three installer artifacts, found ${artifacts.length}.`);
const foundNames = new Set(artifacts.map((path) => basename(path)));
if ([...names].some((name) => !foundNames.has(name))) {
  throw new Error(`Installer filenames do not match the ${version} release manifest.`);
}

for (const old of await readdir(release)) {
  if (old === 'staging') continue;
  await rm(join(release, old), { recursive: true, force: true });
}
const copied = [];
for (const artifact of artifacts) {
  const destination = join(release, basename(artifact));
  await copyFile(artifact, destination);
  copied.push(destination);
}
const sums = [];
for (const artifact of copied) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  sums.push(`${hash.digest('hex')}  ${basename(artifact)}`);
}
await writeFile(join(release, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
await copyFile(join(root, 'docs', `RELEASE_NOTES_${version}.md`), join(release, 'RELEASE_NOTES.md'));
await rm(staging, { recursive: true, force: true });
console.log(`Combined ${copied.length} packages, checksums, and release notes in ${release}`);

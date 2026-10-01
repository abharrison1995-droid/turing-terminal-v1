import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(root, 'src-tauri', 'target', 'release');

// tauri-build copies resources into target/release/resources, but it does not
// remove files that disappeared from the source tree. Clear both the copied
// tree and prior bundles so platform-specific native files cannot leak into a
// subsequent AppImage build.
await Promise.all([
  rm(join(releaseRoot, 'resources'), { recursive: true, force: true }),
  rm(join(releaseRoot, 'bundle'), { recursive: true, force: true }),
]);

import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const tauriRoot = join(root, 'src-tauri');
const resourceRoot = join(tauriRoot, 'resources');
const temporary = await mkdtemp(join(tmpdir(), 'turing-terminal-resources-'));
const app = join(temporary, 'app');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  await execFileAsync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], {
    cwd: root,
  });
  await execFileAsync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: root,
  });
  await rm(join(root, 'dist-server'), { recursive: true, force: true });
  await execFileAsync(
    process.execPath,
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.server.json'],
    { cwd: root },
  );
  await mkdir(app, { recursive: true });
  await cp(join(root, 'package.json'), join(app, 'package.json'));
  await cp(join(root, 'package-lock.json'), join(app, 'package-lock.json'));
  await cp(join(root, 'dist'), join(app, 'dist'), { recursive: true });
  await cp(join(root, 'dist-server'), join(app, 'dist-server'), { recursive: true });
  await cp(join(root, 'migrations'), join(app, 'migrations'), { recursive: true });
  await execFileAsync(npmCommand, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: app,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
  const sqlitePrebuilds = join(app, 'node_modules', 'better-sqlite3', 'prebuilds');
  const currentPrebuild = `${process.platform}-${process.arch}`;
  for (const filename of await readdir(sqlitePrebuilds)) {
    if (filename.endsWith('.node') && filename !== `${currentPrebuild}.node`) {
      await rm(join(sqlitePrebuilds, filename), { force: true });
    }
  }
  // These install-time command shims are not used by the Master; removing them
  // also avoids dangling links in platform resource packagers.
  await rm(join(app, 'node_modules', '.bin'), { recursive: true, force: true });
  const installManifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: installManifest.name,
        version: installManifest.version,
        type: installManifest.type,
        dependencies: installManifest.dependencies,
      },
      null,
      2,
    ) + '\n',
  );
  await rm(join(app, 'package-lock.json'), { force: true });

  await rm(join(resourceRoot, 'app'), { recursive: true, force: true });
  await rm(join(resourceRoot, 'runtime'), { recursive: true, force: true });
  await mkdir(join(resourceRoot, 'app'), { recursive: true });
  await mkdir(join(resourceRoot, 'runtime'), { recursive: true });
  await cp(app, join(resourceRoot, 'app'), { recursive: true });
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  await cp(await realpath(process.execPath), join(resourceRoot, 'runtime', runtimeName));
  const scan = await execFileAsync(process.execPath, [join(root, 'scripts', 'scan-package.mjs')], {
    cwd: root,
  });
  process.stdout.write(scan.stdout);
  console.log(
    `Prepared Turing Terminal ${packageJson.version} with bundled ${process.version} runtime and production dependencies.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

import { execFile as callbackExecFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);
const EXCLUDED = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'Library',
  'Temp',
]);
const INSTRUCTIONS = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'COPILOT.md',
  '.github/copilot-instructions.md',
  '.cursor/rules',
];

export interface ScannedProject {
  name: string;
  path: string;
  gitRoot: string | null;
  branch: string | null;
  dirty: boolean | null;
  packageManager: string | null;
  languages: string[];
  frameworks: string[];
  buildCommand: string[] | null;
  testCommand: string[] | null;
  lintCommand: string[] | null;
  readmePath: string | null;
  instructionFiles: string[];
}

export async function scanProject(inputPath: string): Promise<ScannedProject> {
  if (!inputPath.trim()) throw new Error('Choose a project folder.');
  const root = realpathSync(resolve(inputPath.trim()));
  if (!statSync(root).isDirectory()) throw new Error('The selected project path is not a folder.');
  const gitRoot = await gitValue(['rev-parse', '--show-toplevel'], root);
  const branch = gitRoot ? (await gitValue(['branch', '--show-current'], root)) || null : null;
  const status = gitRoot ? await gitValue(['status', '--porcelain'], root) : null;
  const files = collectFiles(root);
  const rootEntries = new Set(readdirSync(root));
  const packageJsonPath = join(root, 'package.json');
  let packageData: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
  } = {};
  if (existsSync(packageJsonPath)) {
    try {
      packageData = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof packageData;
    } catch {
      /* malformed metadata is left for manual correction */
    }
  }

  const languages = detectLanguages(files);
  const frameworks = detectFrameworks(
    packageData.dependencies ?? {},
    packageData.devDependencies ?? {},
    rootEntries,
  );
  const packageManager = detectPackageManager(packageData.packageManager, rootEntries);
  const npm = packageManager ?? 'npm';
  const hasScripts =
    packageManager && (packageManager !== 'npm' || rootEntries.has('package.json'))
      ? (packageData.scripts ?? {})
      : (packageData.scripts ?? {});
  const command = (script: string): string[] | null => (hasScripts[script] ? [npm, 'run', script] : null);
  const readme = ['README.md', 'README.MD', 'readme.md', 'README.rst', 'README.txt'].find((name) =>
    rootEntries.has(name),
  );
  const instructionFiles = INSTRUCTIONS.filter((name) => existsSync(join(root, name)));

  return {
    name: basename(root) || parse(root).root,
    path: root,
    gitRoot: gitRoot ? realpathSync(gitRoot) : null,
    branch,
    dirty: status === null ? null : status.trim().length > 0,
    packageManager,
    languages,
    frameworks,
    buildCommand: command('build'),
    testCommand: command('test'),
    lintCommand: command('lint'),
    readmePath: readme ? join(root, readme) : null,
    instructionFiles,
  };
}

async function gitValue(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 250_000,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 4 || files.length >= 1_000) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= 1_000) return;
      if (entry.isDirectory()) {
        if (!EXCLUDED.has(entry.name) && !entry.name.startsWith('.'))
          visit(join(directory, entry.name), depth + 1);
      } else if (entry.isFile()) files.push(join(directory, entry.name));
    }
  };
  visit(root, 0);
  return files;
}

function detectLanguages(files: string[]): string[] {
  const extensions: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.py': 'Python',
    '.rs': 'Rust',
    '.go': 'Go',
    '.cs': 'C#',
    '.cpp': 'C++',
    '.cc': 'C++',
    '.c': 'C',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.swift': 'Swift',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.lua': 'Lua',
    '.gd': 'GDScript',
    '.html': 'HTML',
    '.css': 'CSS',
    '.scss': 'SCSS',
  };
  const count = new Map<string, number>();
  for (const file of files) {
    const language = extensions[extname(file).toLowerCase()];
    if (language) count.set(language, (count.get(language) ?? 0) + 1);
  }
  return [...count]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language]) => language);
}

function detectFrameworks(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  entries: Set<string>,
): string[] {
  const all = new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)]);
  const found: string[] = [];
  const candidates: Array<[string, string]> = [
    ['next', 'Next.js'],
    ['vite', 'Vite'],
    ['react', 'React'],
    ['vue', 'Vue'],
    ['svelte', 'Svelte'],
    ['@angular/core', 'Angular'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['astro', 'Astro'],
    ['electron', 'Electron'],
  ];
  for (const [key, label] of candidates) if (all.has(key)) found.push(label);
  if (entries.has('Cargo.toml')) found.push('Rust');
  if (entries.has('pyproject.toml') || entries.has('requirements.txt')) found.push('Python');
  if (entries.has('Packages') && (entries.has('ProjectSettings') || entries.has('Assets')))
    found.push('Unity');
  return [...new Set(found)];
}

function detectPackageManager(packageManager: string | undefined, entries: Set<string>): string | null {
  if (packageManager) {
    const match = packageManager.match(/^(npm|pnpm|yarn|bun)@?/);
    if (match) return match[1];
  }
  if (entries.has('pnpm-lock.yaml')) return 'pnpm';
  if (entries.has('yarn.lock')) return 'yarn';
  if (entries.has('bun.lockb') || entries.has('bun.lock')) return 'bun';
  if (entries.has('package-lock.json') || entries.has('package.json')) return 'npm';
  return null;
}

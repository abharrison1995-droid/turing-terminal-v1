import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProject } from './projectScanner.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('project scanning', () => {
  it('detects project scripts, languages, frameworks, and instruction files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-project-'));
    folders.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: { build: 'vite build', test: 'vitest run' },
        dependencies: { react: '^19.0.0', vite: '^7.0.0' },
      }),
    );
    writeFileSync(join(root, 'AGENTS.md'), 'Use TypeScript.');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.tsx'), 'export const App = () => null;');
    writeFileSync(join(root, 'src', 'worker.py'), 'print("hello")');

    const project = await scanProject(root);
    expect(project.path).toBe(root);
    expect(project.gitRoot).toBeNull();
    expect(project.dirty).toBeNull();
    expect(project.packageManager).toBe('pnpm');
    expect(project.buildCommand).toEqual(['pnpm', 'run', 'build']);
    expect(project.testCommand).toEqual(['pnpm', 'run', 'test']);
    expect(project.languages).toContain('TypeScript');
    expect(project.languages).toContain('Python');
    expect(project.frameworks).toEqual(expect.arrayContaining(['React', 'Vite']));
    expect(project.instructionFiles).toContain('AGENTS.md');
  });

  it('rejects a file path where a project directory is expected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-project-'));
    folders.push(root);
    const file = join(root, 'file.txt');
    writeFileSync(file, 'text');
    await expect(scanProject(file)).rejects.toThrow('not a folder');
    expect(readFileSync(file, 'utf8')).toBe('text');
  });
});

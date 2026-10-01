import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGitDiff } from './git.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('Git diff collection', () => {
  it('includes new source files and excludes common local credential files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-git-'));
    folders.push(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'turing-test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Turing Test']);
    writeFileSync(join(root, 'tracked.ts'), 'const value = 1;\n');
    execFileSync('git', ['-C', root, 'add', 'tracked.ts']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    writeFileSync(join(root, 'tracked.ts'), 'const value = 2;\n');
    writeFileSync(join(root, 'new.ts'), 'export const added = true;\n');
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-testsecretvalue123456789\n');
    writeFileSync(join(root, 'service.pem'), 'private key material');

    const diff = await readGitDiff(root);
    expect(diff).toContain('const value = 2');
    expect(diff).toContain('new.ts');
    expect(diff).toContain('export const added');
    expect(diff).not.toContain('OPENAI_API_KEY');
    expect(diff).not.toContain('testsecretvalue');
    expect(diff).not.toContain('private key material');
  });
});

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyBrokerOperation, resolveProjectPath, summarizeBrokerAction } from './executionBroker.js';

const roots: string[] = [];

function project() {
  const root = mkdtempSync(join(tmpdir(), 'turing-broker-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('execution broker permission policy', () => {
  it('applies different policy to the same ordinary edit in all four modes', () => {
    const root = project();
    const request = {
      toolName: 'write_file',
      input: { path: 'src/index.ts', content: 'new' },
      cwd: root,
      projectRoot: root,
    };
    expect(classifyBrokerOperation('supervised', request).decision).toBe('approval');
    expect(classifyBrokerOperation('normal', request).decision).toBe('allow');
    expect(classifyBrokerOperation('yolo', request).decision).toBe('allow');
    expect(classifyBrokerOperation('enigma', request).decision).toBe('allow');
  });

  it('allows routine tests in Normal and autonomous modes, but asks in Supervised', () => {
    const root = project();
    const request = {
      toolName: 'run_command',
      input: { command: ['npm', 'run', 'test'] },
      cwd: root,
      projectRoot: root,
    };
    expect(classifyBrokerOperation('supervised', request).decision).toBe('approval');
    expect(classifyBrokerOperation('normal', request).decision).toBe('allow');
    expect(classifyBrokerOperation('yolo', request).decision).toBe('allow');
    expect(classifyBrokerOperation('enigma', request).decision).toBe('allow');
  });

  it('raises approval for deletes and commits in Normal, while YOLO and Enigma may proceed', () => {
    const root = project();
    const deletion = {
      toolName: 'delete_file',
      input: { path: 'src/index.ts' },
      cwd: root,
      projectRoot: root,
    };
    const commit = {
      toolName: 'run_command',
      input: { command: ['git', 'commit', '-m', 'change'] },
      cwd: root,
      projectRoot: root,
    };
    for (const mode of ['supervised', 'normal'] as const) {
      expect(classifyBrokerOperation(mode, deletion).decision).toBe('approval');
      expect(classifyBrokerOperation(mode, commit).decision).toBe('approval');
    }
    for (const mode of ['yolo', 'enigma'] as const) {
      expect(classifyBrokerOperation(mode, deletion).decision).toBe('allow');
      expect(classifyBrokerOperation(mode, commit).decision).toBe('allow');
    }
  });

  it('keeps push and merge approval-gated in every permission mode', () => {
    const root = project();
    const push = {
      toolName: 'run_command',
      input: { command: ['git', 'push', 'origin', 'main'] },
      cwd: root,
      projectRoot: root,
    };
    const merge = {
      toolName: 'run_command',
      input: { command: ['git', 'merge', 'main'] },
      cwd: root,
      projectRoot: root,
    };
    for (const mode of ['supervised', 'normal', 'yolo'] as const) {
      expect(classifyBrokerOperation(mode, push).decision).toBe('approval');
      expect(classifyBrokerOperation(mode, merge).decision).toBe('approval');
    }
    expect(classifyBrokerOperation('enigma', push).decision).toBe('approval');
    expect(classifyBrokerOperation('enigma', merge).decision).toBe('approval');
  });

  it('always requires approval for destructive Git commands', () => {
    const root = project();
    const request = {
      toolName: 'run_command',
      input: { command: ['git', 'reset', '--hard'] },
      cwd: root,
      projectRoot: root,
    };
    for (const mode of ['supervised', 'normal', 'yolo', 'enigma'] as const)
      expect(classifyBrokerOperation(mode, request).decision).toBe('approval');
  });

  it('blocks paths outside the project in every mode', () => {
    const root = project();
    for (const mode of ['supervised', 'normal', 'yolo', 'enigma'] as const) {
      expect(
        classifyBrokerOperation(mode, {
          toolName: 'read_file',
          input: { path: '../outside.txt' },
          cwd: root,
          projectRoot: root,
        }).decision,
      ).toBe('deny');
    }
  });

  it('blocks symlink escapes and suspected secret access in every mode', () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), 'turing-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'private.txt'), 'private');
    symlinkSync(outside, join(root, 'escape'), 'dir');
    expect(() => resolveProjectPath(root, root, 'escape/private.txt')).toThrow(
      /outside the selected project/,
    );
    for (const mode of ['supervised', 'normal', 'yolo', 'enigma'] as const) {
      expect(
        classifyBrokerOperation(mode, {
          toolName: 'read_file',
          input: { path: '.env.local' },
          cwd: root,
          projectRoot: root,
        }).decision,
      ).toBe('deny');
      expect(
        classifyBrokerOperation(mode, {
          toolName: 'write_file',
          input: { path: 'src/index.ts', content: 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345' },
          cwd: root,
          projectRoot: root,
        }).decision,
      ).toBe('deny');
    }
  });

  it('blocks shell commands that name credential files, including nested shell text', () => {
    const root = project();
    for (const command of [
      ['cat', '.env'],
      ['bash', '-lc', 'cat /tmp/project/.env.local'],
      ['git', 'add', 'server.pem'],
    ]) {
      for (const mode of ['supervised', 'normal', 'yolo', 'enigma'] as const) {
        expect(
          classifyBrokerOperation(mode, {
            toolName: 'execute_command',
            input: { command },
            cwd: root,
            projectRoot: root,
          }).decision,
        ).toBe('deny');
      }
    }
  });

  it('requires approval for package installation and remote Git access in every mode', () => {
    const root = project();
    for (const command of [
      ['npm', 'install', 'some-package'],
      ['pnpm', 'add', 'some-package'],
      ['git', 'fetch', 'origin'],
      ['git', 'clone', 'https://example.test/repo.git'],
    ]) {
      for (const mode of ['supervised', 'normal', 'yolo', 'enigma'] as const) {
        expect(
          classifyBrokerOperation(mode, {
            toolName: 'execute_command',
            input: { command },
            cwd: root,
            projectRoot: root,
          }).decision,
        ).toBe('approval');
      }
    }
  });

  it('keeps submitted file bodies out of the persisted broker action summary', () => {
    const privateKey = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
    const summary = summarizeBrokerAction({
      path: 'src/settings.ts',
      content: privateKey,
      metadata: { text: 'nested secret body' },
      command: ['npm', 'run', 'test'],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('secret-material');
    expect(serialized).not.toContain('nested secret body');
    expect(summary.path).toBe('src/settings.ts');
    expect(summary.command).toEqual(['npm', 'run', 'test']);
  });
});

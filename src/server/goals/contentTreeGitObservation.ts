import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { devNull } from 'node:os';
import { realpathSync } from 'node:fs';

import { CONTENT_TREE_MAX_CHANGED_PATHS } from './contentTreeComparison.js';
import type { ContentTreeEntry } from './contentTreeComparison.js';

export type ObjectFormat = 'sha1' | 'sha256';

export type ContentTreeGitObservationStatus =
  | 'observed'
  | 'too_many_changed_paths'
  | 'git_object_missing'
  | 'malformed_git_output'
  | 'git_command_failed'
  | 'git_command_timed_out'
  | 'git_output_limit_exceeded'
  | 'lfs_filter_refused'
  | 'filter_driver_refused'
  | 'unsupported_object_format'
  | 'invalid_input';

export interface ContentTreeGitObservationLimits {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
}

export interface ContentTreeGitCommandResult {
  ok: boolean;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  truncated?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface ContentTreeGitCommandRunner {
  run(
    args: readonly string[],
    options: {
      cwd: string;
      input?: Buffer;
      timeoutMs: number;
      maxStdoutBytes: number;
      maxStderrBytes: number;
      env: NodeJS.ProcessEnv;
    },
  ): Promise<ContentTreeGitCommandResult>;
}

export interface ContentTreeGitObservationInput {
  repoRoot: string;
  expectedBaseCommit: string;
  acceptedSourceCommit: string;
  destinationObservationCommit: string;
  objectFormat: ObjectFormat;
  runner?: ContentTreeGitCommandRunner;
  limits?: ContentTreeGitObservationLimits;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
}

export type ContentTreeGitObservation =
  | {
      ok: true;
      status: 'observed';
      changedPaths: Uint8Array[];
      sourceEntries: ContentTreeEntry[];
      destinationEntries: ContentTreeEntry[];
    }
  | {
      ok: false;
      status: Exclude<ContentTreeGitObservationStatus, 'observed'>;
      detail?: string;
    };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;

const OBJECT_ID: Record<ObjectFormat, RegExp> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_NO_LAZY_FETCH = '1';
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return env;
}

function spawnGit(
  args: readonly string[],
  options: {
    cwd: string;
    input?: Buffer;
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    env: NodeJS.ProcessEnv;
  },
): Promise<ContentTreeGitCommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const stdoutBuffer = () => Buffer.concat(stdoutChunks);
    const stderrBuffer = () => Buffer.concat(stderrChunks);

    const finish = (result: ContentTreeGitCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        stdout: stdoutBuffer(),
        stderr: stderrBuffer(),
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        truncated: false,
        stdoutTruncated,
        stderrTruncated,
      });
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutLength + chunk.length > options.maxStdoutBytes) {
        stdoutTruncated = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish({
          ok: false,
          stdout: stdoutBuffer(),
          stderr: stderrBuffer(),
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: false,
          truncated: true,
          stdoutTruncated: true,
          stderrTruncated,
        });
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stdout.on('error', (error: Error) => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        stdout: stdoutBuffer(),
        stderr: Buffer.concat([stderrBuffer(), Buffer.from(String(error))]),
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrLength + chunk.length > options.maxStderrBytes) {
        stderrTruncated = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish({
          ok: false,
          stdout: stdoutBuffer(),
          stderr: stderrBuffer(),
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: false,
          truncated: true,
          stdoutTruncated,
          stderrTruncated: true,
        });
        return;
      }
      stderrChunks.push(chunk);
      stderrLength += chunk.length;
    });
    child.stderr.on('error', (error: Error) => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        stdout: stdoutBuffer(),
        stderr: Buffer.concat([stderrBuffer(), Buffer.from(String(error))]),
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        stdout: stdoutBuffer(),
        stderr: Buffer.concat([stderrBuffer(), Buffer.from(String(error))]),
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      finish({
        ok: code === 0 && !timedOut && !stdoutTruncated && !stderrTruncated,
        stdout: stdoutBuffer(),
        stderr: stderrBuffer(),
        exitCode: code,
        signal: signal ?? null,
        timedOut: false,
        truncated: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.stdin.on('error', () => {
      // ignore broken pipe
    });

    try {
      if (options.input && options.input.length > 0) child.stdin.write(options.input);
      child.stdin.end();
    } catch {
      // ignore broken pipe
    }
  });
}

function createDefaultRunner(): ContentTreeGitCommandRunner {
  return { run: spawnGit };
}

function failResult(
  status: Exclude<ContentTreeGitObservationStatus, 'observed'>,
  detail?: string,
): ContentTreeGitObservation {
  return {
    ok: false,
    status,
    ...(detail ? { detail } : {}),
  };
}

function successResult(
  changedPaths: Uint8Array[],
  sourceEntries: ContentTreeEntry[],
  destinationEntries: ContentTreeEntry[],
): ContentTreeGitObservation {
  return {
    ok: true,
    status: 'observed',
    changedPaths,
    sourceEntries,
    destinationEntries,
  };
}

function splitNul(buffer: Buffer): Buffer[] | null {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) return null;
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

function normalizeBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'latin1');
  return Buffer.alloc(0);
}

function normalizeCommandResult(value: ContentTreeGitCommandResult): ContentTreeGitCommandResult {
  const stdout = normalizeBuffer(value.stdout);
  const stderr = normalizeBuffer(value.stderr);
  const timedOut = Boolean(value.timedOut);
  const stdoutTruncated = Boolean(value.stdoutTruncated);
  const stderrTruncated = Boolean(value.stderrTruncated);
  const truncated = Boolean(value.truncated || stdoutTruncated || stderrTruncated);
  const ok = value.ok === true && value.exitCode === 0 && !timedOut && !truncated;
  return {
    ok,
    stdout,
    stderr,
    exitCode: value.exitCode ?? null,
    signal: value.signal ?? null,
    timedOut,
    truncated,
    stdoutTruncated,
    stderrTruncated,
  };
}

function commandFailureCode(
  result: ContentTreeGitCommandResult,
): Exclude<ContentTreeGitObservationStatus, 'observed'> | null {
  if (result.timedOut) return 'git_command_timed_out';
  if (result.truncated) return 'git_output_limit_exceeded';
  if (result.ok) return null;
  return 'git_command_failed';
}

function oidRegex(format: ObjectFormat): RegExp {
  return OBJECT_ID[format];
}

const VALID_MODE_TYPE = new Set<string>([
  '100644 blob',
  '100755 blob',
  '120000 blob',
  '040000 tree',
  '40000 tree',
  '160000 commit',
]);

function parseChangedPaths(
  buffer: Buffer,
  cap: number,
): { paths: Uint8Array[]; malformed: boolean; tooMany: boolean } {
  if (buffer.length === 0) return { paths: [], malformed: false, tooMany: false };
  if (buffer[buffer.length - 1] !== 0) return { paths: [], malformed: true, tooMany: false };
  const seen = new Set<string>();
  const paths: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) continue;
    if (i === start) return { paths: [], malformed: true, tooMany: false };
    const token = buffer.subarray(start, i);
    const key = token.toString('latin1');
    if (seen.has(key)) return { paths: [], malformed: true, tooMany: false };
    seen.add(key);
    if (seen.size > cap) return { paths: [], malformed: false, tooMany: true };
    paths.push(new Uint8Array(token));
    start = i + 1;
  }
  if (start !== buffer.length) return { paths: [], malformed: true, tooMany: false };
  return { paths, malformed: false, tooMany: false };
}

function parseLsTree(
  buffer: Buffer,
  format: ObjectFormat,
): { entries: ContentTreeEntry[]; malformed: boolean } {
  const tokens = splitNul(buffer);
  if (tokens === null) return { entries: [], malformed: true };
  const seen = new Set<string>();
  const entries: ContentTreeEntry[] = [];
  const oidPattern = oidRegex(format);
  for (const token of tokens) {
    if (token.length === 0) return { entries: [], malformed: true };
    const tabIndex = token.indexOf(0x09);
    if (tabIndex <= 0 || tabIndex === token.length - 1) return { entries: [], malformed: true };
    const meta = token.subarray(0, tabIndex);
    const path = token.subarray(tabIndex + 1);
    if (path.length === 0) return { entries: [], malformed: true };
    for (let i = 0; i < meta.length; i += 1) {
      if (meta[i]! > 127) return { entries: [], malformed: true };
    }
    const metaText = meta.toString('ascii');
    const parts = metaText.split(' ');
    if (parts.length !== 3) return { entries: [], malformed: true };
    const [mode, type, oid] = parts;
    if (!VALID_MODE_TYPE.has(`${mode} ${type}`)) return { entries: [], malformed: true };
    if (mode === '160000' && type === 'commit') {
      if (!/^[0-9a-f]{40}$/.test(oid) && !/^[0-9a-f]{64}$/.test(oid)) return { entries: [], malformed: true };
    } else {
      if (!oidPattern.test(oid)) return { entries: [], malformed: true };
    }
    const key = path.toString('latin1');
    if (seen.has(key)) return { entries: [], malformed: true };
    seen.add(key);
    entries.push({ path: new Uint8Array(path), mode, oid });
  }
  return { entries, malformed: false };
}

function parseCheckAttr(
  buffer: Buffer,
  expectedPaths: readonly Uint8Array[],
): { lfs: boolean; otherFilter: boolean; malformed: boolean } {
  const tokens = splitNul(buffer);
  if (tokens === null) return { lfs: false, otherFilter: false, malformed: true };
  if (expectedPaths.length === 0) {
    if (tokens.length !== 0) return { lfs: false, otherFilter: false, malformed: true };
    return { lfs: false, otherFilter: false, malformed: false };
  }
  if (tokens.length !== expectedPaths.length * 3) return { lfs: false, otherFilter: false, malformed: true };
  let lfs = false;
  let otherFilter = false;
  for (let i = 0; i < expectedPaths.length; i += 1) {
    const pathToken = tokens[i * 3]!;
    const attrToken = tokens[i * 3 + 1]!;
    const valueToken = tokens[i * 3 + 2]!;
    if (pathToken.length === 0) return { lfs: false, otherFilter: false, malformed: true };
    if (!Buffer.from(pathToken).equals(Buffer.from(expectedPaths[i]!))) {
      return { lfs: false, otherFilter: false, malformed: true };
    }
    for (let j = 0; j < attrToken.length; j += 1) {
      if (attrToken[j]! > 127) return { lfs: false, otherFilter: false, malformed: true };
    }
    if (attrToken.toString('ascii') !== 'filter') return { lfs: false, otherFilter: false, malformed: true };
    for (let j = 0; j < valueToken.length; j += 1) {
      if (valueToken[j]! > 127) return { lfs: false, otherFilter: false, malformed: true };
    }
    const value = valueToken.toString('ascii');
    if (value === 'lfs') lfs = true;
    else if (value !== 'unspecified' && value !== 'unset') otherFilter = true;
  }
  return { lfs, otherFilter, malformed: false };
}

function bufferFromPaths(paths: readonly Uint8Array[]): Buffer {
  const chunks: Buffer[] = [];
  for (const path of paths) {
    chunks.push(Buffer.from(path));
    chunks.push(Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

function canonicalPath(value: string): string | null {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

export async function observeContentTree(
  input: ContentTreeGitObservationInput,
): Promise<ContentTreeGitObservation> {
  const limits = input.limits ?? {};
  const timeoutMs = limits.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes =
    limits.maxStdoutBytes ??
    input.maxStdoutBytes ??
    limits.maxOutputBytes ??
    input.maxOutputBytes ??
    DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = limits.maxStderrBytes ?? input.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

  const repoRoot = input.repoRoot;
  const expectedBaseCommit = input.expectedBaseCommit;
  const acceptedSourceCommit = input.acceptedSourceCommit;
  const destinationObservationCommit = input.destinationObservationCommit;
  const objectFormat = input.objectFormat;

  if (!repoRoot || typeof repoRoot !== 'string') return failResult('invalid_input');
  if (!OBJECT_ID[objectFormat]) return failResult('unsupported_object_format');
  if (!OBJECT_ID[objectFormat].test(expectedBaseCommit)) return failResult('git_object_missing');
  if (!OBJECT_ID[objectFormat].test(acceptedSourceCommit)) return failResult('git_object_missing');
  if (!OBJECT_ID[objectFormat].test(destinationObservationCommit)) return failResult('git_object_missing');

  const runner = input.runner ?? createDefaultRunner();
  const env = cleanEnvironment();

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const run = async (gitArgs: readonly string[], stdin?: Buffer) => {
    if (Date.now() >= deadline) {
      return normalizeCommandResult({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: null,
        signal: null,
        timedOut: true,
        truncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }
    const remainingMs = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
    let raw: unknown;
    try {
      raw = await runner.run(gitArgs, {
        cwd: repoRoot,
        input: stdin,
        timeoutMs: remainingMs,
        maxStdoutBytes,
        maxStderrBytes,
        env,
      });
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') {
      return normalizeCommandResult({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }
    return normalizeCommandResult(raw as ContentTreeGitCommandResult);
  };

  // Canonical repository top-level check.
  const toplevelResult = await run(['rev-parse', '--show-toplevel']);
  if (toplevelResult.timedOut) return failResult('git_command_timed_out');
  if (toplevelResult.truncated) return failResult('git_output_limit_exceeded');
  if (!toplevelResult.ok) return failResult('git_command_failed');
  const toplevel = toplevelResult.stdout.toString('utf8').trim();
  const repoCanonical = canonicalPath(repoRoot);
  const topCanonical = canonicalPath(toplevel);
  if (!repoCanonical || !topCanonical || repoCanonical !== topCanonical) return failResult('invalid_input');

  // Cross-check object format.
  const formatResult = await run(['rev-parse', '--show-object-format']);
  if (formatResult.timedOut) return failResult('git_command_timed_out');
  if (formatResult.truncated) return failResult('git_output_limit_exceeded');
  if (!formatResult.ok) return failResult('git_command_failed');
  if (formatResult.stdout.toString('utf8').trim() !== objectFormat)
    return failResult('unsupported_object_format');

  for (const commit of [expectedBaseCommit, acceptedSourceCommit, destinationObservationCommit]) {
    const typeResult = await run(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      Buffer.from(`${commit}\n`),
    );
    if (typeResult.timedOut) return failResult('git_command_timed_out');
    if (typeResult.truncated) return failResult('git_output_limit_exceeded');
    if (!typeResult.ok) return failResult('git_command_failed');
    if (typeResult.stdout.length === 0 || typeResult.stdout[typeResult.stdout.length - 1] !== 0x0a) {
      return failResult('malformed_git_output');
    }
    for (let i = 0; i < typeResult.stdout.length; i += 1) {
      if (typeResult.stdout[i]! > 127) return failResult('malformed_git_output');
    }
    const lines = typeResult.stdout.toString('ascii').split('\n');
    if (lines.length !== 2 || lines[1] !== '') return failResult('malformed_git_output');
    const fields = lines[0].split(' ');
    if (fields.length !== 2 || fields[0] !== commit) return failResult('malformed_git_output');
    if (fields[1] === 'missing') return failResult('git_object_missing');
    if (fields[1] !== 'commit') return failResult('malformed_git_output');
  }

  const diffResult = await run([
    'diff-tree',
    '--no-commit-id',
    '-r',
    '-z',
    '--no-renames',
    '--name-only',
    '--no-ext-diff',
    '--no-textconv',
    expectedBaseCommit,
    acceptedSourceCommit,
  ]);
  const diffFailure = commandFailureCode(diffResult);
  if (diffFailure) return failResult(diffFailure);
  const parsedChanged = parseChangedPaths(diffResult.stdout, CONTENT_TREE_MAX_CHANGED_PATHS);
  if (parsedChanged.malformed) return failResult('malformed_git_output');
  if (parsedChanged.tooMany) return failResult('too_many_changed_paths');
  const changedPaths = parsedChanged.paths;

  const sourceResult = await run(['ls-tree', '-r', '-z', '--full-tree', acceptedSourceCommit]);
  const sourceFailure = commandFailureCode(sourceResult);
  if (sourceFailure) return failResult(sourceFailure);
  const parsedSource = parseLsTree(sourceResult.stdout, objectFormat);
  if (parsedSource.malformed) return failResult('malformed_git_output');

  const destinationResult = await run(['ls-tree', '-r', '-z', '--full-tree', destinationObservationCommit]);
  const destinationFailure = commandFailureCode(destinationResult);
  if (destinationFailure) return failResult(destinationFailure);
  const parsedDestination = parseLsTree(destinationResult.stdout, objectFormat);
  if (parsedDestination.malformed) return failResult('malformed_git_output');

  const inputBuffer = bufferFromPaths(changedPaths);
  for (const commit of [expectedBaseCommit, acceptedSourceCommit, destinationObservationCommit]) {
    const attrResult = await run(
      ['check-attr', `--source=${commit}`, '-z', '--stdin', 'filter'],
      inputBuffer,
    );
    const attrFailure = commandFailureCode(attrResult);
    if (attrFailure) return failResult(attrFailure);
    const attrParsed = parseCheckAttr(attrResult.stdout, changedPaths);
    if (attrParsed.malformed) return failResult('malformed_git_output');
    if (attrParsed.lfs) return failResult('lfs_filter_refused');
    if (attrParsed.otherFilter) return failResult('filter_driver_refused');
  }

  return successResult(changedPaths, parsedSource.entries, parsedDestination.entries);
}

export const observeContentTrees = observeContentTree;
export default observeContentTree;
export const observeContentTreeGit = observeContentTree;
export const gitObserveContentTree = observeContentTree;
export const observeGitContentTree = observeContentTree;

export { CONTENT_TREE_MAX_CHANGED_PATHS };
export { compareContentTrees } from './contentTreeComparison.js';
export type { ContentTreeEntry, ContentTreeComparisonResult } from './contentTreeComparison.js';

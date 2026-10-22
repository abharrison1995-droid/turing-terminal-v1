import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { devNull } from 'node:os';
import { realpathSync } from 'node:fs';

import { CONTENT_TREE_MAX_CHANGED_PATHS } from './contentTreeComparison.js';
import type { ContentTreeEntry } from './contentTreeComparison.js';

export type ObjectFormat = 'sha1' | 'sha256';

export const CONTENT_TREE_MAX_HISTORY_COMMITS = 100_000;
export const CONTENT_TREE_LFS_POINTER_MAX_BYTES = 4_096;

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
  | 'invalid_input'
  | 'base_not_ancestor'
  | 'source_not_ancestor'
  | 'comparison_commit_missing'
  | 'comparison_commit_ambiguous'
  | 'comparison_history_unbounded'
  | 'shallow_probe_failed';

export interface ContentTreeGitObservationLimits {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
  maxChangedPaths?: number;
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
  destinationTipCommit: string;
  objectFormat: ObjectFormat;
  runner?: ContentTreeGitCommandRunner;
  limits?: ContentTreeGitObservationLimits;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
  maxChangedPaths?: number;
}

export type ContentTreeGitObservation =
  | {
      ok: true;
      status: 'observed';
      comparisonCommit: string;
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

const BATCH_CHECK_COMMIT_ARGS = ['cat-file', '--batch-check=%(objectname) %(objecttype)'] as const;
const BATCH_CHECK_SIZE_ARGS = [
  'cat-file',
  '--batch-check=%(objectname) %(objecttype) %(objectsize)',
] as const;

const LFS_POINTER_HEADER = Buffer.from('version https://git-lfs.github.com/spec/v1', 'ascii');

const MISSING_OBJECT_PATTERN =
  /(bad object|missing object|not a valid object|not a valid commit|not a valid tree|no such object|unable to read|bad tree object|could not read|invalid object|object not found|bad revision|unknown revision|shallow)/;

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
  comparisonCommit: string,
  changedPaths: Uint8Array[],
  sourceEntries: ContentTreeEntry[],
  destinationEntries: ContentTreeEntry[],
): ContentTreeGitObservation {
  return {
    ok: true,
    status: 'observed',
    comparisonCommit,
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

function hasHighBytes(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i]! > 127) return true;
  }
  return false;
}

function commandFailureCode(
  result: ContentTreeGitCommandResult,
): Exclude<ContentTreeGitObservationStatus, 'observed'> | null {
  if (result.timedOut) return 'git_command_timed_out';
  if (result.truncated) return 'git_output_limit_exceeded';
  if (result.ok) return null;
  const stderr = result.stderr.toString('latin1').toLowerCase();
  if (MISSING_OBJECT_PATTERN.test(stderr)) return 'git_object_missing';
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
    if (hasHighBytes(meta)) return { entries: [], malformed: true };
    const metaText = meta.toString('ascii');
    const parts = metaText.split(' ');
    if (parts.length !== 3) return { entries: [], malformed: true };
    const [mode, type, oid] = parts;
    if (!VALID_MODE_TYPE.has(`${mode} ${type}`)) return { entries: [], malformed: true };
    if (mode === '160000' && type === 'commit') {
      if (!/^[0-9a-f]{40}$/.test(oid) && !/^[0-9a-f]{64}$/.test(oid)) return { entries: [], malformed: true };
    } else if (!oidPattern.test(oid)) {
      return { entries: [], malformed: true };
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
    if (hasHighBytes(attrToken) || hasHighBytes(valueToken))
      return { lfs: false, otherFilter: false, malformed: true };
    if (attrToken.toString('ascii') !== 'filter') return { lfs: false, otherFilter: false, malformed: true };
    const value = valueToken.toString('ascii');
    if (value === 'lfs') lfs = true;
    else if (value !== 'unspecified' && value !== 'unset') otherFilter = true;
  }
  return { lfs, otherFilter, malformed: false };
}

interface HistoryCommit {
  oid: string;
  parents: string[];
}

function parseHistory(buffer: Buffer, format: ObjectFormat): HistoryCommit[] | null {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0x0a) return null;
  if (hasHighBytes(buffer)) return null;
  const lines = buffer.toString('ascii').split('\n');
  lines.pop();
  const pattern = oidRegex(format);
  const seen = new Set<string>();
  const commits: HistoryCommit[] = [];
  for (const line of lines) {
    if (line.length === 0) return null;
    const fields = line.split(' ');
    if (fields.length === 0) return null;
    const oid = fields[0]!;
    if (!pattern.test(oid) || seen.has(oid)) return null;
    seen.add(oid);
    const parents = fields.slice(1);
    for (const parent of parents) {
      if (!pattern.test(parent)) return null;
    }
    commits.push({ oid, parents });
  }
  return commits;
}

function parseBatchCheckCommit(
  buffer: Buffer,
  expectedOid: string,
  format: ObjectFormat,
): { status: 'ok' } | { status: 'missing' } | { status: 'malformed' } {
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) return { status: 'malformed' };
  if (hasHighBytes(buffer)) return { status: 'malformed' };
  const lines = buffer.toString('ascii').split('\n');
  if (lines.length !== 2 || lines[1] !== '') return { status: 'malformed' };
  const fields = lines[0]!.split(' ');
  if (fields.length < 2 || fields.length > 3 || fields[0] !== expectedOid) return { status: 'malformed' };
  if (fields[1] === 'missing') {
    return fields.length === 2 ? { status: 'missing' } : { status: 'malformed' };
  }
  if (fields.length !== 2 || fields[1] !== 'commit') return { status: 'malformed' };
  if (!oidRegex(format).test(fields[0]!)) return { status: 'malformed' };
  return { status: 'ok' };
}

function parseBatchCheckSizes(
  buffer: Buffer,
  expectedOids: readonly string[],
): { sizes: Map<string, number> } | { status: 'missing' } | { status: 'malformed' } {
  if (expectedOids.length === 0) {
    return buffer.length === 0 ? { sizes: new Map() } : { status: 'malformed' };
  }
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) return { status: 'malformed' };
  if (hasHighBytes(buffer)) return { status: 'malformed' };
  const lines = buffer.toString('ascii').split('\n');
  lines.pop();
  if (lines.length !== expectedOids.length) return { status: 'malformed' };
  const sizes = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fields = line.split(' ');
    const expected = expectedOids[i]!;
    if (fields.length === 2 && fields[1] === 'missing' && fields[0] === expected)
      return { status: 'missing' };
    if (fields.length !== 3 || fields[0] !== expected || fields[1] !== 'blob') return { status: 'malformed' };
    if (!/^(0|[1-9][0-9]*)$/.test(fields[2]!)) return { status: 'malformed' };
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size)) return { status: 'malformed' };
    sizes.set(expected, size);
  }
  return { sizes };
}

function parseCatFileBatch(
  buffer: Buffer,
  expectedOids: readonly string[],
): { contents: Map<string, Buffer> } | { status: 'missing' } | { status: 'malformed' } {
  const contents = new Map<string, Buffer>();
  let offset = 0;
  for (const expected of expectedOids) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) return { status: 'malformed' };
    const header = buffer.subarray(offset, newline);
    if (hasHighBytes(header)) return { status: 'malformed' };
    const fields = header.toString('ascii').split(' ');
    if (fields.length === 2 && fields[0] === expected && fields[1] === 'missing')
      return { status: 'missing' };
    if (fields.length !== 3 || fields[0] !== expected || fields[1] !== 'blob') return { status: 'malformed' };
    if (!/^(0|[1-9][0-9]*)$/.test(fields[2]!)) return { status: 'malformed' };
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size)) return { status: 'malformed' };
    const start = newline + 1;
    const end = start + size;
    if (end >= buffer.length) return { status: 'malformed' };
    const content = buffer.subarray(start, end);
    if (buffer[end] !== 0x0a) return { status: 'malformed' };
    contents.set(expected, content);
    offset = end + 1;
  }
  if (offset !== buffer.length) return { status: 'malformed' };
  return { contents };
}

function isLfsPointer(content: Buffer): boolean {
  if (content.length < LFS_POINTER_HEADER.length) return false;
  if (!content.subarray(0, LFS_POINTER_HEADER.length).equals(LFS_POINTER_HEADER)) return false;
  if (content.length === LFS_POINTER_HEADER.length) return true;
  const next = content[LFS_POINTER_HEADER.length];
  if (next === 0x0a) return true;
  return next === 0x0d && content[LFS_POINTER_HEADER.length + 1] === 0x0a;
}

function sourceBlobOids(
  changedPaths: readonly Uint8Array[],
  sourceEntries: readonly ContentTreeEntry[],
): string[] {
  const byPath = new Map<string, ContentTreeEntry>();
  for (const entry of sourceEntries) byPath.set(Buffer.from(entry.path).toString('latin1'), entry);
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const path of changedPaths) {
    const entry = byPath.get(Buffer.from(path).toString('latin1'));
    if (!entry) continue;
    if (entry.mode !== '100644' && entry.mode !== '100755') continue;
    if (seen.has(entry.oid)) continue;
    seen.add(entry.oid);
    oids.push(entry.oid);
  }
  return oids;
}

function bufferFromPaths(paths: readonly Uint8Array[]): Buffer {
  const chunks: Buffer[] = [];
  for (const path of paths) {
    chunks.push(Buffer.from(path));
    chunks.push(Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

function bufferFromOids(oids: readonly string[]): Buffer {
  if (oids.length === 0) return Buffer.alloc(0);
  return Buffer.from(`${oids.join('\n')}\n`, 'ascii');
}

function canonicalPath(value: string): string | null {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

function tightenLimit(value: number | undefined, hardDefault: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return hardDefault;
  return Math.min(Math.floor(value), hardDefault);
}

export async function observeContentTree(
  input: ContentTreeGitObservationInput,
): Promise<ContentTreeGitObservation> {
  const limits = input.limits ?? {};
  const timeoutMs = tightenLimit(limits.timeoutMs ?? input.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxStdoutBytes = tightenLimit(
    limits.maxStdoutBytes ?? input.maxStdoutBytes ?? limits.maxOutputBytes ?? input.maxOutputBytes,
    DEFAULT_MAX_STDOUT_BYTES,
  );
  const maxStderrBytes = tightenLimit(
    limits.maxStderrBytes ?? input.maxStderrBytes,
    DEFAULT_MAX_STDERR_BYTES,
  );
  const maxChangedPaths = tightenLimit(
    limits.maxChangedPaths ?? input.maxChangedPaths,
    CONTENT_TREE_MAX_CHANGED_PATHS,
  );

  const repoRoot = input.repoRoot;
  const expectedBaseCommit = input.expectedBaseCommit;
  const acceptedSourceCommit = input.acceptedSourceCommit;
  const destinationTipCommit = input.destinationTipCommit;
  const objectFormat = input.objectFormat;

  if (!repoRoot || typeof repoRoot !== 'string') return failResult('invalid_input');
  if (!OBJECT_ID[objectFormat]) return failResult('unsupported_object_format');
  const oidPattern = OBJECT_ID[objectFormat];
  for (const commit of [expectedBaseCommit, acceptedSourceCommit, destinationTipCommit]) {
    if (typeof commit !== 'string' || !oidPattern.test(commit)) return failResult('invalid_input');
  }

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
  if (hasHighBytes(formatResult.stdout)) return failResult('malformed_git_output');
  if (formatResult.stdout.toString('ascii').trim() !== objectFormat)
    return failResult('unsupported_object_format');

  // A failed shallow probe fails closed; a shallow repository with all required history is not rejected.
  const shallowResult = await run(['rev-parse', '--is-shallow-repository']);
  if (shallowResult.timedOut) return failResult('git_command_timed_out');
  if (shallowResult.truncated) return failResult('git_output_limit_exceeded');
  if (!shallowResult.ok) return failResult('shallow_probe_failed');
  if (hasHighBytes(shallowResult.stdout)) return failResult('malformed_git_output');
  const shallowText = shallowResult.stdout.toString('ascii').trim();
  if (shallowText !== 'true' && shallowText !== 'false') return failResult('malformed_git_output');
  const shallow = shallowText === 'true';

  for (const commit of [expectedBaseCommit, acceptedSourceCommit, destinationTipCommit]) {
    const typeResult = await run(BATCH_CHECK_COMMIT_ARGS, Buffer.from(`${commit}\n`));
    if (typeResult.timedOut) return failResult('git_command_timed_out');
    if (typeResult.truncated) return failResult('git_output_limit_exceeded');
    if (!typeResult.ok) {
      const failure = commandFailureCode(typeResult);
      return failResult(failure ?? 'git_command_failed');
    }
    const parsed = parseBatchCheckCommit(typeResult.stdout, commit, objectFormat);
    if (parsed.status === 'missing') return failResult('git_object_missing');
    if (parsed.status === 'malformed') return failResult('malformed_git_output');
  }

  const checkAncestor = async (
    ancestor: string,
    refusal: 'base_not_ancestor' | 'source_not_ancestor',
  ): Promise<ContentTreeGitObservation | null> => {
    const result = await run(['merge-base', '--is-ancestor', ancestor, destinationTipCommit]);
    if (result.timedOut) return failResult('git_command_timed_out');
    if (result.truncated) return failResult('git_output_limit_exceeded');
    if (result.ok) return null;
    if (result.exitCode === 1) {
      const stderr = result.stderr.toString('latin1').toLowerCase();
      if (MISSING_OBJECT_PATTERN.test(stderr) || shallow) return failResult('git_object_missing');
      return failResult(refusal);
    }
    const failure = commandFailureCode(result);
    return failResult(failure ?? 'git_command_failed');
  };

  const baseAncestorResult = await checkAncestor(expectedBaseCommit, 'base_not_ancestor');
  if (baseAncestorResult) return baseAncestorResult;
  const sourceAncestorResult = await checkAncestor(acceptedSourceCommit, 'source_not_ancestor');
  if (sourceAncestorResult) return sourceAncestorResult;

  const firstParentResult = await run([
    'rev-list',
    '--first-parent',
    `--max-count=${CONTENT_TREE_MAX_HISTORY_COMMITS + 1}`,
    '--end-of-options',
    destinationTipCommit,
  ]);
  const firstParentFailure = commandFailureCode(firstParentResult);
  if (firstParentFailure) return failResult(firstParentFailure);
  const firstParentHistory = parseHistory(firstParentResult.stdout, objectFormat);
  if (!firstParentHistory) return failResult('malformed_git_output');
  const sourceOnFirstParent = firstParentHistory.some((commit) => commit.oid === acceptedSourceCommit);
  if (!sourceOnFirstParent && firstParentHistory.length > CONTENT_TREE_MAX_HISTORY_COMMITS)
    return failResult('comparison_history_unbounded');

  let comparisonCommit: string;
  if (sourceOnFirstParent) {
    comparisonCommit = acceptedSourceCommit;
  } else {
    const historyResult = await run([
      'rev-list',
      '--ancestry-path',
      '--parents',
      '--topo-order',
      `--max-count=${CONTENT_TREE_MAX_HISTORY_COMMITS + 1}`,
      '--end-of-options',
      `${acceptedSourceCommit}..${destinationTipCommit}`,
    ]);
    const historyFailure = commandFailureCode(historyResult);
    if (historyFailure) return failResult(historyFailure);
    const history = parseHistory(historyResult.stdout, objectFormat);
    if (!history) return failResult('malformed_git_output');
    if (history.length > CONTENT_TREE_MAX_HISTORY_COMMITS) return failResult('comparison_history_unbounded');
    if (history.length === 0) return failResult('comparison_commit_missing');

    history.reverse();
    const commitsWithMergeAncestor = new Set<string>();
    const firstMerges: string[] = [];
    for (const commit of history) {
      const hasMergeAncestor = commit.parents.some((parent) => commitsWithMergeAncestor.has(parent));
      if (hasMergeAncestor) {
        commitsWithMergeAncestor.add(commit.oid);
        continue;
      }
      if (commit.parents.length >= 2) {
        firstMerges.push(commit.oid);
        commitsWithMergeAncestor.add(commit.oid);
      }
    }
    if (firstMerges.length === 0) return failResult('comparison_commit_missing');
    if (firstMerges.length > 1) return failResult('comparison_commit_ambiguous');
    comparisonCommit = firstMerges[0]!;
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
    '--end-of-options',
    expectedBaseCommit,
    acceptedSourceCommit,
  ]);
  const diffFailure = commandFailureCode(diffResult);
  if (diffFailure) return failResult(diffFailure);
  const parsedChanged = parseChangedPaths(diffResult.stdout, maxChangedPaths);
  if (parsedChanged.malformed) return failResult('malformed_git_output');
  if (parsedChanged.tooMany) return failResult('too_many_changed_paths');
  const changedPaths = parsedChanged.paths;

  const sourceResult = await run(['ls-tree', '-r', '-z', '--full-tree', acceptedSourceCommit]);
  const sourceFailure = commandFailureCode(sourceResult);
  if (sourceFailure) return failResult(sourceFailure);
  const parsedSource = parseLsTree(sourceResult.stdout, objectFormat);
  if (parsedSource.malformed) return failResult('malformed_git_output');

  const destinationResult = await run(['ls-tree', '-r', '-z', '--full-tree', comparisonCommit]);
  const destinationFailure = commandFailureCode(destinationResult);
  if (destinationFailure) return failResult(destinationFailure);
  const parsedDestination = parseLsTree(destinationResult.stdout, objectFormat);
  if (parsedDestination.malformed) return failResult('malformed_git_output');

  const inputBuffer = bufferFromPaths(changedPaths);
  const attrCommits = [...new Set([expectedBaseCommit, acceptedSourceCommit, comparisonCommit])];
  for (const commit of attrCommits) {
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

  const blobOids = sourceBlobOids(changedPaths, parsedSource.entries);
  if (blobOids.length > 0) {
    const sizeResult = await run(BATCH_CHECK_SIZE_ARGS, bufferFromOids(blobOids));
    const sizeFailure = commandFailureCode(sizeResult);
    if (sizeFailure) return failResult(sizeFailure);
    const parsedSizes = parseBatchCheckSizes(sizeResult.stdout, blobOids);
    if ('status' in parsedSizes) {
      return failResult(parsedSizes.status === 'missing' ? 'git_object_missing' : 'malformed_git_output');
    }
    const smallOids = blobOids.filter(
      (oid) => (parsedSizes.sizes.get(oid) ?? 0) <= CONTENT_TREE_LFS_POINTER_MAX_BYTES,
    );
    if (smallOids.length > 0) {
      const contentResult = await run(['cat-file', '--batch'], bufferFromOids(smallOids));
      const contentFailure = commandFailureCode(contentResult);
      if (contentFailure) return failResult(contentFailure);
      const parsedContents = parseCatFileBatch(contentResult.stdout, smallOids);
      if ('status' in parsedContents) {
        return failResult(
          parsedContents.status === 'missing' ? 'git_object_missing' : 'malformed_git_output',
        );
      }
      for (const oid of smallOids) {
        if (isLfsPointer(parsedContents.contents.get(oid)!)) return failResult('lfs_filter_refused');
      }
    }
  }

  return successResult(comparisonCommit, changedPaths, parsedSource.entries, parsedDestination.entries);
}

export const observeContentTrees = observeContentTree;
export default observeContentTree;
export const observeContentTreeGit = observeContentTree;
export const gitObserveContentTree = observeContentTree;
export const observeGitContentTree = observeContentTree;

export { CONTENT_TREE_MAX_CHANGED_PATHS };
export { compareContentTrees } from './contentTreeComparison.js';
export type { ContentTreeEntry, ContentTreeComparisonResult } from './contentTreeComparison.js';

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PermissionMode } from '../shared/types.js';

export type BrokerOperationType =
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'shell'
  | 'git_commit'
  | 'git_push'
  | 'git_merge'
  | 'git_destructive'
  | 'network'
  | 'unknown';

export type BrokerDecision = 'allow' | 'approval' | 'deny';

export interface BrokerOperationInput {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  projectRoot: string;
  role?: string;
}

export interface BrokerPolicyResult {
  operationType: BrokerOperationType;
  decision: BrokerDecision;
  classification: 'routine' | 'consequential' | 'destructive' | 'sensitive' | 'out_of_scope' | 'unknown';
  reason: string;
  displayAction: string;
  paths: string[];
  command: string[] | null;
}

const SECRET_PATH_PART =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const SECRET_VALUE =
  /(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|credentials?|password|private[_-]?key)\s*[:=]\s*['"]?[^\s'",;}]{12,})/i;
const DESTRUCTIVE_SHELL =
  /(?:\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b|\b(?:del|erase)\s+\/s\b|\bRemove-Item\b[^\n]*\s-Recurse\b|\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|branch\s+-D|push\s+[^\n]*--force|push\s+-f|checkout\s+--\s+\.))/i;
const NETWORK_SHELL =
  /(?:\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|nc|ncat|ssh|scp|ftp)\b|https?:\/\/|\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|upgrade|update|publish|exec|dlx|x)\b|\bgit\s+(?:clone|fetch|pull|remote\s+add)\b)/i;
const SENSITIVE_COMMAND_PATH =
  /(?:^|[\\/\s"'=])(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\.[\w.-]+)?|secrets?(?:\.[\w.-]+)?|id_(?:rsa|ed25519)|[^\s\\/"']+\.(?:pem|key|p12|pfx))(?=$|[\\/\s"'=])/i;

export function isSensitivePath(path: string): boolean {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => SECRET_PATH_PART.test(part));
}

export function hasSuspectedSecret(value: string): boolean {
  return SECRET_VALUE.test(value);
}

export function summarizeBrokerAction(input: Record<string, unknown>): Record<string, unknown> {
  const summarize = (value: unknown, key = '', depth = 0): unknown => {
    if (typeof value === 'string' && /(?:content|patch|diff|text|prompt|body|data)$/i.test(key))
      return `[omitted ${value.length} characters]`;
    if (Array.isArray(value)) return value.map((item) => summarize(item, key, depth + 1));
    if (value && typeof value === 'object') {
      if (depth >= 5) return '[nested input omitted]';
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          summarize(childValue, childKey, depth + 1),
        ]),
      );
    }
    return value;
  };
  return summarize(input) as Record<string, unknown>;
}

export function resolveProjectPath(projectRoot: string, cwd: string, candidate: string): string {
  const root = canonicalExisting(projectRoot);
  const base = canonicalExisting(cwd);
  if (!isWithin(root, base)) throw new Error('Provider working directory is outside the selected project.');
  const target = resolve(base, candidate);
  if (!isWithin(root, target)) throw new Error('Requested path is outside the selected project.');
  const canonicalTarget = canonicalPotential(target);
  if (!isWithin(root, canonicalTarget))
    throw new Error('Requested path resolves outside the selected project.');
  return canonicalTarget;
}

export function classifyBrokerOperation(
  mode: PermissionMode,
  request: BrokerOperationInput,
): BrokerPolicyResult {
  const inputText = safeStringify(request.input);
  const tool = request.toolName.toLowerCase();
  const command = readCommand(request.input);
  const paths = readPaths(request.input);
  for (const part of command ?? []) {
    if (looksLikePath(part) && !paths.includes(part)) paths.push(part);
  }
  const displayAction = displayToolAction(request.toolName, request.input);
  const base = {
    displayAction,
    paths,
    command,
  };

  if (
    SECRET_VALUE.test(inputText) ||
    paths.some(isSensitivePath) ||
    command?.some((part) => isSensitivePath(part)) ||
    (command !== null && SENSITIVE_COMMAND_PATH.test(command.join(' ')))
  ) {
    return {
      ...base,
      operationType: 'unknown',
      decision: 'deny',
      classification: 'sensitive',
      reason: 'Secret material and credential files are denied in every permission mode.',
    };
  }

  for (const path of paths) {
    try {
      const resolved = resolveProjectPath(request.projectRoot, request.cwd, path);
      const relativePath = relative(canonicalExisting(request.projectRoot), resolved);
      if (isSensitivePath(relativePath)) {
        return {
          ...base,
          operationType: 'unknown',
          decision: 'deny',
          classification: 'sensitive',
          reason: 'Secret material and credential files are denied in every permission mode.',
        };
      }
    } catch {
      return {
        ...base,
        operationType: 'unknown',
        decision: 'deny',
        classification: 'out_of_scope',
        reason: 'The operation targets a path outside the selected project or through an escaping symlink.',
      };
    }
  }

  const normalizedCommand = command?.join(' ') ?? '';
  if (
    request.role &&
    ['planner', 'prompt-refinement', 'reviewer', 'parallelReview', 'consolidator', 'final-gate'].includes(
      request.role,
    ) &&
    (!isReadTool(tool) || command !== null)
  ) {
    return {
      ...base,
      operationType: 'unknown',
      decision: 'deny',
      classification: 'out_of_scope',
      reason: 'This workflow role is read-only and cannot execute project changes or commands.',
    };
  }
  if (DESTRUCTIVE_SHELL.test(normalizedCommand)) {
    return permissionResult(
      mode,
      'git_destructive',
      'destructive',
      base,
      'Destructive shell or Git actions always require a separate approval.',
    );
  }
  if (/\bgit\s+push\b/i.test(normalizedCommand))
    return permissionResult(
      mode,
      'git_push',
      'consequential',
      base,
      'Pushing changes can affect a remote repository.',
    );
  if (/\bgit\s+merge\b/i.test(normalizedCommand))
    return permissionResult(
      mode,
      'git_merge',
      'consequential',
      base,
      'Merging changes changes branch history.',
    );
  if (/\bgit\s+commit\b/i.test(normalizedCommand))
    return permissionResult(
      mode,
      'git_commit',
      'consequential',
      base,
      'Creating a commit records project changes in Git.',
    );
  if (NETWORK_SHELL.test(normalizedCommand) || /(?:web|browser|fetch|http|network)/i.test(tool))
    return permissionResult(
      mode,
      'network',
      'consequential',
      base,
      'Network access requires explicit approval.',
    );

  if (isReadTool(tool))
    return permissionResult(mode, 'file_read', 'routine', base, 'Read is within the selected project.');
  if (isDeleteTool(tool))
    return permissionResult(
      mode,
      'file_delete',
      'consequential',
      base,
      'Deleting project files is consequential.',
    );
  if (isWriteTool(tool))
    return permissionResult(mode, 'file_write', 'routine', base, 'Write is within the selected project.');
  if (command) {
    return permissionResult(
      mode,
      'shell',
      isRoutineCommand(command) ? 'routine' : 'consequential',
      base,
      isRoutineCommand(command)
        ? 'This is an allowlisted project build, test, or lint command.'
        : 'This command launches a process in the selected project.',
    );
  }
  return permissionResult(
    mode,
    'unknown',
    'unknown',
    base,
    'The operation is not recognized by the project execution broker.',
  );
}

export function assertProjectPath(projectRoot: string, cwd: string, candidate: string): string {
  if (isSensitivePath(candidate)) throw new Error('Credential files are protected from agent access.');
  if (candidate.split(/[\\/]/).some((part) => part === '.git'))
    throw new Error('Git metadata is controlled by Turing Terminal and is not directly writable by agents.');
  const result = resolveProjectPath(projectRoot, cwd, candidate);
  const root = canonicalExisting(projectRoot);
  const relativeResult = relative(root, result);
  if (isSensitivePath(relativeResult)) throw new Error('Credential files are protected from agent access.');
  if (relativeResult.split(sep).some((part) => part === '.git'))
    throw new Error('Git metadata is controlled by Turing Terminal and is not directly writable by agents.');
  return result;
}

function permissionResult(
  mode: PermissionMode,
  operationType: BrokerOperationType,
  classification: BrokerPolicyResult['classification'],
  base: Pick<BrokerPolicyResult, 'displayAction' | 'paths' | 'command'>,
  reason: string,
): BrokerPolicyResult {
  const decision: BrokerDecision =
    classification === 'sensitive' || classification === 'out_of_scope'
      ? 'deny'
      : operationNeedsApproval(mode, operationType, classification)
        ? 'approval'
        : 'allow';
  return { ...base, operationType, classification, decision, reason };
}

function operationNeedsApproval(
  mode: PermissionMode,
  type: BrokerOperationType,
  classification: BrokerPolicyResult['classification'],
): boolean {
  if (mode === 'supervised') return type !== 'file_read';
  if (mode === 'normal') return classification !== 'routine' || type === 'unknown';
  if (mode === 'yolo')
    return ['git_push', 'git_merge', 'git_destructive', 'network', 'unknown'].includes(type);
  return ['git_push', 'git_merge', 'git_destructive', 'network', 'unknown'].includes(type);
}

function readCommand(input: Record<string, unknown>): string[] | null {
  for (const key of ['command', 'cmd', 'args']) {
    const value = input[key];
    if (Array.isArray(value) && value.length && value.every((part) => typeof part === 'string'))
      return value as string[];
    if (typeof value === 'string' && value.trim()) return splitCommandPreview(value);
  }
  return null;
}

function readPaths(input: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && /(?:path|file|directory|dir|cwd)$/i.test(key)) paths.add(value);
    if (Array.isArray(value) && /(?:paths|files)$/i.test(key))
      for (const item of value) if (typeof item === 'string') paths.add(item);
  }
  return [...paths];
}

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith('~') ||
    value.startsWith('../') ||
    value.startsWith('..\\') ||
    value.includes('/') ||
    value.includes('\\')
  );
}

function splitCommandPreview(command: string): string[] {
  return command.trim().split(/\s+/).slice(0, 80);
}

function isRoutineCommand(command: string[]): boolean {
  return (
    command.length === 3 &&
    ['npm', 'pnpm', 'yarn', 'bun'].includes(command[0] ?? '') &&
    command[1] === 'run' &&
    ['build', 'test', 'lint'].includes(command[2] ?? '')
  );
}

function isReadTool(tool: string): boolean {
  return /(?:read|list|search|grep|glob|find|stat|git.*diff|git.*status)/i.test(tool);
}

function isWriteTool(tool: string): boolean {
  return /(?:write|edit|patch|create|apply)/i.test(tool);
}

function isDeleteTool(tool: string): boolean {
  return /(?:delete|remove|unlink)/i.test(tool);
}

function displayToolAction(toolName: string, input: Record<string, unknown>): string {
  const details = safeStringify(summarizeBrokerAction(input)).slice(0, 2_000);
  return `${toolName}: ${details}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function canonicalExisting(path: string): string {
  return realpathSync(resolve(path));
}

function canonicalPotential(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

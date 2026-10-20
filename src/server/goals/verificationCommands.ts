import type { VerificationSpec } from '../../shared/goals.js';
import type { WorkflowStage } from '../../shared/types.js';
import { isSafeProjectCommand } from '../commandPolicy.js';
import type { Db } from '../db.js';

/**
 * Deterministic materialisation of an approved build/test/lint verifier into a workflow stage (a helper for the
 * verification workflow). A model never supplies a command: it is either the approved definition command
 * (re-validated here, at the execution boundary) or the registered project profile's default. Nothing is invented: an
 * absent default is a stable `verification_command_missing` result that verification surfaces as missing evidence.
 */
export type VerifierMaterialization =
  | {
      ok: true;
      source: 'explicit' | 'project_default';
      command: string[];
      /** `build`/`test` use the native stage for the project default; everything else is an allowlisted shellCommand. */
      stage: WorkflowStage;
    }
  | {
      ok: false;
      code: 'verification_command_missing' | 'verification_command_unsafe' | 'verification_kind_unsupported';
    };

const COLUMN = { build: 'build_command_json', test: 'test_command_json', lint: 'lint_command_json' } as const;
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, index) => part === b[index]);

function projectDefault(db: Db, projectId: string, kind: keyof typeof COLUMN): string[] | null {
  const row = db.prepare(`SELECT ${COLUMN[kind]} AS command FROM projects WHERE id = ?`).get(projectId) as
    { command: string | null } | undefined;
  if (!row?.command) return null;
  try {
    const parsed: unknown = JSON.parse(row.command);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

export function materializeVerifierStage(
  db: Db,
  projectId: string,
  verifier: VerificationSpec,
  stageId: string,
): VerifierMaterialization {
  if (verifier.kind !== 'build' && verifier.kind !== 'test' && verifier.kind !== 'lint')
    return { ok: false, code: 'verification_kind_unsupported' };
  const kind = verifier.kind;
  const projectCommand = projectDefault(db, projectId, kind);
  const explicit = verifier.command;
  const command = explicit ?? projectCommand;
  if (!command) return { ok: false, code: 'verification_command_missing' };
  if (!isSafeProjectCommand(command) || command[2] !== kind)
    return { ok: false, code: 'verification_command_unsafe' };
  const source = explicit ? 'explicit' : 'project_default';
  const label = kind === 'build' ? 'Build' : kind === 'test' ? 'Test' : 'Lint';
  const native = kind !== 'lint' && projectCommand !== null && same(command, projectCommand);
  const stage: WorkflowStage = native
    ? { id: stageId, label, kind, enabled: true }
    : { id: stageId, label, kind: 'shellCommand', command: [...command], enabled: true };
  return { ok: true, source, command: [...command], stage };
}

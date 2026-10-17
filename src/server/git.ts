import { execFile as callbackExecFile } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { redactSecrets } from './security.js';

const execFile = promisify(callbackExecFile);

export async function readGitDiff(cwd: string, limit = 180_000, baseCommit?: string | null): Promise<string> {
  let diff = '';
  try {
    const result = await execFile('git', ['diff', baseCommit || 'HEAD', '--no-ext-diff', '--'], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 2_000_000,
    });
    diff = result.stdout;
  } catch {
    try {
      const result = await execFile('git', ['diff', '--no-ext-diff', '--'], {
        cwd,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2_000_000,
      });
      diff = result.stdout;
    } catch {
      /* This folder may not be a Git repository. */
    }
  }
  let remaining = Math.max(0, limit - diff.length);
  if (remaining > 0) {
    try {
      const result = await execFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2_000_000,
      });
      for (const candidate of result.stdout.split('\0').filter(Boolean)) {
        const path = normalize(candidate);
        const portablePath = path.split(sep).join('/');
        const pathParts = portablePath.split('/');
        const sensitivePath = pathParts.some(
          (part) =>
            (part.toLowerCase().startsWith('.env') && part.toLowerCase() !== '.env.example') ||
            /secret|credential|token/i.test(part) ||
            /^(id_rsa|id_ed25519)$/i.test(part) ||
            /\.(pem|key|p12|pfx)$/i.test(part),
        );
        if (!path || path.startsWith(`..${sep}`) || path === '..' || path.startsWith(sep) || sensitivePath)
          continue;
        try {
          const fullPath = join(cwd, path);
          if (!lstatSync(fullPath).isFile()) continue;
          const bytes = readFileSync(fullPath);
          if (bytes.length > 100_000 || bytes.includes(0)) continue;
          const content = redactSecrets(bytes.toString('utf8'));
          const header = `diff --git a/${portablePath} b/${portablePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${portablePath}\n@@ -0,0 +1,${content.split('\n').length - 1} @@\n`;
          const patch =
            header +
            content
              .split('\n')
              .map((line) => `+${line}`)
              .join('\n');
          const clipped = patch.slice(0, remaining);
          diff += clipped;
          remaining -= clipped.length;
          if (!remaining) break;
        } catch {
          /* unreadable, changing, or non-regular paths are omitted */
        }
      }
    } catch {
      /* Non-Git folders have no untracked file list. */
    }
  }
  return redactSecrets(diff).slice(0, limit);
}

export interface SubjectState {
  /** HEAD of the worktree the verification ran in. */
  subjectCommit: string;
  /** Tree a scoped commit of the verified state would produce. */
  subjectTree: string;
  /** Project folder inside the repository ('' when the project is the repository root). */
  subjectScope: string;
}

/**
 * Computes the tree object for the state about to be verified: HEAD with the project scope replaced by the working
 * state (modified, deleted and new non-ignored files). Uses a temporary index so the real index is never touched,
 * and leaves files outside the project scope exactly as HEAD has them, matching what a scoped Git commit stage
 * would commit.
 */
export async function captureSubjectState(cwd: string): Promise<SubjectState> {
  const run = async (args: string[], env: NodeJS.ProcessEnv = {}) =>
    (
      await execFile('git', args, {
        cwd,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2_000_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
      })
    ).stdout.trim();
  const subjectCommit = await run(['rev-parse', 'HEAD']);
  const subjectScope = (await run(['rev-parse', '--show-prefix'])).replace(/\/+$/, '');
  const directory = mkdtempSync(join(tmpdir(), 'turing-subject-'));
  try {
    const env = { GIT_INDEX_FILE: join(directory, 'index') };
    await run(['read-tree', subjectCommit], env);
    await run(['add', '-A', '--', subjectScope ? `:(top,literal)${subjectScope}` : ':/'], env);
    return { subjectCommit, subjectTree: await run(['write-tree'], env), subjectScope };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

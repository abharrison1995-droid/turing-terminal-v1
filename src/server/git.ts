import { execFile as callbackExecFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
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

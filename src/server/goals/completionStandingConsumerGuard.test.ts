import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Consumer guard for the historical completion read (D.3F commit 3). `readStoredCompletion` answers whether a completion
 * is historically identical, and it still answers `completed` after a later correction. So no production file outside the
 * allow-list may use it as a success signal. A consumer must read `readGoalCompletionStanding` instead.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Allow-list by path relative to `src`, so a same-named file elsewhere is never exempt. Test files are excluded below. */
const ALLOWED_PATHS = new Set([
  'server/goals/externalCompletion.ts',
  'server/goals/externalCompletionTerminal.ts',
  'server/goals/completionStanding.ts',
]);

/**
 * The identifier, anywhere in the text. Matching the bare name rather than a call pattern means that spacing, a line break
 * before the parenthesis, a different letter case, or an alias cannot hide a use.
 */
const FORBIDDEN_USE = /\breadStoredCompletion\b/i;

function productionFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...productionFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts'))
      found.push(full);
  }
  return found;
}

/** True when a file outside the allow-list uses the stored-completion read. */
function violates(path: string, text: string): boolean {
  return !ALLOWED_PATHS.has(path) && FORBIDDEN_USE.test(text);
}

describe('completion standing consumer guard: readStoredCompletion is not a success signal outside the allow-list', () => {
  it('the production tree under src has no use of readStoredCompletion outside the allow-list', () => {
    const files = productionFiles(SRC);
    // Non-vacuous: the scan covers the whole production tree and includes the reader itself.
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(SRC, file))).toContain('server/goals/completionStanding.ts');
    const violations = files
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .filter((path) => violates(path, readFileSync(join(SRC, path), 'utf8')));
    expect(violations).toEqual([]);
  });

  it('seeded violation: a new production file that calls the read is caught, including with a line break and a case change', () => {
    const seeded = [
      'const stored = readStoredCompletion(db, goalId);',
      'const stored = readStoredCompletion\n  (db, goalId);',
      'const stored = READSTOREDCOMPLETION (db, goalId);',
    ];
    for (const text of seeded) {
      expect(violates('server/goals/newConsumer.ts', text), text).toBe(true);
    }
  });

  it('negative control: the same use inside an allow-listed file is not a violation, and the standing read is not flagged', () => {
    const use = 'const stored = readStoredCompletion(db, goalId);';
    expect(violates('server/goals/externalCompletion.ts', use)).toBe(false);
    expect(violates('server/goals/completionStanding.ts', use)).toBe(false);
    // A same-named file in another directory is not exempt, and the standing reader is not the stored read.
    expect(violates('server/goals/other/externalCompletion.ts', use)).toBe(true);
    expect(
      violates('server/goals/newConsumer.ts', 'const model = readGoalCompletionStanding(db, goalId);'),
    ).toBe(false);
    expect(violates('server/goals/newConsumer.ts', 'const x = readStoredCompletionLegacy(db, goalId);')).toBe(
      false,
    );
  });
});

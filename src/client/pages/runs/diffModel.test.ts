// @vitest-environment node

// UI.2 RED tests for the pure diff parser (UI2_SCOPE section 1, matrix R2). The expected API is:
//   parseDiff(text: string, options: { maxLines: number }) => {
//     files: Array<{ path: string; lines: Array<{ kind: 'add' | 'remove' | 'context' | 'meta'; text: string }> }>;
//     capped: boolean;
//   }
// Assumptions: files split at each line that starts with 'diff --git'; the path is the b/ side; the header line itself is
// not a row; add, remove and context rows drop their one-character marker; meta rows keep the full line (index, ---, +++,
// @@ and mode lines), so a '+++' or '---' header is never counted as an add or a remove; maxLines counts every row across
// all files, and capped is true only when rows were dropped. The module does not exist yet, so every test is RED.

import { describe, expect, it } from 'vitest';
import { parseDiff } from './diffModel';

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+# Title',
].join('\n');

describe('parseDiff (matrix R2)', () => {
  it('splits the diff per file at "diff --git" and takes the path from the b/ side', () => {
    const { files } = parseDiff(SAMPLE, { maxLines: 1_000 });

    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'README.md']);
  });

  it('classifies add, remove, context and meta rows, and keeps headers out of the add and remove counts', () => {
    const [first] = parseDiff(SAMPLE, { maxLines: 1_000 }).files;

    expect(first!.lines).toEqual([
      { kind: 'meta', text: 'index 1111111..2222222 100644' },
      { kind: 'meta', text: '--- a/src/a.ts' },
      { kind: 'meta', text: '+++ b/src/a.ts' },
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: 'keep' },
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('a new file is an add-only section, and its mode line is meta', () => {
    const readme = parseDiff(SAMPLE, { maxLines: 1_000 }).files[1]!;

    expect(readme.lines[0]).toEqual({ kind: 'meta', text: 'new file mode 100644' });
    expect(readme.lines.filter((line) => line.kind === 'add')).toEqual([{ kind: 'add', text: '# Title' }]);
    expect(readme.lines.some((line) => line.kind === 'remove')).toBe(false);
  });

  it('caps the rows at maxLines and sets capped, and sets nothing when the diff fits or is empty', () => {
    const capped = parseDiff(SAMPLE, { maxLines: 4 });
    const total = capped.files.reduce((sum, file) => sum + file.lines.length, 0);

    expect(capped.capped).toBe(true);
    expect(total).toBe(4);

    const fits = parseDiff(SAMPLE, { maxLines: 1_000 });
    expect(fits.capped).toBe(false);
    expect(parseDiff('', { maxLines: 10 })).toEqual({ files: [], capped: false });
  });
});

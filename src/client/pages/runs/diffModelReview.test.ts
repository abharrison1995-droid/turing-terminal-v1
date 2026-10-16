// @vitest-environment node

// UI.2 review round 2 (findings 4 and 5), pure tests for the diff parser. File paths come from the git headers: rename
// lines and the +++ b/ line are preferred, a rename shows "old → new", a path that contains " b/" stays whole, and git's
// C-style quoting is undone. The row cap counts only the rows the view draws and never leaves an empty trailing file.
// RED before the fix: the rename, quoting and " b/" tests fail on the old regex, and the cap tests fail on the old
// eager file creation and on the missing limitRenderedRows.

import { describe, expect, it } from 'vitest';
import { isHiddenRow, limitRenderedRows, parseDiff } from './diffModel';

const paths = (text: string) => parseDiff(text, { maxLines: 10_000 }).files.map((file) => file.path);

describe('diff file paths (finding 4)', () => {
  it('a rename shows "old → new" from the rename headers', () => {
    const text = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    expect(paths(text)).toEqual(['src/old.ts → src/new.ts']);
  });

  it('a pure rename with no content change still shows "old → new"', () => {
    const text = [
      'diff --git a/x.ts b/y.ts',
      'similarity index 100%',
      'rename from x.ts',
      'rename to y.ts',
    ].join('\n');

    expect(paths(text)).toEqual(['x.ts → y.ts']);
  });

  it('a path that contains " b/" is kept whole when both sides match', () => {
    const text = [
      'diff --git a/lib b/c.ts b/lib b/c.ts',
      'index 1111111..2222222 100644',
      '--- a/lib b/c.ts',
      '+++ b/lib b/c.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    expect(paths(text)).toEqual(['lib b/c.ts']);
  });

  it('a quoted path is unquoted and its C escapes are decoded', () => {
    const text = [
      'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
      'index 1111111..2222222 100644',
      '--- "a/tab\\there.ts"',
      '+++ "b/tab\\there.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    expect(paths(text)).toEqual(['tab\there.ts']);
  });

  it('an octal-escaped UTF-8 path is decoded to its characters', () => {
    const text = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      'index 1111111..2222222 100644',
      '@@ -1 +1 @@',
      '+b',
    ].join('\n');

    expect(paths(text)).toEqual(['café.ts']);
  });

  it('a trailing tab on the +++ line (git adds one for names with spaces) is not part of the path', () => {
    const text = [
      'diff --git a/my file.ts b/my file.ts',
      'index 1111111..2222222 100644',
      '--- a/my file.ts\t',
      '+++ b/my file.ts\t',
      '@@ -1 +1 @@',
      '+b',
    ].join('\n');

    expect(paths(text)).toEqual(['my file.ts']);
  });

  it('a deleted file keeps its path from the header when +++ is /dev/null', () => {
    const text = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-a',
    ].join('\n');

    expect(paths(text)).toEqual(['gone.ts']);
  });
});

describe('row cap counts only rows the view draws (finding 5)', () => {
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

  it('[RED shape] a cap that lands on the first row of the next file leaves no empty trailing file section', () => {
    // The first file has exactly seven rows. The cap trips on the README section's first row.
    const { files, capped } = parseDiff(SAMPLE, { maxLines: 7 });

    expect(capped).toBe(true);
    expect(files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(files.every((file) => file.lines.length > 0)).toBe(true);
  });

  it('hidden index, --- and +++ rows do not use up the drawn-row limit', () => {
    const { files, capped } = limitRenderedRows(parseDiff(SAMPLE, { maxLines: Infinity }).files, 3);
    const drawn = files.flatMap((file) => file.lines).filter((line) => !isHiddenRow(line));

    expect(capped).toBe(true);
    expect(drawn).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: 'keep' },
      { kind: 'remove', text: 'old' },
    ]);
    expect(files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('nothing is dropped when the drawn rows fit, so capped stays false', () => {
    const all = parseDiff(SAMPLE, { maxLines: Infinity }).files;
    const { files, capped } = limitRenderedRows(all, 1_000);

    expect(capped).toBe(false);
    expect(files).toEqual(all);
  });
});

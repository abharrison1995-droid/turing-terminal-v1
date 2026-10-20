/**
 * Pure parser for the unified diff that `api.diff` returns. It splits the text per file, and classifies each row so the
 * view can mark added and removed lines in text as well as colour. Header lines (index, ---, +++, @@, mode) are meta
 * rows, so a '+++' or '---' header is never counted as an add or a remove.
 */

export type DiffLineKind = 'add' | 'remove' | 'context' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  files: DiffFile[];
  /** True only when rows were dropped because the cap was reached. */
  capped: boolean;
}

const FILE_HEADER = 'diff --git ';
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * The index, ---, and +++ rows are parsed and kept, but the view does not draw them: the file heading already names the
 * path. A row is drawn only when it is not hidden.
 */
export function isHiddenRow(line: DiffLine): boolean {
  return line.kind === 'meta' && /^(index |--- |\+\+\+ )/.test(line.text);
}

/** Undoes git's C-style quoting, which wraps a path that holds a tab, a quote, or a non-ASCII byte in double quotes. */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const match of value.slice(1, -1).matchAll(/\\([0-7]{3}|[abtnvfr"\\])|([^\\]+)/g)) {
    if (match[2] !== undefined) bytes.push(...encoder.encode(match[2]));
    else if (match[1]!.length === 3) bytes.push(parseInt(match[1]!, 8));
    else bytes.push(C_ESCAPES[match[1]!]!);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Removes the a/ or b/ prefix that git puts in front of each side of a path. */
function stripSide(value: string, side: 'a/' | 'b/'): string {
  const plain = unquote(value);
  return plain.startsWith(side) ? plain.slice(side.length) : plain;
}

/** The index of the quote that closes a quoted value, or -1. A backslash escapes the character after it. */
function closingQuote(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '"') return index;
  }
  return -1;
}

/**
 * The b-side path from the text after "diff --git ". A side that git quoted is read as quoted. When both sides are plain
 * and equal, the text is "P b/P", so it is split at its midpoint and a path that contains " b/" stays whole.
 */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    return end > 0 && rest[end + 1] === ' ' ? stripSide(rest.slice(end + 2), 'b/') : rest;
  }
  const quotedB = rest.indexOf(' "b/');
  if (quotedB >= 0) return stripSide(rest.slice(quotedB + 1), 'b/');
  const body = rest.startsWith('a/') ? rest.slice(2) : rest;
  const half = (body.length - 3) / 2;
  if (
    Number.isInteger(half) &&
    body.slice(half, half + 3) === ' b/' &&
    body.slice(0, half) === body.slice(half + 3)
  )
    return body.slice(0, half);
  const last = body.lastIndexOf(' b/');
  return last >= 0 ? body.slice(last + 3) : body;
}

/** What the header lines before the first hunk say about one file's path. */
interface FileNames {
  /** The b-side path from the "diff --git" line, used when the other lines say nothing more. */
  header: string;
  /** From "rename from" or "copy from". */
  from?: string;
  /** From "rename to" or "copy to". */
  to?: string;
  /** From the +++ line. Absent for a deleted file, whose +++ is /dev/null. */
  newPath?: string;
}

/** Reads one header line that names the file. Lines that name nothing are ignored. */
function absorbNameLine(names: FileNames, line: string): void {
  const from = /^(?:rename|copy) from (.+)$/.exec(line);
  const to = /^(?:rename|copy) to (.+)$/.exec(line);
  const plus = /^\+\+\+ (.+)$/.exec(line);
  if (from) {
    names.from = unquote(from[1]!);
  } else if (to) {
    names.to = unquote(to[1]!);
  } else if (plus) {
    // git adds a trailing tab to ---/+++ lines when a name contains a space.
    const value = plus[1]!.replace(/\t$/, '');
    if (value !== '/dev/null') names.newPath = stripSide(value, 'b/');
  }
}

/** "old → new" for a rename or copy, otherwise the new path, otherwise the header path. */
function displayPath(names: FileNames): string {
  const to = names.to ?? names.newPath;
  if (names.from !== undefined && to !== undefined && names.from !== to) return `${names.from} → ${to}`;
  return to ?? names.header;
}

/**
 * Parse at most `maxLines` rows across all files. A file's rows begin after its "diff --git" line. Inside a file, rows
 * before the first "@@" are meta. After it, a leading '+' or '-' is an add or a remove, a leading space is context, and
 * anything else is meta. A file is created only when its first row is accepted, so a cap never leaves an empty section.
 */
export function parseDiff(text: string, options: { maxLines: number }): ParsedDiff {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let names: FileNames = { header: '' };
  let inHunk = false;
  let rows = 0;
  let capped = false;

  for (const line of lines) {
    if (line.startsWith(FILE_HEADER)) {
      names = { header: headerPath(line.slice(FILE_HEADER.length)) };
      file = { path: names.header, lines: [] };
      inHunk = false;
      continue;
    }
    if (!file) file = { path: '', lines: [] };

    const beforeHunk = !inHunk;
    let row: DiffLine;
    if (!inHunk || line.startsWith('@@')) {
      if (line.startsWith('@@')) inHunk = true;
      row = { kind: 'meta', text: line };
    } else if (line.startsWith('+')) {
      row = { kind: 'add', text: line.slice(1) };
    } else if (line.startsWith('-')) {
      row = { kind: 'remove', text: line.slice(1) };
    } else if (line.startsWith(' ') || line === '') {
      row = { kind: 'context', text: line.slice(1) };
    } else {
      row = { kind: 'meta', text: line };
    }

    if (rows >= options.maxLines) {
      capped = true;
      break;
    }
    rows += 1;
    if (beforeHunk) {
      absorbNameLine(names, line);
      file.path = displayPath(names);
    }
    if (file.lines.length === 0) files.push(file);
    file.lines.push(row);
  }

  return { files, capped };
}

/**
 * Keeps at most `limit` rows that the view draws. Hidden rows (index, ---, +++) stay beside the drawn rows but do not
 * count. A file is left out rather than shown empty when the cap lands before any of its drawn rows, and `capped` is true
 * only when a drawn row was dropped.
 */
export function limitRenderedRows(files: DiffFile[], limit: number): ParsedDiff {
  const kept: DiffFile[] = [];
  let shown = 0;
  for (const file of files) {
    const lines: DiffLine[] = [];
    for (const line of file.lines) {
      if (!isHiddenRow(line)) {
        if (shown >= limit) {
          if (lines.some((item) => !isHiddenRow(item))) kept.push({ path: file.path, lines });
          return { files: kept, capped: true };
        }
        shown += 1;
      }
      lines.push(line);
    }
    if (lines.some((item) => !isHiddenRow(item))) kept.push({ path: file.path, lines });
  }
  return { files: kept, capped: false };
}

import type { GoalDefinition } from '../../shared/goals';

/**
 * Pure helpers for the definition document editor. The editor works on the exact JSON the user is reviewing: parsing
 * never drops, adds, reorders or rewrites anything, and nothing here computes a hash or decides validity (the server is
 * the only authority for both).
 */

export const DEFINITION_KEYS = ['contract', 'milestones', 'routing', 'review', 'limits'] as const;

export type ParseResult =
  | { ok: true; value: GoalDefinition }
  | { ok: false; message: string; line: number | null; column: number | null };

const locate = (text: string, position: number): { line: number; column: number } => {
  const before = text.slice(0, Math.max(0, position));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
};

/**
 * Some engines omit the error position. Every prefix before the offending character fails only because the input ends
 * early (or parses cleanly), and every longer prefix fails for another reason, so a binary search finds it.
 */
function firstBadIndex(text: string): number | null {
  const endedEarly = (prefix: string): boolean => {
    try {
      JSON.parse(prefix);
      return true;
    } catch (error) {
      return /end of (JSON|data)|Unterminated|unexpected end/i.test(
        error instanceof Error ? error.message : '',
      );
    }
  };
  let low = 0;
  let high = text.length;
  if (endedEarly(text)) return null;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (endedEarly(text.slice(0, mid + 1))) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Parses the editor text into a complete `GoalDefinition` document, or explains why it cannot be sent. */
export function parseDefinitionText(text: string): ParseResult {
  if (text.trim() === '') return { ok: false, message: 'The definition is empty.', line: null, column: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Invalid JSON.';
    const lineColumn = /line (\d+) column (\d+)/.exec(raw);
    if (lineColumn)
      return { ok: false, message: raw, line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
    const at = /position (\d+)/.exec(raw);
    if (at) {
      const { line, column } = locate(text, Number(at[1]));
      return { ok: false, message: raw, line, column };
    }
    const found = firstBadIndex(text);
    if (found !== null) {
      const { line, column } = locate(text, found);
      return { ok: false, message: raw, line, column };
    }
    return { ok: false, message: raw, line: null, column: null };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, message: 'The definition must be a JSON object.', line: null, column: null };
  const missing = DEFINITION_KEYS.filter((key) => !(key in value));
  if (missing.length > 0)
    return {
      ok: false,
      message: `The definition is missing required section(s): ${missing.join(', ')}.`,
      line: null,
      column: null,
    };
  return { ok: true, value: value as GoalDefinition };
}

/** One readable line for a failed parse, with the location only when the engine's own message lacks it. */
export const parseFailureText = (failure: Extract<ParseResult, { ok: false }>): string =>
  failure.line && !/line \d+/.test(failure.message)
    ? `${failure.message} (line ${failure.line}, column ${failure.column ?? 1})`
    : failure.message;

export const prettyDefinition = (definition: unknown): string => JSON.stringify(definition, null, 2);

/** Re-indents valid JSON only; whitespace is the sole change. Invalid text is left for the user to fix. */
export function formatDefinitionText(text: string): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { ok: false };
  }
}

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const MAX_DIFF_LINES = 2_500;

/**
 * A bounded line diff (longest common subsequence) for reviewing a revision against its parent. Returns null when the
 * documents are too large to diff safely in the browser.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

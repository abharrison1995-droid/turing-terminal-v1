import { describe, expect, it } from 'vitest';
import { diffLines, formatDefinitionText, parseDefinitionText } from './definitionDoc';

const FULL = { contract: {}, milestones: [], routing: {}, review: {}, limits: {} };

describe('definition document helpers', () => {
  it('parses a complete document exactly, keeping unknown keys and order', () => {
    const text = JSON.stringify({ ...FULL, extra: { b: 1, a: 2 } });
    const parsed = parseDefinitionText(text);
    expect(parsed.ok && JSON.stringify(parsed.value)).toBe(text);
  });

  it('refuses empty, non-object, malformed and incomplete documents with a reason', () => {
    expect(parseDefinitionText('  ').ok).toBe(false);
    expect(parseDefinitionText('[]')).toMatchObject({ ok: false });
    const broken = parseDefinitionText('{\n  "contract": ,\n}');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.line).toBe(2);
    const missing = parseDefinitionText('{"contract":{}}');
    expect(!missing.ok && missing.message).toContain('milestones');
  });

  it('formatting changes whitespace only and refuses invalid text', () => {
    const out = formatDefinitionText(JSON.stringify(FULL));
    expect(out.ok && JSON.parse(out.text)).toEqual(FULL);
    expect(formatDefinitionText('{').ok).toBe(false);
  });

  it('diffs line by line and bounds very large inputs', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')?.map((l) => l.kind)).toEqual(['same', 'removed', 'added', 'same']);
    expect(diffLines('same', 'same')?.every((l) => l.kind === 'same')).toBe(true);
    const huge = Array.from({ length: 2_600 }, (_, i) => String(i)).join('\n');
    expect(diffLines(huge, huge)).toBeNull();
  });
});

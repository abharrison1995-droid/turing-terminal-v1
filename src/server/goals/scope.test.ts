import { describe, expect, it } from 'vitest';
import { globMatches, pathInMilestoneScope, scopePrefixes } from './scope.js';

describe('milestone scope matching', () => {
  it('matches globs without letting a single star cross directories', () => {
    expect(globMatches('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatches('src/**', 'other/a.ts')).toBe(false);
    expect(globMatches('src/{a,b}.ts', 'src/b.ts')).toBe(true);
    expect(globMatches('src/{a,b}.ts', 'src/c.ts')).toBe(false);
    expect(globMatches('**/x.ts', 'x.ts')).toBe(true);
  });

  it('lets an exclude glob veto an include and treats an empty include list as nothing allowed', () => {
    const scope = { includeGlobs: ['src/**'], excludeGlobs: ['src/generated/**'] };
    expect(pathInMilestoneScope('src/a.ts', scope)).toBe(true);
    expect(pathInMilestoneScope('src/generated/a.ts', scope)).toBe(false);
    expect(pathInMilestoneScope('docs/a.md', scope)).toBe(false);
    expect(pathInMilestoneScope('src/a.ts', { includeGlobs: [], excludeGlobs: [] })).toBe(false);
  });

  it('derives literal directory prefixes that are never narrower than the globs', () => {
    expect(scopePrefixes({ includeGlobs: ['src/**', 'docs/api/*.md'], excludeGlobs: [] }).sort()).toEqual([
      'docs/api',
      'src',
    ]);
    expect(scopePrefixes({ includeGlobs: ['**/*.ts'], excludeGlobs: [] })).toEqual(['']);
  });
});

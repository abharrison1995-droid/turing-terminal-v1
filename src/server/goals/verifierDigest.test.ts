import { describe, expect, it } from 'vitest';
import type { VerificationSpec } from '../../shared/goals.js';
import { findVerifier, listVerifiers, verifierDigest } from './verifierDigest.js';
import { validDefinition } from './testKit.js';

describe('verifierDigest', () => {
  const digest = (spec: VerificationSpec, key = 'c') => verifierDigest(key, spec);

  it('is a stable SHA-256 hex digest independent of key order', () => {
    const a = digest({ kind: 'file_exists', path: 'a.txt' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(digest({ path: 'a.txt', kind: 'file_exists' } as VerificationSpec)).toBe(a);
    expect(digest({ kind: 'file_exists', path: 'a.txt' })).toBe(a);
  });

  it('changes whenever the verifier semantics change', () => {
    const variants: VerificationSpec[] = [
      { kind: 'test' },
      { kind: 'test', command: ['npm', 'run', 'test'] },
      { kind: 'test', command: ['npm', 'run', 'test', '--', 'unit'] },
      { kind: 'build' },
      { kind: 'lint' },
      { kind: 'file_exists', path: 'a' },
      { kind: 'file_exists', path: 'b' },
      { kind: 'review_verdict', reviewKind: 'final' },
      { kind: 'review_verdict', reviewKind: 'milestone' },
      { kind: 'commit_on_branch' },
      { kind: 'user_confirmation', prompt: 'ok?', freshness: 'any' },
      { kind: 'user_confirmation', prompt: 'ok?', freshness: 'head-bound' },
      { kind: 'user_confirmation', prompt: 'really?', freshness: 'any' },
    ];
    expect(new Set(variants.map((spec) => digest(spec))).size).toBe(variants.length);
  });

  it('binds the criterion key', () => {
    expect(digest({ kind: 'test' }, 'a')).not.toBe(digest({ kind: 'test' }, 'b'));
  });

  it('lists verifiers in definition order and finds them by criterion and digest', () => {
    const definition = validDefinition();
    const verifiers = listVerifiers(definition);
    expect(verifiers.map((verifier) => `${verifier.criterionKey}:${verifier.spec.kind}`)).toEqual([
      'builds:build',
      'tests:test',
      'tests:review_verdict',
    ]);
    const second = verifiers[1]!;
    expect(findVerifier(definition, 'tests', second.digest)?.spec.kind).toBe('test');
    expect(findVerifier(definition, 'builds', second.digest)).toBeUndefined();
    expect(findVerifier(definition, 'tests', 'nope')).toBeUndefined();
  });

  it('collapses duplicate verifiers of one criterion', () => {
    const definition = validDefinition();
    definition.contract.successCriteria[1]!.verification.push({ kind: 'test' });
    expect(listVerifiers(definition)).toHaveLength(3);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareContentTrees,
  CONTENT_TREE_MAX_CHANGED_PATHS,
  CONTENT_TREE_MISMATCH_DIGEST_DOMAIN,
  type ContentTreeEntry,
} from './contentTreeComparison.js';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf8'));

const entry = (path: Uint8Array | string, mode: string, oid: string): ContentTreeEntry => ({
  path: typeof path === 'string' ? bytes(path) : path,
  mode,
  oid,
});

/** The digest the implementation must produce for a given set of mismatching paths, computed independently here. */
const expectedDigest = (paths: readonly Uint8Array[]): string => {
  const hash = createHash('sha256');
  hash.update(CONTENT_TREE_MISMATCH_DIGEST_DOMAIN, 'utf8');
  for (const path of paths) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(path.length, 0);
    hash.update(length);
    hash.update(path);
  }
  return hash.digest('hex');
};

describe('content tree comparison', () => {
  it('verifies an added and a modified path whose destination mode and object id match the source', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/added.ts'), bytes('src/modified.ts')],
      sourceEntries: [entry('src/added.ts', '100644', OID_A), entry('src/modified.ts', '100755', OID_B)],
      destinationEntries: [
        entry('src/added.ts', '100644', OID_A),
        entry('src/modified.ts', '100755', OID_B),
        entry('src/untouched.ts', '100644', OID_C),
      ],
    });

    expect(result).toEqual({
      status: 'verified',
      mismatchCount: 0,
      mismatchPathDigest: expectedDigest([]),
    });
  });

  it('accepts a path the source deleted when the destination no longer holds it', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/removed.ts')],
      sourceEntries: [entry('src/kept.ts', '100644', OID_A)],
      destinationEntries: [entry('src/kept.ts', '100644', OID_A)],
    });

    expect(result.status).toBe('verified');
    expect(result.mismatchCount).toBe(0);
  });

  it('reports a mismatch when the destination still holds a path the source deleted', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/removed.ts')],
      sourceEntries: [],
      destinationEntries: [entry('src/removed.ts', '100644', OID_A)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/removed.ts')]));
  });

  it('reports a mismatch when the destination object id differs from the source', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/changed.ts')],
      sourceEntries: [entry('src/changed.ts', '100644', OID_A)],
      destinationEntries: [entry('src/changed.ts', '100644', OID_B)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
  });

  it('reports a mismatch when the destination mode differs from the source', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/changed.ts')],
      sourceEntries: [entry('src/changed.ts', '100644', OID_A)],
      destinationEntries: [entry('src/changed.ts', '100755', OID_A)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
  });

  it('reports a mismatch when the destination no longer holds a path the source changed', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/changed.ts')],
      sourceEntries: [entry('src/changed.ts', '100644', OID_A)],
      destinationEntries: [],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
  });

  it('reports a mismatch when the destination replaced a deleted path with a directory', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/removed.ts')],
      sourceEntries: [],
      destinationEntries: [entry('src/removed.ts/child.ts', '100644', OID_A)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/removed.ts')]));
  });

  it('reports a mismatch when the destination replaced a source file with a directory', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/replaced.ts')],
      sourceEntries: [entry('src/replaced.ts', '100644', OID_A)],
      destinationEntries: [entry('src/replaced.ts/child.ts', '100644', OID_B)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/replaced.ts')]));
  });

  it('reports a mismatch when the destination blocked a deleted path with a file where its directory belongs', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/removed.ts')],
      sourceEntries: [],
      destinationEntries: [entry('src', '100644', OID_A)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/removed.ts')]));
  });

  it('reports a mismatch when the destination blocked a source file with a file where its directory belongs', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/kept.ts')],
      sourceEntries: [entry('src/kept.ts', '100644', OID_A)],
      destinationEntries: [entry('src/kept.ts', '100644', OID_A), entry('src', '100644', OID_B)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/kept.ts')]));
  });

  it('does not treat a directory where a directory belongs as a blocking file', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/removed.ts')],
      sourceEntries: [],
      destinationEntries: [entry('src', '040000', OID_A), entry('src/kept.ts', '100644', OID_B)],
    });

    expect(result.status).toBe('verified');
    expect(result.mismatchCount).toBe(0);
  });

  it('matches a directory only on a slash boundary, so a similar name is no conflict', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/removed.ts')],
      sourceEntries: [],
      destinationEntries: [entry('src/removed.tsx', '100644', OID_A), entry('sr', '100644', OID_B)],
    });

    expect(result.status).toBe('verified');
    expect(result.mismatchCount).toBe(0);
  });

  it('never returns a path name', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('secret/customer-name.ts')],
      sourceEntries: [entry('secret/customer-name.ts', '100644', OID_A)],
      destinationEntries: [entry('secret/customer-name.ts', '100644', OID_B)],
    });

    expect(Object.keys(result).sort()).toEqual(['mismatchCount', 'mismatchPathDigest', 'status']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('customer-name');
    expect(serialized).not.toContain('.ts');
    expect(result.mismatchPathDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('digests the mismatching paths stably, whatever order the inputs arrive in', () => {
    const changedPaths = [bytes('b.ts'), bytes('a.ts'), bytes('c.ts')];
    const sourceEntries = [
      entry('a.ts', '100644', OID_A),
      entry('b.ts', '100644', OID_A),
      entry('c.ts', '100644', OID_A),
    ];
    const destinationEntries = [
      entry('a.ts', '100644', OID_A),
      entry('b.ts', '100644', OID_B),
      entry('c.ts', '100644', OID_B),
    ];

    const first = compareContentTrees({ changedPaths, sourceEntries, destinationEntries });
    const second = compareContentTrees({
      changedPaths: [...changedPaths].reverse(),
      sourceEntries: [...sourceEntries].reverse(),
      destinationEntries: [...destinationEntries].reverse(),
    });

    expect(first.mismatchCount).toBe(2);
    expect(first.mismatchPathDigest).toBe(second.mismatchPathDigest);
    expect(first.mismatchPathDigest).toBe(expectedDigest([bytes('b.ts'), bytes('c.ts')]));
  });

  it('length-prefixes the digest input, so different path sets hash different bytes', () => {
    const first = compareContentTrees({
      changedPaths: [bytes('a'), bytes('bc')],
      sourceEntries: [entry('a', '100644', OID_A), entry('bc', '100644', OID_A)],
      destinationEntries: [entry('a', '100644', OID_B), entry('bc', '100644', OID_B)],
    });
    const second = compareContentTrees({
      changedPaths: [bytes('ab'), bytes('c')],
      sourceEntries: [entry('ab', '100644', OID_A), entry('c', '100644', OID_A)],
      destinationEntries: [entry('ab', '100644', OID_B), entry('c', '100644', OID_B)],
    });

    expect(first.mismatchCount).toBe(2);
    expect(second.mismatchCount).toBe(2);
    expect(first.mismatchPathDigest).not.toBe(second.mismatchPathDigest);
    expect(first.mismatchPathDigest).toBe(expectedDigest([bytes('a'), bytes('bc')]));
    expect(second.mismatchPathDigest).toBe(expectedDigest([bytes('ab'), bytes('c')]));
  });

  it('compares unusual path bytes exactly, without decoding them', () => {
    const unusual = new Uint8Array([0x61, 0x00, 0xff, 0x2e]);
    const same = new Uint8Array([0x61, 0x00, 0xff, 0x2e]);
    const different = new Uint8Array([0x61, 0x00, 0xfe, 0x2e]);

    expect(
      compareContentTrees({
        changedPaths: [unusual],
        sourceEntries: [entry(unusual, '100644', OID_A)],
        destinationEntries: [entry(same, '100644', OID_A)],
      }).status,
    ).toBe('verified');

    expect(
      compareContentTrees({
        changedPaths: [unusual],
        sourceEntries: [entry(unusual, '100644', OID_A)],
        destinationEntries: [entry(different, '100644', OID_A)],
      }).status,
    ).toBe('content_not_preserved');
  });

  it('fails closed on a path the listings describe in two different ways', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/ambiguous.ts')],
      sourceEntries: [entry('src/ambiguous.ts', '100644', OID_A)],
      destinationEntries: [
        entry('src/ambiguous.ts', '100644', OID_A),
        entry('src/ambiguous.ts', '100644', OID_B),
      ],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
  });

  it('fails closed on a path the destination lists twice, even when both entries agree', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/repeated.ts')],
      sourceEntries: [entry('src/repeated.ts', '100644', OID_A)],
      destinationEntries: [
        entry('src/repeated.ts', '100644', OID_A),
        entry('src/repeated.ts', '100644', OID_A),
      ],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/repeated.ts')]));
  });

  it('fails closed on a path the source lists twice, even when both entries agree', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/repeated.ts')],
      sourceEntries: [entry('src/repeated.ts', '100644', OID_A), entry('src/repeated.ts', '100644', OID_A)],
      destinationEntries: [entry('src/repeated.ts', '100644', OID_A)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/repeated.ts')]));
  });

  it('fails closed on a path whose destination ancestor is listed twice', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/kept.ts')],
      sourceEntries: [entry('src/kept.ts', '100644', OID_A)],
      destinationEntries: [
        entry('src', '040000', OID_A),
        entry('src', '040000', OID_B),
        entry('src/kept.ts', '100644', OID_A),
      ],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/kept.ts')]));
  });

  it('compares every changed path of a set at the cap', () => {
    const changedPaths = Array.from({ length: CONTENT_TREE_MAX_CHANGED_PATHS }, (_unused, index) =>
      bytes(`src/file-${index}.ts`),
    );
    const sourceEntries = changedPaths.map((path) => entry(path, '100644', OID_A));
    const destinationEntries = [
      ...sourceEntries.slice(0, -1),
      entry(changedPaths[changedPaths.length - 1]!, '100644', OID_B),
    ];

    const result = compareContentTrees({ changedPaths, sourceEntries, destinationEntries });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
  });

  it('verifies a changed-path set that sits exactly at the cap', () => {
    const changedPaths = Array.from({ length: CONTENT_TREE_MAX_CHANGED_PATHS }, (_unused, index) =>
      bytes(`src/file-${index}.ts`),
    );
    const entries = changedPaths.map((path) => entry(path, '100644', OID_A));

    const result = compareContentTrees({
      changedPaths,
      sourceEntries: entries,
      destinationEntries: entries,
    });

    expect(result.status).toBe('verified');
    expect(result.mismatchCount).toBe(0);
  });

  it('counts a repeated changed path once, so it cannot inflate the set against the cap', () => {
    const changedPaths = Array.from({ length: CONTENT_TREE_MAX_CHANGED_PATHS }, (_unused, index) =>
      bytes(`src/file-${index}.ts`),
    );
    const entries = changedPaths.map((path) => entry(path, '100644', OID_A));

    const result = compareContentTrees({
      changedPaths: [...changedPaths, bytes('src/file-0.ts')],
      sourceEntries: entries,
      destinationEntries: entries,
    });

    expect(result.status).toBe('verified');
    expect(result.mismatchCount).toBe(0);
  });

  it('reports a repeated changed path once when it does not match', () => {
    const result = compareContentTrees({
      changedPaths: [bytes('src/changed.ts'), bytes('src/changed.ts')],
      sourceEntries: [entry('src/changed.ts', '100644', OID_A)],
      destinationEntries: [entry('src/changed.ts', '100644', OID_B)],
    });

    expect(result.status).toBe('content_not_preserved');
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchPathDigest).toBe(expectedDigest([bytes('src/changed.ts')]));
  });

  it('fails closed above the cap without sampling and without a success', () => {
    const changedPaths = Array.from({ length: CONTENT_TREE_MAX_CHANGED_PATHS + 1 }, (_unused, index) =>
      bytes(`src/file-${index}.ts`),
    );
    const sourceEntries = changedPaths.map((path) => entry(path, '100644', OID_A));
    const destinationEntries = changedPaths.map((path) =>
      entry(path, '100644', path === changedPaths[0] ? OID_B : OID_A),
    );

    const result = compareContentTrees({ changedPaths, sourceEntries, destinationEntries });

    expect(result.status).toBe('content_observation_too_large');
    expect(result.mismatchCount).toBe(0);
    expect(result.mismatchPathDigest).toBe(expectedDigest([]));
  });

  it('fails closed above the cap on unique paths even when the raw set repeats them', () => {
    const uniquePaths = Array.from({ length: CONTENT_TREE_MAX_CHANGED_PATHS + 1 }, (_unused, index) =>
      bytes(`src/file-${index}.ts`),
    );
    const changedPaths = [...uniquePaths, ...uniquePaths];
    const sourceEntries = uniquePaths.map((path) => entry(path, '100644', OID_A));
    const destinationEntries = uniquePaths.map((path) => entry(path, '100644', OID_A));

    const result = compareContentTrees({ changedPaths, sourceEntries, destinationEntries });

    expect(result.status).toBe('content_observation_too_large');
    expect(result.mismatchCount).toBe(0);
    expect(result.mismatchPathDigest).toBe(expectedDigest([]));
  });
});

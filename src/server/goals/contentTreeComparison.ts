import { createHash } from 'node:crypto';

/**
 * Content comparison of two recursive Git tree listings.
 *
 * This module is the pure core of the content-verified integration check (design proposal
 * `docs/proposals/GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md`, section 3). It reads nothing but its arguments: no
 * Git, no filesystem, no database, no route, no completion wiring. Everything it knows about a repository arrives as
 * bytes and strings, so the same input always yields the same output.
 *
 * The output is an aggregate only: a status, the number of changed paths that did not match, and a SHA-256 digest over
 * an unambiguous encoding of the raw bytes of exactly those paths. A path name never leaves this module, so a caller
 * that reports the digest cannot leak a file name into user-facing text.
 */

/** The largest changed-path set that is compared. One path more fails closed instead of sampling. */
export const CONTENT_TREE_MAX_CHANGED_PATHS = 10_000;

/**
 * Domain separator of the mismatch digest. It is hashed in front of the path bytes, so this digest is computed over
 * an input no other digest of the repository uses, and the two can never be told apart by the bytes they cover.
 * The digest itself is a SHA-256 fingerprint, so a collision needs a SHA-256 collision.
 */
export const CONTENT_TREE_MISMATCH_DIGEST_DOMAIN = 'turing.content-tree-comparison.mismatch.v1';

/** The byte that separates the directory parts of a path. */
const SLASH_BYTE = 0x2f;

/** The modes Git gives to a tree entry, that is to a directory rather than to a file. */
const DIRECTORY_MODES = new Set(['040000', '40000']);

export interface ContentTreeEntry {
  /** The path of the entry, exactly as Git recorded it. Unusual bytes (NUL, invalid UTF-8) are preserved. */
  path: Uint8Array;
  /** The Git mode of the entry, for example `100644`, `100755`, `120000` or `160000`. */
  mode: string;
  /** The object id of the entry, exactly as Git recorded it. */
  oid: string;
}

export interface ContentTreeComparisonInput {
  /** The paths the Goal changed, as raw path bytes. */
  changedPaths: readonly Uint8Array[];
  /** The recursive listing of the source tree. */
  sourceEntries: readonly ContentTreeEntry[];
  /** The recursive listing of the destination tree. */
  destinationEntries: readonly ContentTreeEntry[];
}

export type ContentTreeComparisonStatus =
  'verified' | 'content_not_preserved' | 'content_observation_too_large';

/**
 * The aggregate result of one comparison. It carries no path name, only a status, the number of changed paths that
 * did not match, and the digest of an unambiguous encoding of their raw path bytes.
 */
export type ContentTreeComparisonResult =
  | { status: 'verified'; mismatchCount: 0; mismatchPathDigest: string }
  | { status: 'content_not_preserved'; mismatchCount: number; mismatchPathDigest: string }
  | { status: 'content_observation_too_large'; mismatchCount: 0; mismatchPathDigest: string };

interface IndexedEntry {
  mode: string;
  oid: string;
  /** True when the listing holds one path twice, so that path is ambiguous and can never be verified. */
  ambiguous: boolean;
}

/** A byte-exact key for a path: every byte maps to one code point, so two different byte strings never share a key. */
function pathKey(path: Uint8Array): string {
  return Buffer.from(path).toString('latin1');
}

/** True when the mode is the mode of a tree entry, that is of a directory rather than of a file. */
function isDirectoryMode(mode: string): boolean {
  return DIRECTORY_MODES.has(mode);
}

/**
 * The keys of the directories that hold the path, that is the path prefixes that end on a slash boundary. The path
 * `a/b/c` is held by the directories `a` and `a/b`, and by no other path, because a prefix that stops in the middle
 * of a name is not a directory of this path.
 */
function directoryKeys(path: Uint8Array): string[] {
  const keys: string[] = [];
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== SLASH_BYTE) continue;
    keys.push(pathKey(path.subarray(0, index)));
  }
  return keys;
}

/**
 * The listing indexed by exact path bytes, so the order of the listing never affects the outcome. A path listed
 * twice is ambiguous, whatever mode and object id the two entries carry, and an ambiguous path can never be verified.
 */
function indexEntries(entries: readonly ContentTreeEntry[]): Map<string, IndexedEntry> {
  const index = new Map<string, IndexedEntry>();
  for (const entry of entries) {
    const key = pathKey(entry.path);
    const existing = index.get(key);
    if (existing) {
      existing.ambiguous = true;
    } else {
      index.set(key, { mode: entry.mode, oid: entry.oid, ambiguous: false });
    }
  }
  return index;
}

/**
 * The directories that hold at least one listed entry, keyed by their exact bytes. A recursive listing does not name
 * its directories, so they are read from the paths of the entries below them.
 */
function listedDirectories(entries: readonly ContentTreeEntry[]): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    for (const directory of directoryKeys(entry.path)) directories.add(directory);
  }
  return directories;
}

/**
 * True when the destination holds a file where one of the directories of the path belongs. A file there and the path
 * below it cannot both exist, so the path is blocked in the destination. A directory the listing names twice is
 * ambiguous: the listing cannot say whether a file sits there, so it blocks the path as well, because an observation
 * that cannot be resolved is never verified.
 */
function hasFileAncestor(
  entries: ReadonlyMap<string, IndexedEntry>,
  directories: readonly string[],
): boolean {
  for (const directory of directories) {
    const entry = entries.get(directory);
    if (!entry) continue;
    if (entry.ambiguous) return true;
    if (!isDirectoryMode(entry.mode)) return true;
  }
  return false;
}

/**
 * The changed paths, deduplicated by exact bytes and in byte order. The order never depends on a locale or on how the
 * bytes decode, and a repeated path is one path, so it never counts twice against the cap. Returns null when the
 * unique set is larger than the cap.
 */
function sortedUniquePaths(paths: readonly Uint8Array[]): Uint8Array[] | null {
  const unique = new Map<string, Uint8Array>();
  for (const path of paths) {
    const key = pathKey(path);
    if (unique.has(key)) continue;
    unique.set(key, path);
    if (unique.size > CONTENT_TREE_MAX_CHANGED_PATHS) return null;
  }
  const items = [...unique.values()].map((path) => ({ path, bytes: Buffer.from(path) }));
  items.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  return items.map((item) => item.path);
}

/**
 * SHA-256 over an unambiguous encoding of the raw bytes of the mismatching paths, in byte order. Every path is
 * length-prefixed, so the hashed bytes describe the path set in exactly one way: two different sets of paths never
 * produce the same bytes to hash, whatever bytes the paths hold. The digest is the SHA-256 fingerprint of those
 * bytes, so a collision needs a SHA-256 collision, which is computationally hard rather than impossible.
 */
function mismatchPathDigest(paths: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  hash.update(CONTENT_TREE_MISMATCH_DIGEST_DOMAIN, 'utf8');
  for (const path of paths) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(path.length, 0);
    hash.update(length);
    hash.update(path);
  }
  return hash.digest('hex');
}

/**
 * Compare the changed paths of a source tree against a destination tree.
 *
 * For every changed path: when the source no longer holds it, the destination must not hold it either, must not
 * hold anything under it, and must not hold a file where one of its directories belongs; otherwise the destination
 * entry must carry exactly the source mode and the source object id, and the destination must again hold nothing
 * under the path and no file where one of its directories belongs. A path the source holds but the destination
 * does not, a path the source deleted and the destination kept, a different object id and a different mode are all
 * mismatches.
 *
 * The recursive listings do not carry directory entries, so the file and directory conflicts are detected from the
 * raw path bytes themselves: a path is held under a directory when the listing holds a path below it, and it is
 * blocked when the listing holds a file at one of its directories. Both checks stop on a slash boundary, so a name
 * that merely starts with the same bytes is never mistaken for a child of a path. A listing entry that names a
 * directory is not a blocking file, unless the listing names that directory twice, in which case the directory is
 * ambiguous and blocks the path as well.
 *
 * The changed-path set is bounded and deduplicated first, so a repeated path never inflates the set. A unique set
 * above the cap fails closed as `content_observation_too_large`: nothing is sampled, nothing is verified, and the
 * reported mismatch set is empty.
 */
export function compareContentTrees(input: ContentTreeComparisonInput): ContentTreeComparisonResult {
  const changedPaths = sortedUniquePaths(input.changedPaths);
  if (!changedPaths) {
    return {
      status: 'content_observation_too_large',
      mismatchCount: 0,
      mismatchPathDigest: mismatchPathDigest([]),
    };
  }

  const source = indexEntries(input.sourceEntries);
  const destination = indexEntries(input.destinationEntries);
  const destinationDirectories = listedDirectories(input.destinationEntries);
  const mismatches: Uint8Array[] = [];

  for (const path of changedPaths) {
    const key = pathKey(path);
    const directories = directoryKeys(path);
    const sourceEntry = source.get(key);
    const destinationEntry = destination.get(key);

    if (!sourceEntry) {
      // The source deleted the path, so the destination must not hold it, must not hold anything under it, and must
      // not hold a file where one of its directories belongs.
      if (destinationEntry) {
        mismatches.push(path);
        continue;
      }
      if (destinationDirectories.has(key)) {
        mismatches.push(path);
        continue;
      }
      if (hasFileAncestor(destination, directories)) {
        mismatches.push(path);
        continue;
      }
      continue;
    }

    // An ambiguous listing cannot be verified, so it fails closed like any other mismatch.
    if (sourceEntry.ambiguous) {
      mismatches.push(path);
      continue;
    }
    if (!destinationEntry || destinationEntry.ambiguous) {
      mismatches.push(path);
      continue;
    }
    if (sourceEntry.mode !== destinationEntry.mode || sourceEntry.oid !== destinationEntry.oid) {
      mismatches.push(path);
      continue;
    }
    // The destination holds the same file, but a directory under the path or a file where one of its directories
    // belongs means the path does not survive in the destination as the source wrote it.
    if (destinationDirectories.has(key)) {
      mismatches.push(path);
      continue;
    }
    if (hasFileAncestor(destination, directories)) {
      mismatches.push(path);
      continue;
    }
  }

  const digest = mismatchPathDigest(mismatches);
  if (mismatches.length === 0) {
    return { status: 'verified', mismatchCount: 0, mismatchPathDigest: digest };
  }
  return {
    status: 'content_not_preserved',
    mismatchCount: mismatches.length,
    mismatchPathDigest: digest,
  };
}

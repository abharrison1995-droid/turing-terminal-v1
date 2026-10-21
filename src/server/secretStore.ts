import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Desktop-only credential store for API keys that have no official CLI login (OpenRouter).
 *
 * Secrets live in `<data dir>/secrets/credentials.json`, outside SQLite, with an owner-only
 * directory (0700) and file (0600); Windows relies on the per-user profile ACL. They are never
 * written to workflow definitions, run history, usage rows, logs, exports, or mobile responses, and
 * are never placed in the environment of an agent process. Turing reads them only inside the
 * server-side HTTP adapter at request time. V1 does not integrate an OS keychain.
 */
export type SecretKind = 'inference' | 'management';

const REF_PATTERN = /^secret:[A-Za-z0-9-]{1,80}:(inference|management)$/;
const CREDENTIALS_FILE = 'credentials.json';
const CORRUPT_PREFIX = `${CREDENTIALS_FILE}.corrupt-`;
/** Corrupt stores already reported this process, keyed by their kept copy, so repeated lookups log once. */
const reportedCorruptStores = new Set<string>();

/**
 * The credentials file exists but is not a readable credential map. Turing never treats it as empty, because a write
 * would then replace every stored key. The original file is left in place and a copy is kept, so nothing is lost.
 */
export class SecretStoreCorruptError extends Error {
  constructor(readonly copyPath: string | null) {
    super(
      copyPath
        ? `The stored credentials file is unreadable. A copy was kept at ${copyPath}. Repair or remove credentials.json before saving or deleting credentials.`
        : 'The stored credentials file is unreadable, and a copy could not be kept. Repair or remove credentials.json before saving or deleting credentials.',
    );
    this.name = 'SecretStoreCorruptError';
  }
}

export function secretRef(profileId: string, kind: SecretKind): string {
  return `secret:${profileId}:${kind}`;
}

export class SecretStore {
  private readonly directory: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'secrets');
    this.file = join(this.directory, 'credentials.json');
  }

  static forDatabase(db: Db): SecretStore {
    return new SecretStore(dirname(db.name));
  }

  has(ref: string): boolean {
    return REF_PATTERN.test(ref) && typeof this.readForLookup()[ref] === 'string';
  }

  /** Server-internal use only. Never return this value from an API route. */
  read(ref: string): string | null {
    if (!REF_PATTERN.test(ref)) return null;
    const value = this.readForLookup()[ref];
    return typeof value === 'string' ? value : null;
  }

  write(ref: string, secret: string): void {
    if (!REF_PATTERN.test(ref)) throw new Error('Invalid credential reference.');
    const trimmed = secret.trim();
    if (trimmed.length < 8 || trimmed.length > 512 || /\s/.test(trimmed))
      throw new Error('The credential format is not valid.');
    const all = this.readAll();
    all[ref] = trimmed;
    this.writeAll(all);
  }

  delete(ref: string): void {
    const all = this.readAll();
    if (!(ref in all)) return;
    delete all[ref];
    this.writeAll(all);
  }

  deleteProfile(profileId: string): void {
    const all = this.readAll();
    let changed = false;
    for (const key of Object.keys(all))
      if (key.startsWith(`secret:${profileId}:`)) {
        delete all[key];
        changed = true;
      }
    if (changed) this.writeAll(all);
  }

  /**
   * Lookups answer "no key" for a corrupt store, so connection lists, routing and run launch degrade instead of failing.
   * The corruption is logged once per kept copy. Writes and deletes still go through readAll and refuse.
   */
  private readForLookup(): Record<string, string> {
    try {
      return this.readAll();
    } catch (error) {
      if (!(error instanceof SecretStoreCorruptError)) throw error;
      const key = error.copyPath ?? this.file;
      if (!reportedCorruptStores.has(key)) {
        reportedCorruptStores.add(key);
        console.error(`[secrets] ${error.message}`);
      }
      return {};
    }
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const bytes = readFileSync(this.file);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      value = undefined;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>;
    throw new SecretStoreCorruptError(this.keepCorruptCopy(bytes));
  }

  /**
   * Copies the unreadable bytes beside the store, owner-only. A copy with identical bytes is reused, so repeated reads
   * of one corrupt file keep one copy. Returns null when no copy could be kept.
   */
  private keepCorruptCopy(bytes: Buffer): string | null {
    try {
      for (const name of readdirSync(this.directory))
        if (name.startsWith(CORRUPT_PREFIX) && readFileSync(join(this.directory, name)).equals(bytes))
          return join(this.directory, name);
      const copy = join(this.directory, `${CORRUPT_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`);
      // COPYFILE_EXCL: a name collision never overwrites an earlier copy, it just keeps no new one.
      copyFileSync(this.file, copy, constants.COPYFILE_EXCL);
      try {
        chmodSync(copy, 0o600);
      } catch {
        /* Windows profile ACLs provide the platform equivalent. */
      }
      return copy;
    } catch {
      return null;
    }
  }

  private writeAll(value: Record<string, string>): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.directory, 0o700);
    } catch {
      /* Windows profile ACLs provide the platform equivalent. */
    }
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      /* Windows profile ACLs provide the platform equivalent. */
    }
    try {
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

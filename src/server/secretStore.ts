import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    return REF_PATTERN.test(ref) && typeof this.readAll()[ref] === 'string';
  }

  /** Server-internal use only. Never return this value from an API route. */
  read(ref: string): string | null {
    if (!REF_PATTERN.test(ref)) return null;
    const value = this.readAll()[ref];
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

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, string>)
        : {};
    } catch {
      return {};
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

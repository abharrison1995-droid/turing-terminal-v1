import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretStore, SecretStoreCorruptError, secretRef } from './secretStore.js';

describe('SecretStore', () => {
  let dataDir = '';
  let file = '';
  let secrets = '';
  const ref = secretRef('profile-1', 'inference');
  const key = 'sk-or-test-0123456789';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'turing-secrets-'));
    secrets = join(dataDir, 'secrets');
    file = join(secrets, 'credentials.json');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const quarantined = () =>
    readdirSync(secrets).filter((name) => name.startsWith('credentials.json.corrupt-'));

  it('treats a missing credentials file as an empty store and creates it on the first write', () => {
    const store = new SecretStore(dataDir);
    expect(store.has(ref)).toBe(false);
    expect(store.read(ref)).toBeNull();
    store.write(ref, key);
    expect(store.read(ref)).toBe(key);
    expect(quarantined()).toEqual([]);
  });

  it('refuses to write over a truncated credentials file and leaves the original bytes intact', () => {
    mkdirSync(secrets, { recursive: true });
    const truncated = '{"secret:profile-1:inference":"sk-or-test-01234';
    writeFileSync(file, truncated, { mode: 0o600 });

    const store = new SecretStore(dataDir);
    expect(() => store.write(secretRef('profile-2', 'inference'), key)).toThrow(SecretStoreCorruptError);
    expect(readFileSync(file, 'utf8')).toBe(truncated);
  });

  it('copies a corrupt credentials file aside with owner-only permissions before refusing', () => {
    mkdirSync(secrets, { recursive: true });
    const truncated = '{"secret:profile-1:inference":"sk-or-test-01234';
    writeFileSync(file, truncated, { mode: 0o600 });

    expect(() => new SecretStore(dataDir).write(ref, key)).toThrow(/copy/);
    const copies = quarantined();
    expect(copies).toHaveLength(1);
    const copy = join(secrets, copies[0]!);
    expect(readFileSync(copy, 'utf8')).toBe(truncated);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  it('reads a corrupt store as empty so read-only callers degrade, while deletes still refuse', () => {
    mkdirSync(secrets, { recursive: true });
    writeFileSync(file, '{"secret:profile-1:inf', { mode: 0o600 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const store = new SecretStore(dataDir);
      expect(store.read(ref)).toBeNull();
      expect(store.has(ref)).toBe(false);
      expect(store.read(ref)).toBeNull();
      expect(store.has(ref)).toBe(false);
      // The read-only path logs the corruption once, not once per call.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(() => store.delete(ref)).toThrow(SecretStoreCorruptError);
      expect(() => store.deleteProfile('profile-1')).toThrow(SecretStoreCorruptError);
      expect(quarantined()).toHaveLength(1);
      expect(readFileSync(file, 'utf8')).toBe('{"secret:profile-1:inf');
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps has() false and write() refusing on a corrupt store, with the original bytes intact', () => {
    mkdirSync(secrets, { recursive: true });
    const truncated = '{"secret:profile-1:inference":"sk-or-test-01234';
    writeFileSync(file, truncated, { mode: 0o600 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const store = new SecretStore(dataDir);
      expect(store.has(ref)).toBe(false);
      expect(() => store.write(ref, key)).toThrow(SecretStoreCorruptError);
      expect(readFileSync(file, 'utf8')).toBe(truncated);
    } finally {
      logged.mockRestore();
    }
  });

  it('treats valid JSON that is not an object as corrupt rather than as an empty store', () => {
    mkdirSync(secrets, { recursive: true });
    writeFileSync(file, '["not","a","store"]', { mode: 0o600 });

    expect(() => new SecretStore(dataDir).write(ref, key)).toThrow(SecretStoreCorruptError);
    expect(readFileSync(file, 'utf8')).toBe('["not","a","store"]');
  });

  it('round-trips a stored key and deletes it through a healthy store', () => {
    const store = new SecretStore(dataDir);
    store.write(ref, key);
    store.write(secretRef('profile-1', 'management'), 'sk-or-mgmt-0123456789');
    expect(store.has(ref)).toBe(true);
    store.deleteProfile('profile-1');
    expect(store.has(ref)).toBe(false);
    expect(store.read(secretRef('profile-1', 'management'))).toBeNull();
  });
});

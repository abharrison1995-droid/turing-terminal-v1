import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../db.js';
import {
  buildContentVerificationRecord,
  computeContentVerificationRecordDigest,
  CONTENT_VERIFICATION_KIND,
  CONTENT_VERIFIED_VERIFIER,
  CONTENT_VERIFIED_VERIFIER_VERSION,
  ContentVerificationError,
  contentVerificationPayloadJson,
  parseContentVerificationRecord,
  persistContentVerification,
  readContentVerification,
  type ContentVerificationInput,
} from './contentVerification.js';
import { CONTENT_TREE_MAX_CHANGED_PATHS, type ContentTreeEntry } from './contentTreeComparison.js';
import type { ContentTreeGitObservation } from './contentTreeGitObservation.js';

// The cap-boundary tests compare 10,000 and 10,001 paths in one case; assertions are unchanged.
vi.setConfig({ testTimeout: 30_000 });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const GOAL_ID = '20000000-0000-4000-8000-000000000001';
const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const BASE = '1'.repeat(40);
const SOURCE = '2'.repeat(40);
const TIP = '3'.repeat(40);
const COMPARISON = '4'.repeat(40);

function fresh(): Db {
  const folder = mkdtempSync(join(tmpdir(), 'turing-content-verification-'));
  folders.push(folder);
  return openDatabase(folder);
}

function machineId(db: Db): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string })
    .value;
}

function seedGoal(db: Db, goalId = GOAL_ID): void {
  db.prepare(
    "INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, 'P', '/tmp/p', ?)",
  ).run(PROJECT_ID, machineId(db), new Date().toISOString());
  db.prepare(
    `INSERT INTO goals
     (id, machine_id, project_id, title, status, current_definition_version, active_milestone_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Content verification Goal', 'draft', NULL, NULL, ?, ?)`,
  ).run(goalId, machineId(db), PROJECT_ID, new Date().toISOString(), new Date().toISOString());
}

function entry(path: string, oid: string, mode = '100644'): ContentTreeEntry {
  return { path: new Uint8Array(Buffer.from(path)), mode, oid };
}

type SuccessfulObservation = Extract<ContentTreeGitObservation, { ok: true }>;

function observed(input: {
  changedPaths?: string[];
  sourceEntries?: ContentTreeEntry[];
  destinationEntries?: ContentTreeEntry[];
  comparisonCommit?: string;
}): SuccessfulObservation {
  return {
    ok: true,
    status: 'observed',
    comparisonCommit: input.comparisonCommit ?? COMPARISON,
    changedPaths: (input.changedPaths ?? ['goal.txt']).map((path) => new Uint8Array(Buffer.from(path))),
    sourceEntries: input.sourceEntries ?? [entry('goal.txt', 'a'.repeat(40))],
    destinationEntries: input.destinationEntries ?? [entry('goal.txt', 'a'.repeat(40))],
  };
}

function input(
  observation: SuccessfulObservation,
  overrides: Partial<ContentVerificationInput> = {},
): ContentVerificationInput {
  return {
    goalId: GOAL_ID,
    expectedBaseCommit: BASE,
    acceptedSourceCommit: SOURCE,
    destinationTipCommit: TIP,
    destinationRef: 'refs/heads/main',
    objectFormat: 'sha1',
    observation,
    ...overrides,
  };
}

function count(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM goal_content_verifications').get() as { n: number }).n;
}

function refusal(run: () => unknown): ContentVerificationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContentVerificationError);
    return error as ContentVerificationError;
  }
  throw new Error('expected a content verification refusal');
}

describe('content verification record digests', () => {
  it('recomputes the record and evidence digests from the canonical payload', () => {
    const db = fresh();
    seedGoal(db);
    const persisted = persistContentVerification(db, input(observed({})));
    const { record } = persisted;
    const payload = JSON.parse(contentVerificationPayloadJson(record)) as Record<string, unknown>;

    const parsed = parseContentVerificationRecord(payload);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    const { recordDigest, verificationDigest, ...body } = parsed.record;
    expect(computeContentVerificationRecordDigest({ ...body, verificationDigest })).toBe(recordDigest);
    expect(parsed.digest).toBe(record.recordDigest);

    const rebuilt = buildContentVerificationRecord({
      ...body,
      verificationId: record.verificationId,
      observedAt: record.observedAt,
    });
    expect(rebuilt?.recordDigest).toBe(record.recordDigest);
    expect(rebuilt?.verificationDigest).toBe(record.verificationDigest);
    expect(parsed.record).toMatchObject({
      schemaVersion: 1,
      kind: CONTENT_VERIFICATION_KIND,
      verifier: CONTENT_VERIFIED_VERIFIER,
      verifierVersion: CONTENT_VERIFIED_VERIFIER_VERSION,
      status: 'verified',
      changedPathCount: 1,
      mismatchCount: 0,
    });
    db.close();
  });

  it('changes the record digest when the evidence changes and rejects a tampered digest', () => {
    const body = {
      schemaVersion: 1 as const,
      kind: CONTENT_VERIFICATION_KIND,
      goalId: GOAL_ID,
      verifier: CONTENT_VERIFIED_VERIFIER,
      verifierVersion: CONTENT_VERIFIED_VERIFIER_VERSION,
      status: 'content_not_preserved' as const,
      changedPathCount: 1,
      mismatchCount: 1,
      mismatchPathDigest: 'c'.repeat(64),
      repository: { objectFormat: 'sha1' as const },
      source: { commit: SOURCE },
      destination: {
        ref: 'refs/heads/main',
        expectedBaseCommit: BASE,
        tipCommit: TIP,
        comparisonCommit: COMPARISON,
      },
      verificationId: '30000000-0000-4000-8000-000000000001',
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const record = buildContentVerificationRecord(body);
    expect(record).not.toBeNull();
    if (!record) return;
    const changed = buildContentVerificationRecord({ ...body, mismatchPathDigest: 'd'.repeat(64) });
    expect(changed?.recordDigest).not.toBe(record.recordDigest);

    expect(parseContentVerificationRecord({ ...record, recordDigest: 'f'.repeat(64) })).toEqual({
      valid: false,
      reason: 'digest_mismatch',
    });
    expect(parseContentVerificationRecord({ ...record, unexpected: true })).toEqual({
      valid: false,
      reason: 'schema_invalid',
    });
  });
});

describe('content verification persistence', () => {
  it('persists a verified observation and reuses the identical evidence without writing again', () => {
    const db = fresh();
    seedGoal(db);
    const observation = observed({});

    const first = persistContentVerification(db, input(observation));
    expect(first.reused).toBe(false);
    expect(first.record.status).toBe('verified');
    expect(first.record.changedPathCount).toBe(1);
    expect(first.record.mismatchCount).toBe(0);
    expect(count(db)).toBe(1);

    const second = persistContentVerification(db, input(observed({})));
    expect(second.reused).toBe(true);
    expect(second.record.verificationId).toBe(first.record.verificationId);
    expect(second.record.recordDigest).toBe(first.record.recordDigest);
    expect(count(db)).toBe(1);

    expect(readContentVerification(db, GOAL_ID, first.record.verificationId)).toMatchObject({
      state: 'valid',
      id: first.record.verificationId,
      goalId: GOAL_ID,
      record: { status: 'verified', recordDigest: first.record.recordDigest },
    });
    expect(readContentVerification(db, GOAL_ID, 'missing')).toEqual({ state: 'not_found' });
    expect(readContentVerification(db, 'another-goal', first.record.verificationId)).toEqual({
      state: 'not_found',
    });
    db.close();
  });

  it('persists a content mismatch with a count and digest, and nothing else', () => {
    const db = fresh();
    seedGoal(db);
    const mismatch = observed({
      sourceEntries: [entry('goal.txt', 'a'.repeat(40))],
      destinationEntries: [entry('goal.txt', 'b'.repeat(40))],
    });
    const persisted = persistContentVerification(db, input(mismatch));
    expect(persisted.record.status).toBe('content_not_preserved');
    expect(persisted.record.changedPathCount).toBe(1);
    expect(persisted.record.mismatchCount).toBe(1);
    expect(persisted.record.mismatchPathDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(count(db)).toBe(1);
    db.close();
  });

  it('accepts exactly the 10,000-path boundary and refuses 10,001 paths without writing', () => {
    const db = fresh();
    seedGoal(db);
    const atCap = Array.from({ length: CONTENT_TREE_MAX_CHANGED_PATHS }, (_, index) => `p-${index}`);
    const boundary = persistContentVerification(
      db,
      input(observed({ changedPaths: atCap, sourceEntries: [], destinationEntries: [] })),
    );
    expect(boundary.record.status).toBe('verified');
    expect(boundary.record.changedPathCount).toBe(CONTENT_TREE_MAX_CHANGED_PATHS);
    expect(count(db)).toBe(1);

    const overCap = [...atCap, 'p-over-cap'];
    const refusalError = refusal(() =>
      persistContentVerification(
        db,
        input(observed({ changedPaths: overCap, sourceEntries: [], destinationEntries: [] })),
      ),
    );
    expect(refusalError.code).toBe('content_observation_too_large');
    expect(count(db)).toBe(1);
    db.close();
  });

  it('refuses failed and malformed observations without writing a row', () => {
    const db = fresh();
    seedGoal(db);
    const failed = {
      ...input(observed({})),
      observation: { ok: false, status: 'git_object_missing' },
    } as unknown as ContentVerificationInput;
    const failedRefusal = refusal(() => persistContentVerification(db, failed));
    expect(failedRefusal.code).toBe('content_observation_failed');
    expect(failedRefusal.detail).toBe('git_object_missing');
    expect(count(db)).toBe(0);

    const malformed = {
      ...input(observed({})),
      observation: { ok: true, status: 'observed', comparisonCommit: 'not-an-object-id', changedPaths: [] },
    } as unknown as ContentVerificationInput;
    expect(refusal(() => persistContentVerification(db, malformed)).code).toBe(
      'content_verification_input_invalid',
    );
    expect(count(db)).toBe(0);

    const wrongWidth = input(observed({}), { objectFormat: 'sha256' });
    const widthRefusal = refusal(() => persistContentVerification(db, wrongWidth));
    expect(widthRefusal.code).toBe('content_verification_input_invalid');
    expect(widthRefusal.detail).toBe('object_id_width');
    expect(count(db)).toBe(0);
    db.close();
  });
});

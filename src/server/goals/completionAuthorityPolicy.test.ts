import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import {
  computeEmptyCorrectionChainIdentity,
  computeExternalCompletionPreflight,
  readPreflightSnapshotIdentity,
} from './externalCompletionPreflight.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  v2DecidedFixture,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Call counts of the spied exports, keyed `module.export`. The spies below only count and then call the real export, so
 * fixtures and results are unchanged. The runtime isolation test reads and clears this map.
 */
const spiedCalls = vi.hoisted(() => new Map<string, number>());

// Pass-through spies. Factories run before this module's top-level code, so they inline their lists.
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify: promisifyFn } = await import('node:util');
  const actual = await importOriginal<typeof import('node:child_process')>();
  const out: Record<string, unknown> = { ...actual };
  for (const name of [
    'exec',
    'execFile',
    'execFileSync',
    'execSync',
    'fork',
    'spawn',
    'spawnSync',
  ] as const) {
    const real = actual[name] as unknown as (...args: unknown[]) => unknown;
    const count = () =>
      spiedCalls.set(`child_process.${name}`, (spiedCalls.get(`child_process.${name}`) ?? 0) + 1);
    const spy = vi.fn((...args: unknown[]) => {
      count();
      return real(...args);
    });
    // externalIntegration.ts and repository.ts promisify execFile. A spy without this symbol would resolve with stdout
    // only, which changes behaviour. The promisified path is counted too, so it cannot evade the spy.
    const custom = (real as unknown as Record<symbol, unknown>)[promisifyFn.custom] as
      ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (custom) {
      Object.defineProperty(spy, promisifyFn.custom, {
        value: (...args: unknown[]) => {
          count();
          return custom(...args);
        },
      });
    }
    out[name] = spy;
  }
  return out;
});

vi.mock('../goalGit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../goalGit.js')>();
  const out: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    // Classes (such as GoalGitError) keep their real constructors.
    if (typeof value !== 'function' || /^[A-Z]/.test(name)) continue;
    const real = value as (...args: unknown[]) => unknown;
    out[name] = vi.fn((...args: unknown[]) => {
      spiedCalls.set(`goalGit.${name}`, (spiedCalls.get(`goalGit.${name}`) ?? 0) + 1);
      return real(...args);
    });
  }
  return out;
});

afterEach(() => {
  cleanupRepoFixtures();
});

const GOAL_DIR = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-01-01T00:00:00.000Z';

type Attested = Awaited<ReturnType<typeof v2RunningAttestedFixture>>;

const hex = (label: string) => createHash('sha256').update(label).digest('hex');

/** The reviewed action fields of an attested Goal, as the preflight reports them. Test-only. */
async function completionBody(attested: Attested): Promise<Record<string, unknown>> {
  const report = await computeExternalCompletionPreflight(
    attested.fx.db,
    attested.fx.goalId,
    { attestationId: attested.attestationId },
    { allowRecordedDecision: true },
  );
  if (!report.actionFields) throw new Error('completionBody: the preflight reports no action fields');
  return {
    ...report.actionFields,
    contentOutcomeAcknowledged: true,
    userReviewedPreflightDigest: report.digest,
  };
}

/** A second decision row for the same attestation: only the reviewed digest differs, so its action digest is new. */
function variantBody(body: Record<string, unknown>, label: string): Record<string, unknown> {
  return { ...body, userReviewedPreflightDigest: hex(label) };
}

/** Writes one completion-decision row for an action body. `decide` approves it as the user; otherwise it stays pending. */
function seedCompletionRow(db: Db, goalId: string, body: Record<string, unknown>, decide: boolean): string {
  const action = buildExternalCompletionAction(body);
  if (action === null) throw new Error('seedCompletionRow: the action body is not valid');
  const approval = requestGoalApproval(db, {
    goalId,
    gate: 'user_confirmation',
    risk: 'high',
    reason: 'Seeded completion row for a classifier test.',
    requestedBy: 'user',
    detail: { ...action },
    externalCompletionActionDigest: action.actionDigest,
  });
  if (decide)
    decideGoalApproval(db, { goalId, approvalId: approval.id, decision: 'approved', decidedBy: 'user' });
  return approval.id;
}

/** Moves the destination branch to a commit made outside Turing and leaves it there. Returns the new tip. */
function moveDestination(attested: Attested, label: string): string {
  const { repo } = attested.fx;
  const baseRef = attested.handoff.target.baseRef;
  const current = git(repo, 'rev-parse', baseRef);
  const tree = git(repo, 'rev-parse', `${current}^{tree}`);
  git(repo, 'update-ref', baseRef, git(repo, 'commit-tree', tree, '-p', current, '-m', label));
  return git(repo, 'rev-parse', baseRef);
}

/** A second attestation of the same handoff, observed at a moved tip. The destination is restored to its prior tip. */
async function anotherAttestation(attested: Attested): Promise<string> {
  const { repo } = attested.fx;
  const baseRef = attested.handoff.target.baseRef;
  const priorTip = git(repo, 'rev-parse', baseRef);
  moveDestination(attested, 'destination moved for an independent attestation');
  const other = await reattestAtCurrentTip(attested);
  git(repo, 'update-ref', baseRef, priorTip);
  return other.attestationId;
}

/** Occupies the proof table with one complete proof row, as the preflight tests do. Test-only. */
function insertProofRow(db: Db, goalId: string): string {
  const row = proofRow(goalId);
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TRIGGER trg_goal_external_completion_proof_insert_authority;');
  db.exec('DROP TRIGGER trg_goal_external_completion_content_verification_authority;');
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO goal_external_completion_proofs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row));
  db.pragma('foreign_keys = ON');
  return String(row.id);
}

/** The database handle with every prepared statement recorded, so a test can see what the classifier executes. */
function recordStatements(db: Db): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const handle = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: handle, statements };
}

/** The database handle whose `prepare` throws for any SQL matching `pattern`. Test-only read-fault injection. */
function failPrepareFor(db: Db, pattern: RegExp): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          if (pattern.test(sql)) throw new Error(`injected read fault for ${pattern.source}`);
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('completion authority classifier: classes', () => {
  it(
    'class 1: a running attested Goal with no decision and no proof',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      expect(result).toMatchObject({
        class: 1,
        reason: null,
        selectedAttestationId: attested.attestationId,
        proofIds: [],
        entries: [],
      });
      expect(result.policyDigest).toMatch(/^[0-9a-f]{64}$/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 1 under sha256: the policy digest equals the domain-separated digest of its hand-written canonical body',
    async () => {
      const attested = await v2RunningAttestedFixture('sha256');
      const { db, goalId } = attested.fx;
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      // Written out by hand, not through the classifier, so the expected digest does not share its implementation.
      const canonical = `{"class":1,"entries":[],"goalId":"${goalId}","proofIds":[],"schemaVersion":1,"selectedAttestationId":"${attested.attestationId}"}`;
      const expected = createHash('sha256')
        .update('turing-goal-external-completion-policy-v1\0')
        .update(canonical)
        .digest('hex');
      expect(result).toMatchObject({ class: 1, reason: null, entries: [] });
      expect(result.policyDigest).toBe(expected);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 2: the selected attestation has its own decision; the public preflight still refuses it',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 2, reason: null, proofIds: [] });
      expect(result.entries).toEqual([
        {
          decisionId: decided.recorded.approvalId,
          actionDigest: decided.recorded.actionDigest,
          reviewedPreflightDigest: decided.digest,
          attestationId: decided.attestationId,
          attestationRecordDigest: decided.attestation.recordDigest,
          integrity: 'ok',
          standing: 'active_uncontested',
          correctionCount: 0,
          correctionSequence: 0,
          correctionTipDigest: null,
          eligible: true,
        },
      ]);
      // Parity with today's preflight: the recorded decision refuses completion (externalCompletionPreflight.ts:402).
      const preflight = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: decided.attestationId,
      });
      expect(preflight.outcome).toBe('refused');
      expect(preflight.reasons[0]?.code).toBe('completion_already_recorded');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 3: the only decision is for another attestation, and that decision is corrected',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const otherId = await anotherAttestation(decided);
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const result = classifyCompletionAuthority(db, goalId, otherId);
      expect(result).toMatchObject({ class: 3, reason: null, selectedAttestationId: otherId, proofIds: [] });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        decisionId: decided.recorded.approvalId,
        attestationId: decided.attestationId,
        integrity: 'ok',
        standing: 'disputed',
        correctionCount: 1,
        eligible: false,
      });
      expect(result.entries[0]?.correctionTipDigest).toMatch(/^[0-9a-f]{64}$/);
      // A corrected decision for another attestation no longer blocks a fresh B at check 4. The fixture then
      // reaches a Git refusal, because the destination was restored to its prior tip after B was observed.
      const preflight = await computeExternalCompletionPreflight(db, goalId, { attestationId: otherId });
      expect(preflight.reasons[0]?.code).toBe('destination_advanced_after_observation');
      expect(preflight.checks.find((check) => check.status === 'failed')?.name).not.toBe('prior_completion');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 4: another attestation has an eligible decision, which wins over the selected attestation having none',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const otherId = await anotherAttestation(decided);
      const result = classifyCompletionAuthority(db, goalId, otherId);
      expect(result).toMatchObject({ class: 4, reason: null, selectedAttestationId: otherId, proofIds: [] });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        decisionId: decided.recorded.approvalId,
        attestationId: decided.attestationId,
        integrity: 'ok',
        standing: 'active_uncontested',
        eligible: true,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 6: a terminal proof row outranks the decisions, and the public preflight refuses it',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const proofId = insertProofRow(db, goalId);
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 6, reason: null, proofIds: [proofId] });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ integrity: 'ok', eligible: true });
      // Parity with today's preflight: a proof row refuses completion (externalCompletionPreflight.ts:395).
      const preflight = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: decided.attestationId,
      });
      expect(preflight.reasons[0]?.code).toBe('completion_already_recorded');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: class 5 (history invalid or unavailable)', () => {
  it(
    'a tampered approval row is class 5 with its digest mismatch, and the classifier does not throw',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const id = decided.recorded.approvalId;
      const stored = db.prepare('SELECT detail_json FROM goal_approvals WHERE id = ?').get(id) as {
        detail_json: string;
      };
      db.exec('DROP TRIGGER trg_goal_approval_identity;');
      db.exec('DROP TRIGGER trg_goal_approval_terminal;');
      db.prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?').run(
        JSON.stringify({
          ...(JSON.parse(stored.detail_json) as Record<string, unknown>),
          userReviewedPreflightDigest: 'e'.repeat(64),
        }),
        id,
      );
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'digest_mismatch', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: id,
          integrity: 'digest_mismatch',
          actionDigest: null,
          attestationId: null,
          standing: null,
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a forged row that names the completion action only inside its detail is class 5 and is not a decision',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      // The service refuses a completion-named detail without a digest, so the row is written as an ordinary approval and
      // its detail is rewritten after the immutability triggers are dropped, the way the tamper test does.
      const forgedId = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Forged row for a classifier test.',
        requestedBy: 'user',
        detail: { note: 'An ordinary confirmation.' },
      }).id;
      db.exec('DROP TRIGGER trg_goal_approval_identity;');
      db.exec('DROP TRIGGER trg_goal_approval_terminal;');
      db.prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?').run(
        JSON.stringify({ action: 'complete_goal_external_integration_v2' }),
        forgedId,
      );
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'not_completion_approval', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: forgedId,
          integrity: 'not_completion_approval',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a decision that names a fabricated attestation id is class 5 attestation_not_found',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const body = await completionBody(decided);
      const attestation = body.attestation as Record<string, unknown>;
      const correctionChain = body.correctionChain as Record<string, unknown>;
      const fabricated = randomUUID();
      const fabricatedId = seedCompletionRow(
        db,
        goalId,
        {
          ...body,
          attestation: { ...attestation, id: fabricated },
          correctionChain: { ...correctionChain, attestationId: fabricated },
        },
        true,
      );
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'attestation_not_found', proofIds: [] });
      expect(result.entries).toContainEqual(
        expect.objectContaining({
          decisionId: fabricatedId,
          attestationId: fabricated,
          integrity: 'attestation_not_found',
          eligible: false,
        }),
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a pending decision row is class 5 approval_fields_invalid',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const pendingId = seedCompletionRow(db, goalId, await completionBody(attested), false);
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'approval_fields_invalid', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: pendingId,
          integrity: 'approval_fields_invalid',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an invalid stored correction chain is class 5 correction_chain_invalid, and the classifier does not throw',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const stored = db
        .prepare(
          'SELECT payload_json FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?',
        )
        .get(goalId, decided.attestationId) as { payload_json: string };
      const forged = {
        ...(JSON.parse(stored.payload_json) as Record<string, unknown>),
        correctionDigest: 'f'.repeat(64),
      };
      db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      db.prepare(
        'UPDATE goal_attestation_corrections SET payload_json = ?, correction_digest = ? WHERE goal_id = ? AND attestation_id = ?',
      ).run(JSON.stringify(forged), 'f'.repeat(64), goalId, decided.attestationId);
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'correction_chain_invalid', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: decided.recorded.approvalId,
          integrity: 'correction_chain_invalid',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
  it(
    'a decision naming another Goal in its action is class 5 and does not throw; the decision validator reports it',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const body = await completionBody(attested);
      // The service refuses an action that names another Goal, so a valid row is written and its action is rewritten
      // after the immutability triggers are dropped, the way the tamper test does. The row keeps its Goal.
      const mismatchId = seedCompletionRow(db, goalId, body, true);
      const foreign = buildExternalCompletionAction({ ...body, goalId: randomUUID() });
      if (foreign === null) throw new Error('the foreign action body is not valid');
      db.exec('DROP TRIGGER trg_goal_approval_identity;');
      db.exec('DROP TRIGGER trg_goal_approval_terminal;');
      db.prepare(
        'UPDATE goal_approvals SET detail_json = ?, external_completion_action_digest = ? WHERE id = ?',
      ).run(JSON.stringify(foreign), foreign.actionDigest, mismatchId);
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'approval_fields_invalid', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: mismatchId,
          integrity: 'approval_fields_invalid',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a decision whose attestation record digest is tampered is class 5 attestation_record_mismatch, and the classifier does not throw',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const body = await completionBody(attested);
      const attestation = body.attestation as Record<string, unknown>;
      const tamperedId = seedCompletionRow(
        db,
        goalId,
        { ...body, attestation: { ...attestation, recordDigest: 'f'.repeat(64) } },
        true,
      );
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'attestation_record_mismatch', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: tamperedId,
          integrity: 'attestation_record_mismatch',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a decision whose stored attestation record cannot be read is class 5 attestation_invalid, and the classifier does not throw',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      // The table CHECKs the payload's mapped fields, so the tamper adds a key that no column maps; the record then
      // fails its own validation and the read throws.
      const stored = db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(decided.attestationId) as { payload_json: string };
      const tampered = { ...(JSON.parse(stored.payload_json) as Record<string, unknown>), tampered: true };
      db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      db.prepare('UPDATE goal_external_integration_attestations SET payload_json = ? WHERE id = ?').run(
        JSON.stringify(tampered),
        decided.attestationId,
      );
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'attestation_invalid', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: decided.recorded.approvalId,
          integrity: 'attestation_invalid',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a decision whose empty correction chain digest is tampered is class 5 correction_chain_digest_mismatch',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const body = await completionBody(attested);
      const correctionChain = body.correctionChain as Record<string, unknown>;
      const tamperedId = seedCompletionRow(
        db,
        goalId,
        { ...body, correctionChain: { ...correctionChain, digest: 'f'.repeat(64) } },
        true,
      );
      const result = classifyCompletionAuthority(db, goalId, attested.attestationId);
      expect(result).toMatchObject({ class: 5, reason: 'correction_chain_digest_mismatch', proofIds: [] });
      expect(result.entries).toEqual([
        expect.objectContaining({
          decisionId: tamperedId,
          integrity: 'correction_chain_digest_mismatch',
          eligible: false,
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a failed proof, count or completion-row read is class 5 history_unreadable, not class 6, and does not throw',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const expected = {
        class: 5,
        reason: 'history_unreadable',
        selectedAttestationId: decided.attestationId,
        proofIds: [],
        entries: [],
        policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      };
      expect(
        classifyCompletionAuthority(
          failPrepareFor(db, /goal_external_completion_proofs/),
          goalId,
          decided.attestationId,
        ),
      ).toEqual(expected);
      expect(
        classifyCompletionAuthority(
          failPrepareFor(db, /COUNT\(\*\) AS n FROM goal_approvals/),
          goalId,
          decided.attestationId,
        ),
      ).toEqual(expected);
      expect(
        classifyCompletionAuthority(
          failPrepareFor(db, /SELECT id FROM goal_approvals/),
          goalId,
          decided.attestationId,
        ),
      ).toEqual(expected);
      // Control: the same state reads normally without the injected fault, so the failure above is the injected one.
      expect(classifyCompletionAuthority(db, goalId, decided.attestationId)).toMatchObject({ class: 2 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: empty correction chain digest', () => {
  it(
    'a fresh attested decision stores the digest the preflight identity computes, and the classifier accepts it',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const stored = db
        .prepare('SELECT detail_json FROM goal_approvals WHERE id = ?')
        .get(decided.recorded.approvalId) as {
        detail_json: string;
      };
      const { correctionChain } = JSON.parse(stored.detail_json) as { correctionChain: { digest: string } };
      const real = computeEmptyCorrectionChainIdentity({
        attestationId: decided.attestationId,
        attestationRecordDigest: decided.attestation.recordDigest,
      });
      expect(correctionChain.digest).toBe(real.digest);
      expect(classifyCompletionAuthority(db, goalId, decided.attestationId).entries[0]).toMatchObject({
        integrity: 'ok',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: eligibility by correction chain', () => {
  it(
    'an uncorrected attestation is eligible, even when Git has moved past it (A1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      moveDestination(decided, 'destination moved after the decision');
      const otherId = await anotherAttestation(decided);
      const result = classifyCompletionAuthority(db, goalId, otherId);
      expect(result).toMatchObject({ class: 4, reason: null });
      expect(result.entries[0]).toMatchObject({
        attestationId: decided.attestationId,
        integrity: 'ok',
        standing: 'active_uncontested',
        correctionCount: 0,
        correctionSequence: 0,
        correctionTipDigest: null,
        eligible: true,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['dispute', ['dispute'], 'disputed'],
    ['withdraw', ['withdraw'], 'withdrawn'],
    ['supersede', ['supersede'], 'superseded'],
    ['dispute then withdraw', ['dispute', 'withdraw'], 'withdrawn'],
    ['dispute then supersede', ['dispute', 'supersede'], 'superseded'],
  ] as const)(
    'a %s chain is ineligible: the decision is corrected, so the other selection is class 3',
    async (_label, kinds, standing) => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const otherId = await anotherAttestation(decided);
      for (const kind of kinds)
        appendCorrectionForTest(
          decided.fx,
          decided.attestationId,
          kind,
          kind === 'supersede' ? otherId : null,
        );
      const result = classifyCompletionAuthority(db, goalId, otherId);
      expect(result).toMatchObject({ class: 3, reason: null });
      expect(result.entries[0]).toMatchObject({
        attestationId: decided.attestationId,
        integrity: 'ok',
        standing,
        correctionCount: kinds.length,
        eligible: false,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: the row cap', () => {
  it(
    'classifies exactly 50 completion rows normally',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const body = await completionBody(decided);
      for (let index = 1; index < 50; index += 1)
        seedCompletionRow(db, goalId, variantBody(body, `cap row ${index}`), true);
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toMatchObject({ class: 2, reason: null, proofIds: [] });
      expect(result.entries).toHaveLength(50);
      expect(result.entries.every((entry) => entry.integrity === 'ok')).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed at 51 rows: class 5 too_many_decisions, no entries, and no approval row is read',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const body = await completionBody(decided);
      for (let index = 1; index <= 50; index += 1)
        seedCompletionRow(db, goalId, variantBody(body, `cap row ${index}`), true);
      const recording = recordStatements(db);
      const result = classifyCompletionAuthority(recording.db, goalId, decided.attestationId);
      expect(result).toEqual({
        class: 5,
        reason: 'too_many_decisions',
        selectedAttestationId: decided.attestationId,
        proofIds: [],
        entries: [],
        policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // Only the row count may touch the approval table; any approval read would be a statement without COUNT.
      const approvalStatements = recording.statements.filter((sql) => /goal_approvals/.test(sql));
      expect(approvalStatements.length).toBeGreaterThan(0);
      for (const sql of approvalStatements) expect(sql).toMatch(/COUNT\(\*\)/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
  it(
    'class 6 outranks the cap: 51 rows and a proof row classify as 6 with no entries read',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const body = await completionBody(decided);
      for (let index = 1; index <= 50; index += 1)
        seedCompletionRow(db, goalId, variantBody(body, `cap row ${index}`), true);
      const proofId = insertProofRow(db, goalId);
      const result = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(result).toEqual({
        class: 6,
        reason: null,
        selectedAttestationId: decided.attestationId,
        proofIds: [proofId],
        entries: [],
        policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: policy digest', () => {
  it(
    'is identical when the same state is classified twice',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const first = classifyCompletionAuthority(db, goalId, decided.attestationId);
      const second = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(second.policyDigest).toBe(first.policyDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'changes when the selected attestation changes',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const otherId = await anotherAttestation(decided);
      const selectedDecided = classifyCompletionAuthority(db, goalId, decided.attestationId);
      const selectedOther = classifyCompletionAuthority(db, goalId, otherId);
      expect(selectedOther.policyDigest).not.toBe(selectedDecided.policyDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'changes when a correction is appended to an attestation',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const before = classifyCompletionAuthority(db, goalId, decided.attestationId);
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const after = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(after.policyDigest).not.toBe(before.policyDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'changes when the decision set changes',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const before = classifyCompletionAuthority(db, goalId, decided.attestationId);
      seedCompletionRow(db, goalId, variantBody(await completionBody(decided), 'extra decision'), true);
      const after = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(after.entries).toHaveLength(2);
      expect(after.policyDigest).not.toBe(before.policyDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'changes when the proof set changes',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const before = classifyCompletionAuthority(db, goalId, decided.attestationId);
      insertProofRow(db, goalId);
      const after = classifyCompletionAuthority(db, goalId, decided.attestationId);
      expect(after.class).toBe(6);
      expect(after.policyDigest).not.toBe(before.policyDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: the public preflight by class', () => {
  it(
    'class 3: a fresh attestation is ready when the only decision is for another attestation and that decision is corrected',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      moveDestination(decided, 'destination moved for a fresh attestation');
      const fresh = await reattestAtCurrentTip(decided);
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      expect(classifyCompletionAuthority(db, goalId, fresh.attestationId)).toMatchObject({ class: 3 });
      const report = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: fresh.attestationId,
      });
      expect(report.outcome).toBe('ready');
      expect(report.actionFields).not.toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 4: another attestation has an eligible decision, so the public and option calls both refuse with competing_decision and write nothing',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const otherId = await anotherAttestation(decided);
      expect(classifyCompletionAuthority(db, goalId, otherId)).toMatchObject({ class: 4 });
      const before = databaseSnapshot(db);
      const publicReport = await computeExternalCompletionPreflight(db, goalId, { attestationId: otherId });
      const optionReport = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: otherId },
        { allowRecordedDecision: true },
      );
      for (const report of [publicReport, optionReport]) {
        expect(report).toMatchObject({
          outcome: 'refused',
          actionFields: null,
          reasons: [{ code: 'completion_already_recorded', detail: 'competing_decision' }],
        });
      }
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'class 5: a pending completion row makes the public and option calls both refuse with completion_history_invalid and write nothing',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      seedCompletionRow(db, goalId, await completionBody(attested), false);
      expect(classifyCompletionAuthority(db, goalId, attested.attestationId)).toMatchObject({
        class: 5,
        reason: 'approval_fields_invalid',
      });
      const before = databaseSnapshot(db);
      const publicReport = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attested.attestationId,
      });
      const optionReport = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        { allowRecordedDecision: true },
      );
      for (const report of [publicReport, optionReport]) {
        expect(report).toMatchObject({
          outcome: 'refused',
          actionFields: null,
          reasons: [{ code: 'completion_history_invalid', detail: 'approval_fields_invalid' }],
        });
      }
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the option accepts class 2 only: the decided attestation is refused without the option and ready with it',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      expect(classifyCompletionAuthority(db, goalId, decided.attestationId)).toMatchObject({ class: 2 });
      const publicReport = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: decided.attestationId,
      });
      expect(publicReport).toMatchObject({
        outcome: 'refused',
        reasons: [{ code: 'completion_already_recorded', detail: null }],
      });
      const optionReport = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: decided.attestationId },
        { allowRecordedDecision: true },
      );
      expect(optionReport.outcome).toBe('ready');
      expect(optionReport.actionFields).not.toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the option never waives a terminal proof: class 6 is refused with completion_already_recorded by both calls',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      insertProofRow(db, goalId);
      expect(classifyCompletionAuthority(db, goalId, decided.attestationId)).toMatchObject({ class: 6 });
      const before = databaseSnapshot(db);
      for (const options of [{}, { allowRecordedDecision: true }]) {
        const report = await computeExternalCompletionPreflight(
          db,
          goalId,
          { attestationId: decided.attestationId },
          options,
        );
        expect(report).toMatchObject({
          outcome: 'refused',
          reasons: [{ code: 'completion_already_recorded', detail: null }],
        });
      }
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the policy keys of the identity change when another attestation correction changes',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      moveDestination(decided, 'destination moved for a fresh attestation');
      const fresh = await reattestAtCurrentTip(decided);
      appendCorrectionForTest(decided.fx, decided.attestationId, 'dispute');
      const before = readPreflightSnapshotIdentity(db, goalId, fresh.attestationId);
      expect(before).toMatchObject({ policy_class: '3' });
      appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');
      const after = readPreflightSnapshotIdentity(db, goalId, fresh.attestationId);
      expect(after).toMatchObject({ policy_class: '3' });
      expect(after.policy_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(after.policy_digest).not.toBe(before.policy_digest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: no write', () => {
  it(
    'leaves the database identical and runs only SELECT statements',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const before = databaseSnapshot(db);
      const recording = recordStatements(db);
      classifyCompletionAuthority(recording.db, goalId, decided.attestationId);
      expect(databaseSnapshot(db)).toEqual(before);
      expect(recording.statements.length).toBeGreaterThan(0);
      for (const sql of recording.statements) expect(sql).toMatch(/^\s*SELECT\b/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completion authority classifier: sources', () => {
  const sources = ['completionAuthorityPolicy.ts', 'externalCompletionDecisionRows.ts'].map((name) => ({
    name,
    text: readFileSync(join(GOAL_DIR, name), 'utf8'),
  }));

  it.each(sources)('$name: every prepared statement is a SELECT literal', ({ text }) => {
    const calls = text.match(/\.prepare\(/g) ?? [];
    const literals = [...text.matchAll(/\.prepare\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)].map(([, quoted]) =>
      quoted!.slice(1, -1).trim(),
    );
    expect(literals.length).toBeGreaterThan(0);
    // Every prepare call takes a literal, so no statement is assembled out of view of this check.
    expect(literals).toHaveLength(calls.length);
    for (const sql of literals) expect(sql).toMatch(/^SELECT\b/);
  });

  it.each(sources)('$name: reads no Git, no clock and runs no statement runner', ({ text }) => {
    expect(text).not.toMatch(/child_process|\bgit\(|\bDate\b|\.run\(|\.exec\(/);
  });
});

/** A complete proof row copied from the schema test's builder; used only to occupy the proof table. */
function proofRow(goalId: string): Record<string, string | number> {
  const id = (part: string) => `30000000-0000-4000-8000-${part.padStart(12, '0')}`;
  const hash = (letter: string) => letter.repeat(64);
  const objectId = (letter: string) => letter.repeat(40);
  const actionDigest = hash('a');
  const proof = {
    schemaVersion: 1,
    kind: 'turing_goal_external_completion_proof',
    contractVersion: 2,
    goalId,
    definition: { version: 1, hash: hash('b'), approvalId: id('1'), lineageDigest: hash('c') },
    evaluation: {
      integrationHead: objectId('d'),
      integrationTree: objectId('e'),
      verificationEvidenceDigest: hash('f'),
      milestoneIdentityDigest: hash('1'),
      findingIdentityDigest: hash('2'),
      finalReviewId: id('2'),
      finalAcceptanceApprovalId: id('3'),
    },
    handoff: { id: id('4'), digest: hash('3') },
    attestation: { id: id('5'), actionDigest: hash('4'), recordDigest: hash('5'), approvalId: id('6') },
    repository: { projectId: id('7'), identity: hash('6'), scope: '', objectFormat: 'sha1' },
    source: { ref: `refs/heads/turing/goal/${goalId}`, commit: objectId('d'), tree: objectId('e') },
    destination: {
      ref: 'refs/heads/main',
      recordedBaseCommit: objectId('7'),
      recordedBaseTree: objectId('8'),
      observedCommit: objectId('9'),
      observedTree: objectId('a'),
    },
    gitProof: {
      mode: 'source_history_observed',
      sourceAncestor: true,
      baseAncestor: true,
      verifierVersion: 1,
      evidenceDigest: hash('7'),
      observedAt: NOW,
    },
    decision: {
      approvalId: id('8'),
      actionDigest,
      decidedAt: NOW,
      classification: 'user_confirmed_historical_external_integration',
    },
    proofLimitations: { contentPreservation: 'not_proven' },
    correctionChain: {
      schemaVersion: 1,
      kind: 'turing_goal_external_integration_correction_chain',
      attestationId: id('5'),
      sequence: 0,
      digest: hash('8'),
      standing: 'active_uncontested',
    },
    userReviewedPreflightDigest: hash('9'),
    proofDigest: hash('a'),
  };
  return {
    id: id('1'),
    goal_id: goalId,
    schema_version: 1,
    kind: proof.kind,
    contract_version: 2,
    action_digest: actionDigest,
    proof_digest: proof.proofDigest,
    definition_version: proof.definition.version,
    definition_hash: proof.definition.hash,
    definition_approval_id: proof.definition.approvalId,
    definition_lineage_digest: proof.definition.lineageDigest,
    handoff_id: proof.handoff.id,
    handoff_digest: proof.handoff.digest,
    attestation_id: proof.attestation.id,
    attestation_action_digest: proof.attestation.actionDigest,
    attestation_record_digest: proof.attestation.recordDigest,
    attestation_approval_id: proof.attestation.approvalId,
    completion_approval_id: proof.decision.approvalId,
    final_review_id: proof.evaluation.finalReviewId,
    final_acceptance_approval_id: proof.evaluation.finalAcceptanceApprovalId,
    verification_evidence_digest: proof.evaluation.verificationEvidenceDigest,
    milestone_identity_digest: proof.evaluation.milestoneIdentityDigest,
    finding_identity_digest: proof.evaluation.findingIdentityDigest,
    repository_project_id: proof.repository.projectId,
    repository_identity: proof.repository.identity,
    repository_scope: proof.repository.scope,
    object_format: proof.repository.objectFormat,
    source_ref: proof.source.ref,
    source_commit: proof.source.commit,
    source_tree: proof.source.tree,
    destination_ref: proof.destination.ref,
    recorded_base_commit: proof.destination.recordedBaseCommit,
    recorded_base_tree: proof.destination.recordedBaseTree,
    observed_destination_commit: proof.destination.observedCommit,
    observed_destination_tree: proof.destination.observedTree,
    proof_mode: proof.gitProof.mode,
    source_ancestor: 1,
    base_ancestor: 1,
    verifier_version: proof.gitProof.verifierVersion,
    git_evidence_digest: proof.gitProof.evidenceDigest,
    preflight_digest: proof.userReviewedPreflightDigest,
    correction_chain_digest: proof.correctionChain.digest,
    correction_sequence: proof.correctionChain.sequence,
    correction_standing: proof.correctionChain.standing,
    observed_at: proof.gitProof.observedAt,
    decided_at: proof.decision.decidedAt,
    payload_json: JSON.stringify(proof),
  };
}

/** Makes one completion row's stored approval detail disagree with its digest. The same tamper as the class 5 test. */
function tamperApprovalDetail(decided: Awaited<ReturnType<typeof v2DecidedFixture>>): void {
  const { db } = decided.fx;
  const id = decided.recorded.approvalId;
  const stored = db.prepare('SELECT detail_json FROM goal_approvals WHERE id = ?').get(id) as {
    detail_json: string;
  };
  db.exec('DROP TRIGGER trg_goal_approval_identity;');
  db.exec('DROP TRIGGER trg_goal_approval_terminal;');
  db.prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?').run(
    JSON.stringify({
      ...(JSON.parse(stored.detail_json) as Record<string, unknown>),
      userReviewedPreflightDigest: 'e'.repeat(64),
    }),
    id,
  );
}

describe('completion authority classifier: runtime isolation from Git and child processes', () => {
  it(
    'classes 1, 2 and 5 call no spied child_process or goalGit export, and the spies do count a direct call',
    async () => {
      // Fixtures run Git legitimately, so they are built first. Their calls must reach the spies, or the zero below
      // would prove nothing.
      const running = await v2RunningAttestedFixture('sha1');
      const decided = await v2DecidedFixture('sha1');
      const tampered = await v2DecidedFixture('sha1');
      tamperApprovalDetail(tampered);
      expect([...spiedCalls.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
      spiedCalls.clear();

      const one = classifyCompletionAuthority(running.fx.db, running.fx.goalId, running.attestationId);
      const two = classifyCompletionAuthority(decided.fx.db, decided.fx.goalId, decided.attestationId);
      const five = classifyCompletionAuthority(tampered.fx.db, tampered.fx.goalId, tampered.attestationId);
      expect([one.class, two.class, five.class]).toEqual([1, 2, 5]);
      expect(five.reason).toBe('digest_mismatch');
      expect(Object.fromEntries(spiedCalls)).toEqual({});

      // Control: a direct call through the plain and the promisified path is counted, so the zero above is not vacuous.
      execFileSync('git', ['--version']);
      await promisify(execFile)('git', ['--version']);
      expect(Object.fromEntries(spiedCalls)).toEqual({
        'child_process.execFileSync': 1,
        'child_process.execFile': 1,
      });
      spiedCalls.clear();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

/**
 * Static import ratchet. RESIDUAL, NOT A CLOSED ITEM: the static import closure of
 * completionAuthorityPolicy.ts REACHES write-capable modules (Goal database writes, Git ref writes, goal status
 * transitions). The chains are recorded below. This suite does not prove static isolation. What holds for the classifier
 * path is the runtime spy test above, plus this ratchet, which only makes a change visible: the closure must equal the
 * committed list, so any new module fails until a reviewer classifies it; the decision, terminal, route and lock modules
 * stay out; and the write-capable set must match exactly. The write check is a text scan, a heuristic that catches a new
 * writer, not a proof that a module is read-only. Walked: src/server only, static, export-from, dynamic import() and
 * import types, all counted. Type-only edges are counted too, so the list is an upper bound.
 */

const SERVER_ROOT = resolve(GOAL_DIR, '..');
const CLASSIFIER_FILE = join(GOAL_DIR, 'completionAuthorityPolicy.ts');
const NON_LITERAL_IMPORT = '<non-literal import()>';

/** Modules the classifier must never reach: the decision, terminal, route and lock paths. */
const FORBIDDEN_MODULES = [
  'goals/externalCompletionPreflight.ts',
  'goals/externalCompletionDecision.ts',
  'goals/externalCompletionTerminal.ts',
  'goals/goalRoutes.ts',
  'goals/goalCompletionLock.ts',
];

/** Text signatures of a write: a mutating or DDL statement, a `db.exec`, a Git ref write, a file write, a status transition. */
const WRITE_SIGNATURES = [
  /\b(?:INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM|CREATE TABLE|DROP TRIGGER|ALTER TABLE)\b/,
  /\bdb\.exec\(/,
  /'(?:update-ref|commit-tree|push|merge|reset|checkout|tag|branch)'/,
  /\b(?:writeFileSync|mkdirSync|rmSync|unlinkSync|renameSync|appendFileSync|chmodSync)\(/,
  /\btransitionGoal\(/,
];

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

function resolveLocal(file: string, spec: string): string {
  // NodeNext: a relative specifier names the emitted .js file, whose source is the .ts file beside it.
  return resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
}

/** Every module specifier of one source file: static, export-from, dynamic import(), and import types. */
function specifiersOf(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      specs.push(arg && ts.isStringLiteral(arg) ? arg.text : NON_LITERAL_IMPORT);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specs.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** The transitive closure of src/server files reachable from the classifier, as sorted paths relative to src/server. */
function localClosure(): string[] {
  const seen = new Set<string>([CLASSIFIER_FILE]);
  const queue = [CLASSIFIER_FILE];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const spec of specifiersOf(file)) {
      if (spec === NON_LITERAL_IMPORT)
        throw new Error(`${relative(SERVER_ROOT, file)}: import() with a non-literal`);
      if (!isRelativeSpecifier(spec)) continue;
      const target = resolveLocal(file, spec);
      if (!target.startsWith(SERVER_ROOT + sep)) continue;
      if (!existsSync(target)) throw new Error(`${relative(SERVER_ROOT, file)}: unresolved ${spec}`);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen].map((file) => relative(SERVER_ROOT, file).split(sep).join('/')).sort();
}

function importsProcessOrGit(file: string): boolean {
  return specifiersOf(file).some(
    (spec) =>
      spec === 'node:child_process' ||
      spec === 'child_process' ||
      (isRelativeSpecifier(spec) && resolveLocal(file, spec) === join(SERVER_ROOT, 'goalGit.ts')),
  );
}

/**
 * The committed classification of every module in the closure. `read-only` means the module's own source has no write
 * signature. `WRITE-CAPABLE` modules carry the write they perform and the import chain from the classifier, as recorded
 * when this ratchet was written. `process` records a direct node:child_process or goalGit import and why it is accepted.
 */
type Classified =
  | { kind: 'read-only'; process?: string }
  | { kind: 'WRITE-CAPABLE'; reason: string; chain: string; process?: string };

const VIA_EXTERNAL = 'completionAuthorityPolicy.ts -> externalIntegration.ts';
const VIA_HANDOFF = `${VIA_EXTERNAL} -> manualHandoff.ts`;

const CLOSURE: Record<string, Classified> = {
  'commandPolicy.ts': { kind: 'read-only' },
  'db.ts': {
    kind: 'WRITE-CAPABLE',
    reason:
      'opens the database: CREATE TABLE, db.exec and INSERT for migrations and seed rows; mkdirSync and chmodSync',
    chain: 'completionAuthorityPolicy.ts -> db.ts (type-only import)',
  },
  'executionBroker.ts': { kind: 'read-only' },
  'goalGit.ts': {
    kind: 'WRITE-CAPABLE',
    reason:
      'Git ref writes (update-ref through advanceGoalRef and initGoalRef), INSERT goal_integration_ops, UPDATE goal_runtime, mkdirSync',
    chain: `${VIA_EXTERNAL} -> goalGit.ts`,
    process: 'is the Git kit: imports node:child_process (execFile, spawn)',
  },
  'goals/activeWork.ts': { kind: 'read-only' },
  'goals/amendmentAuthority.ts': { kind: 'read-only' },
  'goals/approvals.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT goal_approvals (requestGoalApproval) and UPDATE goal_approvals (decideGoalApproval)',
    chain: 'completionAuthorityPolicy.ts -> attestationCorrection.ts -> approvals.ts',
  },
  'goals/approvedCompletionAuthority.ts': { kind: 'read-only' },
  'goals/attestationCorrection.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT goal_attestation_corrections',
    chain: 'completionAuthorityPolicy.ts -> attestationCorrection.ts (direct)',
  },
  'goals/attestationCorrectionDetail.ts': { kind: 'read-only' },
  'goals/bounds.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'calls transitionGoal, which writes the goal status',
    chain: `${VIA_HANDOFF} -> readModel.ts -> bounds.ts`,
  },
  'goals/completionAuthorityPolicy.ts': { kind: 'read-only' },
  'goals/completionEvaluation.ts': { kind: 'read-only' },
  'goals/completionPolicy.ts': { kind: 'read-only' },
  'goals/contentTreeComparison.ts': { kind: 'read-only' },
  'goals/contentTreeGitObservation.ts': {
    kind: 'read-only',
    process: 'imports node:child_process (spawn runs bounded read-only Git object queries)',
  },
  'goals/contentVerification.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT goal_content_verifications (persistContentVerification)',
    chain: `${VIA_EXTERNAL} -> externalCompletionProof.ts -> contentVerification.ts`,
  },
  'goals/cycles.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT and UPDATE goal_cycles, UPDATE goal_runtime',
    chain: `${VIA_EXTERNAL} -> finalApplyOperation.ts -> finalApplyAuthority.ts (type-only edge) -> cycles.ts`,
  },
  'goals/definitionHash.ts': { kind: 'read-only' },
  'goals/definitionValidation.ts': { kind: 'read-only' },
  'goals/definitions.ts': {
    kind: 'WRITE-CAPABLE',
    reason:
      'INSERT goals and goal_definition_versions, UPDATE goal_milestones and goal_definition_versions, calls transitionGoal',
    chain: `${VIA_HANDOFF} -> definitions.ts`,
  },
  'goals/events.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT goal_events',
    chain: 'completionAuthorityPolicy.ts -> attestationCorrection.ts -> events.ts',
  },
  'goals/externalCompletionDecisionRows.ts': { kind: 'read-only' },
  'goals/externalCompletionProof.ts': { kind: 'read-only' },
  'goals/externalIntegration.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT goal_external_integration_attestations (persistExternalIntegrationAttestation)',
    chain: `${VIA_EXTERNAL} (direct)`,
    process: 'imports node:child_process (promisified execFile runs git reads) and goalGit.ts',
  },
  'goals/externalIntegrationApproval.ts': { kind: 'read-only' },
  'goals/finalApply.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'update-ref on the base branch (applyApprovedGoalToBase), UPDATE goal_integration_ops',
    chain:
      'completionAuthorityPolicy.ts -> externalIntegration.ts -> goalGit.ts -> finalApply.ts (dynamic import() in goalGit.ts)',
    process: 'imports node:child_process (execFileSync runs git reads and update-ref) and goalGit.ts',
  },
  'goals/finalApplyAuthority.ts': {
    kind: 'read-only',
    process: 'imports goalGit.ts; reads only',
  },
  'goals/finalApplyOperation.ts': {
    kind: 'read-only',
    process: 'imports goalGit.ts; reads only',
  },
  'goals/findings.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT and UPDATE goal_findings and goal_finding_observations',
    chain: `${VIA_HANDOFF} -> completionEvaluation.ts -> findings.ts`,
  },
  'goals/freshness.ts': { kind: 'read-only' },
  'goals/independence.ts': { kind: 'read-only' },
  'goals/manualHandoff.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT goal_result_handoffs',
    chain: `${VIA_EXTERNAL} -> manualHandoff.ts`,
    process: 'imports goalGit.ts; the handoff write itself is a database write',
  },
  'goals/milestones.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'UPDATE goal_milestones (satisfy and reopen)',
    chain: `${VIA_HANDOFF} -> completionEvaluation.ts -> milestones.ts`,
  },
  'modelOpportunity.ts': {
    kind: 'WRITE-CAPABLE',
    reason:
      'INSERT model_observation_refreshes and model_observations; retention job INSERT plus bounded DELETEs and UPDATE',
    chain:
      'completionAuthorityPolicy.ts -> attestationCorrection.ts -> approvals.ts -> opportunityEvidence.ts -> modelOpportunity.ts',
  },
  'opportunityEvidence.ts': {
    kind: 'WRITE-CAPABLE',
    reason:
      'INSERT model_opportunity_admission_proofs after rechecking the approved binding and observations',
    chain:
      'completionAuthorityPolicy.ts -> attestationCorrection.ts -> approvals.ts -> opportunityEvidence.ts',
  },
  'goals/modelFamily.ts': { kind: 'read-only' },
  'goals/readModel.ts': { kind: 'read-only' },
  'goals/remediationPlan.ts': { kind: 'read-only' },
  'goals/repository.ts': {
    kind: 'read-only',
    process:
      'imports node:child_process (promisified execFile runs git cat-file blob) and goalGit.ts; reads only',
  },
  'goals/reviewPlan.ts': { kind: 'read-only' },
  'goals/reviews.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'INSERT and UPDATE goal_reviews',
    chain: `${VIA_HANDOFF} -> reviews.ts`,
  },
  'goals/routeAudit.ts': { kind: 'read-only' },
  'goals/routeIdentity.ts': { kind: 'read-only' },
  'goals/routeResolution.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'UPDATE goal_cycles route_resolution_json',
    chain: `${VIA_HANDOFF} -> readModel.ts -> routeResolution.ts`,
  },
  'goals/routeValidation.ts': { kind: 'read-only' },
  'goals/routing.ts': { kind: 'read-only' },
  'goals/stateMachine.ts': {
    kind: 'WRITE-CAPABLE',
    reason: 'transitionGoal: UPDATE goals status and status reason, the goal status writer',
    chain: `${VIA_HANDOFF} -> definitions.ts -> stateMachine.ts`,
  },
  'goals/verifierDigest.ts': { kind: 'read-only' },
  'security.ts': { kind: 'read-only' },
  'serialize.ts': { kind: 'read-only' },
};

/** The write-capable members, committed. A writer that becomes reachable, or a classified writer that stops writing, fails. */
const WRITE_CAPABLE = [
  'db.ts',
  'goalGit.ts',
  'goals/approvals.ts',
  'goals/attestationCorrection.ts',
  'goals/bounds.ts',
  'goals/contentVerification.ts',
  'goals/cycles.ts',
  'goals/definitions.ts',
  'goals/events.ts',
  'goals/externalIntegration.ts',
  'goals/finalApply.ts',
  'goals/findings.ts',
  'goals/manualHandoff.ts',
  'goals/milestones.ts',
  'goals/reviews.ts',
  'goals/routeResolution.ts',
  'goals/stateMachine.ts',
  'modelOpportunity.ts',
  'opportunityEvidence.ts',
];

describe('completion authority classifier: static import closure ratchet (residual)', () => {
  it('the walker counts dynamic import() and import types, so the edge that reaches finalApply.ts is seen', () => {
    expect(specifiersOf(join(SERVER_ROOT, 'goalGit.ts'))).toContain('./goals/finalApply.js');
    expect(specifiersOf(CLASSIFIER_FILE)).toContain('../db.js');
  });

  it('the closure is exactly the committed list, so a newly reachable module fails until it is classified', () => {
    expect(localClosure()).toEqual(Object.keys(CLOSURE).sort());
  });

  it('no decision, terminal, route or lock module is in the closure', () => {
    const closure = localClosure();
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(existsSync(join(SERVER_ROOT, forbidden)), forbidden).toBe(true);
      expect(closure, forbidden).not.toContain(forbidden);
    }
  });

  it('the write-capable members equal the committed set, by classification and by the text scan', () => {
    const closure = localClosure();
    const declared = Object.entries(CLOSURE)
      .filter(([, entry]) => entry.kind === 'WRITE-CAPABLE')
      .map(([file]) => file)
      .sort();
    const scanned = closure.filter((file) =>
      WRITE_SIGNATURES.some((signature) => signature.test(readFileSync(join(SERVER_ROOT, file), 'utf8'))),
    );
    expect(declared).toEqual(WRITE_CAPABLE);
    expect(scanned).toEqual(WRITE_CAPABLE);
  });

  it('every module that imports node:child_process or goalGit is in the closure with a recorded reason', () => {
    const importers = localClosure().filter((file) => importsProcessOrGit(join(SERVER_ROOT, file)));
    const listed = Object.entries(CLOSURE)
      .filter(([, entry]) => entry.process !== undefined)
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual(listed);
  });
});

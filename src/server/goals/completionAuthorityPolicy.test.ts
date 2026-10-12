import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  v2DecidedFixture,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

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
  return { ...report.actionFields, userReviewedPreflightDigest: report.digest };
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
      // Slice 1 changes no preflight behaviour: a recorded decision still refuses the other attestation today.
      const preflight = await computeExternalCompletionPreflight(db, goalId, { attestationId: otherId });
      expect(preflight.reasons[0]?.code).toBe('completion_already_recorded');
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

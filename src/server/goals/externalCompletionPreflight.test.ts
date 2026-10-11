import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvedCompletionPolicyMode } from './approvedCompletionAuthority.js';
import { buildExternalCompletionAction, parseExternalCompletionAction } from './externalCompletionProof.js';
import {
  PREFLIGHT_CHECK_NAMES,
  computeEmptyCorrectionChainIdentity,
  computeExternalCompletionPreflight,
  computeMilestoneIdentityDigest,
  externalCompletionPreflightReportSchema,
  type ExternalCompletionPreflightReport,
  type PreflightCheckName,
  type PreflightReasonCode,
} from './externalCompletionPreflight.js';
import { withExternalIntegrationVerificationSlot } from './externalIntegrationWorkflow.js';
import { pauseGoal } from './goalCommands.js';
import { transitionGoal } from './stateMachine.js';
import {
  acceptedFixture,
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  v2AttestedFixture,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { getAttestationCorrectionStanding } from './attestationCorrection.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;
const NOW = '2026-01-01T00:00:00.000Z';

function compute(fx: GoalFixture, attestationId: string) {
  return computeExternalCompletionPreflight(fx.db, fx.goalId, { attestationId });
}

function expectRefusal(
  report: ExternalCompletionPreflightReport,
  code: PreflightReasonCode,
  detail: string | null,
  check: PreflightCheckName,
): void {
  expect(report.outcome).toBe('refused');
  expect(report.reasons).toEqual([{ code, detail }]);
  expect(report.actionFields).toBeNull();
  expect(report.checks.find(({ status }) => status === 'failed')).toEqual({ name: check, status: 'failed' });
  expect(externalCompletionPreflightReportSchema.parse(report)).toEqual(report);
}

function emptyChainDigest(attestationId: string, recordDigest: string): string {
  // Written out by hand, not through the service, so the expected digest is independent of the implementation.
  const canonical = `{"attestationId":"${attestationId}","attestationRecordDigest":"${recordDigest}","kind":"turing_goal_external_integration_correction_chain","schemaVersion":1,"sequence":0,"tipCorrectionDigest":null}`;
  return createHash('sha256')
    .update('turing-goal-attestation-correction-chain-v1')
    .update('\0')
    .update(canonical)
    .digest('hex');
}

/** Starts an approved Goal exactly as the user-start path does; completion can only leave `running`. */
function startGoal(db: GoalFixture['db'], goalId: string): void {
  transitionGoal(db, {
    goalId,
    to: 'running',
    reasonCode: 'user_start',
    actor: 'user',
    preconditions: [{ code: 'preflight', ok: true }],
  });
}

function rewriteStoredContract(fx: GoalFixture, mutate: (contract: Record<string, unknown>) => void): void {
  const row = fx.db
    .prepare('SELECT contract_json FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
    .get(fx.goalId) as { contract_json: string };
  const contract = JSON.parse(row.contract_json) as Record<string, unknown>;
  mutate(contract);
  fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
  fx.db
    .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = 1')
    .run(JSON.stringify(contract), fx.goalId);
}

describe('external completion preflight: ready outcome', () => {
  it.each(FORMATS)(
    'T1 is ready for an exactly attested version-2 Goal under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const report = await compute(attested.fx, attested.attestationId);
      const record = attested.attestation;

      expect(report.outcome).toBe('ready');
      expect(report.reasons).toEqual([]);
      expect(report.checks).toEqual(PREFLIGHT_CHECK_NAMES.map((name) => ({ name, status: 'passed' })));
      expect(report.facts).toMatchObject({
        goalStatus: 'running',
        mode: 'external_user_attested_v2',
        handoffId: record.handoff.id,
        handoffDigest: record.handoff.digest,
        attestationActionDigest: record.actionDigest,
        attestationRecordDigest: record.recordDigest,
        correctionStanding: 'active_uncontested',
        correctionSequence: 0,
        destinationRef: record.destination.ref,
        attestedCommit: record.destination.observedCommit,
        attestedTree: record.destination.observedTree,
        freshCommit: record.destination.observedCommit,
        freshTree: record.destination.observedTree,
        objectFormat,
      });
      expect(report.proofLimitations).toEqual({
        contentPreservation: 'not_proven',
        goalCompletion: 'not_completed_by_preflight',
        destinationPolicy: 'exact_attested_tip',
      });
      expect(report.authority).toEqual({
        mintsApproval: false,
        mintsProof: false,
        mintsTerminalAuthority: false,
      });

      const action = buildExternalCompletionAction({
        ...report.actionFields!,
        userReviewedPreflightDigest: report.digest,
      });
      expect(action).not.toBeNull();
      expect(parseExternalCompletionAction(action)).toMatchObject({
        valid: true,
        digest: action!.actionDigest,
      });
      expect(report.actionFields!.correctionChain).toMatchObject({
        sequence: 0,
        standing: 'active_uncontested',
        digest: emptyChainDigest(attested.attestationId, record.recordDigest),
      });
      expect(
        computeEmptyCorrectionChainIdentity({
          attestationId: attested.attestationId,
          attestationRecordDigest: record.recordDigest,
        }).digest,
      ).toBe(emptyChainDigest(attested.attestationId, record.recordDigest));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T2 is still ready when the observation discarded the accepted content',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1', { strategy: 'ours' });
      const report = await compute(attested.fx, attested.attestationId);
      expect(report.outcome).toBe('ready');
      expect(report.proofLimitations.contentPreservation).toBe('not_proven');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T3 repeats to an identical report and digest, is time-free, and differs by object format',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const first = await compute(attested.fx, attested.attestationId);
      const second = await compute(attested.fx, attested.attestationId);
      expect(second).toEqual(first);
      expect(second.digest).toBe(first.digest);
      expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);

      const other = await v2RunningAttestedFixture('sha256');
      const otherReport = await compute(other.fx, other.attestationId);
      expect(otherReport.digest).not.toBe(first.digest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion preflight: input and state refusals', () => {
  it(
    'T4 refuses a malformed attestation id, an unknown Goal, and an unknown attestation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      expectRefusal(await compute(attested.fx, 'not-a-uuid'), 'attestation_id_invalid', null, 'input');
      const unknownGoal = await computeExternalCompletionPreflight(attested.fx.db, randomUUID(), {
        attestationId: attested.attestationId,
      });
      expectRefusal(unknownGoal, 'goal_not_found', null, 'input');
      expectRefusal(await compute(attested.fx, randomUUID()), 'attestation_not_found', null, 'attestation');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T4b does not expose an attestation that belongs to a different Goal database',
    async () => {
      // Each fixture owns a separate database, so this proves the lookup is scoped to the Goal being checked.
      const mine = await v2RunningAttestedFixture('sha1');
      const other = await v2RunningAttestedFixture('sha1');
      expectRefusal(
        await compute(mine.fx, other.attestationId),
        'attestation_not_found',
        null,
        'attestation',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T5 refuses a paused Goal with its status as the detail',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      pauseGoal(attested.fx.db, attested.fx.goalId);
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'goal_not_running',
        'paused',
        'goal_status',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T6a refuses a version-1 definition as not version 2',
    async () => {
      const accepted = await acceptedFixture('sha1');
      startGoal(accepted.fx.db, accepted.fx.goalId);
      const report = await computeExternalCompletionPreflight(accepted.fx.db, accepted.fx.goalId, {
        attestationId: randomUUID(),
      });
      expectRefusal(report, 'definition_not_v2', 'legacy_v1', 'definition');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T6c refuses a corrupted stored definition and reports no approved mode',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      rewriteStoredContract(attested.fx, (contract) => {
        contract.outcome = 'A different outcome stored after approval.';
      });
      expect(approvedCompletionPolicyMode(attested.fx.db, attested.fx.goalId, 1)).toBeNull();
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'definition_not_approved',
        null,
        'definition',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T6d refuses a definition whose version-2 discriminators were stripped after approval',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      rewriteStoredContract(attested.fx, (contract) => {
        const policy = contract.completionPolicy as Record<string, unknown>;
        delete policy.completionContractVersion;
        delete policy.integrationMode;
      });
      expect(approvedCompletionPolicyMode(attested.fx.db, attested.fx.goalId, 1)).toBeNull();
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'definition_not_approved',
        null,
        'definition',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T7 refuses when a completion proof is already recorded, and leaves that proof untouched',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const row = proofRow(attested.fx.goalId);
      // The row only occupies the table; its referenced rows are not part of this check, so FK checks are off for the insert.
      attested.fx.db.pragma('foreign_keys = OFF');
      attested.fx.db.exec('DROP TRIGGER trg_goal_external_completion_proof_insert_authority;');
      const columns = Object.keys(row);
      attested.fx.db
        .prepare(
          `INSERT INTO goal_external_completion_proofs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .run(...Object.values(row));
      attested.fx.db.pragma('foreign_keys = ON');
      const before = databaseSnapshot(attested.fx.db);
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'completion_already_recorded',
        null,
        'prior_completion',
      );
      expect(databaseSnapshot(attested.fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T8 refuses a tampered stored attestation as invalid',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const tampered = { ...attested.attestation, observedAt: '2020-01-01T00:00:00.000Z' };
      attested.fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      attested.fx.db
        .prepare(
          'UPDATE goal_external_integration_attestations SET payload_json = ?, observed_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(tampered), tampered.observedAt, attested.attestationId);
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'attestation_invalid',
        null,
        'attestation',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T20 refuses a Goal that was never started, with its stored status as the detail',
    async () => {
      const attested = await v2AttestedFixture('sha1');
      const status = (
        attested.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(attested.fx.goalId) as {
          status: string;
        }
      ).status;
      expect(status).toBe('ready');
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'goal_not_running',
        status,
        'goal_status',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion preflight: correction standing', () => {
  it(
    'T9a refuses a disputed attestation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      appendCorrectionForTest(attested.fx, attested.attestationId, 'dispute');
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'attestation_disputed',
        null,
        'correction_standing',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T9b refuses a withdrawn attestation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      appendCorrectionForTest(attested.fx, attested.attestationId, 'withdraw');
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'attestation_withdrawn',
        null,
        'correction_standing',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T9c refuses the superseded attestation and accepts its replacement',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      git(attested.fx.repo, 'update-ref', attested.handoff.target.baseRef, moveTip(attested));
      const replacement = await reattestAtCurrentTip(attested);
      appendCorrectionForTest(attested.fx, attested.attestationId, 'supersede', replacement.attestationId);
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'attestation_superseded',
        null,
        'correction_standing',
      );
      const replacementReport = await compute(attested.fx, replacement.attestationId);
      expect(replacementReport.outcome).toBe('ready');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T9d reports the real invalid code when a stored correction fails verification',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      appendCorrectionForTest(attested.fx, attested.attestationId, 'dispute');
      const stored = attested.fx.db
        .prepare(
          'SELECT payload_json FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?',
        )
        .get(attested.fx.goalId, attested.attestationId) as { payload_json: string };
      const forged = {
        ...(JSON.parse(stored.payload_json) as Record<string, unknown>),
        correctionDigest: 'f'.repeat(64),
      };
      attested.fx.db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      attested.fx.db
        .prepare(
          'UPDATE goal_attestation_corrections SET payload_json = ?, correction_digest = ? WHERE goal_id = ? AND attestation_id = ?',
        )
        .run(JSON.stringify(forged), 'f'.repeat(64), attested.fx.goalId, attested.attestationId);
      const standing = getAttestationCorrectionStanding(
        attested.fx.db,
        attested.fx.goalId,
        attested.attestationId,
      );
      expect(standing.standing).toBe('invalid');
      expect(standing.invalidCode).not.toBeNull();
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'correction_standing_invalid',
        standing.invalidCode,
        'correction_standing',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion preflight: destination and Git', () => {
  it(
    'T10 refuses an attestation whose destination advanced, and accepts a fresh attestation at the new tip',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const oldRow = attested.fx.db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(attested.attestationId);
      git(attested.fx.repo, 'update-ref', attested.handoff.target.baseRef, moveTip(attested));

      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'destination_advanced_after_observation',
        'destination_advanced_after_observation',
        'git_observation',
      );
      const fresh = await reattestAtCurrentTip(attested);
      expect((await compute(attested.fx, fresh.attestationId)).outcome).toBe('ready');
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'destination_advanced_after_observation',
        'destination_advanced_after_observation',
        'git_observation',
      );
      expect(
        attested.fx.db
          .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
          .get(attested.attestationId),
      ).toEqual(oldRow);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T11c refuses when the destination no longer contains the accepted source',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      git(
        attested.fx.repo,
        'update-ref',
        attested.handoff.target.baseRef,
        attested.attestation.destination.expectedBaseCommit,
      );
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'destination_not_integrated',
        'source_not_ancestor',
        'git_observation',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T11e refuses while two verifications already hold the Goal slots, then releases them',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const releases: (() => void)[] = [];
      const hold = () =>
        withExternalIntegrationVerificationSlot(
          attested.fx.goalId,
          () => new Promise<void>((resolve) => releases.push(resolve)),
        );
      const holders = [hold(), hold()];
      try {
        expectRefusal(
          await compute(attested.fx, attested.attestationId),
          'verification_busy',
          null,
          'git_observation',
        );
      } finally {
        releases.forEach((release) => release());
        await Promise.all(holders);
      }
      expect((await compute(attested.fx, attested.attestationId)).outcome).toBe('ready');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T21 refuses as a stale observation when the destination ref was deleted after attestation',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      // The base ref is the checked-out branch. Move HEAD to a branch at the same commit first: deleting it would
      // leave HEAD unborn, and a detached HEAD fails `symbolic-ref` in repositoryState.
      git(attested.fx.repo, 'branch', 'retained-head');
      git(attested.fx.repo, 'symbolic-ref', 'HEAD', 'refs/heads/retained-head');
      git(attested.fx.repo, 'update-ref', '-d', attested.handoff.target.baseRef);
      const before = databaseSnapshot(attested.fx.db);
      const repoBefore = repositoryState(attested.fx.repo);
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'attestation_stale',
        'destination_ref_missing',
        'git_observation',
      );
      expect(databaseSnapshot(attested.fx.db)).toEqual(before);
      expect(repositoryState(attested.fx.repo)).toEqual(repoBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T22 refuses as a stale observation when the Goal ref is served by a repository with another identity',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const clone = join(dirname(attested.fx.repo), 'clone');
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', attested.fx.repo, clone]);
      git(
        clone,
        'branch',
        attested.handoff.source.goalRef.slice('refs/heads/'.length),
        attested.handoff.source.commit,
      );
      attested.fx.db
        .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
        .run(clone, clone, attested.fx.projectId);
      const before = databaseSnapshot(attested.fx.db);
      expectRefusal(
        await compute(attested.fx, attested.attestationId),
        'attestation_stale',
        'repository_identity_changed',
        'git_observation',
      );
      expect(databaseSnapshot(attested.fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion preflight: no writes', () => {
  it.each(FORMATS)(
    'T12 writes nothing to the database or the repository under %s',
    async (objectFormat) => {
      const ready = await v2RunningAttestedFixture(objectFormat);
      const snapshotBefore = {
        database: databaseSnapshot(ready.fx.db),
        repo: repositoryState(ready.fx.repo),
        goal: ready.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(ready.fx.goalId),
        attestation: ready.fx.db
          .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
          .get(ready.attestationId),
      };
      expect((await compute(ready.fx, ready.attestationId)).outcome).toBe('ready');
      expect({
        database: databaseSnapshot(ready.fx.db),
        repo: repositoryState(ready.fx.repo),
        goal: ready.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(ready.fx.goalId),
        attestation: ready.fx.db
          .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
          .get(ready.attestationId),
      }).toEqual(snapshotBefore);

      const refused = await v2RunningAttestedFixture(objectFormat);
      const beforeRefused = databaseSnapshot(refused.fx.db);
      const repoBeforeRefused = repositoryState(refused.fx.repo);
      git(refused.fx.repo, 'update-ref', refused.handoff.target.baseRef, moveTip(refused));
      const repoAfterMove = repositoryState(refused.fx.repo);
      expect((await compute(refused.fx, refused.attestationId)).outcome).toBe('refused');
      expect(databaseSnapshot(refused.fx.db)).toEqual(beforeRefused);
      expect(repositoryState(refused.fx.repo)).toEqual(repoAfterMove);
      expect(repoAfterMove).not.toEqual(repoBeforeRefused);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('T12b keeps the service source free of write statements, write entry points and non-SELECT prepares', () => {
    const source = readFileSync(new URL('./externalCompletionPreflight.ts', import.meta.url), 'utf8');
    expect(preparedLiterals(source).length).toBeGreaterThan(0);
    expect(scanPreflightSource(source)).toEqual([]);
  });

  it('T12b scanner is clean on a negative control that uses update() and lowercase SELECT', () => {
    const control = [
      "const digest = createHash('sha256').update(domain).update('\\0');",
      "const row = db.prepare('select status from goals where id = ?').get(goalId);",
    ].join('\n');
    expect(scanPreflightSource(control)).toEqual([]);
  });

  it.each([
    [
      'double-quoted lowercase insert',
      'db.prepare("insert into goals (id) values (1)");',
      ['prepare_not_select', 'sql_write'],
    ],
    [
      'template mixed-case update',
      "db.prepare(`Update goals set status = 'x'`);",
      ['prepare_not_select', 'sql_write'],
    ],
    ['mixed-case delete', 'const sql = "DeLeTe FrOm goals";', ['sql_write']],
    ['concatenated prepare', "db.prepare('SELECT 1 ' + x);", ['prepare_not_literal']],
    ['interpolated prepare', 'db.prepare(`SELECT ${t}`);', ['prepare_dynamic']],
    ['variable prepare', 'db.prepare(sql);', ['prepare_not_literal']],
    [
      'multi-statement prepare',
      'db.prepare("SELECT 1; DROP TABLE goals");',
      ['prepare_multi_statement', 'sql_write'],
    ],
    ['bracket prepare', "db['prepare']('SELECT 1');", ['prepare_not_literal']],
    ['run call', 'stmt.run();', ['write_entry']],
    ['exec call', "db.exec('x');", ['write_entry']],
    ['immediate transaction', 'BEGIN immediate', ['write_entry']],
    ['Goal event writer', 'writeGoalEvent(db, event);', ['identifier:writeGoalEvent']],
    ['hub publisher', 'hub.publishGoal(goal);', ['identifier:publishGoal']],
    ['master event hub', 'const hub = new MasterEventHub();', ['identifier:MasterEventHub']],
    [
      'events import',
      "import { writeGoalEvent } from './events.js';",
      ['identifier:writeGoalEvent', 'import_module'],
    ],
    ['masterEvents import', "import { x } from '../masterEvents.js';", ['import_module']],
    [
      'decision recorder call',
      'await recordExternalCompletionDecision(db, input);',
      ['identifier:recordExternalCompletionDecision'],
    ],
    [
      'decision module import',
      "import { recordExternalCompletionDecision } from './externalCompletionDecision.js';",
      [
        'identifier:externalCompletionDecision',
        'identifier:recordExternalCompletionDecision',
        'import_module',
      ],
    ],
    [
      'completion lock import',
      "import { withGoalCompletionLock } from './goalCompletionLock.js';",
      ['identifier:goalCompletionLock', 'identifier:withGoalCompletionLock', 'import_module'],
    ],
    [
      'completion terminal import',
      "import { x } from './externalCompletionTerminal.js';",
      ['identifier:externalCompletionTerminal', 'import_module'],
    ],
    ['bare completion module import', "import { x } from './externalCompletion.js';", ['import_module']],
  ])('T12b scanner flags %s with exact rules', (_label, snippet, expected) => {
    expect(scanPreflightSource(snippet)).toEqual(expected);
  });
});

describe('external completion preflight: golden identities', () => {
  it('T13 pins the chain and milestone identities to independently computed digests', () => {
    const chain = computeEmptyCorrectionChainIdentity({
      attestationId: '11111111-1111-4111-8111-111111111111',
      attestationRecordDigest: 'ab'.repeat(32),
    });
    expect(chain.digest).toBe('22b6857ba302a660ad9e2e055f513f3857f81fec81020d6cbcc54ea6af0e3a98');
    const other = computeEmptyCorrectionChainIdentity({
      attestationId: '11111111-1111-4111-8111-111111111111',
      attestationRecordDigest: 'cd'.repeat(32),
    });
    expect(other.digest).not.toBe(chain.digest);

    const milestones = computeMilestoneIdentityDigest({
      milestones: [
        {
          key: 'm1',
          milestoneId: '22222222-2222-4222-8222-222222222222',
          state: 'satisfied',
          blockers: [],
          skipApprovalId: null,
        },
      ],
    } as unknown as Parameters<typeof computeMilestoneIdentityDigest>[0]);
    expect(milestones).toBe('929d475b9c1135b059cba201246cdfa237d9498d3f0d9a7e4529dc33aa459797');
  });
});

const SQL_WRITE =
  /\b(?:insert\s+(?:or\s+\w+\s+)?into|update\s+(?:or\s+\w+\s+)?["`[]?\w+["`\]]?\s+set|delete\s+from|replace\s+into|create\s+(?:(?:temp|temporary|unique|virtual)\s+)*(?:table|index|trigger|view)|drop\s+(?:table|index|trigger|view)|alter\s+table|pragma\s+\w+|vacuum|reindex|attach\s+database|detach\s+database)\b/i;
const WRITE_ENTRY =
  /\.(?:run|exec|immediate|exclusive|pragma|backup|loadExtension)\s*\(|\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i;
const PREPARE_CALL = /\.prepare\s*\(/g;
const PREPARE_LITERAL =
  /\.prepare\s*\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*[,)]/gs;
const PREPARE_BRACKET = /\[\s*['"`]prepare['"`]\s*\]/;
const IMPORT_MODULE =
  /from\s+['"][^'"]*\/(?:stateMachine|completion|goalCommands|approvals|events|masterEvents|webPush|externalCompletion|externalCompletionDecision|externalCompletionTerminal|goalCompletionLock)\.js['"]/;
const FORBIDDEN_IDENTIFIERS = [
  'transitionGoal',
  'completeGoal',
  'checkCompletionProof',
  'requestGoalApproval',
  'decideGoalApproval',
  'decideGoalApprovalAsUser',
  'persistExternalIntegrationAttestation',
  'confirmExternalIntegration',
  'prepareManualHandoff',
  'buildManualHandoffSnapshot',
  'requestAttestationCorrectionApproval',
  'appendAttestationCorrection',
  'writeGoalEvent',
  'recordCompletionEvaluation',
  'onGoalTransition',
  'publishGoal',
  'publishRun',
  'MasterEventHub',
  'MasterEventPublisher',
  'createMasterEventPublisher',
  'noticeForMasterEvent',
  'deliverPush',
  'webPush',
  'externalCompletionDecision',
  'recordExternalCompletionDecision',
  'readExternalCompletionDecision',
  'listExternalCompletionDecisions',
  'externalCompletionTerminal',
  'goalCompletionLock',
  'withGoalCompletionLock',
  'completeGoalFromExternalDecision',
];

/** The SQL text of every `.prepare('...')` call whose argument is a single literal. */
function preparedLiterals(source: string): string[] {
  return [...source.matchAll(PREPARE_LITERAL)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * Static scan of service source. Returns the sorted names of every rule the source breaks. SQL verbs are matched in
 * SQL shape, so `hash.update(x)` is not a write, and a case-insensitive match covers literals in any quote style.
 */
function scanPreflightSource(source: string): string[] {
  const found = new Set<string>();
  if (SQL_WRITE.test(source)) found.add('sql_write');
  if (WRITE_ENTRY.test(source)) found.add('write_entry');
  const calls = source.match(PREPARE_CALL)?.length ?? 0;
  const literals = preparedLiterals(source);
  if (calls !== literals.length || PREPARE_BRACKET.test(source)) found.add('prepare_not_literal');
  for (const statement of literals) {
    if (statement.includes('${')) found.add('prepare_dynamic');
    if (!/^\s*select\s/i.test(statement)) found.add('prepare_not_select');
    if (/;\s*\S/.test(statement)) found.add('prepare_multi_statement');
  }
  if (IMPORT_MODULE.test(source)) found.add('import_module');
  for (const identifier of FORBIDDEN_IDENTIFIERS)
    if (source.includes(identifier)) found.add(`identifier:${identifier}`);
  return [...found].sort();
}

/** Moves the destination base ref to a commit that keeps the attested tree but drops the accepted source. */
function moveTip(attested: Awaited<ReturnType<typeof v2AttestedFixture>>): string {
  return git(
    attested.fx.repo,
    'commit-tree',
    attested.attestation.destination.observedTree,
    '-p',
    attested.attestation.destination.observedCommit,
    '-m',
    'destination moved after observation',
  );
}

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

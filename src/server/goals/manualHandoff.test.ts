import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, disabledSupervisor, goalApp } from './apiKit.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
import { decideGoalApprovalAsUser } from './goalCommands.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { approvedCompletionPolicyMode } from './approvedCompletionAuthority.js';
import { beginAmendment, approveDefinition, createGoalDraft, loadDefinitionVersion } from './definitions.js';
import { recordEvidence } from './evidence.js';
import type { GoalDefinition } from '../../shared/goals.js';
import { prepareFinalApplyIntent } from './finalApplyAuthority.js';
import { applyReviewFindings } from './findings.js';
import {
  ManualHandoffError,
  getManualHandoffProjection,
  prepareManualHandoff,
  validateManualHandoff,
  validateManualHandoffAuthorityForExternalIntegration,
} from './manualHandoff.js';
import {
  buildExternalIntegrationObservation,
  computeExternalIntegrationActionDigest,
  approvalIdentityMatchesRow,
  createExternalIntegrationApprovalDetail,
  getExternalIntegrationProjection,
  persistExternalIntegrationAttestation,
  validateExternalIntegrationAttestation,
  validateExternalIntegrationObservation,
} from './externalIntegration.js';
import { openDatabase, type Db } from '../db.js';
import { canonicalJson } from './definitionHash.js';
import {
  AttestationCorrectionError,
  appendAttestationCorrection,
  buildAttestationCorrectionAction,
  attestationCorrectionStandingAllowsCompletion,
  getAttestationCorrectionStanding,
  listAttestationCorrectionHistory,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import {
  computeAttestationCorrectionActionDigest,
  computeAttestationCorrectionRecordDigest,
} from './attestationCorrectionDetail.js';
import { closeReview, completeReview, createReview, getReview } from './reviews.js';
import { cleanupRepoFixtures, goalRepoFixture, simpleDefinition } from './repoKit.js';
import { createCycle } from './cycles.js';
import { GoalStateError, transitionGoal } from './stateMachine.js';
import {
  acceptedFixture,
  approveExternalObservation,
  git,
  integratedExternalFixture,
  passingReport,
  repositoryState,
} from './goalV2TestKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

async function expectInjectedRefRace(
  fx: Awaited<ReturnType<typeof acceptedFixture>>['fx'],
  ref: string,
  replacement: string,
): Promise<void> {
  const wrapperDirectory = join(fx.repo, '.handoff-test-git-bin');
  mkdirSync(wrapperDirectory);
  const wrapper = join(wrapperDirectory, 'git');
  const counter = join(wrapperDirectory, 'counter');
  const lock = join(wrapperDirectory, 'lock');
  const marker = join(wrapperDirectory, 'injected');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'if [ "$1" = "for-each-ref" ]; then',
      '  while ! mkdir "$HANDOFF_GIT_LOCK" 2>/dev/null; do :; done',
      '  count=0',
      '  if [ -f "$HANDOFF_GIT_COUNTER" ]; then count=$(cat "$HANDOFF_GIT_COUNTER"); fi',
      '  count=$((count + 1))',
      '  printf "%s" "$count" > "$HANDOFF_GIT_COUNTER"',
      '  rmdir "$HANDOFF_GIT_LOCK"',
      '  if [ "$count" -eq 6 ]; then',
      '    "$HANDOFF_GIT_REAL" update-ref "$HANDOFF_RACE_REF" "$HANDOFF_RACE_TO" || exit $?',
      '    : > "$HANDOFF_RACE_MARKER"',
      '  fi',
      'fi',
      'exec "$HANDOFF_GIT_REAL" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o700);
  const originalPath = process.env.PATH;
  const originalEnvironment = {
    real: process.env.HANDOFF_GIT_REAL,
    counter: process.env.HANDOFF_GIT_COUNTER,
    lock: process.env.HANDOFF_GIT_LOCK,
    ref: process.env.HANDOFF_RACE_REF,
    to: process.env.HANDOFF_RACE_TO,
    marker: process.env.HANDOFF_RACE_MARKER,
  };
  process.env.PATH = `${wrapperDirectory}:${originalPath ?? ''}`;
  process.env.HANDOFF_GIT_REAL = realGit;
  process.env.HANDOFF_GIT_COUNTER = counter;
  process.env.HANDOFF_GIT_LOCK = lock;
  process.env.HANDOFF_RACE_REF = ref;
  process.env.HANDOFF_RACE_TO = replacement;
  process.env.HANDOFF_RACE_MARKER = marker;
  try {
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({ code: 'snapshot_changed' });
    expect(readFileSync(marker, 'utf8')).toBe('');
  } finally {
    process.env.PATH = originalPath;
    for (const [key, value] of Object.entries({
      HANDOFF_GIT_REAL: originalEnvironment.real,
      HANDOFF_GIT_COUNTER: originalEnvironment.counter,
      HANDOFF_GIT_LOCK: originalEnvironment.lock,
      HANDOFF_RACE_REF: originalEnvironment.ref,
      HANDOFF_RACE_TO: originalEnvironment.to,
      HANDOFF_RACE_MARKER: originalEnvironment.marker,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(wrapperDirectory, { recursive: true, force: true });
  }
}

interface AmendedFixtureOptions {
  includeVersion2Evidence?: boolean;
  includeVersion2Review?: boolean;
  includeVersion2Acceptance?: boolean;
}

function revisedTestDefinition(definition: GoalDefinition): GoalDefinition {
  const revised = structuredClone(definition);
  revised.contract.outcome = 'The same reviewed result under an amended Goal contract.';
  const criterion = revised.contract.successCriteria.find(({ key }) => key === 'deliverable')!;
  criterion.verification = [{ kind: 'file_exists', path: 'src/parser.ts' }];
  return revised;
}

async function amendedAcceptedFixture(options: AmendedFixtureOptions = {}) {
  const original = await acceptedFixture();
  const { fx, sourceCommit } = original;
  const version1Handoff = (await prepareManualHandoff(fx.db, fx.goalId)).record;
  const v1Definition = loadDefinitionVersion(fx.db, fx.goalId, 1)!;
  const revised = revisedTestDefinition(fx.definition);
  const proposal = beginAmendment(fx.db, {
    goalId: fx.goalId,
    actor: 'user',
    changeSummary: 'Amend the accepted Goal definition.',
    definition: revised,
  });
  const approved = approveDefinition(fx.db, {
    goalId: fx.goalId,
    version: proposal.version,
    expectedDefinitionHash: proposal.definitionHash,
    actor: 'user',
  });
  const version2 = loadDefinitionVersion(fx.db, fx.goalId, proposal.version)!;
  const version1AfterAmendment = loadDefinitionVersion(fx.db, fx.goalId, 1)!;
  const version2Approval = getGoalApproval(fx.db, approved.approvalId);

  if (options.includeVersion2Evidence !== false)
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: proposal.version,
      criterionKey: 'deliverable',
      verifierDigest: fx.digest('deliverable', 0, proposal.version),
      kind: 'artifact',
      milestoneId: fx.milestoneId('m1'),
    });

  let version2ReviewId: string | null = null;
  if (options.includeVersion2Review !== false) {
    const pendingReview = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: proposal.version,
      reviewKind: 'final',
    });
    version2ReviewId = pendingReview.id;
    completeReview(fx.db, {
      reviewId: pendingReview.id,
      report: passingReport,
      independence: {
        established: true,
        policy: 'different-family',
        detail: { fixture: 'service-recorded-amendment' },
      },
    });
  }

  let version2AcceptanceId: string | null = null;
  if (options.includeVersion2Acceptance !== false) {
    const acceptance = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_acceptance',
      risk: 'medium',
      reason: 'Accept the amended Goal result.',
      requestedBy: 'user',
      detail: {
        definitionVersion: proposal.version,
        definitionHash: proposal.definitionHash,
        integrationHead: sourceCommit,
        integrationTree: fx.tree(sourceCommit),
      },
    });
    decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: acceptance.id,
      decision: 'approved',
      decidedBy: 'user',
    });
    version2AcceptanceId = acceptance.id;
  }

  const evaluation = await evaluateCompletion(fx.db, fx.goalId);
  return {
    ...original,
    version1Handoff,
    v1Definition,
    proposal,
    approved,
    version2,
    version1AfterAmendment,
    version2Approval,
    version2ReviewId,
    version2AcceptanceId,
    evaluation,
  };
}

function dropApprovalIdentityTriggers(db: Awaited<ReturnType<typeof acceptedFixture>>['fx']['db']): void {
  db.exec(
    'DROP TRIGGER IF EXISTS trg_goal_approval_identity; DROP TRIGGER IF EXISTS trg_goal_approval_terminal;',
  );
}

function dropDefinitionImmutabilityTrigger(
  db: Awaited<ReturnType<typeof acceptedFixture>>['fx']['db'],
): void {
  db.exec('DROP TRIGGER IF EXISTS trg_goal_definition_immutable;');
}

function otherGoalAmendmentApprovalId(fx: Awaited<ReturnType<typeof acceptedFixture>>['fx']): string {
  const other = createGoalDraft(fx.db, {
    projectId: fx.projectId,
    title: 'A separate amended Goal',
    definition: structuredClone(fx.definition),
  });
  approveDefinition(fx.db, { goalId: other.goalId, version: 1, actor: 'user' });
  const revised = revisedTestDefinition(fx.definition);
  const proposal = beginAmendment(fx.db, {
    goalId: other.goalId,
    actor: 'user',
    definition: revised,
  });
  return approveDefinition(fx.db, {
    goalId: other.goalId,
    version: proposal.version,
    expectedDefinitionHash: proposal.definitionHash,
    actor: 'user',
  }).approvalId;
}

describe('manual integration handoff', () => {
  it('prepares a legitimate amended definition handoff after every v2 prerequisite is satisfied', async () => {
    const amended = await amendedAcceptedFixture();
    expect(amended.v1Definition).toMatchObject({
      version: 1,
      parentVersion: null,
      status: 'approved',
      approvalId: expect.any(String),
      approvedBy: 'user',
    });
    expect(amended.version1AfterAmendment).toMatchObject({
      version: 1,
      parentVersion: null,
      status: 'superseded',
      approvalId: amended.v1Definition.approvalId,
      approvedBy: 'user',
    });
    expect(amended.version2).toMatchObject({
      version: 2,
      parentVersion: 1,
      status: 'approved',
      approvalId: amended.approved.approvalId,
      approvedBy: 'user',
      definitionHash: amended.proposal.definitionHash,
    });
    expect(amended.version2Approval).toMatchObject({
      id: amended.approved.approvalId,
      goalId: amended.fx.goalId,
      gate: 'amendment',
      status: 'approved',
      decidedBy: 'user',
      detail: { version: 2, definitionHash: amended.proposal.definitionHash },
    });
    expect(getReview(amended.fx.db, amended.version2ReviewId!)).toMatchObject({
      goalId: amended.fx.goalId,
      definitionVersion: 2,
      reviewKind: 'final',
      status: 'completed',
      reviewedToCommit: amended.sourceCommit,
      reviewedToTree: amended.fx.tree(amended.sourceCommit),
      verdict: 'pass',
      blocking: false,
      independence: { established: true, policy: 'different-family' },
    });
    expect(getGoalApproval(amended.fx.db, amended.version2AcceptanceId!)).toMatchObject({
      goalId: amended.fx.goalId,
      gate: 'final_acceptance',
      status: 'approved',
      decidedBy: 'user',
      detail: {
        definitionVersion: 2,
        definitionHash: amended.proposal.definitionHash,
        integrationHead: amended.sourceCommit,
        integrationTree: amended.fx.tree(amended.sourceCommit),
      },
    });
    expect(amended.evaluation.failures.map(({ code }) => code)).toEqual(['final_apply_required']);
    expect(amended.evaluation.criteria.every((criterion) => criterion.state === 'satisfied')).toBe(true);
    expect(amended.evaluation.milestones.every((milestone) => milestone.state === 'satisfied')).toBe(true);
    expect(amended.evaluation.finalReview).toMatchObject({ required: true, ok: true });
    expect(amended.evaluation.finalAcceptance).toMatchObject({ required: true, ok: true });
    expect(amended.evaluation.finalApply).toMatchObject({ required: true, ok: false, reason: 'not_applied' });

    const before = repositoryState(amended.fx.repo);
    app = goalApp(amended.fx.db, disabledSupervisor(amended.fx.db));
    const handoffsPath = `/api/goals/${amended.fx.goalId}/handoffs`;
    const preparedResponse = await call(app, 'POST', handoffsPath, {});
    expect(preparedResponse.status).toBe(201);
    const preparedProjection = await call(app, 'GET', `${handoffsPath}/${preparedResponse.body.handoffId}`);
    expect(preparedProjection.status).toBe(200);
    const prepared = {
      reused: preparedResponse.body.reused as boolean,
      record: preparedProjection.body.projection.handoff as Awaited<
        ReturnType<typeof prepareManualHandoff>
      >['record'],
    };
    expect(prepared.record).toMatchObject({
      definition: {
        version: 2,
        hash: amended.proposal.definitionHash,
        approvalId: amended.approved.approvalId,
        approvalIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      finalAcceptance: { approvalId: amended.version2AcceptanceId },
      review: { finalReviewId: amended.version2ReviewId },
      source: { commit: amended.sourceCommit, tree: amended.fx.tree(amended.sourceCommit) },
      target: {
        baseRef: 'refs/heads/main',
        observedBaseCommit: amended.fx.baseCommit,
        observedBaseTree: amended.fx.tree(amended.fx.baseCommit),
      },
    });
    expect(prepared.record.handoffId).not.toBe(amended.version1Handoff.handoffId);
    expect(prepared.record.handoffDigest).not.toBe(amended.version1Handoff.handoffDigest);
    expect(prepared.record.source.commit).toBe(amended.version1Handoff.source.commit);
    expect(prepared.record.review.evidence.map(({ evidenceId }) => evidenceId)).toContain(
      amended.fx.db
        .prepare(
          "SELECT id FROM goal_evidence WHERE goal_id = ? AND definition_version = 2 AND criterion_key = 'deliverable'",
        )
        .get(amended.fx.goalId)?.id,
    );
    const originalPayload = JSON.stringify(amended.version1Handoff);
    expect(
      JSON.parse(
        (
          amended.fx.db
            .prepare('SELECT payload_json FROM goal_result_handoffs WHERE id = ?')
            .get(amended.version1Handoff.handoffId) as { payload_json: string }
        ).payload_json,
      ),
    ).toEqual(JSON.parse(originalPayload));
    expect(await call(app, 'GET', `${handoffsPath}/${amended.version1Handoff.handoffId}`)).toMatchObject({
      status: 200,
      body: {
        projection: {
          state: 'stale',
          reason: { code: 'definition_not_approved' },
          handoff: { handoffId: amended.version1Handoff.handoffId },
        },
      },
    });
    expect(await call(app, 'GET', `${handoffsPath}/${prepared.record.handoffId}`)).toMatchObject({
      status: 200,
      body: { projection: { state: 'current', handoff: { handoffId: prepared.record.handoffId } } },
    });
    expect(await call(app, 'POST', handoffsPath, {})).toMatchObject({
      status: 200,
      body: { reused: true, handoffId: prepared.record.handoffId },
    });
    expect(await call(app, 'GET', handoffsPath)).toMatchObject({
      status: 200,
      body: {
        handoffs: [
          { definitionVersion: 2, handoffId: prepared.record.handoffId },
          { definitionVersion: 1, handoffId: amended.version1Handoff.handoffId },
        ],
      },
    });
    expect(repositoryState(amended.fx.repo)).toEqual(before);
    expect(await evaluateCompletion(amended.fx.db, amended.fx.goalId)).toMatchObject({
      finalApply: { required: true, ok: false, reason: 'not_applied' },
      failures: [{ code: 'final_apply_required' }],
    });
    expect(amended.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(amended.fx.goalId)).toEqual({
      status: 'ready',
    });
    expect(
      amended.fx.db
        .prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base'")
        .get(amended.fx.goalId),
    ).toEqual({ n: 0 });

    const registeredGitRoot = (
      amended.fx.db.prepare('SELECT git_root FROM projects WHERE id = ?').get(amended.fx.projectId) as {
        git_root: string;
      }
    ).git_root;
    amended.fx.db
      .prepare('UPDATE projects SET git_root = ? WHERE id = ?')
      .run(join(amended.fx.repo, 'repository-no-longer-available'), amended.fx.projectId);
    expect(await call(app, 'GET', `${handoffsPath}/${prepared.record.handoffId}`)).toMatchObject({
      status: 200,
      body: { projection: { state: 'unavailable', handoff: { handoffId: prepared.record.handoffId } } },
    });
    amended.fx.db
      .prepare('UPDATE projects SET git_root = ? WHERE id = ?')
      .run(registeredGitRoot, amended.fx.projectId);

    amended.fx.db.exec('DROP TRIGGER trg_goal_result_handoff_immutable;');
    amended.fx.db
      .prepare('UPDATE goal_result_handoffs SET payload_json = payload_json || ? WHERE id = ?')
      .run(' ', prepared.record.handoffId);
    expect(await call(app, 'GET', `${handoffsPath}/${prepared.record.handoffId}`)).toMatchObject({
      status: 200,
      body: { projection: { state: 'invalid', handoff: null, reason: { code: 'handoff_invalid' } } },
    });
  });

  const amendedApprovalCorruptions = [
    { label: 'a version 1 approval is reused', kind: 'version1' },
    { label: 'the approval belongs to another Goal', kind: 'wrong_goal' },
    { label: 'the approval names another definition version', kind: 'wrong_version' },
    { label: 'the approval carries another definition hash', kind: 'wrong_hash' },
    { label: 'the approval is still pending', kind: 'pending' },
    { label: 'the approval was denied', kind: 'denied' },
    { label: 'the decision actor is system', kind: 'system' },
    { label: 'the amendment uses the initial-definition gate', kind: 'wrong_gate' },
    { label: 'the parent-definition lineage is missing', kind: 'invalid_lineage' },
    { label: 'the approval uses an unsupported gate', kind: 'unsupported_gate' },
  ] as const;

  it.each(amendedApprovalCorruptions)('refuses an amended handoff when $label', async ({ kind }) => {
    const amended = await amendedAcceptedFixture();
    expect(amended.evaluation.failures.map(({ code }) => code)).toEqual(['final_apply_required']);
    const approvalId = amended.approved.approvalId;

    // These authority-corruption fixtures bypass SQLite immutability only to verify that handoff preparation
    // revalidates the lineage and actual approval row instead of trusting an approved version flag.
    if (kind === 'version1') {
      dropDefinitionImmutabilityTrigger(amended.fx.db);
      amended.fx.db
        .prepare('UPDATE goal_definition_versions SET approval_id = ? WHERE goal_id = ? AND version = 2')
        .run(amended.v1Definition.approvalId, amended.fx.goalId);
    } else if (kind === 'wrong_goal') {
      dropDefinitionImmutabilityTrigger(amended.fx.db);
      amended.fx.db
        .prepare('UPDATE goal_definition_versions SET approval_id = ? WHERE goal_id = ? AND version = 2')
        .run(otherGoalAmendmentApprovalId(amended.fx), amended.fx.goalId);
    } else if (kind === 'invalid_lineage') {
      dropDefinitionImmutabilityTrigger(amended.fx.db);
      amended.fx.db
        .prepare('UPDATE goal_definition_versions SET parent_version = 99 WHERE goal_id = ? AND version = 2')
        .run(amended.fx.goalId);
    } else {
      dropApprovalIdentityTriggers(amended.fx.db);
      const approval = getGoalApproval(amended.fx.db, approvalId)!;
      if (kind === 'wrong_version' || kind === 'wrong_hash') {
        const detail = { ...approval.detail };
        if (kind === 'wrong_version') detail.version = 1;
        else detail.definitionHash = 'f'.repeat(64);
        amended.fx.db
          .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
          .run(JSON.stringify(detail), approvalId);
      } else if (kind === 'pending') {
        amended.fx.db
          .prepare(
            "UPDATE goal_approvals SET status = 'pending', decided_by = NULL, responded_at = NULL WHERE id = ?",
          )
          .run(approvalId);
      } else if (kind === 'denied') {
        amended.fx.db
          .prepare(
            "UPDATE goal_approvals SET status = 'denied', decided_by = 'user', responded_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), approvalId);
      } else if (kind === 'system') {
        amended.fx.db.exec('PRAGMA ignore_check_constraints = ON;');
        try {
          amended.fx.db
            .prepare(
              "UPDATE goal_approvals SET status = 'approved', decided_by = 'system', responded_at = ? WHERE id = ?",
            )
            .run(new Date().toISOString(), approvalId);
        } finally {
          amended.fx.db.exec('PRAGMA ignore_check_constraints = OFF;');
        }
      } else {
        const gate = kind === 'wrong_gate' ? 'definition' : 'final_acceptance';
        amended.fx.db.prepare('UPDATE goal_approvals SET gate = ? WHERE id = ?').run(gate, approvalId);
      }
    }

    await expect(prepareManualHandoff(amended.fx.db, amended.fx.goalId)).rejects.toMatchObject({
      code: 'definition_not_approved',
    });
  });

  it('refuses an amendment gate forged onto a non-amended definition', async () => {
    const accepted = await acceptedFixture();
    const version = loadDefinitionVersion(accepted.fx.db, accepted.fx.goalId, 1)!;
    // Explicit corruption fixture: normal definition and approval services cannot change this immutable identity.
    dropApprovalIdentityTriggers(accepted.fx.db);
    accepted.fx.db
      .prepare('UPDATE goal_approvals SET gate = ? WHERE id = ?')
      .run('amendment', version.approvalId);
    await expect(prepareManualHandoff(accepted.fx.db, accepted.fx.goalId)).rejects.toMatchObject({
      code: 'definition_not_approved',
    });
  });

  it('refuses an amended result whose final review still references version 1', async () => {
    const amended = await amendedAcceptedFixture({ includeVersion2Review: false });
    expect(amended.evaluation.finalReview).toMatchObject({
      required: true,
      ok: false,
      reason: 'final_review_stale',
    });
    expect(amended.evaluation.finalAcceptance).toMatchObject({ required: true, ok: true });
    await expect(prepareManualHandoff(amended.fx.db, amended.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
  });

  it('refuses an amended result whose final acceptance still references version 1', async () => {
    const amended = await amendedAcceptedFixture({ includeVersion2Acceptance: false });
    expect(amended.evaluation.finalReview).toMatchObject({ required: true, ok: true });
    expect(amended.evaluation.finalAcceptance).toMatchObject({
      required: true,
      ok: false,
      reason: 'bound_to_other_definition_or_tree',
    });
    await expect(prepareManualHandoff(amended.fx.db, amended.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
  });

  it('refuses an amended result with stale version 2 verification evidence', async () => {
    const amended = await amendedAcceptedFixture();
    const evidence = amended.fx.db
      .prepare(
        "SELECT id FROM goal_evidence WHERE goal_id = ? AND definition_version = 2 AND criterion_key = 'deliverable'",
      )
      .get(amended.fx.goalId) as { id: string };
    // Explicit corruption case: the evidence row is immutable in normal operation.
    amended.fx.db.exec('DROP TRIGGER trg_goal_evidence_immutable;');
    amended.fx.db
      .prepare('UPDATE goal_evidence SET subject_blob = ? WHERE id = ?')
      .run('f'.repeat(64), evidence.id);
    const evaluation = await evaluateCompletion(amended.fx.db, amended.fx.goalId);
    expect(evaluation.finalReview).toMatchObject({ required: true, ok: true });
    expect(evaluation.finalAcceptance).toMatchObject({ required: true, ok: true });
    expect(evaluation.criteria.find(({ key }) => key === 'deliverable')?.state).not.toBe('satisfied');
    await expect(prepareManualHandoff(amended.fx.db, amended.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
  });

  it.each(['sha1', 'sha256'] as const)(
    'prepares, reuses, and revalidates an immutable %s handoff without mutating Git',
    async (objectFormat) => {
      const { fx, sourceCommit, sourceRef, acceptanceId } = await acceptedFixture(objectFormat);
      const ignored = join(fx.repo, 'handoff-user-ignored.txt');
      const untracked = join(fx.repo, 'handoff-user-untracked.txt');
      writeFileSync(ignored, 'ignored user bytes\n');
      writeFileSync(untracked, 'untracked user bytes\n');
      writeFileSync(
        join(fx.repo, '.git', 'info', 'exclude'),
        `${readFileSync(join(fx.repo, '.git', 'info', 'exclude'), 'utf8')}\n/handoff-user-ignored.txt\n`,
      );
      const before = repositoryState(fx.repo);
      const [first, concurrent] = await Promise.all([
        prepareManualHandoff(fx.db, fx.goalId, { previewChars: 128 }),
        prepareManualHandoff(fx.db, fx.goalId, { previewChars: 128 }),
      ]);
      expect(first.record.handoffId).toBe(concurrent.record.handoffId);
      expect(first.record.handoffDigest).toBe(concurrent.record.handoffDigest);
      expect([first.reused, concurrent.reused].sort()).toEqual([false, true]);
      const record = first.record;
      expect(record).toMatchObject({
        schemaVersion: 1,
        kind: 'turing_goal_manual_integration_handoff',
        goalId: fx.goalId,
        definition: { version: 1, hash: fx.currentHash() },
        finalAcceptance: { approvalId: acceptanceId },
        repository: { projectId: fx.projectId, objectFormat },
        source: { goalRef: sourceRef, commit: sourceCommit, tree: fx.tree(sourceCommit) },
        target: {
          baseBranch: 'main',
          baseRef: 'refs/heads/main',
          observedBaseCommit: fx.baseCommit,
          observedBaseTree: fx.tree(fx.baseCommit),
        },
        review: {
          changedPathCount: 1,
          changedPathDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          evidenceIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          reviewIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          diffPreviewTruncated: true,
        },
        projection: {
          changedPaths: ['src/result.txt'],
          manualIntegrationRequired: true,
        },
      });
      expect(record.source.commit).toHaveLength(objectFormat === 'sha1' ? 40 : 64);
      expect(record.projection.diffPreview.length).toBeLessThanOrEqual(128);
      expect(record.projection.diffPreview).toContain('[truncated]');
      expect(record.projection.inspectionCommands).toEqual([
        `git show --stat ${sourceCommit}`,
        `git diff --stat ${fx.baseCommit} ${sourceCommit}`,
        `git diff ${fx.baseCommit} ${sourceCommit}`,
      ]);
      expect(
        fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(fx.goalId),
      ).toEqual({ n: 1 });
      expect(() =>
        fx.db
          .prepare('UPDATE goal_result_handoffs SET created_at = ? WHERE id = ?')
          .run(new Date().toISOString(), record.handoffId),
      ).toThrow(/immutable/);
      expect(() =>
        fx.db.prepare('DELETE FROM goal_result_handoffs WHERE id = ?').run(record.handoffId),
      ).toThrow(/cannot be deleted/);

      const repeated = await prepareManualHandoff(fx.db, fx.goalId, { previewChars: 128 });
      expect(repeated).toMatchObject({
        reused: true,
        record: { handoffId: record.handoffId, handoffDigest: record.handoffDigest },
      });
      expect(fx.head()).toBe(sourceCommit);
      expect(fx.git('rev-parse', sourceRef)).toBe(sourceCommit);
      expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
        state: 'current',
        reason: null,
        record: { handoffId: record.handoffId },
      });
      expect(await getManualHandoffProjection(fx.db, fx.goalId, record.handoffId)).toMatchObject({
        state: 'current',
        label: 'Ready for manual integration',
        actualApplication: 'not_performed_by_turing',
        goalCompletion: 'not_completed_by_handoff',
      });
      expect(repositoryState(fx.repo)).toEqual(before);
      expect(readFileSync(ignored, 'utf8')).toBe('ignored user bytes\n');
      expect(readFileSync(untracked, 'utf8')).toBe('untracked user bytes\n');
      expect(fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId)).toEqual({
        status: 'ready',
      });
      expect(
        fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(fx.goalId),
      ).toEqual({ n: 2 });
      expect(
        fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base'",
          )
          .get(fx.goalId),
      ).toEqual({ n: 0 });
      const completion = await evaluateCompletion(fx.db, fx.goalId);
      expect(completion.finalApply).toMatchObject({ required: true, ok: false, reason: 'not_applied' });
      expect(completion.failures.map(({ code }) => code)).toEqual(['final_apply_required']);
    },
  );

  it('refuses a source or base ref race during projection without publishing a handoff', async () => {
    const { fx, sourceCommit, sourceRef } = await acceptedFixture();
    const replacement = fx.sideCommit({ 'src/result.txt': 'raced source\n' });
    await expectInjectedRefRace(fx, sourceRef, replacement);
    fx.git('update-ref', sourceRef, sourceCommit);
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({ n: 0 });

    const alternateBase = fx.git(
      'commit-tree',
      fx.tree(fx.baseCommit),
      '-p',
      fx.baseCommit,
      '-m',
      'raced base',
    );
    await expectInjectedRefRace(fx, 'refs/heads/main', alternateBase);
    fx.git('update-ref', 'refs/heads/main', fx.baseCommit);
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({ n: 0 });
  });

  it('reports a published handoff stale when its recorded target base moves or disappears', async () => {
    const { fx } = await acceptedFixture();
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    const advancedBase = fx.git(
      'commit-tree',
      fx.tree(fx.baseCommit),
      '-p',
      fx.baseCommit,
      '-m',
      'external base move',
    );
    fx.git('update-ref', 'refs/heads/main', advancedBase);
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'base_diverged' },
    });
    fx.git('update-ref', 'refs/heads/main', fx.baseCommit);
    fx.git('update-ref', '-d', 'refs/heads/main');
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'base_ref_missing' },
    });
  });

  it('reports source movement and newly selected evidence as stale instead of refreshing the record', async () => {
    const { fx, sourceCommit, sourceRef, record } = await (async () => {
      const accepted = await acceptedFixture();
      const created = await prepareManualHandoff(accepted.fx.db, accepted.fx.goalId);
      return { ...accepted, record: created.record };
    })();
    const replacement = fx.sideCommit({ 'src/extra.txt': 'another source change\n' });
    fx.git('update-ref', sourceRef, replacement);
    fx.db
      .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
      .run(replacement, fx.goalId);
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'source_changed' },
      record: { source: { commit: sourceCommit } },
    });
    fx.git('update-ref', sourceRef, sourceCommit);
    fx.db
      .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
      .run(sourceCommit, fx.goalId);
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'deliverable',
      verifierDigest: fx.digest('deliverable'),
      kind: 'artifact',
      milestoneId: fx.milestoneId('m1'),
      now: new Date(Date.now() + 10_000).toISOString(),
    });
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'evidence_invalid' },
    });
    expect(
      fx.db.prepare('SELECT payload_json FROM goal_result_handoffs WHERE id = ?').get(record.handoffId),
    ).toEqual({
      payload_json: expect.stringContaining(record.handoffDigest),
    });
  });

  it('refuses active review and unresolved integration-operation states', async () => {
    const { fx } = await acceptedFixture();
    const pending = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      reviewKind: 'final',
    });
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({ code: 'pending_review' });
    closeReview(fx.db, { reviewId: pending.id, status: 'cancelled' });
    fx.db
      .prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, op, new_commit, status, checks_json, created_at)
         VALUES ('handoff-pending-op', ?, 'init_ref', ?, 'planned', '{}', ?)`,
      )
      .run(fx.goalId, fx.head(), new Date().toISOString());
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
      code: 'integration_operation_in_progress',
    });
  });

  it('fails closed on a historical failed v1 apply operation with uncertain recovery state', async () => {
    const { fx, sourceCommit } = await acceptedFixture();
    // This is a corruption/legacy compatibility fixture: bypass the current insert authority only to model an
    // uncertain operation written by an earlier implementation. No positive test manufactures an applied record.
    fx.db.exec('DROP TRIGGER trg_goal_integration_op_apply_approval_insert;');
    fx.db
      .prepare(
        `INSERT INTO goal_integration_ops
         (id, goal_id, op, expected_old, new_commit, status, checks_json, created_at, approval_id)
         VALUES ('legacy-uncertain-apply', ?, 'apply_to_base', ?, ?, 'planned', '{}', ?, NULL)`,
      )
      .run(fx.goalId, fx.baseCommit, sourceCommit, new Date().toISOString());
    fx.db
      .prepare(
        `UPDATE goal_integration_ops SET status = 'failed', error_code = 'manual_reconciliation_required', finished_at = ?
         WHERE id = 'legacy-uncertain-apply'`,
      )
      .run(new Date().toISOString());
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
      code: 'manual_reconciliation_required',
    });
  });

  it('rejects missing, wrong-Goal, tampered, and malformed handoff records', async () => {
    const { fx } = await acceptedFixture();
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    expect(
      await validateManualHandoff(fx.db, fx.goalId, '00000000-0000-4000-8000-000000000000'),
    ).toMatchObject({
      state: 'invalid',
      reason: { code: 'handoff_not_found' },
    });
    expect(
      await validateManualHandoff(fx.db, '00000000-0000-4000-8000-000000000000', record.handoffId),
    ).toMatchObject({
      state: 'invalid',
      reason: { code: 'handoff_not_found' },
    });

    fx.db.exec('DROP TRIGGER trg_goal_result_handoff_immutable;');
    const corrupted = { ...record, projection: { ...record.projection, diffPreview: 'tampered projection' } };
    fx.db
      .prepare('UPDATE goal_result_handoffs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(corrupted), record.handoffId);
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'invalid',
      reason: { code: 'handoff_invalid' },
    });
  });

  it('refuses a handoff when completion, repository, activity, or the Goal ref is ineligible', async () => {
    const { fx, sourceRef } = await acceptedFixture();
    await expect(prepareManualHandoff(fx.db, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'goal_not_found',
    });
    fx.git('update-ref', '-d', sourceRef);
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
      code: 'source_ref_missing',
    });
    fx.git('update-ref', sourceRef, fx.head());
  });

  it('refuses a Goal with no approved definition or an incorrect stored definition hash', async () => {
    const unapproved = goalRepoFixture({ approved: false });
    await expect(prepareManualHandoff(unapproved.db, unapproved.goalId)).rejects.toMatchObject({
      code: 'definition_not_approved',
    });

    const corrupt = goalRepoFixture();
    corrupt.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
    corrupt.db
      .prepare('UPDATE goal_definition_versions SET definition_hash = ? WHERE goal_id = ? AND version = 1')
      .run('f'.repeat(64), corrupt.goalId);
    await expect(prepareManualHandoff(corrupt.db, corrupt.goalId)).rejects.toMatchObject({
      code: 'definition_not_approved',
    });
  });

  it('refuses acceptance bound to an incorrect source tree', async () => {
    const { fx, acceptanceId } = await acceptedFixture();
    fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
    const row = fx.db.prepare('SELECT detail_json FROM goal_approvals WHERE id = ?').get(acceptanceId) as {
      detail_json: string;
    };
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    detail.integrationTree = 'f'.repeat(40);
    fx.db
      .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
      .run(JSON.stringify(detail), acceptanceId);
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
  });

  it('refuses a source commit that is not descended from the recorded base', async () => {
    const { fx } = await acceptedFixture('sha1', { orphanSource: true });
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({ code: 'not_fast_forward' });
  });

  it('rejects out-of-project paths, sensitive paths, and unsafe added content', async () => {
    const outside = await acceptedFixture('sha1', { subdir: 'app', outsideProjectPath: 'outside.txt' });
    await expect(prepareManualHandoff(outside.fx.db, outside.fx.goalId)).rejects.toMatchObject({
      code: 'unsafe_changes',
    });

    const sensitive = await acceptedFixture('sha1', { files: { '.env': 'private config\n' } });
    await expect(prepareManualHandoff(sensitive.fx.db, sensitive.fx.goalId)).rejects.toMatchObject({
      code: 'unsafe_changes',
    });

    const secret = await acceptedFixture('sha1', {
      files: { 'src/private.txt': 'api_key=abcdefghijklmnop-secret-value\n' },
    });
    await expect(prepareManualHandoff(secret.fx.db, secret.fx.goalId)).rejects.toMatchObject({
      code: 'unsafe_changes',
    });
  });

  it('refuses missing review, acceptance, and required evidence prerequisites', async () => {
    const noReview = await acceptedFixture('sha1', { omitReview: true });
    await expect(prepareManualHandoff(noReview.fx.db, noReview.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });

    const noAcceptance = await acceptedFixture('sha1', { omitAcceptance: true });
    await expect(prepareManualHandoff(noAcceptance.fx.db, noAcceptance.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });

    const noEvidence = await acceptedFixture('sha1', { omitEvidence: true });
    await expect(prepareManualHandoff(noEvidence.fx.db, noEvidence.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
  });

  it('reports a published handoff stale after a later blocking final review', async () => {
    const { fx } = await acceptedFixture();
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    const now = new Date(Date.now() + 60_000).toISOString();
    const later = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      reviewKind: 'final',
      now,
    });
    completeReview(fx.db, {
      reviewId: later.id,
      report: { ...passingReport, verdict: 'block' },
      independence: { established: true, policy: 'different-family' },
      now,
    });
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'final_review_changed' },
    });
  });

  it('reports a published handoff stale after final acceptance is explicitly invalidated in a corruption test', async () => {
    const { fx, acceptanceId } = await acceptedFixture();
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    fx.db.exec('DROP TRIGGER trg_goal_approval_terminal;');
    fx.db
      .prepare(
        "UPDATE goal_approvals SET status = 'denied', decided_by = 'user', responded_at = ? WHERE id = ?",
      )
      .run(new Date(Date.now() + 60_000).toISOString(), acceptanceId);
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'final_acceptance_changed' },
    });
  });

  it('reports a published handoff stale after the approved definition is amended through its service', async () => {
    const { fx } = await acceptedFixture();
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    const revised = structuredClone(fx.definition);
    revised.contract.outcome = 'The same reviewed result with an amended goal contract.';
    const proposal = beginAmendment(fx.db, {
      goalId: fx.goalId,
      actor: 'user',
      changeSummary: 'Amend the goal after handoff preparation.',
      definition: revised,
    });
    approveDefinition(fx.db, { goalId: fx.goalId, version: proposal.version, actor: 'user' });
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'stale',
      reason: { code: 'definition_not_approved' },
    });
  });

  it('refuses active execution cycles and blocking findings created through Goal services', async () => {
    const active = await acceptedFixture();
    transitionGoal(active.fx.db, {
      goalId: active.fx.goalId,
      to: 'running',
      reasonCode: 'user_start',
      actor: 'user',
      preconditions: [{ code: 'preflight', ok: true }],
    });
    expect(
      createCycle(active.fx.db, {
        goalId: active.fx.goalId,
        kind: 'verification',
        triggerCode: 'handoff_test',
        milestoneKey: 'm1',
      }),
    ).toMatchObject({ created: true });
    await expect(prepareManualHandoff(active.fx.db, active.fx.goalId)).rejects.toMatchObject({
      code: 'active_work',
    });

    const finding = await acceptedFixture();
    const review = await createReview(finding.fx.db, {
      goalId: finding.fx.goalId,
      definitionVersion: 1,
      reviewKind: 'milestone',
      milestoneId: finding.fx.milestoneId('m1'),
    });
    completeReview(finding.fx.db, {
      reviewId: review.id,
      report: {
        ...passingReport,
        verdict: 'pass_with_findings',
        newFindings: [
          {
            severity: 'critical',
            category: 'safety',
            description: 'Critical finding blocks delivery.',
            evidence: 'A deterministic test finding.',
            affectedFiles: ['src/result.txt'],
            remediation: 'Resolve it.',
          },
        ],
      },
    });
    await applyReviewFindings(finding.fx.db, { reviewId: review.id });
    await expect(prepareManualHandoff(finding.fx.db, finding.fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
  });

  it('reports repository identity changes as stale and unreadable repositories as unavailable', async () => {
    const changed = await acceptedFixture();
    const { record: changedRecord } = await prepareManualHandoff(changed.fx.db, changed.fx.goalId);
    const alternateRepo = join(changed.fx.repo, 'alternate-repository');
    mkdirSync(alternateRepo);
    execFileSync('git', ['init', '-q', '-b', 'main', alternateRepo]);
    changed.fx.db
      .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
      .run(alternateRepo, alternateRepo, changed.fx.projectId);
    expect(
      await validateManualHandoff(changed.fx.db, changed.fx.goalId, changedRecord.handoffId),
    ).toMatchObject({
      state: 'stale',
      reason: { code: 'repository_identity_changed' },
    });

    const unreadable = await acceptedFixture();
    const { record: unreadableRecord } = await prepareManualHandoff(unreadable.fx.db, unreadable.fx.goalId);
    const gitDir = join(unreadable.fx.repo, '.git');
    const hiddenGitDir = join(unreadable.fx.repo, '.git-temporarily-unreadable');
    renameSync(gitDir, hiddenGitDir);
    try {
      expect(
        await validateManualHandoff(unreadable.fx.db, unreadable.fx.goalId, unreadableRecord.handoffId),
      ).toMatchObject({
        state: 'unavailable',
        reason: { code: 'repository_unavailable' },
      });
    } finally {
      renameSync(hiddenGitDir, gitDir);
    }
  });

  it('treats terminal control characters and bidi controls in diff text as inert display text', async () => {
    const { fx } = await acceptedFixture('sha1', {
      files: { 'src/\u001b[2J.txt': `\u001b[31mcontent\u001b[0m \u202e reversed\n` },
    });
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    expect(record.projection.diffPreview).not.toContain('\u001b');
    expect(record.projection.diffPreview).not.toContain('\u202e');
    expect(record.projection.changedPaths.join('')).not.toContain('\u001b');
    expect(record.projection.inspectionCommands.every((command) => !command.includes('src/'))).toBe(true);
  });

  it('does not treat an approved historical prospective apply intent as application authority', async () => {
    const { fx } = await acceptedFixture();
    // A prospective v1 approval remains historical authority only. It neither changes refs nor satisfies completion.
    const { intent } = await prepareFinalApplyIntent(fx.db, fx.goalId);
    const legacy = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_apply',
      risk: 'high',
      reason: 'Approve the historical exact prospective intent.',
      requestedBy: 'user',
      intentDigest: intent.intentDigest,
      detail: {
        action: 'apply_to_base_intent',
        intentDigest: intent.intentDigest,
        repositoryProjectId: fx.projectId,
        intent,
        reviewDisplay: { diffStat: '', diffPreview: '' },
      },
    });
    decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: legacy.id,
      decision: 'approved',
      decidedBy: 'user',
    });
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    expect(record).toBeDefined();
    expect(await evaluateCompletion(fx.db, fx.goalId)).toMatchObject({
      finalApply: { required: true, ok: false, reason: 'not_applied' },
      failures: [{ code: 'final_apply_required' }],
    });
    expect(
      fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get(),
    ).toEqual({ n: 0 });
  });

  it('rejects a tampered handoff digest independently from malformed handoff payloads', async () => {
    const { fx } = await acceptedFixture();
    const { record } = await prepareManualHandoff(fx.db, fx.goalId);
    fx.db.exec('DROP TRIGGER trg_goal_result_handoff_immutable;');
    const payload = { ...record, handoffDigest: '0'.repeat(64) };
    fx.db
      .prepare('UPDATE goal_result_handoffs SET payload_json = ?, handoff_digest = ? WHERE id = ?')
      .run(JSON.stringify(payload), payload.handoffDigest, record.handoffId);
    expect(await validateManualHandoff(fx.db, fx.goalId, record.handoffId)).toMatchObject({
      state: 'invalid',
      reason: { code: 'handoff_invalid' },
    });
  });

  it('keeps the rejected writer unreachable from every production server module', () => {
    const server = join(process.cwd(), 'src', 'server');
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'finalApply.ts' &&
          /applyApprovedGoalToBase/.test(readFileSync(fullPath, 'utf8'))
        )
          offenders.push(fullPath);
      }
    };
    walk(server);
    expect(offenders).toEqual([]);
    expect(readFileSync(join(server, 'index.ts'), 'utf8')).toContain('new DisabledGoalExecutor()');
  });
});

describe('external integration attestation authority', () => {
  it('exposes scoped read-only verification and requires the exact reviewed digest before user confirmation', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    app = goalApp(fx.db, disabledSupervisor(fx.db));
    const basePath = `/api/goals/${fx.goalId}/handoffs/${handoff.handoffId}/external-integration`;
    const beforeGit = repositoryState(fx.repo);
    const approvalsBefore = (
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(fx.goalId) as {
        n: number;
      }
    ).n;
    const attestationsBefore = (
      fx.db
        .prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations WHERE goal_id = ?')
        .get(fx.goalId) as { n: number }
    ).n;

    expect(await call(app, 'GET', `${basePath}/attestations/not-a-uuid`)).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
    expect(
      await call(app, 'GET', `/api/goals/not-a-uuid/handoffs/${handoff.handoffId}/external-integration`),
    ).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
    expect(
      await call(app, 'GET', `/api/goals/${fx.goalId}/handoffs/not-a-uuid/external-integration`),
    ).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
    expect(
      await call(
        app,
        'GET',
        `/api/goals/00000000-0000-4000-8000-000000000000/handoffs/${handoff.handoffId}/external-integration`,
      ),
    ).toMatchObject({
      status: 404,
      body: { code: 'goal_not_found' },
    });

    const emptyStatus = await call(app, 'GET', basePath);
    expect(emptyStatus).toMatchObject({
      status: 200,
      body: {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        hasAttestation: false,
        attestations: [],
        approvals: [],
      },
    });
    const fresh = await call(app, 'GET', `${basePath}/verification`);
    expect(fresh).toMatchObject({
      status: 200,
      body: {
        verification: {
          state: 'verified',
          observation: {
            goalId: fx.goalId,
            handoff: { id: handoff.handoffId, digest: handoff.handoffDigest },
            source: { commit: observation.source.commit, tree: observation.source.tree },
            destination: {
              ref: observation.destination.ref,
              observedCommit: observation.destination.observedCommit,
            },
            actionDigest: observation.actionDigest,
          },
          proofLimitations: {
            contentPreservation: 'not_proven',
            goalCompletion: 'not_completed_by_attestation',
          },
        },
      },
    });
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({
      n: approvalsBefore,
    });
    expect(
      fx.db
        .prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations WHERE goal_id = ?')
        .get(fx.goalId),
    ).toEqual({ n: attestationsBefore });

    const confirmUrl = `${basePath}/attest`;
    const decision = { decision: 'confirm_external_integration' };
    const remoteDenied = await app.inject({
      method: 'POST',
      url: confirmUrl,
      headers: { origin: 'https://turing.example.test', 'content-type': 'application/json' },
      payload: decision,
    });
    expect(remoteDenied.statusCode).toBe(401);
    const tauriPreflight = await app.inject({
      method: 'OPTIONS',
      url: confirmUrl,
      headers: {
        origin: 'tauri://localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, if-match',
      },
    });
    expect(tauriPreflight.statusCode).toBe(204);
    expect(tauriPreflight.headers['access-control-allow-headers']).toContain('if-match');
    expect(await call(app, 'POST', confirmUrl, decision)).toMatchObject({
      status: 428,
      body: { code: 'reviewed_action_precondition_required' },
    });
    expect(await call(app, 'POST', confirmUrl, decision, { 'if-match': 'not-a-digest' })).toMatchObject({
      status: 400,
      body: { code: 'reviewed_action_precondition_invalid' },
    });
    expect(
      await call(
        app,
        'POST',
        confirmUrl,
        { ...decision, approvalId: 'client-controlled' },
        {
          'if-match': `"${observation.actionDigest}"`,
        },
      ),
    ).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    expect(
      await call(
        app,
        'POST',
        confirmUrl,
        { decision: 'approve' },
        {
          'if-match': `"${observation.actionDigest}"`,
        },
      ),
    ).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    expect(
      await call(app, 'POST', confirmUrl, decision, { 'if-match': `"${'0'.repeat(64)}"` }),
    ).toMatchObject({
      status: 412,
      body: { code: 'reviewed_observation_changed' },
    });
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({
      n: approvalsBefore,
    });
    expect(
      fx.db
        .prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations WHERE goal_id = ?')
        .get(fx.goalId),
    ).toEqual({ n: attestationsBefore });

    const confirmed = await call(app, 'POST', confirmUrl, decision, {
      'if-match': `"${observation.actionDigest}"`,
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({
      actionDigest: observation.actionDigest,
      reusedApproval: false,
      reusedAttestation: false,
    });
    const approval = getGoalApproval(fx.db, confirmed.body.approvalId as string)!;
    expect(approval).toMatchObject({
      goalId: fx.goalId,
      gate: 'final_apply',
      risk: 'high',
      requestedBy: 'user',
      status: 'approved',
      decidedBy: 'user',
      externalIntegrationActionDigest: observation.actionDigest,
      detail: {
        schemaVersion: 2,
        action: 'confirm_external_integration',
        actionDigest: observation.actionDigest,
        handoffId: handoff.handoffId,
      },
    });
    expect(approval.intentDigest).toBeUndefined();
    expect(
      fx.db
        .prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base'")
        .get(fx.goalId),
    ).toEqual({ n: 0 });
    expect(fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId)).not.toEqual({
      status: 'completed',
    });

    const repeated = await call(app, 'POST', confirmUrl, decision, {
      'if-match': `"${observation.actionDigest}"`,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      attestationId: confirmed.body.attestationId,
      approvalId: confirmed.body.approvalId,
      actionDigest: observation.actionDigest,
      reusedApproval: true,
      reusedAttestation: true,
    });
    const stored = await call(app, 'GET', basePath);
    expect(stored.body).toMatchObject({
      hasAttestation: true,
      attestations: [
        expect.objectContaining({
          attestationId: confirmed.body.attestationId,
          approvalId: confirmed.body.approvalId,
          actionDigest: observation.actionDigest,
        }),
      ],
      approvals: [
        expect.objectContaining({
          status: 'approved',
          decidedBy: 'user',
          attestationId: confirmed.body.attestationId,
        }),
      ],
    });
    const projection = await call(
      app,
      'GET',
      `${basePath}/attestations/${confirmed.body.attestationId as string}`,
    );
    expect(projection).toMatchObject({
      status: 200,
      body: {
        projection: {
          state: 'current',
          claim: 'source_history_observed_at_recorded_time',
          contentPreservation: 'not_proven',
          goalCompletion: 'not_completed_by_attestation',
        },
      },
    });

    expect(repositoryState(fx.repo)).toEqual(beforeGit);
    const later = git(
      fx.repo,
      'commit-tree',
      observation.destination.observedTree,
      '-p',
      observation.destination.observedCommit,
      '-m',
      'later user integration history',
    );
    git(fx.repo, 'update-ref', observation.destination.ref, later);
    const changedEvidence = await call(app, 'POST', confirmUrl, decision, {
      'if-match': `"${observation.actionDigest}"`,
    });
    expect(changedEvidence).toMatchObject({ status: 412, body: { code: 'reviewed_observation_changed' } });
    const oldProjection = await call(
      app,
      'GET',
      `${basePath}/attestations/${confirmed.body.attestationId as string}`,
    );
    expect(oldProjection).toMatchObject({ status: 200, body: { projection: { state: 'historical' } } });
    expect(
      fx.db
        .prepare(
          'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_integration_action_digest = ?',
        )
        .get(fx.goalId, observation.actionDigest),
    ).toEqual({ n: 1 });
    expect(repositoryState(fx.repo)).not.toEqual(beforeGit); // Only the test-simulated manual ref advance changed Git.
    expect(
      fx.db
        .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ? AND type = 'completed'")
        .get(fx.goalId),
    ).toEqual({ n: 0 });
    expect((await evaluateCompletion(fx.db, fx.goalId)).failures.map(({ code }) => code)).toEqual([
      'final_apply_required',
    ]);
  });

  it('keeps wrong-Goal and unavailable records scoped and distinguishes non-ancestral history from unavailable Git', async () => {
    const { fx, handoff } = await integratedExternalFixture();
    app = goalApp(fx.db, disabledSupervisor(fx.db));
    const path = `/api/goals/${fx.goalId}/handoffs/${handoff.handoffId}/external-integration`;
    const approvalsBefore = (
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(fx.goalId) as {
        n: number;
      }
    ).n;
    const other = createGoalDraft(fx.db, {
      projectId: fx.projectId,
      title: 'External integration scope probe',
      definition: simpleDefinition(),
    });
    expect(await call(app, 'GET', `${path}/attestations/00000000-0000-4000-8000-000000000000`)).toMatchObject(
      {
        status: 404,
        body: { code: 'attestation_not_found' },
      },
    );
    expect(
      await call(
        app,
        'GET',
        `/api/goals/${other.goalId}/handoffs/${handoff.handoffId}/external-integration/verification`,
      ),
    ).toMatchObject({ status: 404, body: { code: 'handoff_not_found' } });

    git(fx.repo, 'update-ref', 'refs/heads/main', handoff.target.observedBaseCommit);
    const notIntegrated = await call(app, 'GET', `${path}/verification`);
    expect(notIntegrated).toMatchObject({
      status: 200,
      body: {
        verification: { state: 'not_integrated', observation: null, reason: { code: 'source_not_ancestor' } },
      },
    });

    const project = fx.db.prepare('SELECT path, git_root FROM projects WHERE id = ?').get(fx.projectId) as {
      path: string;
      git_root: string;
    };
    const missingRoot = `${project.git_root}-unavailable`;
    fx.db
      .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
      .run(`${project.path}-unavailable`, missingRoot, fx.projectId);
    const unavailable = await call(app, 'GET', `${path}/verification`);
    expect(unavailable).toMatchObject({
      status: 200,
      body: {
        verification: { state: 'unavailable', observation: null, reason: { code: 'repository_unavailable' } },
      },
    });
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({
      n: approvalsBefore,
    });
  });

  it('does not override a denied exact user decision or create an attestation for it', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    app = goalApp(fx.db, disabledSupervisor(fx.db));
    const denied = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_apply',
      risk: 'high',
      reason: 'The user previously denied this exact observation.',
      requestedBy: 'user',
      detail: createExternalIntegrationApprovalDetail(observation),
      externalIntegrationActionDigest: observation.actionDigest,
    });
    decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: denied.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    const response = await call(
      app,
      'POST',
      `/api/goals/${fx.goalId}/handoffs/${handoff.handoffId}/external-integration/attest`,
      { decision: 'confirm_external_integration' },
      { 'if-match': `"${observation.actionDigest}"` },
    );
    expect(response).toMatchObject({ status: 409, body: { code: 'approval_denied' } });
    expect(
      fx.db
        .prepare(
          'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_integration_action_digest = ?',
        )
        .get(fx.goalId, observation.actionDigest),
    ).toEqual({ n: 1 });
    expect(
      fx.db
        .prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations WHERE goal_id = ?')
        .get(fx.goalId),
    ).toEqual({ n: 0 });
  });

  it.each(['sha1', 'sha256'] as const)(
    'persists an exact user-approved fast-forward observation read-only in %s',
    async (objectFormat) => {
      const { fx, handoff, observation } = await integratedExternalFixture(objectFormat);
      const before = repositoryState(fx.repo);
      expect(observation).toMatchObject({
        schemaVersion: 1,
        completionContractVersion: 2,
        repository: { objectFormat },
        handoff: { id: handoff.handoffId, digest: handoff.handoffDigest },
        proof: { mode: 'source_history_observed', sourceAncestor: true, baseAncestor: true },
      });
      expect(observation.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toMatchObject({ state: 'valid', observation: { actionDigest: observation.actionDigest } });

      const approval = approveExternalObservation(fx, observation);
      const eventCountBeforePersistence = (
        fx.db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(fx.goalId) as {
          n: number;
        }
      ).n;
      const inserted = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      expect(inserted.reused).toBe(false);
      expect(inserted.record).toMatchObject({
        kind: 'turing_goal_external_integration_attestation',
        approvalId: approval.id,
        decision: { value: 'confirm_external_integration', decidedBy: 'user' },
        actionDigest: observation.actionDigest,
        destination: {
          ref: handoff.target.baseRef,
          expectedBaseCommit: handoff.target.observedBaseCommit,
          observedCommit: observation.destination.observedCommit,
        },
        proof: { mode: 'source_history_observed', sourceAncestor: true, baseAncestor: true },
      });
      expect(inserted.record.recordDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(
        await validateExternalIntegrationAttestation(fx.db, fx.goalId, inserted.record.attestationId),
      ).toMatchObject({
        state: 'current',
        record: { recordDigest: inserted.record.recordDigest },
      });
      expect(
        await getExternalIntegrationProjection(fx.db, fx.goalId, inserted.record.attestationId),
      ).toMatchObject({
        state: 'current',
        claim: 'source_history_observed_at_recorded_time',
        contentPreservation: 'not_proven',
        goalCompletion: 'not_completed_by_attestation',
      });
      const retry = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      expect(retry).toMatchObject({ reused: true, record: { attestationId: inserted.record.attestationId } });
      const concurrentRetries = await Promise.all([
        persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation,
          approvalId: approval.id,
        }),
        persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation,
          approvalId: approval.id,
        }),
      ]);
      expect(concurrentRetries.every(({ reused }) => reused)).toBe(true);
      expect(
        concurrentRetries.every(({ record }) => record.attestationId === inserted.record.attestationId),
      ).toBe(true);
      expect(await evaluateCompletion(fx.db, fx.goalId)).toMatchObject({
        finalApply: { required: true, ok: false, reason: 'not_applied' },
        failures: [{ code: 'final_apply_required' }],
      });
      expect(
        fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get(),
      ).toEqual({ n: 0 });
      expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(fx.goalId)).toEqual(
        { n: eventCountBeforePersistence },
      );
      expect(repositoryState(fx.repo)).toEqual(before);
    },
  );

  it('does not reuse a migration-026 attestation after a Goal explicitly opts into completion v2', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    const approval = approveExternalObservation(fx, observation);
    const attestation = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    expect(attestation.record.completionContractVersion).toBe(2);

    const version2 = structuredClone(fx.definition);
    version2.contract.completionPolicy.completionContractVersion = 2;
    version2.contract.completionPolicy.integrationMode = 'external_user_attested';
    const amendment = beginAmendment(fx.db, {
      goalId: fx.goalId,
      actor: 'user',
      definition: version2,
      changeSummary: 'Explicitly opt into external-integration completion contract v2.',
    });
    approveDefinition(fx.db, { goalId: fx.goalId, version: amendment.version, actor: 'user' });

    const evaluation = await evaluateCompletion(fx.db, fx.goalId);
    expect(evaluation.definitionVersion).toBe(amendment.version);
    expect(evaluation.finalApply).toEqual({
      required: true,
      ok: false,
      basis: null,
      reason: 'external_completion_not_activated',
    });
    expect(evaluation.failures).toContainEqual(
      expect.objectContaining({ code: 'external_completion_not_activated' }),
    );
  });

  it('classifies git merge -s ours as source-history inclusion and explicitly does not prove content preservation', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture('sha1', 'ours');
    expect(observation.proof).toMatchObject({
      mode: 'source_history_observed',
      sourceAncestor: true,
      baseAncestor: true,
    });
    expect(observation.destination.observedTree).toBe(observation.destination.expectedBaseTree);
    expect(observation.source.tree).not.toBe(observation.destination.observedTree);
    expect(() =>
      execFileSync(
        'git',
        ['-C', fx.repo, 'show', `${observation.destination.observedCommit}:src/result.txt`],
        {
          stdio: 'ignore',
        },
      ),
    ).toThrow();

    const approval = approveExternalObservation(fx, observation);
    const persisted = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    expect(
      await getExternalIntegrationProjection(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({
      state: 'current',
      claim: 'source_history_observed_at_recorded_time',
      contentPreservation: 'not_proven',
    });
  });

  it.each([
    ['past', '1900-01-01T00:00:00.000Z'],
    ['future', '2999-12-31T23:59:59.999Z'],
  ])(
    'uses a fresh server timestamp instead of a caller-supplied %s observation time',
    async (_label, callerTimestamp) => {
      const { fx, handoff, observation } = await integratedExternalFixture();
      const substituted = { ...observation, observedAt: callerTimestamp };
      const { actionDigest: _actionDigest, ...digestInput } = substituted;
      void _actionDigest;
      expect(computeExternalIntegrationActionDigest(digestInput)).toBe(observation.actionDigest);

      const validationStartedAt = Date.now();
      const validation = await validateExternalIntegrationObservation(
        fx.db,
        fx.goalId,
        handoff.handoffId,
        substituted,
      );
      const validationFinishedAt = Date.now();
      expect(validation).toMatchObject({
        state: 'valid',
        observation: { actionDigest: observation.actionDigest },
      });
      if (validation.state !== 'valid') throw new Error('Expected fresh observation validation to pass.');
      expect(validation.observation.observedAt).not.toBe(callerTimestamp);
      expect(Date.parse(validation.observation.observedAt)).toBeGreaterThanOrEqual(validationStartedAt);
      expect(Date.parse(validation.observation.observedAt)).toBeLessThanOrEqual(validationFinishedAt);

      const approval = approveExternalObservation(fx, observation);
      const persistenceStartedAt = Date.now();
      const persisted = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: substituted,
        approvalId: approval.id,
      });
      const persistenceFinishedAt = Date.now();
      expect(persisted.record.observedAt).not.toBe(callerTimestamp);
      expect(Date.parse(persisted.record.observedAt)).toBeGreaterThanOrEqual(persistenceStartedAt);
      expect(Date.parse(persisted.record.observedAt)).toBeLessThanOrEqual(persistenceFinishedAt);
      expect(persisted.record.actionDigest).toBe(observation.actionDigest);

      const { recordDigest, ...recordBody } = persisted.record;
      const expectedRecordDigest = createHash('sha256')
        .update(`turing-goal-external-integration-record-v1\n${canonicalJson(recordBody)}`, 'utf8')
        .digest('hex');
      expect(recordDigest).toBe(expectedRecordDigest);
      const row = fx.db
        .prepare(
          'SELECT observed_at, record_digest, payload_json FROM goal_external_integration_attestations WHERE id = ?',
        )
        .get(persisted.record.attestationId) as {
        observed_at: string;
        record_digest: string;
        payload_json: string;
      };
      expect(row.observed_at).toBe(persisted.record.observedAt);
      expect(row.record_digest).toBe(recordDigest);
      expect(JSON.parse(row.payload_json)).toMatchObject({
        observedAt: persisted.record.observedAt,
        recordDigest,
      });
      expect(
        await validateExternalIntegrationAttestation(fx.db, fx.goalId, persisted.record.attestationId),
      ).toMatchObject({
        state: 'current',
        record: { observedAt: persisted.record.observedAt, recordDigest },
      });

      const retry = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: substituted,
        approvalId: approval.id,
      });
      expect(retry.reused).toBe(true);
      expect(retry.record.observedAt).toBe(persisted.record.observedAt);
      expect(retry.record.recordDigest).toBe(recordDigest);
    },
  );

  it('fails closed when a parseable attestation record has invalid linked approval authority', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    const approval = approveExternalObservation(fx, observation);
    const persisted = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    expect(
      await getExternalIntegrationProjection(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({
      state: 'current',
      claim: 'source_history_observed_at_recorded_time',
    });

    // Deliberately invalidate approval authority without changing the parseable immutable attestation.
    fx.db.exec('DROP TRIGGER trg_goal_approval_terminal;');
    fx.db.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(approval.id);

    expect(
      await validateExternalIntegrationAttestation(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({ state: 'invalid', record: { attestationId: persisted.record.attestationId } });
    expect(
      await getExternalIntegrationProjection(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({
      state: 'invalid',
      claim: 'not_verified',
      reason: { code: 'approval_invalid' },
    });
  });

  it('distinguishes a strict ancestry refusal from invalid or unavailable Git evidence', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    const replacement = fx.git(
      'commit-tree',
      observation.destination.expectedBaseTree,
      '-p',
      observation.destination.expectedBaseCommit,
      '-m',
      'destination omits the accepted source commit',
    );
    fx.git('update-ref', handoff.target.baseRef, replacement);
    expect(
      await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
    ).toMatchObject({ state: 'not_integrated', code: 'source_not_ancestor' });
  });

  it('fails closed when the Goal source ref moves or the registered repository identity changes', async () => {
    const sourceMoved = await integratedExternalFixture();
    const replacementSource = sourceMoved.fx.git(
      'commit-tree',
      sourceMoved.observation.source.tree,
      '-p',
      sourceMoved.handoff.target.observedBaseCommit,
      '-m',
      'different source commit with the same tree',
    );
    sourceMoved.fx.git('update-ref', sourceMoved.handoff.source.goalRef, replacementSource);
    expect(
      await validateExternalIntegrationObservation(
        sourceMoved.fx.db,
        sourceMoved.fx.goalId,
        sourceMoved.handoff.handoffId,
        sourceMoved.observation,
      ),
    ).toMatchObject({ state: 'stale', code: 'source_changed' });

    const replacedRepository = await integratedExternalFixture();
    const alternate = join(replacedRepository.fx.repo, 'unrelated-repository');
    mkdirSync(alternate);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', alternate]);
    replacedRepository.fx.db
      .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
      .run(alternate, alternate, replacedRepository.fx.projectId);
    expect(
      await validateExternalIntegrationObservation(
        replacedRepository.fx.db,
        replacedRepository.fx.goalId,
        replacedRepository.handoff.handoffId,
        replacedRepository.observation,
      ),
    ).toMatchObject({ state: 'stale', code: 'repository_identity_changed' });
  });

  it('refuses missing or pending user approval and never reuses a legacy apply intent', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    await expect(
      persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: 'missing-approval',
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    const pending = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_apply',
      risk: 'high',
      reason: 'Pending exact external integration decision.',
      requestedBy: 'user',
      detail: createExternalIntegrationApprovalDetail(observation),
      externalIntegrationActionDigest: observation.actionDigest,
    });
    await expect(
      persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'user_attestation_approval_required' });
    decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: pending.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    await expect(
      persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'user_attestation_approval_required' });

    const legacyDigest = 'f'.repeat(64);
    const legacy = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_apply',
      risk: 'high',
      reason: 'Historical prospective apply authority.',
      requestedBy: 'user',
      intentDigest: legacyDigest,
      detail: { action: 'apply_to_base_intent', intentDigest: legacyDigest },
    });
    decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: legacy.id,
      decision: 'approved',
      decidedBy: 'user',
    });
    await expect(
      persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: legacy.id,
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations').get()).toEqual({
      n: 0,
    });
  });

  it('returns a valid historical record after the destination advances and requires a new digest for new authority', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    const approval = approveExternalObservation(fx, observation);
    const inserted = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    const later = fx.git(
      'commit-tree',
      observation.destination.observedTree,
      '-p',
      observation.destination.observedCommit,
      '-m',
      'later destination change',
    );
    fx.git('update-ref', handoff.target.baseRef, later);
    expect(
      await validateExternalIntegrationAttestation(fx.db, fx.goalId, inserted.record.attestationId),
    ).toMatchObject({
      state: 'historical',
      record: { actionDigest: observation.actionDigest },
      reason: { code: 'destination_advanced_after_observation' },
    });
    expect(
      await getExternalIntegrationProjection(fx.db, fx.goalId, inserted.record.attestationId),
    ).toMatchObject({
      state: 'historical',
      claim: 'source_history_observed_at_recorded_time',
    });
    const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
    expect(newObservation.actionDigest).not.toBe(observation.actionDigest);
    await expect(
      persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: newObservation,
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    const newApproval = approveExternalObservation(fx, newObservation);
    const next = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation: newObservation,
      approvalId: newApproval.id,
    });
    expect(next.reused).toBe(false);
    expect(next.record.actionDigest).toBe(newObservation.actionDigest);
    expect(next.record.attestationId).not.toBe(inserted.record.attestationId);
  });

  it('does not make stale, unavailable, or not-integrated records positive claims', async () => {
    const stale = await integratedExternalFixture();
    const staleApproval = approveExternalObservation(stale.fx, stale.observation);
    const staleRecord = await persistExternalIntegrationAttestation(stale.fx.db, {
      goalId: stale.fx.goalId,
      handoffId: stale.handoff.handoffId,
      observation: stale.observation,
      approvalId: staleApproval.id,
    });
    const changedSource = stale.fx.git(
      'commit-tree',
      stale.observation.source.tree,
      '-p',
      stale.observation.destination.expectedBaseCommit,
      '-m',
      'source identity changed after attestation',
    );
    stale.fx.git('update-ref', stale.handoff.source.goalRef, changedSource);
    expect(
      await getExternalIntegrationProjection(stale.fx.db, stale.fx.goalId, staleRecord.record.attestationId),
    ).toMatchObject({ state: 'stale', claim: 'not_verified' });

    const notIntegrated = await integratedExternalFixture();
    const notIntegratedApproval = approveExternalObservation(notIntegrated.fx, notIntegrated.observation);
    const notIntegratedRecord = await persistExternalIntegrationAttestation(notIntegrated.fx.db, {
      goalId: notIntegrated.fx.goalId,
      handoffId: notIntegrated.handoff.handoffId,
      observation: notIntegrated.observation,
      approvalId: notIntegratedApproval.id,
    });
    const destinationWithoutSource = notIntegrated.fx.git(
      'commit-tree',
      notIntegrated.observation.destination.expectedBaseTree,
      '-p',
      notIntegrated.observation.destination.expectedBaseCommit,
      '-m',
      'destination does not contain the accepted source',
    );
    notIntegrated.fx.git('update-ref', notIntegrated.handoff.target.baseRef, destinationWithoutSource);
    expect(
      await getExternalIntegrationProjection(
        notIntegrated.fx.db,
        notIntegrated.fx.goalId,
        notIntegratedRecord.record.attestationId,
      ),
    ).toMatchObject({ state: 'not_integrated', claim: 'not_verified' });

    const unavailable = await integratedExternalFixture();
    const unavailableApproval = approveExternalObservation(unavailable.fx, unavailable.observation);
    const unavailableRecord = await persistExternalIntegrationAttestation(unavailable.fx.db, {
      goalId: unavailable.fx.goalId,
      handoffId: unavailable.handoff.handoffId,
      observation: unavailable.observation,
      approvalId: unavailableApproval.id,
    });
    const gitDir = join(unavailable.fx.repo, '.git');
    const hiddenGitDir = join(unavailable.fx.repo, '.git-hidden-for-unavailable-projection');
    renameSync(gitDir, hiddenGitDir);
    try {
      expect(
        await getExternalIntegrationProjection(
          unavailable.fx.db,
          unavailable.fx.goalId,
          unavailableRecord.record.attestationId,
        ),
      ).toMatchObject({ state: 'unavailable', claim: 'not_verified' });
    } finally {
      renameSync(hiddenGitDir, gitDir);
    }
  });

  it('detects a destination ref movement between repeated Git reads', async () => {
    const { fx, handoff } = await integratedExternalFixture();
    const base = handoff.target.observedBaseCommit;
    const destinationBefore = git(fx.repo, 'rev-parse', handoff.target.baseRef);
    const replacement = fx.git(
      'commit-tree',
      handoff.target.observedBaseTree,
      '-p',
      destinationBefore,
      '-m',
      'concurrent destination ref movement',
    );
    const wrapperDirectory = join(fx.repo, '.external-integration-race-bin');
    mkdirSync(wrapperDirectory);
    const wrapper = join(wrapperDirectory, 'git');
    const counter = join(wrapperDirectory, 'counter');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const marker = join(wrapperDirectory, 'injected');
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'if [ "$1" = "for-each-ref" ] && [ "$2" = "--format=%(refname)%00%(objectname)" ]; then',
        '  count=0',
        '  if [ -f "$EXT_GIT_COUNTER" ]; then count=$(cat "$EXT_GIT_COUNTER"); fi',
        '  count=$((count + 1))',
        '  printf "%s" "$count" > "$EXT_GIT_COUNTER"',
        '  "$EXT_GIT_REAL" "$@"',
        '  status=$?',
        '  if [ "$count" -eq 3 ]; then "$EXT_GIT_REAL" update-ref "$EXT_RACE_REF" "$EXT_RACE_TO"; : > "$EXT_RACE_MARKER"; fi',
        '  exit "$status"',
        'fi',
        'exec "$EXT_GIT_REAL" "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(wrapper, 0o700);
    const originalPath = process.env.PATH;
    const originalEnvironment = {
      real: process.env.EXT_GIT_REAL,
      counter: process.env.EXT_GIT_COUNTER,
      ref: process.env.EXT_RACE_REF,
      to: process.env.EXT_RACE_TO,
      marker: process.env.EXT_RACE_MARKER,
    };
    process.env.PATH = `${wrapperDirectory}:${originalPath ?? ''}`;
    process.env.EXT_GIT_REAL = realGit;
    process.env.EXT_GIT_COUNTER = counter;
    process.env.EXT_RACE_REF = handoff.target.baseRef;
    process.env.EXT_RACE_TO = replacement;
    process.env.EXT_RACE_MARKER = marker;
    try {
      let observedError: unknown;
      try {
        await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
      } catch (error) {
        observedError = error;
      }
      expect(existsSync(marker)).toBe(true);
      expect(observedError).toMatchObject({ code: 'observation_changed' });
      expect(git(fx.repo, 'rev-parse', handoff.target.baseRef)).toBe(replacement);
      expect(replacement).not.toBe(base);
    } finally {
      process.env.PATH = originalPath;
      for (const [key, value] of Object.entries({
        EXT_GIT_REAL: originalEnvironment.real,
        EXT_GIT_COUNTER: originalEnvironment.counter,
        EXT_RACE_REF: originalEnvironment.ref,
        EXT_RACE_TO: originalEnvironment.to,
        EXT_RACE_MARKER: originalEnvironment.marker,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(wrapperDirectory, { recursive: true, force: true });
    }
  });

  it('rejects tampered immutable records and never lets them produce a positive projection', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture();
    const approval = approveExternalObservation(fx, observation);
    const persisted = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    expect(() =>
      fx.db
        .prepare('UPDATE goal_external_integration_attestations SET record_digest = ? WHERE id = ?')
        .run('0'.repeat(64), persisted.record.attestationId),
    ).toThrow(/immutable/);
    expect(() =>
      fx.db
        .prepare('DELETE FROM goal_external_integration_attestations WHERE id = ?')
        .run(persisted.record.attestationId),
    ).toThrow(/cannot be deleted/);
    fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
    const row = fx.db
      .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
      .get(persisted.record.attestationId) as { payload_json: string };
    const damaged = row.payload_json.replace(
      persisted.record.destination.observedCommit,
      '0'.repeat(persisted.record.destination.observedCommit.length),
    );
    fx.db
      .prepare(
        'UPDATE goal_external_integration_attestations SET payload_json = ?, observed_destination_commit = ? WHERE id = ?',
      )
      .run(
        damaged,
        '0'.repeat(persisted.record.destination.observedCommit.length),
        persisted.record.attestationId,
      );
    expect(
      await getExternalIntegrationProjection(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({
      state: 'invalid',
      claim: 'not_verified',
    });
  });
});

describe('external integration attestation corrections', () => {
  function errorCode(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return error instanceof AttestationCorrectionError ? error.code : `unexpected:${String(error)}`;
    }
    return 'no_error';
  }

  async function attestedFixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
    const { fx, handoff, observation } = await integratedExternalFixture(objectFormat);
    const approval = approveExternalObservation(fx, observation);
    const persisted = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    return { fx, handoff, observation, attestation: persisted.record };
  }

  function requestCorrection(
    fx: Awaited<ReturnType<typeof attestedFixture>>['fx'],
    attestationId: string,
    overrides: Partial<Parameters<typeof requestAttestationCorrectionApproval>[1]> = {},
  ) {
    return requestAttestationCorrectionApproval(fx.db, {
      goalId: fx.goalId,
      attestationId,
      correctionKind: 'dispute',
      reasonCode: 'observation_error',
      explanation: 'The recorded observation is not what I confirmed.',
      replacementAttestationId: null,
      ...overrides,
    });
  }

  function decideApproved(fx: Awaited<ReturnType<typeof attestedFixture>>['fx'], approvalId: string): void {
    decideGoalApproval(fx.db, { goalId: fx.goalId, approvalId, decision: 'approved', decidedBy: 'user' });
  }

  function appendReviewed(
    fx: Awaited<ReturnType<typeof attestedFixture>>['fx'],
    reviewed: { approval: { id: string }; actionDigest: string },
    explanation: string | null,
  ) {
    return appendAttestationCorrection(fx.db, {
      goalId: fx.goalId,
      approvalId: reviewed.approval.id,
      expectedActionDigest: reviewed.actionDigest,
      explanation,
    });
  }

  it.each(['sha1', 'sha256'] as const)(
    'appends a dispute once, reuses identical retries, and keeps the original attestation intact (%s)',
    async (objectFormat) => {
      const { fx, attestation } = await attestedFixture(objectFormat);
      const originalRow = fx.db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(attestation.attestationId);
      expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'active_uncontested',
        correctionCount: 0,
        tip: null,
      });

      const reviewed = requestCorrection(fx, attestation.attestationId);
      expect(reviewed.approval).toMatchObject({
        gate: 'user_confirmation',
        risk: 'high',
        requestedBy: 'user',
        status: 'pending',
        attestationCorrectionActionDigest: reviewed.actionDigest,
      });
      const explanation = 'The recorded observation is not what I confirmed.';
      expect(errorCode(() => appendReviewed(fx, reviewed, explanation))).toBe('approval_required');
      decideApproved(fx, reviewed.approval.id);

      const appended = appendReviewed(fx, reviewed, explanation);
      expect(appended).toMatchObject({
        reused: false,
        record: {
          correctionKind: 'dispute',
          sequence: 1,
          previousCorrectionDigest: null,
          actionDigest: reviewed.actionDigest,
          attestationId: attestation.attestationId,
          explanation,
          reasonCode: 'observation_error',
        },
      });
      const retry = appendReviewed(fx, reviewed, explanation);
      expect(retry).toMatchObject({
        reused: true,
        record: {
          correctionId: appended.record.correctionId,
          correctionDigest: appended.record.correctionDigest,
        },
      });
      expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'disputed',
        correctionCount: 1,
        tip: { kind: 'dispute', sequence: 1, correctionDigest: appended.record.correctionDigest },
      });
      expect(
        fx.db
          .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
          .get(attestation.attestationId),
      ).toEqual(originalRow);
      expect(
        await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestation.attestationId),
      ).toMatchObject({ state: 'current' });
      expect(
        (
          fx.db
            .prepare(
              "SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ? AND type = 'external_integration_corrected'",
            )
            .get(fx.goalId) as { n: number }
        ).n,
      ).toBe(1);
    },
  );

  it('allows withdrawal after dispute and refuses any further correction once withdrawn', async () => {
    const { fx, attestation } = await attestedFixture();
    const dispute = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, dispute.approval.id);
    const disputed = appendReviewed(fx, dispute, 'The recorded observation is not what I confirmed.');

    const withdraw = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'withdraw',
      reasonCode: 'integration_not_performed',
      explanation: 'I did not integrate this source.',
    });
    expect(withdraw.detail).toMatchObject({
      sequence: 2,
      previousCorrectionDigest: disputed.record.correctionDigest,
      correctionKind: 'withdraw',
    });
    decideApproved(fx, withdraw.approval.id);
    expect(appendReviewed(fx, withdraw, 'I did not integrate this source.').record).toMatchObject({
      sequence: 2,
      correctionKind: 'withdraw',
    });
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'withdrawn',
      correctionCount: 2,
    });
    expect(
      errorCode(() => requestCorrection(fx, attestation.attestationId, { correctionKind: 'dispute' })),
    ).toBe('correction_transition_not_allowed');
    expect(
      errorCode(() =>
        requestCorrection(fx, attestation.attestationId, {
          correctionKind: 'supersede',
          replacementAttestationId: attestation.attestationId,
        }),
      ),
    ).toBe('correction_transition_not_allowed');
  });

  it('refuses a competing correction built from the same chain tip after the first one commits', async () => {
    const { fx, attestation } = await attestedFixture();
    const first = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'dispute',
      explanation: 'First review.',
    });
    const competing = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'withdraw',
      reasonCode: 'wrong_destination',
      explanation: 'Competing review.',
    });
    expect(first.detail.sequence).toBe(1);
    expect(competing.detail.sequence).toBe(1);
    decideApproved(fx, first.approval.id);
    decideApproved(fx, competing.approval.id);
    appendReviewed(fx, first, 'First review.');
    expect(errorCode(() => appendReviewed(fx, competing, 'Competing review.'))).toBe(
      'correction_chain_changed',
    );
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'disputed',
      correctionCount: 1,
    });
  });

  it('refuses changed, control-character, and cross-Goal correction input', async () => {
    const { fx, attestation } = await attestedFixture();
    expect(
      errorCode(() => requestCorrection(fx, attestation.attestationId, { explanation: 'bad\u0007text' })),
    ).toBe('explanation_invalid');
    expect(
      errorCode(() => requestCorrection(fx, attestation.attestationId, { explanation: 'bidi ‮text' })),
    ).toBe('explanation_invalid');
    expect(
      errorCode(() =>
        buildAttestationCorrectionAction(fx.db, {
          goalId: '00000000-0000-4000-8000-000000000000',
          attestationId: attestation.attestationId,
          correctionKind: 'dispute',
          reasonCode: 'other',
          explanation: null,
          replacementAttestationId: null,
        }),
      ),
    ).toBe('goal_not_found');

    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    expect(errorCode(() => appendReviewed(fx, reviewed, 'A different explanation.'))).toBe(
      'explanation_invalid',
    );
    expect(errorCode(() => appendReviewed(fx, reviewed, null))).toBe('explanation_invalid');
    expect(
      errorCode(() =>
        appendAttestationCorrection(fx.db, {
          goalId: '00000000-0000-4000-8000-000000000000',
          approvalId: reviewed.approval.id,
          expectedActionDigest: reviewed.actionDigest,
          explanation: 'The recorded observation is not what I confirmed.',
        }),
      ),
    ).toBe('goal_not_found');
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId).standing).toBe(
      'active_uncontested',
    );
  });

  it('supersedes only with an exact compatible uncorrected replacement and keeps the replacement independent', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    expect(
      errorCode(() =>
        requestCorrection(fx, attestation.attestationId, {
          correctionKind: 'supersede',
          replacementAttestationId: '00000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toBe('replacement_invalid');
    expect(
      errorCode(() =>
        requestCorrection(fx, attestation.attestationId, {
          correctionKind: 'supersede',
          replacementAttestationId: attestation.attestationId,
        }),
      ),
    ).toBe('replacement_invalid');

    const later = fx.git(
      'commit-tree',
      attestation.destination.observedTree,
      '-p',
      attestation.destination.observedCommit,
      '-m',
      'later destination change',
    );
    fx.git('update-ref', handoff.target.baseRef, later);
    const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
    const newApproval = approveExternalObservation(fx, newObservation);
    const replacement = (
      await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: newObservation,
        approvalId: newApproval.id,
      })
    ).record;

    const supersede = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'supersede',
      reasonCode: 'superseded_by_new_observation',
      explanation: 'A newer exact observation replaces this one.',
      replacementAttestationId: replacement.attestationId,
    });
    expect(supersede.detail).toMatchObject({
      correctionKind: 'supersede',
      replacementAttestationId: replacement.attestationId,
      replacementRecordDigest: replacement.recordDigest,
    });
    decideApproved(fx, supersede.approval.id);
    appendReviewed(fx, supersede, 'A newer exact observation replaces this one.');
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'superseded',
      tip: { kind: 'supersede', replacementAttestationId: replacement.attestationId },
    });
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, replacement.attestationId)).toMatchObject({
      standing: 'active_uncontested',
      correctionCount: 0,
    });
  });

  it('reports a supersession as invalid when its replacement approval no longer matches the replacement', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    const later = fx.git(
      'commit-tree',
      attestation.destination.observedTree,
      '-p',
      attestation.destination.observedCommit,
      '-m',
      'later destination change for replacement tamper',
    );
    fx.git('update-ref', handoff.target.baseRef, later);
    const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
    const newApproval = approveExternalObservation(fx, newObservation);
    const replacement = (
      await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: newObservation,
        approvalId: newApproval.id,
      })
    ).record;
    const supersede = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'supersede',
      reasonCode: 'superseded_by_new_observation',
      explanation: 'A newer exact observation replaces this one.',
      replacementAttestationId: replacement.attestationId,
    });
    decideApproved(fx, supersede.approval.id);
    appendReviewed(fx, supersede, 'A newer exact observation replaces this one.');
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'superseded',
    });

    fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
    fx.db.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(newApproval.id);
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'invalid',
    });
  });

  it('refuses supersession by a replacement that has already been corrected', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    const later = fx.git(
      'commit-tree',
      attestation.destination.observedTree,
      '-p',
      attestation.destination.observedCommit,
      '-m',
      'later destination change',
    );
    fx.git('update-ref', handoff.target.baseRef, later);
    const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
    const replacement = (
      await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: newObservation,
        approvalId: approveExternalObservation(fx, newObservation).id,
      })
    ).record;
    const replacementDispute = requestCorrection(fx, replacement.attestationId);
    decideApproved(fx, replacementDispute.approval.id);
    appendReviewed(fx, replacementDispute, 'The recorded observation is not what I confirmed.');
    expect(
      errorCode(() =>
        requestCorrection(fx, attestation.attestationId, {
          correctionKind: 'supersede',
          replacementAttestationId: replacement.attestationId,
        }),
      ),
    ).toBe('replacement_invalid');
  });

  it('keeps corrections append-only and fails closed on a corrupted stored correction', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    const appended = appendReviewed(fx, reviewed, 'The recorded observation is not what I confirmed.');
    expect(() =>
      fx.db
        .prepare('UPDATE goal_attestation_corrections SET reason_code = ? WHERE id = ?')
        .run('other', appended.record.correctionId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare('DELETE FROM goal_attestation_corrections WHERE id = ?')
        .run(appended.record.correctionId),
    ).toThrow(/cannot be deleted/);

    fx.db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
    const row = fx.db
      .prepare('SELECT payload_json FROM goal_attestation_corrections WHERE id = ?')
      .get(appended.record.correctionId) as { payload_json: string };
    const damaged = row.payload_json.replace(
      'The recorded observation is not what I confirmed.',
      'A changed statement that was never approved.',
    );
    fx.db
      .prepare('UPDATE goal_attestation_corrections SET payload_json = ?, explanation = ? WHERE id = ?')
      .run(damaged, 'A changed statement that was never approved.', appended.record.correctionId);
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'invalid',
      invalidCode: 'correction_chain_invalid',
    });
    expect(
      errorCode(() => appendReviewed(fx, reviewed, 'The recorded observation is not what I confirmed.')),
    ).toBe('correction_chain_invalid');
  });

  it('refuses correction approvals whose authority is forged, mutated, or bound to another action', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    expect(() =>
      fx.db
        .prepare('UPDATE goal_approvals SET attestation_correction_action_digest = ? WHERE id = ?')
        .run('0'.repeat(64), reviewed.approval.id),
    ).toThrow(/immutable/);
    expect(() =>
      requestGoalApproval(fx.db, {
        goalId: fx.goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'forged correction',
        requestedBy: 'user',
        detail: reviewed.detail,
        attestationCorrectionActionDigest: '1'.repeat(64),
      }),
    ).toThrow(/attestation correction digest must match/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at, attestation_correction_action_digest)
           VALUES (?, ?, 'final_apply', 'high', 'forged', 'user', ?, 'pending', ?, ?)`,
        )
        .run(
          randomUUID(),
          fx.goalId,
          JSON.stringify(reviewed.detail),
          new Date().toISOString(),
          reviewed.actionDigest,
        ),
    ).toThrow(/attestation correction approval action digest is invalid/);
  });

  it('exposes read-only correction history scoped to one Goal, handoff, and attestation', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    app = goalApp(fx.db, disabledSupervisor(fx.db));
    const basePath = `/api/goals/${fx.goalId}/handoffs/${handoff.handoffId}/external-integration/attestations/${attestation.attestationId}/corrections`;

    expect(await call(app, 'GET', basePath)).toMatchObject({
      status: 200,
      body: {
        attestationId: attestation.attestationId,
        standing: { standing: 'active_uncontested', correctionCount: 0, tip: null },
        corrections: [],
      },
    });
    expect(
      await call(
        app,
        'GET',
        `/api/goals/not-a-uuid/handoffs/${handoff.handoffId}/external-integration/attestations/${attestation.attestationId}/corrections`,
      ),
    ).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    expect(
      await call(
        app,
        'GET',
        `/api/goals/${fx.goalId}/handoffs/${randomUUID()}/external-integration/attestations/${attestation.attestationId}/corrections`,
      ),
    ).toMatchObject({ status: 404, body: { code: 'attestation_not_found' } });

    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    const appended = appendReviewed(fx, reviewed, 'The recorded observation is not what I confirmed.');
    const countsBefore = fx.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM goal_attestation_corrections) AS corrections, (SELECT COUNT(*) FROM goal_events) AS events',
      )
      .get();
    const read = await call(app, 'GET', basePath);
    expect(read).toMatchObject({
      status: 200,
      body: {
        standing: {
          standing: 'disputed',
          correctionCount: 1,
          tip: { kind: 'dispute', sequence: 1, correctionDigest: appended.record.correctionDigest },
        },
        corrections: [
          {
            correctionId: appended.record.correctionId,
            correctionKind: 'dispute',
            sequence: 1,
            previousCorrectionDigest: null,
            actionDigest: reviewed.actionDigest,
            explanation: 'The recorded observation is not what I confirmed.',
          },
        ],
      },
    });
    expect(
      fx.db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM goal_attestation_corrections) AS corrections, (SELECT COUNT(*) FROM goal_events) AS events',
        )
        .get(),
    ).toEqual(countsBefore);

    fx.db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
    const row = fx.db
      .prepare('SELECT payload_json FROM goal_attestation_corrections WHERE id = ?')
      .get(appended.record.correctionId) as { payload_json: string };
    const damaged = row.payload_json.replace(
      'The recorded observation is not what I confirmed.',
      'A changed statement that was never approved.',
    );
    fx.db
      .prepare('UPDATE goal_attestation_corrections SET payload_json = ?, explanation = ? WHERE id = ?')
      .run(damaged, 'A changed statement that was never approved.', appended.record.correctionId);
    expect(await call(app, 'GET', basePath)).toMatchObject({
      status: 409,
      body: { code: 'correction_chain_invalid' },
    });
  });

  it('keeps a second real Goal from reading, requesting, or appending another Goal’s correction', async () => {
    const { fx, attestation, handoff } = await attestedFixture();
    const other = createGoalDraft(fx.db, {
      projectId: fx.projectId,
      title: 'Other Goal',
      definition: simpleDefinition(),
    });
    expect(
      errorCode(() =>
        buildAttestationCorrectionAction(fx.db, {
          goalId: other.goalId,
          attestationId: attestation.attestationId,
          correctionKind: 'dispute',
          reasonCode: 'other',
          explanation: null,
          replacementAttestationId: null,
        }),
      ),
    ).toBe('attestation_not_found');
    expect(
      errorCode(() => listAttestationCorrectionHistory(fx.db, other.goalId, attestation.attestationId)),
    ).toBe('attestation_not_found');

    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    expect(
      errorCode(() =>
        appendAttestationCorrection(fx.db, {
          goalId: other.goalId,
          approvalId: reviewed.approval.id,
          expectedActionDigest: reviewed.actionDigest,
          explanation: 'The recorded observation is not what I confirmed.',
        }),
      ),
    ).toBe('approval_mismatch');
    expect(
      fx.db
        .prepare('SELECT COUNT(*) AS n FROM goal_attestation_corrections WHERE goal_id = ?')
        .get(other.goalId),
    ).toEqual({ n: 0 });

    const forgedRow = (goalId: string) => {
      const body = {
        schemaVersion: 1 as const,
        kind: 'turing_goal_attestation_correction' as const,
        correctionId: randomUUID(),
        goalId,
        handoffId: handoff.handoffId,
        handoffDigest: handoff.handoffDigest,
        attestationId: attestation.attestationId,
        attestationActionDigest: attestation.actionDigest,
        attestationRecordDigest: attestation.recordDigest,
        approvalId: reviewed.approval.id,
        correctionKind: 'dispute' as const,
        sequence: 1,
        previousCorrectionDigest: null,
        actionDigest: reviewed.actionDigest,
        reasonCode: 'observation_error' as const,
        explanation: null,
        explanationDigest: null,
        replacement: null,
        definition: { version: attestation.definition.version, hash: attestation.definition.hash },
        decision: {
          value: 'correct_external_integration_attestation_v1' as const,
          decidedBy: 'user' as const,
          decidedAt: 'not-the-approval-time',
        },
      };
      return { body, correctionDigest: computeAttestationCorrectionRecordDigest(body) };
    };
    const { body, correctionDigest } = forgedRow(other.goalId);
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO goal_attestation_corrections (
            id, goal_id, schema_version, kind, handoff_id, handoff_digest, attestation_id,
            attestation_action_digest, attestation_record_digest, approval_id, correction_kind, sequence,
            previous_correction_digest, action_digest, correction_digest, reason_code, explanation,
            explanation_digest, replacement_attestation_id, replacement_record_digest, definition_version,
            definition_hash, decided_at, payload_json
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'dispute', 1, NULL, ?, ?, 'observation_error', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          body.correctionId,
          other.goalId,
          body.kind,
          body.handoffId,
          body.handoffDigest,
          body.attestationId,
          body.attestationActionDigest,
          body.attestationRecordDigest,
          body.approvalId,
          body.actionDigest,
          correctionDigest,
          body.definition.version,
          body.definition.hash,
          body.decision.decidedAt,
          canonicalJson({ ...body, correctionDigest }),
        ),
    ).toThrow(/attestation correction lacks exact approved authority or chain position/);
  });

  it('refuses malformed correction rows that bypass the service through direct SQL', async () => {
    const { fx, attestation, handoff } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    const first = appendReviewed(fx, reviewed, 'The recorded observation is not what I confirmed.');
    const insertRow = (
      kind: 'dispute' | 'withdraw' | 'supersede',
      sequence: number,
      approvalDetail: {
        kind: 'dispute' | 'withdraw' | 'supersede';
        sequence: number;
        previous: string | null;
        reasonCode: 'observation_error' | 'other';
      },
    ) => {
      const fields = {
        schemaVersion: 1 as const,
        action: 'correct_external_integration_attestation_v1' as const,
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        handoffDigest: handoff.handoffDigest,
        attestationId: attestation.attestationId,
        attestationActionDigest: attestation.actionDigest,
        attestationRecordDigest: attestation.recordDigest,
        attestationApprovalId: attestation.approvalId,
        correctionKind: approvalDetail.kind,
        sequence: approvalDetail.sequence,
        previousCorrectionDigest: approvalDetail.previous,
        reasonCode: approvalDetail.reasonCode,
        explanationDigest: null,
        replacementAttestationId: null,
        replacementRecordDigest: null,
        definitionVersion: attestation.definition.version,
        definitionHash: attestation.definition.hash,
      };
      const actionDigest = computeAttestationCorrectionActionDigest(fields);
      const approval = requestGoalApproval(fx.db, {
        goalId: fx.goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'direct-SQL negative fixture',
        requestedBy: 'user',
        detail: { ...fields, actionDigest },
        attestationCorrectionActionDigest: actionDigest,
      });
      decideApproved(fx, approval.id);
      const body = {
        schemaVersion: 1 as const,
        kind: 'turing_goal_attestation_correction' as const,
        correctionId: randomUUID(),
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        handoffDigest: handoff.handoffDigest,
        attestationId: attestation.attestationId,
        attestationActionDigest: attestation.actionDigest,
        attestationRecordDigest: attestation.recordDigest,
        approvalId: approval.id,
        correctionKind: kind,
        sequence,
        previousCorrectionDigest: approvalDetail.previous,
        actionDigest,
        reasonCode: approvalDetail.reasonCode,
        explanation: null,
        explanationDigest: null,
        replacement: null,
        definition: { version: attestation.definition.version, hash: attestation.definition.hash },
        decision: {
          value: 'correct_external_integration_attestation_v1' as const,
          decidedBy: 'user' as const,
          decidedAt: approval.respondedAt!,
        },
      };
      const correctionDigest = computeAttestationCorrectionRecordDigest(body);
      return fx.db
        .prepare(
          `INSERT INTO goal_attestation_corrections (
            id, goal_id, schema_version, kind, handoff_id, handoff_digest, attestation_id,
            attestation_action_digest, attestation_record_digest, approval_id, correction_kind, sequence,
            previous_correction_digest, action_digest, correction_digest, reason_code, explanation,
            explanation_digest, replacement_attestation_id, replacement_record_digest, definition_version,
            definition_hash, decided_at, payload_json
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          body.correctionId,
          fx.goalId,
          body.kind,
          body.handoffId,
          body.handoffDigest,
          body.attestationId,
          body.attestationActionDigest,
          body.attestationRecordDigest,
          body.approvalId,
          body.correctionKind,
          body.sequence,
          body.previousCorrectionDigest,
          body.actionDigest,
          correctionDigest,
          approvalDetail.reasonCode,
          body.definition.version,
          body.definition.hash,
          body.decision.decidedAt,
          canonicalJson({ ...body, correctionDigest }),
        );
    };

    expect(() =>
      insertRow('dispute', 2, {
        kind: 'dispute',
        sequence: 2,
        previous: first.record.correctionDigest,
        reasonCode: 'observation_error',
      }),
    ).toThrow(/attestation correction lacks exact approved authority or chain position/);
    expect(() =>
      insertRow('withdraw', 1, {
        kind: 'withdraw',
        sequence: 1,
        previous: null,
        reasonCode: 'observation_error',
      }),
    ).toThrow(/attestation correction lacks exact approved authority or chain position/);
    expect(() =>
      insertRow('withdraw', 2, {
        kind: 'dispute',
        sequence: 2,
        previous: first.record.correctionDigest,
        reasonCode: 'other',
      }),
    ).toThrow(/attestation correction lacks exact approved authority or chain position/);
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'disputed',
      correctionCount: 1,
    });
  });

  function withReopenedDatabase<T>(fx: { db: Db }, run: (db: Db) => T): T {
    const dataDir = dirname(fx.db.name);
    fx.db.close();
    const reopened = openDatabase(dataDir);
    try {
      return run(reopened);
    } finally {
      reopened.close();
    }
  }

  function appendOn(
    db: Db,
    goalId: string,
    reviewed: { approval: { id: string }; actionDigest: string },
    explanation: string | null,
  ) {
    return appendAttestationCorrection(db, {
      goalId,
      approvalId: reviewed.approval.id,
      expectedActionDigest: reviewed.actionDigest,
      explanation,
    });
  }

  it('keeps a committed correction across a fresh connection and returns the original on an exact retry', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    const explanation = 'The recorded observation is not what I confirmed.';
    const first = appendReviewed(fx, reviewed, explanation);
    const before = getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId);
    expect(before).toMatchObject({ standing: 'disputed', correctionCount: 1 });

    withReopenedDatabase(fx, (db) => {
      expect(getAttestationCorrectionStanding(db, fx.goalId, attestation.attestationId)).toEqual(before);
      const retry = appendOn(db, fx.goalId, reviewed, explanation);
      expect(retry.reused).toBe(true);
      expect(retry.record.correctionDigest).toBe(first.record.correctionDigest);
      expect(listAttestationCorrectionHistory(db, fx.goalId, attestation.attestationId)).toHaveLength(1);
    });
  });

  it('leaves an unapproved correction request pending and uncontested after a restart', async () => {
    const { fx, attestation } = await attestedFixture();
    const pending = requestCorrection(fx, attestation.attestationId);

    withReopenedDatabase(fx, (db) => {
      expect(getGoalApproval(db, pending.approval.id)).toMatchObject({ status: 'pending' });
      expect(getAttestationCorrectionStanding(db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'active_uncontested',
        correctionCount: 0,
      });
      expect(
        errorCode(() =>
          appendOn(db, fx.goalId, pending, 'The recorded observation is not what I confirmed.'),
        ),
      ).toBe('approval_required');
      expect(listAttestationCorrectionHistory(db, fx.goalId, attestation.attestationId)).toEqual([]);
    });
  });

  it('does not treat a decided approval without an appended row as a correction after a restart', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);

    withReopenedDatabase(fx, (db) => {
      expect(getAttestationCorrectionStanding(db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'active_uncontested',
        correctionCount: 0,
      });
      expect(listAttestationCorrectionHistory(db, fx.goalId, attestation.attestationId)).toEqual([]);
      // The decided approval still authorizes exactly one append after the restart.
      appendOn(db, fx.goalId, reviewed, 'The recorded observation is not what I confirmed.');
      expect(getAttestationCorrectionStanding(db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'disputed',
        correctionCount: 1,
      });
    });
  });

  it('rolls back the correction row when a later write inside the same transaction fails', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    const approvalBefore = getGoalApproval(fx.db, reviewed.approval.id);
    const explanation = 'The recorded observation is not what I confirmed.';

    // Fault after the correction row is inserted: the event write is the last statement in the transaction.
    fx.db.exec(
      "CREATE TRIGGER tt_fail_correction_event BEFORE INSERT ON goal_events WHEN NEW.type = 'external_integration_corrected' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;",
    );
    expect(errorCode(() => appendReviewed(fx, reviewed, explanation))).toBe('persistence_failed');
    fx.db.exec('DROP TRIGGER tt_fail_correction_event;');
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_attestation_corrections').get()).toEqual({ n: 0 });
    expect(
      fx.db
        .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE type = 'external_integration_corrected'")
        .get(),
    ).toEqual({ n: 0 });
    expect(getGoalApproval(fx.db, reviewed.approval.id)).toEqual(approvalBefore);
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'active_uncontested',
      correctionCount: 0,
    });

    // Fault at the row insert itself.
    fx.db.exec(
      "CREATE TRIGGER tt_fail_correction_insert BEFORE INSERT ON goal_attestation_corrections BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END;",
    );
    expect(errorCode(() => appendReviewed(fx, reviewed, explanation))).toBe('persistence_failed');
    fx.db.exec('DROP TRIGGER tt_fail_correction_insert;');
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_attestation_corrections').get()).toEqual({ n: 0 });

    // Positive control: the same approval appends once the fault is removed.
    appendReviewed(fx, reviewed, explanation);
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'disputed',
      correctionCount: 1,
    });
  });

  it('fails closed after a restart when a stored correction was damaged', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, reviewed.approval.id);
    const explanation = 'The recorded observation is not what I confirmed.';
    const appended = appendReviewed(fx, reviewed, explanation);
    fx.db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
    const row = fx.db
      .prepare('SELECT payload_json FROM goal_attestation_corrections WHERE id = ?')
      .get(appended.record.correctionId) as { payload_json: string };
    const damagedText = 'A changed statement that was never approved.';
    fx.db
      .prepare('UPDATE goal_attestation_corrections SET payload_json = ?, explanation = ? WHERE id = ?')
      .run(row.payload_json.replace(explanation, damagedText), damagedText, appended.record.correctionId);

    withReopenedDatabase(fx, (db) => {
      expect(getAttestationCorrectionStanding(db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'invalid',
        invalidCode: 'correction_chain_invalid',
      });
      expect(errorCode(() => appendOn(db, fx.goalId, reviewed, explanation))).toBe(
        'correction_chain_invalid',
      );
    });
  });

  it.each(['sha1', 'sha256'] as const)(
    'withdraws a disputed attestation under %s and keeps the chain ordered',
    async (objectFormat) => {
      const { fx, attestation } = await attestedFixture(objectFormat);
      const disputed = requestCorrection(fx, attestation.attestationId);
      decideApproved(fx, disputed.approval.id);
      appendReviewed(fx, disputed, 'The recorded observation is not what I confirmed.');
      const withdrawal = requestCorrection(fx, attestation.attestationId, {
        correctionKind: 'withdraw',
        explanation: 'I withdraw this claim.',
      });
      decideApproved(fx, withdrawal.approval.id);
      appendReviewed(fx, withdrawal, 'I withdraw this claim.');
      expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'withdrawn',
        correctionCount: 2,
      });
    },
    30_000,
  );

  it.each(['sha1', 'sha256'] as const)(
    'supersedes an attestation with a same-repository replacement under %s without moving any ref',
    async (objectFormat) => {
      const { fx, handoff, attestation } = await attestedFixture(objectFormat);
      const later = fx.git(
        'commit-tree',
        attestation.destination.observedTree,
        '-p',
        attestation.destination.observedCommit,
        '-m',
        'later destination change for format coverage',
      );
      fx.git('update-ref', handoff.target.baseRef, later);
      const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
      const newApproval = approveExternalObservation(fx, newObservation);
      const replacement = (
        await persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation: newObservation,
          approvalId: newApproval.id,
        })
      ).record;
      const refsBefore = fx.git('for-each-ref', '--format=%(refname) %(objectname)');
      const headBefore = fx.git('rev-parse', 'HEAD');

      const supersede = requestCorrection(fx, attestation.attestationId, {
        correctionKind: 'supersede',
        reasonCode: 'superseded_by_new_observation',
        explanation: 'A newer exact observation replaces this one.',
        replacementAttestationId: replacement.attestationId,
      });
      decideApproved(fx, supersede.approval.id);
      appendReviewed(fx, supersede, 'A newer exact observation replaces this one.');

      expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'superseded',
      });
      expect(getAttestationCorrectionStanding(fx.db, fx.goalId, replacement.attestationId)).toMatchObject({
        standing: 'active_uncontested',
      });
      expect(fx.git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
      expect(fx.git('rev-parse', 'HEAD')).toBe(headBefore);
    },
    30_000,
  );

  it('the completion predicate allows only uncontested correction standing (no completion consumer yet)', () => {
    expect(attestationCorrectionStandingAllowsCompletion('active_uncontested')).toBe(true);
    for (const standing of ['disputed', 'withdrawn', 'superseded', 'invalid'] as const)
      expect(attestationCorrectionStandingAllowsCompletion(standing)).toBe(false);
  });

  it('refuses an otherwise identical approval that belongs to a different Goal', async () => {
    const { fx, attestation } = await attestedFixture();
    const approval = getGoalApproval(fx.db, attestation.approvalId);
    expect(approvalIdentityMatchesRow(approval, attestation)).toBe(true);
    expect(approvalIdentityMatchesRow({ ...approval!, goalId: randomUUID() }, attestation)).toBe(false);
  });
  it('refuses a correction whose approved decision does not match the reviewed digest', async () => {
    const { fx, attestation } = await attestedFixture();
    const dispute = requestCorrection(fx, attestation.attestationId);
    const withdrawal = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'withdraw',
      explanation: 'I withdraw this claim.',
    });
    decideApproved(fx, dispute.approval.id);
    expect(
      errorCode(() =>
        appendAttestationCorrection(fx.db, {
          goalId: fx.goalId,
          approvalId: dispute.approval.id,
          expectedActionDigest: withdrawal.actionDigest,
          explanation: 'The recorded observation is not what I confirmed.',
        }),
      ),
    ).toBe('correction_action_mismatch');
    expect(
      errorCode(() =>
        appendReviewed(
          fx,
          { approval: dispute.approval, actionDigest: '0'.repeat(64) },
          'The recorded observation is not what I confirmed.',
        ),
      ),
    ).toBe('correction_action_mismatch');
    expect(listAttestationCorrectionHistory(fx.db, fx.goalId, attestation.attestationId)).toEqual([]);
  });

  it('refuses a denied correction approval and never appends it, including after a restart', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: reviewed.approval.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    expect(
      errorCode(() => appendReviewed(fx, reviewed, 'The recorded observation is not what I confirmed.')),
    ).toBe('approval_required');
    withReopenedDatabase(fx, (db) => {
      expect(
        errorCode(() =>
          appendOn(db, fx.goalId, reviewed, 'The recorded observation is not what I confirmed.'),
        ),
      ).toBe('approval_required');
      expect(listAttestationCorrectionHistory(db, fx.goalId, attestation.attestationId)).toEqual([]);
      expect(getAttestationCorrectionStanding(db, fx.goalId, attestation.attestationId)).toMatchObject({
        standing: 'active_uncontested',
        correctionCount: 0,
      });
    });
  });

  it('refuses a repeated dispute and any correction after a supersession', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    const disputed = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, disputed.approval.id);
    appendReviewed(fx, disputed, 'The recorded observation is not what I confirmed.');
    expect(errorCode(() => requestCorrection(fx, attestation.attestationId))).toBe(
      'correction_transition_not_allowed',
    );

    const later = fx.git(
      'commit-tree',
      attestation.destination.observedTree,
      '-p',
      attestation.destination.observedCommit,
      '-m',
      'later destination change for transition coverage',
    );
    fx.git('update-ref', handoff.target.baseRef, later);
    const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
    const newApproval = approveExternalObservation(fx, newObservation);
    const replacement = (
      await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: newObservation,
        approvalId: newApproval.id,
      })
    ).record;
    const supersede = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'supersede',
      reasonCode: 'superseded_by_new_observation',
      explanation: 'A newer exact observation replaces this one.',
      replacementAttestationId: replacement.attestationId,
    });
    decideApproved(fx, supersede.approval.id);
    appendReviewed(fx, supersede, 'A newer exact observation replaces this one.');

    expect(
      errorCode(() =>
        requestCorrection(fx, attestation.attestationId, {
          correctionKind: 'withdraw',
          explanation: 'I withdraw this claim.',
        }),
      ),
    ).toBe('correction_transition_not_allowed');
    expect(errorCode(() => requestCorrection(fx, attestation.attestationId))).toBe(
      'correction_transition_not_allowed',
    );
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'superseded',
    });
  });

  it('keeps an independent attestation eligible and leaves Git and Goal state untouched when another is withdrawn', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    const later = fx.git(
      'commit-tree',
      attestation.destination.observedTree,
      '-p',
      attestation.destination.observedCommit,
      '-m',
      'independent destination change',
    );
    fx.git('update-ref', handoff.target.baseRef, later);
    const newObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
    const newApproval = approveExternalObservation(fx, newObservation);
    const independent = (
      await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation: newObservation,
        approvalId: newApproval.id,
      })
    ).record;

    const gitState = () => ({
      refs: fx.git('for-each-ref'),
      head: fx.git('rev-parse', 'HEAD'),
      status: fx.git('status', '--porcelain'),
      staged: fx.git('diff', '--cached', '--name-only'),
    });
    const goalState = () =>
      fx.db
        .prepare(
          `SELECT status, status_reason_code,
            (SELECT COUNT(*) FROM goal_external_completion_proofs WHERE goal_id = goals.id) AS proofs
           FROM goals WHERE id = ?`,
        )
        .get(fx.goalId);
    const gitBefore = gitState();
    const goalBefore = goalState();

    const dispute = requestCorrection(fx, attestation.attestationId);
    decideApproved(fx, dispute.approval.id);
    appendReviewed(fx, dispute, 'The recorded observation is not what I confirmed.');
    const withdrawal = requestCorrection(fx, attestation.attestationId, {
      correctionKind: 'withdraw',
      explanation: 'I withdraw this claim.',
    });
    decideApproved(fx, withdrawal.approval.id);
    appendReviewed(fx, withdrawal, 'I withdraw this claim.');

    const withdrawnStanding = getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId);
    const independentStanding = getAttestationCorrectionStanding(fx.db, fx.goalId, independent.attestationId);
    expect(withdrawnStanding).toMatchObject({ standing: 'withdrawn' });
    expect(attestationCorrectionStandingAllowsCompletion(withdrawnStanding.standing)).toBe(false);
    expect(independentStanding).toMatchObject({ standing: 'active_uncontested', correctionCount: 0 });
    expect(attestationCorrectionStandingAllowsCompletion(independentStanding.standing)).toBe(true);
    expect(gitState()).toEqual(gitBefore);
    expect(goalState()).toEqual(goalBefore);
    expect(goalBefore).toMatchObject({ proofs: 0 });
  });

  it('serves another Goal’s correction route as not found for this attestation', async () => {
    const { fx, handoff, attestation } = await attestedFixture();
    const other = createGoalDraft(fx.db, {
      projectId: fx.projectId,
      title: 'Other Goal',
      definition: simpleDefinition(),
    });
    app = goalApp(fx.db, disabledSupervisor(fx.db));
    expect(
      await call(
        app,
        'GET',
        `/api/goals/${other.goalId}/handoffs/${handoff.handoffId}/external-integration/attestations/${attestation.attestationId}/corrections`,
      ),
    ).toMatchObject({ status: 404 });
  });
  it('appends a correction to a completed Goal without changing its status or reopening it', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    fx.db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").run(fx.goalId);
    const goalBefore = fx.db
      .prepare('SELECT status, status_reason_code FROM goals WHERE id = ?')
      .get(fx.goalId);
    decideApproved(fx, reviewed.approval.id);
    appendReviewed(fx, reviewed, 'The recorded observation is not what I confirmed.');
    expect(fx.db.prepare('SELECT status, status_reason_code FROM goals WHERE id = ?').get(fx.goalId)).toEqual(
      goalBefore,
    );
    expect(goalBefore).toMatchObject({ status: 'completed' });
    expect(getAttestationCorrectionStanding(fx.db, fx.goalId, attestation.attestationId)).toMatchObject({
      standing: 'disputed',
      correctionCount: 1,
    });
  });

  it('refuses a user decision on a correction approval for a terminal Goal through the command path', async () => {
    const { fx, attestation } = await attestedFixture();
    const reviewed = requestCorrection(fx, attestation.attestationId);
    fx.db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").run(fx.goalId);
    await expect(
      decideGoalApprovalAsUser(fx.db, { approvalId: reviewed.approval.id, decision: 'approved' }),
    ).rejects.toMatchObject({ code: 'goal_terminal' });
    expect(getGoalApproval(fx.db, reviewed.approval.id)).toMatchObject({ status: 'pending' });
    expect(listAttestationCorrectionHistory(fx.db, fx.goalId, attestation.attestationId)).toEqual([]);
  });
});
describe('version-2 completion characterization (D.3.0C)', () => {
  // Characterization tests (D.3.0C): they pin observable behaviour and change no production code.
  it('refuses a manual handoff for a version-2 amendment that has no fresh final review or acceptance', async () => {
    const { fx } = await acceptedFixture();
    const version2 = structuredClone(fx.definition);
    version2.contract.completionPolicy.completionContractVersion = 2;
    version2.contract.completionPolicy.integrationMode = 'external_user_attested';
    const amendment = beginAmendment(fx.db, {
      goalId: fx.goalId,
      actor: 'user',
      definition: version2,
      changeSummary: 'Characterize the version-2 handoff refusal.',
    });
    approveDefinition(fx.db, { goalId: fx.goalId, version: amendment.version, actor: 'user' });

    let code = 'no_error';
    try {
      await prepareManualHandoff(fx.db, fx.goalId);
    } catch (error) {
      code = error instanceof ManualHandoffError ? error.code : `unexpected:${String(error)}`;
    }
    expect(code).toBe('completion_not_ready');
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({ n: 0 });
  });

  it('characterizes that a user cannot move a Goal from running to completed through the state machine', async () => {
    const { fx } = await acceptedFixture();
    const before = fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId);
    let refusal = 'no_error';
    try {
      transitionGoal(fx.db, {
        goalId: fx.goalId,
        to: 'completed',
        reasonCode: 'completion_verified',
        actor: 'user',
      });
    } catch (error) {
      refusal = error instanceof GoalStateError ? error.code : `unexpected:${String(error)}`;
    }
    expect(refusal).toBe('illegal_transition');
    expect(fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId)).toEqual(before);
  });
});
describe('version-2 handoff preparation (D.3.1)', () => {
  it.each(['sha1', 'sha256'] as const)(
    'prepares a version-2 handoff, verifies a fast-forward integration, and persists an attestation under %s',
    async (objectFormat) => {
      const { fx, handoff, observation } = await integratedExternalFixture(objectFormat, 'fast-forward', {
        completionContractVersion2: true,
      });
      expect(handoff.handoffId).toMatch(/^[0-9a-f-]{36}$/);
      expect(observation).toMatchObject({
        completionContractVersion: 2,
        handoff: { id: handoff.handoffId, digest: handoff.handoffDigest },
      });
      const statusBefore = fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId);
      const approval = approveExternalObservation(fx, observation);
      const attestation = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      expect(attestation.record).toMatchObject({ completionContractVersion: 2 });
      expect(fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId)).toEqual(statusBefore);
      expect(
        fx.db
          .prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?')
          .get(fx.goalId),
      ).toEqual({ n: 0 });
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.finalApply).toEqual({
        required: true,
        ok: false,
        basis: null,
        reason: 'external_completion_not_activated',
      });
    },
  );

  it('fails closed for a version-2 observation when the source ref moves or the repository identity changes', async () => {
    const sourceMoved = await integratedExternalFixture('sha1', 'fast-forward', {
      completionContractVersion2: true,
    });
    const replacementSource = sourceMoved.fx.git(
      'commit-tree',
      sourceMoved.observation.source.tree,
      '-p',
      sourceMoved.handoff.target.observedBaseCommit,
      '-m',
      'different version-2 source commit with the same tree',
    );
    sourceMoved.fx.git('update-ref', sourceMoved.handoff.source.goalRef, replacementSource);
    expect(
      await validateExternalIntegrationObservation(
        sourceMoved.fx.db,
        sourceMoved.fx.goalId,
        sourceMoved.handoff.handoffId,
        sourceMoved.observation,
      ),
    ).toMatchObject({ state: 'stale', code: 'source_changed' });

    const replacedRepository = await integratedExternalFixture('sha1', 'fast-forward', {
      completionContractVersion2: true,
    });
    const alternate = join(replacedRepository.fx.repo, 'unrelated-version-2-repository');
    mkdirSync(alternate);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', alternate]);
    replacedRepository.fx.db
      .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
      .run(alternate, alternate, replacedRepository.fx.projectId);
    expect(
      await validateExternalIntegrationObservation(
        replacedRepository.fx.db,
        replacedRepository.fx.goalId,
        replacedRepository.handoff.handoffId,
        replacedRepository.observation,
      ),
    ).toMatchObject({ state: 'stale', code: 'repository_identity_changed' });
  });

  it('refuses a version-2 handoff when final review is missing', async () => {
    const { fx } = await acceptedFixture('sha1', { completionContractVersion2: true, omitReview: true });
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({ n: 0 });
  });

  it('refuses a version-2 handoff when final user acceptance is missing', async () => {
    const { fx } = await acceptedFixture('sha1', { completionContractVersion2: true, omitAcceptance: true });
    await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
      code: 'completion_not_ready',
    });
    expect(
      fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(fx.goalId),
    ).toEqual({ n: 0 });
  });
});

type ClosureFixture = Awaited<ReturnType<typeof acceptedFixture>>['fx'];

describe('version-2 handoff closure (D.3.1 review)', () => {
  const FORMATS = ['sha1', 'sha256'] as const;

  async function v2Prepared(objectFormat: 'sha1' | 'sha256') {
    const accepted = await acceptedFixture(objectFormat, { completionContractVersion2: true });
    const handoff = (await prepareManualHandoff(accepted.fx.db, accepted.fx.goalId)).record;
    return { ...accepted, handoff };
  }
  const handoffCount = (db: Db, goalId: string) =>
    db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?').get(goalId);
  const attestationCount = (db: Db, goalId: string) =>
    db
      .prepare('SELECT COUNT(*) AS n FROM goal_external_integration_attestations WHERE goal_id = ?')
      .get(goalId);
  const proofCount = (db: Db, goalId: string) =>
    db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?').get(goalId);
  const goalStatus = (db: Db, goalId: string) =>
    db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId);
  const handoffRow = (db: Db, handoffId: string) =>
    db.prepare('SELECT payload_json, handoff_digest FROM goal_result_handoffs WHERE id = ?').get(handoffId);

  function blockingFinding(severity: 'critical' | 'high' | 'medium') {
    return {
      severity,
      category: 'correctness',
      description: `A ${severity} finding recorded after handoff preparation.`,
      evidence: 'A deterministic test finding.',
      affectedFiles: ['src/result.txt'],
      remediation: 'Resolve it.',
    };
  }

  async function recordMilestoneFindings(fx: ClosureFixture, severity: 'critical' | 'high' | 'medium') {
    const review = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      reviewKind: 'milestone',
      milestoneId: fx.milestoneId('m1'),
    });
    completeReview(fx.db, {
      reviewId: review.id,
      report: {
        ...passingReport,
        verdict: 'pass_with_findings',
        newFindings: [blockingFinding(severity)],
      },
    });
    await applyReviewFindings(fx.db, { reviewId: review.id });
  }

  it.each([
    'no approved version',
    'non-current version',
    'corrupted definition hash',
    'invalid approval lineage',
  ] as const)(
    'A1 fails closed when the approved completion-policy mode is unavailable (%s) and refuses handoff preparation',
    async (cause) => {
      if (cause === 'no approved version') {
        const unapproved = goalRepoFixture({ approved: false });
        expect(approvedCompletionPolicyMode(unapproved.db, unapproved.goalId, 1)).toBeNull();
        const before = repositoryState(unapproved.repo);
        await expect(prepareManualHandoff(unapproved.db, unapproved.goalId)).rejects.toMatchObject({
          code: 'definition_not_approved',
        });
        expect(handoffCount(unapproved.db, unapproved.goalId)).toEqual({ n: 0 });
        expect(repositoryState(unapproved.repo)).toEqual(before);
        return;
      }

      const { fx } = await acceptedFixture('sha1', { completionContractVersion2: true });
      // Control: the untouched version-2 approved authority yields the version-2 mode before any corruption.
      expect(approvedCompletionPolicyMode(fx.db, fx.goalId, 1)).toBe('external_user_attested_v2');
      let expectedCode: 'definition_not_approved' | 'completion_not_ready';

      if (cause === 'non-current version') {
        // A second approved version becomes current; version 1 keeps its own valid mode but is no longer current.
        const revised = structuredClone(fx.definition);
        revised.contract.outcome = 'The same version-2 result under a second approved version.';
        const proposal = beginAmendment(fx.db, {
          goalId: fx.goalId,
          actor: 'user',
          changeSummary: 'Second approved version for the completion-mode test.',
          definition: revised,
        });
        approveDefinition(fx.db, {
          goalId: fx.goalId,
          version: proposal.version,
          expectedDefinitionHash: proposal.definitionHash,
          actor: 'user',
        });
        expect(approvedCompletionPolicyMode(fx.db, fx.goalId, proposal.version)).toBe(
          'external_user_attested_v2',
        );
        expect(approvedCompletionPolicyMode(fx.db, fx.goalId, 1)).toBeNull();
        expectedCode = 'completion_not_ready';
      } else if (cause === 'corrupted definition hash') {
        dropDefinitionImmutabilityTrigger(fx.db);
        fx.db
          .prepare(
            'UPDATE goal_definition_versions SET definition_hash = ? WHERE goal_id = ? AND version = 1',
          )
          .run('f'.repeat(64), fx.goalId);
        expect(approvedCompletionPolicyMode(fx.db, fx.goalId, 1)).toBeNull();
        expectedCode = 'definition_not_approved';
      } else {
        dropApprovalIdentityTriggers(fx.db);
        const approvalId = loadDefinitionVersion(fx.db, fx.goalId, 1)!.approvalId;
        const approval = getGoalApproval(fx.db, approvalId)!;
        fx.db
          .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...approval.detail, definitionHash: 'f'.repeat(64) }), approvalId);
        expect(approvedCompletionPolicyMode(fx.db, fx.goalId, 1)).toBeNull();
        expectedCode = 'definition_not_approved';
      }

      const before = repositoryState(fx.repo);
      await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({ code: expectedCode });
      expect(handoffCount(fx.db, fx.goalId)).toEqual({ n: 0 });
      expect(repositoryState(fx.repo)).toEqual(before);
    },
  );

  it.each(FORMATS)(
    'A2 refuses a previously valid observation and attestation after the Goal source ref moves (%s)',
    async (objectFormat) => {
      const { fx, handoff, observation } = await integratedExternalFixture(objectFormat, 'fast-forward', {
        completionContractVersion2: true,
      });
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toMatchObject({ state: 'valid', observation: { actionDigest: observation.actionDigest } });
      const approval = approveExternalObservation(fx, observation);
      const persisted = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      const attestationId = persisted.record.attestationId;
      expect(await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestationId)).toMatchObject({
        state: 'current',
      });

      const statusBefore = goalStatus(fx.db, fx.goalId);
      const rowBefore = handoffRow(fx.db, handoff.handoffId);
      const replacement = fx.git(
        'commit-tree',
        observation.source.tree,
        '-p',
        handoff.target.observedBaseCommit,
        '-m',
        'same source tree under a different source commit',
      );
      fx.git('update-ref', handoff.source.goalRef, replacement);
      const moved = repositoryState(fx.repo);

      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toEqual({ state: 'stale', code: 'source_changed' });
      expect(await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestationId)).toMatchObject({
        state: 'stale',
        reason: { code: 'source_changed' },
      });
      // A second approval for the same action digest is impossible (unique index); reuse the first one. Validation
      // runs before any approval lookup, so the refusal under test is still the observation's own.
      await expect(
        persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation,
          approvalId: approval.id,
        }),
      ).rejects.toMatchObject({ code: 'source_changed' });
      expect(attestationCount(fx.db, fx.goalId)).toEqual({ n: 1 });
      expect(handoffRow(fx.db, handoff.handoffId)).toEqual(rowBefore);
      expect(goalStatus(fx.db, fx.goalId)).toEqual(statusBefore);
      expect(proofCount(fx.db, fx.goalId)).toEqual({ n: 0 });
      expect(repositoryState(fx.repo)).toEqual(moved);
    },
  );

  it.each(FORMATS)(
    'A3 refuses destination-ref movement for version 2 without ancestry-based acceptance (%s)',
    async (objectFormat) => {
      const { fx, handoff, observation } = await integratedExternalFixture(objectFormat, 'fast-forward', {
        completionContractVersion2: true,
      });
      const approval = approveExternalObservation(fx, observation);
      const persisted = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      const attestationId = persisted.record.attestationId;
      const assertValidBaseline = async () => {
        expect(
          await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
        ).toMatchObject({ state: 'valid' });
        expect(await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestationId)).toMatchObject({
          state: 'current',
        });
      };
      const moveBase = (commit: string) => fx.git('update-ref', handoff.target.baseRef, commit);
      await assertValidBaseline();

      // (a) Advance: the destination moves to a descendant of the attested tip (D1 core).
      const later = fx.git(
        'commit-tree',
        observation.destination.observedTree,
        '-p',
        observation.destination.observedCommit,
        '-m',
        'later destination change',
      );
      moveBase(later);
      const advanced = repositoryState(fx.repo);
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toEqual({ state: 'stale', code: 'observation_changed' });
      const historical = await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestationId);
      expect(historical).toMatchObject({
        state: 'historical',
        reason: { code: 'destination_advanced_after_observation' },
      });
      expect(historical.currentObservation).not.toBeNull();
      expect(historical.currentObservation!.actionDigest).not.toBe(observation.actionDigest);
      await expect(
        persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation,
          approvalId: approval.id,
        }),
      ).rejects.toMatchObject({ code: 'observation_changed' });
      expect(attestationCount(fx.db, fx.goalId)).toEqual({ n: 1 });
      const fresh = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
      expect(fresh.actionDigest).not.toBe(observation.actionDigest);
      await expect(
        persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation: fresh,
          approvalId: approval.id,
        }),
      ).rejects.toMatchObject({ code: 'approval_mismatch' });
      expect(repositoryState(fx.repo)).toEqual(advanced);
      moveBase(observation.destination.observedCommit);
      await assertValidBaseline();

      // (b) Base reset to a commit that does not contain the source.
      moveBase(observation.destination.expectedBaseCommit);
      const notAncestor = repositoryState(fx.repo);
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toEqual({ state: 'not_integrated', code: 'source_not_ancestor' });
      expect(repositoryState(fx.repo)).toEqual(notAncestor);
      moveBase(observation.destination.observedCommit);
      await assertValidBaseline();

      // (c) Base replaced by an unrelated root commit.
      const unrelated = fx.git(
        'commit-tree',
        observation.destination.expectedBaseTree,
        '-m',
        'unrelated root',
      );
      moveBase(unrelated);
      const unrelatedState = repositoryState(fx.repo);
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toEqual({ state: 'not_integrated', code: 'base_not_ancestor' });
      expect(repositoryState(fx.repo)).toEqual(unrelatedState);
      moveBase(observation.destination.observedCommit);
      await assertValidBaseline();

      // (d) Destination ref deleted. HEAD is first pointed at a holder branch at the same commit so that the
      // repository state stays readable (deleting the checked-out branch would leave HEAD unborn).
      fx.git(
        'update-ref',
        'refs/heads/turing/holder-for-deleted-base',
        observation.destination.observedCommit,
      );
      fx.git('symbolic-ref', 'HEAD', 'refs/heads/turing/holder-for-deleted-base');
      fx.git('update-ref', '-d', handoff.target.baseRef);
      const deleted = repositoryState(fx.repo);
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toEqual({ state: 'stale', code: 'destination_ref_missing' });
      expect(repositoryState(fx.repo)).toEqual(deleted);
      expect(attestationCount(fx.db, fx.goalId)).toEqual({ n: 1 });
    },
  );

  it.each([
    { severity: 'critical', objectFormat: 'sha1' },
    { severity: 'high', objectFormat: 'sha1' },
    { severity: 'critical', objectFormat: 'sha256' },
  ] as const)(
    'A4a refuses an un-merged handoff after a $severity finding ($objectFormat)',
    async ({ severity, objectFormat }) => {
      const { fx, handoff } = await v2Prepared(objectFormat);
      expect(await validateManualHandoff(fx.db, fx.goalId, handoff.handoffId)).toMatchObject({
        state: 'current',
        reason: null,
      });
      await recordMilestoneFindings(fx, severity);
      const before = repositoryState(fx.repo);
      expect(await validateManualHandoff(fx.db, fx.goalId, handoff.handoffId)).toMatchObject({
        state: 'stale',
        reason: { code: 'findings_blocked' },
      });
      expect(
        await validateManualHandoffAuthorityForExternalIntegration(fx.db, fx.goalId, handoff.handoffId),
      ).toEqual({ state: 'stale', code: 'completion_not_ready' });
      await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
        code: 'completion_not_ready',
      });
      expect(handoffCount(fx.db, fx.goalId)).toEqual({ n: 1 });
      expect(repositoryState(fx.repo)).toEqual(before);
    },
  );

  it('A4b refuses an integrated, attested version-2 handoff after a blocking finding (sha1)', async () => {
    const { fx, handoff, observation } = await integratedExternalFixture('sha1', 'fast-forward', {
      completionContractVersion2: true,
    });
    const approval = approveExternalObservation(fx, observation);
    const persisted = await persistExternalIntegrationAttestation(fx.db, {
      goalId: fx.goalId,
      handoffId: handoff.handoffId,
      observation,
      approvalId: approval.id,
    });
    expect(
      await validateExternalIntegrationAttestation(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({
      state: 'current',
    });
    await recordMilestoneFindings(fx, 'critical');
    const before = repositoryState(fx.repo);
    expect(
      await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
    ).toEqual({ state: 'invalid', code: 'completion_not_ready' });
    expect(
      await validateExternalIntegrationAttestation(fx.db, fx.goalId, persisted.record.attestationId),
    ).toMatchObject({ state: 'stale', reason: { code: 'completion_not_ready' } });
    await expect(
      persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: 'completion_not_ready' });
    expect(attestationCount(fx.db, fx.goalId)).toEqual({ n: 1 });
    expect(repositoryState(fx.repo)).toEqual(before);
  });

  it('A4c keeps a medium non-blocking finding ready but changes findings identity, so authority is stale (sha1)', async () => {
    const { fx, handoff } = await v2Prepared('sha1');
    await recordMilestoneFindings(fx, 'medium');
    const before = repositoryState(fx.repo);
    expect(
      await validateManualHandoffAuthorityForExternalIntegration(fx.db, fx.goalId, handoff.handoffId),
    ).toEqual({ state: 'stale', code: 'completion_authority_changed' });
    expect(repositoryState(fx.repo)).toEqual(before);
  });

  it.each(FORMATS)(
    'A5 treats a manual base integration as stale without changing authority or evidence (%s)',
    async (objectFormat) => {
      const { fx, handoff } = await v2Prepared(objectFormat);
      expect(await validateManualHandoff(fx.db, fx.goalId, handoff.handoffId)).toMatchObject({
        state: 'current',
        reason: null,
      });
      const statusBefore = goalStatus(fx.db, fx.goalId);
      const rowBefore = handoffRow(fx.db, handoff.handoffId);
      fx.git('merge', '--ff-only', handoff.source.goalRef);
      const integrated = repositoryState(fx.repo);

      expect(await validateManualHandoff(fx.db, fx.goalId, handoff.handoffId)).toMatchObject({
        state: 'stale',
        reason: { code: 'base_diverged' },
      });
      expect(handoffRow(fx.db, handoff.handoffId)).toEqual(rowBefore);
      expect(String((rowBefore as { payload_json: string }).payload_json)).toContain(handoff.handoffDigest);
      expect(await getManualHandoffProjection(fx.db, fx.goalId, handoff.handoffId)).toMatchObject({
        state: 'stale',
      });

      const authority = await validateManualHandoffAuthorityForExternalIntegration(
        fx.db,
        fx.goalId,
        handoff.handoffId,
      );
      expect(authority).toMatchObject({ state: 'valid' });

      const fingerprint = (value: Awaited<ReturnType<typeof validateExternalIntegrationObservation>>) =>
        value.state === 'valid'
          ? {
              state: value.state,
              actionDigest: value.observation.actionDigest,
              authorityFingerprint: value.authorityFingerprint,
              databaseFingerprint: value.databaseFingerprint,
            }
          : value;
      const firstObservation = await buildExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId);
      const secondObservation = await buildExternalIntegrationObservation(
        fx.db,
        fx.goalId,
        handoff.handoffId,
      );
      expect(secondObservation.actionDigest).toBe(firstObservation.actionDigest);
      const firstValidation = await validateExternalIntegrationObservation(
        fx.db,
        fx.goalId,
        handoff.handoffId,
        firstObservation,
      );
      const secondValidation = await validateExternalIntegrationObservation(
        fx.db,
        fx.goalId,
        handoff.handoffId,
        secondObservation,
      );
      expect(fingerprint(firstValidation)).toMatchObject({ state: 'valid' });
      expect(fingerprint(secondValidation)).toEqual(fingerprint(firstValidation));

      expect(repositoryState(fx.repo)).toEqual(integrated);
      expect(attestationCount(fx.db, fx.goalId)).toEqual({ n: 0 });
      expect(proofCount(fx.db, fx.goalId)).toEqual({ n: 0 });
      expect(goalStatus(fx.db, fx.goalId)).toEqual(statusBefore);

      // Negative control: moving the Goal source ref makes the same handoff stale, so staleness follows preconditions.
      const replacement = fx.git(
        'commit-tree',
        handoff.source.tree,
        '-p',
        handoff.target.observedBaseCommit,
        '-m',
        'same source tree under a different source commit',
      );
      fx.git('update-ref', handoff.source.goalRef, replacement);
      expect(
        await validateManualHandoffAuthorityForExternalIntegration(fx.db, fx.goalId, handoff.handoffId),
      ).toEqual({ state: 'stale', code: 'source_changed' });
    },
  );

  it.each(FORMATS)(
    'A6a refuses a historical pre-version-2 attestation as version-2 evidence after amendment (%s)',
    async (objectFormat) => {
      const { fx, handoff, observation } = await integratedExternalFixture(objectFormat);
      const approval = approveExternalObservation(fx, observation);
      const persisted = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      const oldId = persisted.record.attestationId;
      expect(persisted.record.completionContractVersion).toBe(2);

      const version2 = structuredClone(fx.definition);
      version2.contract.completionPolicy.completionContractVersion = 2;
      version2.contract.completionPolicy.integrationMode = 'external_user_attested';
      const amendment = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: version2,
        changeSummary: 'Opt into completion contract version 2 after an attestation was recorded.',
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version: amendment.version, actor: 'user' });
      const statusBefore = goalStatus(fx.db, fx.goalId);
      const before = repositoryState(fx.repo);

      expect(await validateExternalIntegrationAttestation(fx.db, fx.goalId, oldId)).toMatchObject({
        state: 'stale',
        reason: { code: 'definition_not_approved' },
      });
      expect(await getExternalIntegrationProjection(fx.db, fx.goalId, oldId)).toMatchObject({
        state: 'stale',
        claim: 'not_verified',
      });
      expect(
        await validateExternalIntegrationObservation(fx.db, fx.goalId, handoff.handoffId, observation),
      ).toEqual({ state: 'invalid', code: 'definition_not_approved' });
      await expect(
        persistExternalIntegrationAttestation(fx.db, {
          goalId: fx.goalId,
          handoffId: handoff.handoffId,
          observation,
          approvalId: approval.id,
        }),
      ).rejects.toMatchObject({ code: 'definition_not_approved' });
      expect(attestationCount(fx.db, fx.goalId)).toEqual({ n: 1 });

      await expect(prepareManualHandoff(fx.db, fx.goalId)).rejects.toMatchObject({
        code: 'completion_not_ready',
      });
      expect(handoffCount(fx.db, fx.goalId)).toEqual({ n: 1 });
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.finalApply).toMatchObject({
        required: true,
        ok: false,
        reason: 'external_completion_not_activated',
      });
      expect(proofCount(fx.db, fx.goalId)).toEqual({ n: 0 });
      expect(goalStatus(fx.db, fx.goalId)).toEqual(statusBefore);
      expect(repositoryState(fx.repo)).toEqual(before);
    },
  );

  it.each([
    { label: 'version 1', payloadVersion: 1, columnVersion: 1 },
    { label: 'absent', payloadVersion: undefined, columnVersion: 2 },
  ] as const)(
    'A6b refuses a tampered attestation whose completion contract version is $label (sha1)',
    async ({ payloadVersion, columnVersion }) => {
      const { fx, handoff, observation } = await integratedExternalFixture('sha1', 'fast-forward', {
        completionContractVersion2: true,
      });
      const approval = approveExternalObservation(fx, observation);
      const persisted = await persistExternalIntegrationAttestation(fx.db, {
        goalId: fx.goalId,
        handoffId: handoff.handoffId,
        observation,
        approvalId: approval.id,
      });
      const attestationId = persisted.record.attestationId;
      expect(await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestationId)).toMatchObject({
        state: 'current',
      });
      const before = repositoryState(fx.repo);

      // Bypasses immutability and the column CHECK only to prove the zod literal rejects a non-version-2 payload.
      fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      fx.db.exec('PRAGMA ignore_check_constraints = ON;');
      try {
        const row = fx.db
          .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
          .get(attestationId) as { payload_json: string };
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (payloadVersion === undefined) delete payload.completionContractVersion;
        else payload.completionContractVersion = payloadVersion;
        fx.db
          .prepare(
            'UPDATE goal_external_integration_attestations SET payload_json = ?, completion_contract_version = ? WHERE id = ?',
          )
          .run(JSON.stringify(payload), columnVersion, attestationId);
      } finally {
        fx.db.exec('PRAGMA ignore_check_constraints = OFF;');
      }

      expect(await validateExternalIntegrationAttestation(fx.db, fx.goalId, attestationId)).toMatchObject({
        state: 'invalid',
        reason: { code: 'attestation_invalid' },
      });
      expect(await getExternalIntegrationProjection(fx.db, fx.goalId, attestationId)).toMatchObject({
        state: 'invalid',
        claim: 'not_verified',
      });
      expect(proofCount(fx.db, fx.goalId)).toEqual({ n: 0 });
      expect(repositoryState(fx.repo)).toEqual(before);
    },
  );
});

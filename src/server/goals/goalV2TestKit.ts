import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect } from 'vitest';
import type { Db } from '../db.js';
import type { GoalApproval } from '../../shared/goals.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import {
  appendAttestationCorrection,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import {
  buildExternalCompletionProof,
  type ExternalCompletionActionV1,
  type ExternalCompletionProofV1,
} from './externalCompletionProof.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { recordEvidence } from './evidence.js';
import {
  buildExternalIntegrationObservation,
  createExternalIntegrationApprovalDetail,
  persistExternalIntegrationAttestation,
} from './externalIntegration.js';
import { prepareManualHandoff } from './manualHandoff.js';
import { transitionGoal } from './stateMachine.js';
import { goalRepoFixture, milestone, simpleDefinition } from './repoKit.js';
import { completeReview, createReview } from './reviews.js';

// Shared test-only fixtures for version-2 Goal tests. Test support: it registers no hooks and callers own cleanup.

export const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function treeBytes(root: string, directory = root): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    if (directory === root && name === '.git') continue;
    const fullPath = join(directory, name);
    const relativePath = relative(root, fullPath).split('\\').join('/');
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) output[relativePath] = `symlink:${readlinkSync(fullPath)}`;
    else if (stat.isDirectory()) Object.assign(output, treeBytes(root, fullPath));
    else output[relativePath] = readFileSync(fullPath).toString('base64');
  }
  return output;
}

export function repositoryState(repo: string): unknown {
  return {
    refs: git(repo, 'show-ref'),
    head: git(repo, 'rev-parse', 'HEAD'),
    symbolicHead: git(repo, 'symbolic-ref', '-q', 'HEAD'),
    index: readFileSync(join(repo, '.git', 'index')).toString('base64'),
    indexEntries: git(repo, 'ls-files', '--stage'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
    reflogs: git(repo, 'reflog', '--all', '--format=%H%x00%gD%x00%gs'),
    config: readFileSync(join(repo, '.git', 'config')).toString('base64'),
    exclude: readFileSync(join(repo, '.git', 'info', 'exclude')).toString('base64'),
    files: treeBytes(repo),
  };
}

export const passingReport = {
  verdict: 'pass' as const,
  criterionProgress: [
    {
      criterionKey: 'deliverable',
      assessment: 'met' as const,
      basis: 'The file exists at the reviewed tree.',
    },
  ],
  existingFindings: [],
  newFindings: [],
  regressions: [],
  scopeDrift: false,
  architectureDrift: false,
  furtherWorkJustified: false,
};

export interface AcceptedFixtureOptions {
  /** Approve the definition under the explicit version-2 external-integration completion policy. */
  completionContractVersion2?: boolean;
  files?: Record<string, string>;
  omitEvidence?: boolean;
  omitReview?: boolean;
  omitAcceptance?: boolean;
  orphanSource?: boolean;
  subdir?: string;
  outsideProjectPath?: string;
}

export async function acceptedFixture(
  objectFormat: 'sha1' | 'sha256' = 'sha1',
  options: AcceptedFixtureOptions = {},
) {
  const definition = simpleDefinition({
    criteria: [
      {
        key: 'deliverable',
        statement: 'The result file exists.',
        verification: [{ kind: 'file_exists', path: 'src/result.txt' }],
        required: true,
      },
    ],
    milestones: [
      milestone('m1', ['deliverable'], {
        requiredEvidence: [{ criterionKey: 'deliverable', kinds: ['artifact'] }],
      }),
    ],
    policy: options.completionContractVersion2
      ? {
          completionContractVersion: 2,
          integrationMode: 'external_user_attested',
          requireFinalReview: true,
          requireUserAcceptance: true,
          applyToBase: 'required',
        }
      : { requireFinalReview: true, requireUserAcceptance: true, applyToBase: 'required' },
    gates: { finalAcceptance: true },
  });
  definition.routing.independence.finalReview = 'different-family';
  definition.review.final = true;
  const fx = goalRepoFixture({ definition, objectFormat, subdir: options.subdir });
  let sourceCommit = fx.sideCommit({ 'src/result.txt': 'prepared result\n', ...options.files });
  if (options.outsideProjectPath) {
    fx.git('checkout', '-q', '--detach', sourceCommit);
    writeFileSync(join(fx.repo, options.outsideProjectPath), 'outside the registered project scope\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'include a path outside the registered project scope');
    sourceCommit = fx.git('rev-parse', 'HEAD');
    fx.git('checkout', '-q', 'main');
  }
  if (options.orphanSource)
    sourceCommit = fx.git('commit-tree', fx.tree(sourceCommit), '-m', 'orphan source');
  const sourceRef = `refs/heads/turing/goal/${fx.goalId}`;
  fx.git('update-ref', sourceRef, sourceCommit);
  fx.db
    .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
    .run(sourceCommit, fx.goalId);
  if (!options.omitEvidence)
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'deliverable',
      verifierDigest: fx.digest('deliverable'),
      kind: 'artifact',
      milestoneId: fx.milestoneId('m1'),
    });
  let reviewId: string | undefined;
  if (!options.omitReview) {
    const pendingReview = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      reviewKind: 'final',
    });
    reviewId = pendingReview.id;
    completeReview(fx.db, {
      reviewId,
      report: passingReport,
      independence: {
        established: true,
        policy: 'different-family',
        detail: { fixture: 'service-recorded' },
      },
    });
  }
  let acceptanceId: string | undefined;
  if (!options.omitAcceptance) {
    const acceptance = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_acceptance',
      risk: 'medium',
      reason: 'Accept the reviewed Goal result.',
      requestedBy: 'user',
      detail: {
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
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
    acceptanceId = acceptance.id;
  }
  if (!options.omitEvidence && !options.omitReview && !options.omitAcceptance) {
    const completion = await evaluateCompletion(fx.db, fx.goalId);
    expect(completion.failures.map(({ code }) => code)).toEqual([
      options.completionContractVersion2 ? 'external_completion_not_activated' : 'final_apply_required',
    ]);
    expect(completion.finalReview).toMatchObject({ required: true, ok: true });
    expect(completion.finalAcceptance).toMatchObject({ required: true, ok: true });
    expect(completion.finalApply).toMatchObject({
      required: true,
      ok: false,
      reason: options.completionContractVersion2 ? 'external_completion_not_activated' : 'not_applied',
    });
  }
  return { fx, sourceCommit, sourceRef, acceptanceId, reviewId };
}

export async function integratedExternalFixture(
  objectFormat: 'sha1' | 'sha256' = 'sha1',
  strategy: 'fast-forward' | 'ours' = 'fast-forward',
  options: { completionContractVersion2?: boolean; running?: boolean } = {},
) {
  const accepted = await acceptedFixture(objectFormat, options);
  // Completion can only leave `running`, so a preflight fixture starts the Goal before the handoff is prepared.
  if (options.running)
    transitionGoal(accepted.fx.db, {
      goalId: accepted.fx.goalId,
      to: 'running',
      reasonCode: 'user_start',
      actor: 'user',
      preconditions: [{ code: 'preflight', ok: true }],
    });
  const handoff = (await prepareManualHandoff(accepted.fx.db, accepted.fx.goalId)).record;
  if (strategy === 'fast-forward') git(accepted.fx.repo, 'merge', '--ff-only', accepted.sourceRef);
  else
    git(
      accepted.fx.repo,
      'merge',
      '--quiet',
      '--no-ff',
      '-s',
      'ours',
      '-m',
      'fixture discards accepted files',
      accepted.sourceRef,
    );
  const observation = await buildExternalIntegrationObservation(
    accepted.fx.db,
    accepted.fx.goalId,
    handoff.handoffId,
  );
  return { ...accepted, handoff, observation };
}

export function approveExternalObservation(
  fx: Awaited<ReturnType<typeof acceptedFixture>>['fx'],
  observation: Awaited<ReturnType<typeof buildExternalIntegrationObservation>>,
) {
  const approval = requestGoalApproval(fx.db, {
    goalId: fx.goalId,
    gate: 'final_apply',
    risk: 'high',
    reason: 'Confirm this exact external Git observation.',
    requestedBy: 'user',
    detail: createExternalIntegrationApprovalDetail(observation),
    externalIntegrationActionDigest: observation.actionDigest,
  });
  decideGoalApproval(fx.db, {
    goalId: fx.goalId,
    approvalId: approval.id,
    decision: 'approved',
    decidedBy: 'user',
  });
  return approval;
}

export type AcceptedFixture = Awaited<ReturnType<typeof acceptedFixture>>;
export type GoalFixture = AcceptedFixture['fx'];

export interface V2AttestedFixtureOptions {
  strategy?: 'fast-forward' | 'ours';
  /** Start the Goal (`running`) before the handoff. Off by default, matching `integratedExternalFixture`. */
  running?: boolean;
}

/**
 * A version-2 Goal whose exact observed integration is attested through the real persistence service. The Goal is
 * not started unless `running` is set; use `v2RunningAttestedFixture` where the Goal must be `running`.
 */
export async function v2AttestedFixture(
  objectFormat: 'sha1' | 'sha256' = 'sha1',
  options: V2AttestedFixtureOptions = {},
) {
  const integrated = await integratedExternalFixture(objectFormat, options.strategy ?? 'fast-forward', {
    completionContractVersion2: true,
    running: options.running ?? false,
  });
  const approval = approveExternalObservation(integrated.fx, integrated.observation);
  const persisted = await persistExternalIntegrationAttestation(integrated.fx.db, {
    goalId: integrated.fx.goalId,
    handoffId: integrated.handoff.handoffId,
    observation: integrated.observation,
    approvalId: approval.id,
  });
  const attestation = persisted.record;
  return { ...integrated, approval, attestation, attestationId: attestation.attestationId };
}

/** `v2AttestedFixture` with the Goal already `running`, the only status a completion preflight accepts. */
export function v2RunningAttestedFixture(
  objectFormat: 'sha1' | 'sha256' = 'sha1',
  options: Omit<V2AttestedFixtureOptions, 'running'> = {},
) {
  return v2AttestedFixture(objectFormat, { ...options, running: true });
}

/**
 * The digest of the ready preflight for an attested fixture: the value a user reviews before deciding. Throws when the
 * preflight refuses, so a test can never review a state that the decision would refuse.
 */
export async function reviewedDigest(attested: { fx: GoalFixture; attestationId: string }): Promise<string> {
  const report = await computeExternalCompletionPreflight(attested.fx.db, attested.fx.goalId, {
    attestationId: attested.attestationId,
  });
  if (report.outcome !== 'ready')
    throw new Error(`reviewedDigest: preflight refused (${report.reasons[0]?.code})`);
  return report.digest;
}

/** Every user table's row count and a digest of its full content in rowid order: detects updates as well as inserts. */
export function databaseSnapshot(db: Db): {
  counts: Record<string, number>;
  digests: Record<string, string>;
} {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  const digests: Record<string, string> = {};
  for (const { name } of tables) {
    counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    digests[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return { counts, digests };
}

/** Request, user-approve and append one correction, using the same three steps as the correction tests. */
export function appendCorrectionForTest(
  fx: GoalFixture,
  attestationId: string,
  kind: 'dispute' | 'withdraw' | 'supersede',
  replacementAttestationId: string | null = null,
) {
  const reasonCode =
    kind === 'dispute'
      ? 'observation_error'
      : kind === 'withdraw'
        ? 'integration_not_performed'
        : 'superseded_by_new_observation';
  const reviewed = requestAttestationCorrectionApproval(fx.db, {
    goalId: fx.goalId,
    attestationId,
    correctionKind: kind,
    reasonCode,
    explanation: 'Recorded by a preflight test.',
    replacementAttestationId,
  });
  decideGoalApproval(fx.db, {
    goalId: fx.goalId,
    approvalId: reviewed.approval.id,
    decision: 'approved',
    decidedBy: 'user',
  });
  return appendAttestationCorrection(fx.db, {
    goalId: fx.goalId,
    approvalId: reviewed.approval.id,
    expectedActionDigest: reviewed.actionDigest,
    explanation: 'Recorded by a preflight test.',
  });
}

/** Attests the destination's current tip as a new observation for the same immutable handoff. */
export async function reattestAtCurrentTip(attested: Awaited<ReturnType<typeof v2AttestedFixture>>) {
  const observation = await buildExternalIntegrationObservation(
    attested.fx.db,
    attested.fx.goalId,
    attested.handoff.handoffId,
  );
  const approval = approveExternalObservation(attested.fx, observation);
  const persisted = await persistExternalIntegrationAttestation(attested.fx.db, {
    goalId: attested.fx.goalId,
    handoffId: attested.handoff.handoffId,
    observation,
    approvalId: approval.id,
  });
  return persisted.record;
}

/**
 * A running version-2 Goal whose exact completion decision is recorded through the real decision service. The user
 * reviews the ready preflight digest, then the decision is recorded. Test-only: it is the state a completion can consume.
 */
export async function v2DecidedFixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const attested = await v2RunningAttestedFixture(objectFormat);
  const digest = await reviewedDigest(attested);
  const recorded = await recordExternalCompletionDecision(attested.fx.db, {
    goalId: attested.fx.goalId,
    attestationId: attested.attestationId,
    reviewedPreflightDigest: digest,
    acknowledgeContentNotProven: true,
  });
  return { ...attested, digest, recorded };
}

/**
 * The version-2 proof body that a validated decision implies, built with the production proof builder (which computes
 * the digest and validates the shape). Test-only mapping from the action and its approval; the observation time is the
 * caller's. Nothing in production builds a proof yet.
 */
export function completionProofForDecision(
  decision: { approval: GoalApproval; action: ExternalCompletionActionV1 },
  observedAt: string,
): ExternalCompletionProofV1 {
  const { action, approval } = decision;
  const proof = buildExternalCompletionProof({
    schemaVersion: 1,
    kind: 'turing_goal_external_completion_proof',
    contractVersion: 2,
    goalId: action.goalId,
    definition: action.definition,
    evaluation: {
      integrationHead: action.source.commit,
      integrationTree: action.source.tree,
      verificationEvidenceDigest: action.verificationEvidenceDigest,
      milestoneIdentityDigest: action.milestoneIdentityDigest,
      findingIdentityDigest: action.findingIdentityDigest,
      finalReviewId: action.review.finalReviewId,
      finalAcceptanceApprovalId: action.review.acceptanceApprovalId,
    },
    handoff: action.handoff,
    attestation: action.attestation,
    repository: action.repository,
    source: action.source,
    destination: action.destination,
    gitProof: { ...action.proof, observedAt },
    decision: {
      approvalId: approval.id,
      actionDigest: action.actionDigest,
      decidedAt: approval.respondedAt,
      classification: 'user_confirmed_historical_external_integration',
    },
    proofLimitations: action.proofLimitations,
    correctionChain: action.correctionChain,
    userReviewedPreflightDigest: action.userReviewedPreflightDigest,
  });
  if (!proof) throw new Error('completionProofForDecision: the mapped body is not a valid proof');
  return proof;
}

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect } from 'vitest';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { recordEvidence } from './evidence.js';
import {
  buildExternalIntegrationObservation,
  createExternalIntegrationApprovalDetail,
  persistExternalIntegrationAttestation,
} from './externalIntegration.js';
import { prepareManualHandoff } from './manualHandoff.js';
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
  options: { completionContractVersion2?: boolean } = {},
) {
  const accepted = await acceptedFixture(objectFormat, options);
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
}

/** A version-2 Goal whose exact observed integration is attested through the real persistence service. */
export async function v2AttestedFixture(
  objectFormat: 'sha1' | 'sha256' = 'sha1',
  options: V2AttestedFixtureOptions = {},
) {
  const integrated = await integratedExternalFixture(objectFormat, options.strategy ?? 'fast-forward', {
    completionContractVersion2: true,
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

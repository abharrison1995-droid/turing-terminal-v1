import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { beginAmendment, approveDefinition } from './definitions.js';
import { recordEvidence } from './evidence.js';
import { prepareFinalApplyIntent } from './finalApplyAuthority.js';
import { applyReviewFindings } from './findings.js';
import { getManualHandoffProjection, prepareManualHandoff, validateManualHandoff } from './manualHandoff.js';
import { closeReview, completeReview, createReview } from './reviews.js';
import { cleanupRepoFixtures, goalRepoFixture, milestone, simpleDefinition } from './repoKit.js';
import { createCycle } from './cycles.js';
import { transitionGoal } from './stateMachine.js';

afterEach(cleanupRepoFixtures);

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

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

function repositoryState(repo: string): unknown {
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

const passingReport = {
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

interface AcceptedFixtureOptions {
  files?: Record<string, string>;
  omitEvidence?: boolean;
  omitReview?: boolean;
  omitAcceptance?: boolean;
  orphanSource?: boolean;
  subdir?: string;
  outsideProjectPath?: string;
}

async function acceptedFixture(
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
    policy: { requireFinalReview: true, requireUserAcceptance: true, applyToBase: 'required' },
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
    expect(completion.failures.map(({ code }) => code)).toEqual(['final_apply_required']);
    expect(completion.finalReview).toMatchObject({ required: true, ok: true });
    expect(completion.finalAcceptance).toMatchObject({ required: true, ok: true });
    expect(completion.finalApply).toMatchObject({ required: true, ok: false, reason: 'not_applied' });
  }
  return { fx, sourceCommit, sourceRef, acceptanceId, reviewId };
}

describe('manual integration handoff', () => {
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

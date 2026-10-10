import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { evaluateCompletion } from './completionEvaluation.js';
import { applyApprovedGoalToBase, FinalApplyInjectedCrash } from './finalApply.js';
import { decideGoalApprovalAsUser } from './goalCommands.js';
import { requestFinalApplyApproval } from './finalApplyAuthority.js';
import { requestGoalApproval } from './approvals.js';
import { recoverIntegrationOps } from '../goalGit.js';
import { completeReview, createReview } from './reviews.js';
import { approveDefinition, beginAmendment } from './definitions.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  passDeterministic,
  reportOf,
  simpleDefinition,
  type GoalRepoFixture,
} from './repoKit.js';
import { parseFinalApplyOperationRecord } from './finalApplyOperation.js';

afterEach(cleanupRepoFixtures);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

async function readyApplyFixture(objectFormat: 'sha1' | 'sha256' = 'sha1', approve = true) {
  const fx = goalRepoFixture({
    definition: simpleDefinition({ policy: { applyToBase: 'required' } }),
    objectFormat,
  });
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  const worktree = join(fx.repo, '..', `final-apply-source-${randomUUID()}`);
  git(fx.repo, 'worktree', 'add', '-q', '--detach', worktree, fx.baseCommit);
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'final-apply.txt'), 'approved Goal content\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'Approved Goal change');
  const sourceHead = git(worktree, 'rev-parse', 'HEAD');
  const sourceTree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  git(fx.repo, 'worktree', 'remove', worktree);
  const goalRef = `refs/heads/turing/goal/${fx.goalId}`;
  git(fx.repo, 'update-ref', goalRef, sourceHead, fx.baseCommit);
  fx.db.prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?').run(sourceHead, fx.goalId);
  await passDeterministic(fx);
  const approval = await requestFinalApplyApproval(fx.db, fx.goalId);
  if (approve)
    await decideGoalApprovalAsUser(fx.db, {
      approvalId: approval.id,
      decision: 'approved',
    });
  return { fx, approval, sourceHead, sourceTree, goalRef };
}

function refs(fx: GoalRepoFixture): string {
  return git(fx.repo, 'for-each-ref', '--format=%(refname)=%(objectname)');
}

function mainReflog(fx: GoalRepoFixture): string {
  return readFileSync(join(fx.repo, '.git', 'logs', 'refs', 'heads', 'main'), 'utf8');
}

describe('guarded Goal final apply', () => {
  it('does not let a successful historical Turing apply operation satisfy v2 completion', async () => {
    const { fx, approval } = await readyApplyFixture();
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'applied',
    });
    const v2 = structuredClone(fx.definition);
    v2.contract.completionPolicy.completionContractVersion = 2;
    v2.contract.completionPolicy.integrationMode = 'external_user_attested';
    v2.contract.completionPolicy.requireFinalReview = true;
    v2.contract.completionPolicy.requireUserAcceptance = true;
    v2.contract.completionPolicy.applyToBase = 'required';
    v2.review.final = true;
    const { version } = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user', definition: v2 });
    approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
    fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
    const { id: reviewId } = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: version,
      reviewKind: 'final',
    });
    completeReview(fx.db, {
      reviewId,
      report: reportOf({ verdict: 'pass' }),
      independence: { established: true, policy: 'different-family' },
    });
    fx.approval('final_acceptance', {
      definitionVersion: version,
      definitionHash: fx.currentHash(),
      integrationTree: fx.tree(),
    });

    const evaluation = await evaluateCompletion(fx.db, fx.goalId);
    expect(evaluation).toMatchObject({
      ok: false,
      finalReview: { ok: true },
      finalAcceptance: { ok: true },
      finalApply: { required: true, ok: false, reason: 'external_completion_not_activated' },
      failures: [expect.objectContaining({ code: 'external_completion_not_activated' })],
    });
    expect(fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId)).toEqual({
      status: 'running',
    });
  });

  it.each(['sha1', 'sha256'] as const)(
    'applies an exact approved fast-forward in a %s repository',
    async (format) => {
      const { fx, approval, sourceHead, sourceTree, goalRef } = await readyApplyFixture(format);
      const originalRefs = refs(fx).split('\n').filter(Boolean);
      const untouchedIgnoredPath = join(fx.repo, 'local-only.txt');
      writeFileSync(untouchedIgnoredPath, 'keep this ignored user file\n');
      const excludePath = join(fx.repo, '.git', 'info', 'exclude');
      const previousExclude = readFileSync(excludePath, 'utf8');
      writeFileSync(excludePath, `${previousExclude}\n/local-only.txt\n`);

      const result = await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id });
      expect(result).toMatchObject({ outcome: 'applied', commit: sourceHead });
      expect(fx.git('symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(fx.git('rev-parse', 'HEAD')).toBe(sourceHead);
      expect(fx.git('rev-parse', 'refs/heads/main')).toBe(sourceHead);
      expect(fx.git('rev-parse', goalRef)).toBe(sourceHead);
      expect(readFileSync(join(fx.repo, 'src', 'final-apply.txt'), 'utf8')).toBe('approved Goal content\n');
      expect(readFileSync(untouchedIgnoredPath, 'utf8')).toBe('keep this ignored user file\n');
      expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(fx.git('rev-list', '--merges', `${fx.baseCommit}..${sourceHead}`)).toBe('');
      const changedRefs = originalRefs
        .map((line) => line.split('='))
        .filter(([ref]) => ref === 'refs/heads/main');
      expect(changedRefs).toHaveLength(1);
      expect(refs(fx).split('\n').filter(Boolean)).toEqual(
        originalRefs.map((line) =>
          line.startsWith('refs/heads/main=') ? `refs/heads/main=${sourceHead}` : line,
        ),
      );

      const operation = fx.db
        .prepare("SELECT * FROM goal_integration_ops WHERE op = 'apply_to_base' AND status = 'applied'")
        .get() as {
        id: string;
        approval_id: string;
        expected_old: string;
        new_commit: string;
        checks_json: string;
      };
      const record = parseFinalApplyOperationRecord(operation.checks_json);
      expect(record).toMatchObject({
        operationId: operation.id,
        approvalId: approval.id,
        source: { ref: goalRef, integrationHead: sourceHead, integrationTree: sourceTree },
        destination: {
          ref: 'refs/heads/main',
          expectedBaseCommit: fx.baseCommit,
          newCommit: sourceHead,
        },
        objectFormat: format,
      });
      expect(operation).toMatchObject({
        approval_id: approval.id,
        expected_old: fx.baseCommit,
        new_commit: sourceHead,
      });
      const completion = await evaluateCompletion(fx.db, fx.goalId);
      expect(completion.finalApply).toMatchObject({ required: true, ok: true, basis: 'applied_by_turing' });

      const beforeRepeat = mainReflog(fx);
      expect(
        await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
      ).toMatchObject({
        outcome: 'already_applied',
        operationId: operation.id,
        commit: sourceHead,
      });
      expect(mainReflog(fx)).toBe(beforeRepeat);
      expect(
        (
          fx.db
            .prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'")
            .get() as { n: number }
        ).n,
      ).toBe(1);
    },
  );

  describe.skipIf(process.platform === 'win32')('final read-tree boundary characterization', () => {
    let prepared: Awaited<ReturnType<typeof readyApplyFixture>>;

    beforeAll(async () => {
      prepared = await readyApplyFixture();
      const excludePath = join(prepared.fx.repo, '.git', 'info', 'exclude');
      const previousExclude = readFileSync(excludePath, 'utf8');
      writeFileSync(excludePath, `${previousExclude}\n/src/final-apply.txt\n`);
    });

    it('reproduces ignored user-file replacement at the final read-tree boundary on the rejected candidate', async () => {
      const { fx, approval, sourceHead } = prepared;
      const relativeTarget = 'src/final-apply.txt';
      const target = join(fx.repo, relativeTarget);
      const originalBytes = 'USER-ORIGINAL-IGNORED-BYTES\n';
      const approvedBytes = 'approved Goal content\n';

      const wrapperDir = mkdtempSync(join(tmpdir(), 'turing-final-apply-git-boundary-'));
      const wrapperPath = join(wrapperDir, 'git');
      const statusMarker = join(wrapperDir, 'status-before-read-tree');
      const exitMarker = join(wrapperDir, 'read-tree-exit');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const originalPath = process.env.PATH;
      const envKeys = [
        'TT_FINAL_APPLY_REAL_GIT',
        'TT_FINAL_APPLY_REPO',
        'TT_FINAL_APPLY_TARGET',
        'TT_FINAL_APPLY_BYTES',
        'TT_FINAL_APPLY_STATUS_MARKER',
        'TT_FINAL_APPLY_EXIT_MARKER',
      ] as const;
      const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
      const wrapper = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const args = process.argv.slice(2);
const input = args.includes('--stdin') ? readFileSync(0) : undefined;
if (args.includes('read-tree') && args.includes('-u') && !existsSync(process.env.TT_FINAL_APPLY_EXIT_MARKER)) {
  mkdirSync(dirname(process.env.TT_FINAL_APPLY_TARGET), { recursive: true });
  writeFileSync(process.env.TT_FINAL_APPLY_TARGET, process.env.TT_FINAL_APPLY_BYTES);
  const status = spawnSync(process.env.TT_FINAL_APPLY_REAL_GIT, ['-C', process.env.TT_FINAL_APPLY_REPO, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
  if (status.status !== 0) process.exit(status.status || 1);
  writeFileSync(process.env.TT_FINAL_APPLY_STATUS_MARKER, status.stdout);
  const result = spawnSync(process.env.TT_FINAL_APPLY_REAL_GIT, args, { encoding: 'utf8', env: process.env, input });
  writeFileSync(process.env.TT_FINAL_APPLY_EXIT_MARKER, String(result.status));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 0);
}
const result = spawnSync(process.env.TT_FINAL_APPLY_REAL_GIT, args, { encoding: 'utf8', env: process.env, input });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status || 0);
`;
      mkdirSync(wrapperDir, { recursive: true });
      writeFileSync(wrapperPath, wrapper);
      chmodSync(wrapperPath, 0o755);
      process.env.TT_FINAL_APPLY_REAL_GIT = realGit;
      process.env.TT_FINAL_APPLY_REPO = fx.repo;
      process.env.TT_FINAL_APPLY_TARGET = target;
      process.env.TT_FINAL_APPLY_BYTES = originalBytes;
      process.env.TT_FINAL_APPLY_STATUS_MARKER = statusMarker;
      process.env.TT_FINAL_APPLY_EXIT_MARKER = exitMarker;
      process.env.PATH = [wrapperDir, originalPath].filter(Boolean).join(delimiter);

      let result;
      let statusBeforeReadTree = '';
      let readTreeExit = '';
      try {
        result = await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id });
        expect(result).toMatchObject({ outcome: 'applied', commit: sourceHead });
        statusBeforeReadTree = readFileSync(statusMarker, 'utf8');
        readTreeExit = readFileSync(exitMarker, 'utf8');
      } finally {
        process.env.PATH = originalPath;
        for (const key of envKeys) {
          const value = originalEnv.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(wrapperDir, { recursive: true, force: true });
      }

      expect(statusBeforeReadTree.trimEnd()).toBe(`D  ${relativeTarget}`);
      expect(readTreeExit).toBe('0');
      expect(result).toMatchObject({ outcome: 'applied', commit: sourceHead });
      expect(readFileSync(target, 'utf8')).toBe(approvedBytes);
      expect(readFileSync(target, 'utf8')).not.toBe(originalBytes);
      expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(fx.git('rev-parse', 'refs/heads/main')).toBe(sourceHead);
      expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
        required: true,
        ok: true,
        basis: 'applied_by_turing',
      });
    });
  });

  it('keeps an ignored untracked target intact and refuses before creating an operation', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const collision = join(fx.repo, 'src', 'final-apply.txt');
    mkdirSync(join(fx.repo, 'src'), { recursive: true });
    writeFileSync(collision, 'user ignored bytes\n');
    const excludePath = join(fx.repo, '.git', 'info', 'exclude');
    const previousExclude = readFileSync(excludePath, 'utf8');
    writeFileSync(excludePath, `${previousExclude}\n/src/final-apply.txt\n`);
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');

    const result = await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id });
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'changed_git_state',
      code: 'untracked_target_collision',
    });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect(fx.git('rev-parse', `refs/heads/turing/goal/${fx.goalId}`)).toBe(sourceHead);
    expect(readFileSync(collision, 'utf8')).toBe('user ignored bytes\n');
    expect(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('refuses missing and wrong-Goal authority without touching refs or completion', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    for (const input of [
      { goalId: fx.goalId, approvalId: randomUUID(), code: 'approval_not_found' },
      { goalId: randomUUID(), approvalId: approval.id, code: 'approval_mismatch' },
    ]) {
      expect(await applyApprovedGoalToBase(fx.db, input)).toMatchObject({
        outcome: 'refused',
        reason: 'stale_approval',
        code: input.code,
      });
      expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
      expect(fx.git(`rev-parse`, `refs/heads/turing/goal/${fx.goalId}`)).toBe(sourceHead);
      expect((await evaluateCompletion(fx.db, fx.goalId)).ok).toBe(false);
    }
    expect(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('refuses pending and denied final-apply approvals before planning', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture('sha1', false);
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'stale_approval',
      code: 'approval_not_approved',
    });
    await decideGoalApprovalAsUser(fx.db, { approvalId: approval.id, decision: 'denied' });
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'stale_approval',
      code: 'approval_not_approved',
    });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect(fx.git('rev-parse', `refs/heads/turing/goal/${fx.goalId}`)).toBe(sourceHead);
    expect(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('refuses a different approval gate and changed Goal source before planning', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const otherGate = requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'final_acceptance',
      risk: 'high',
      reason: 'Not final-apply authority.',
      requestedBy: 'user',
    });
    await decideGoalApprovalAsUser(fx.db, { approvalId: otherGate.id, decision: 'approved' });
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: otherGate.id }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'stale_approval',
      code: 'approval_mismatch',
    });

    const changedSource = fx.git(
      'commit-tree',
      `${sourceHead}^{tree}`,
      '-p',
      fx.baseCommit,
      '-m',
      'changed Goal head',
    );
    fx.git('update-ref', `refs/heads/turing/goal/${fx.goalId}`, changedSource, sourceHead);
    fx.db
      .prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?')
      .run(changedSource, fx.goalId);
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'stale_approval',
    });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('refuses a dirty or detached destination checkout without losing user bytes', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const userFile = join(fx.repo, 'docs', 'README.md');
    const original = readFileSync(userFile, 'utf8');
    writeFileSync(userFile, `${original}\nuser edit\n`);
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'changed_git_state',
    });
    expect(readFileSync(userFile, 'utf8')).toContain('user edit');
    writeFileSync(userFile, original);
    fx.git('checkout', '--detach', fx.baseCommit);
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'changed_git_state',
    });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect(fx.git('rev-parse', `refs/heads/turing/goal/${fx.goalId}`)).toBe(sourceHead);
    expect(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('aborts a planned operation after a pre-CAS crash and permits a fresh retry', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          afterPlanPersist: () => {
            throw new FinalApplyInjectedCrash('after-planned-record');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    const planned = fx.db
      .prepare("SELECT id, status FROM goal_integration_ops WHERE op = 'apply_to_base'")
      .get() as { id: string; status: string };
    expect(planned.status).toBe('planned');
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    const refsBefore = refs(fx);
    const logBefore = existsSync(join(fx.repo, '.git', 'logs', 'refs', 'heads', 'main'))
      ? mainReflog(fx)
      : '';

    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      { opId: planned.id, op: 'apply_to_base', outcome: 'aborted', observedRef: fx.baseCommit },
    ]);
    expect(refs(fx)).toBe(refsBefore);
    expect(existsSync(join(fx.repo, '.git', 'logs', 'refs', 'heads', 'main')) ? mainReflog(fx) : '').toBe(
      logBefore,
    );
    expect(fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(planned.id)).toEqual({
      status: 'aborted',
    });

    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'applied',
      commit: sourceHead,
    });
    expect(
      (
        fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base' AND status = 'applied'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('leaves no operation or Git mutation for a crash before plan persistence', async () => {
    const { fx, approval } = await readyApplyFixture();
    const before = refs(fx);
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          beforePlanPersist: () => {
            throw new FinalApplyInjectedCrash('before-plan-persist');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    expect(refs(fx)).toBe(before);
    expect(
      fx.db.prepare("SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base'").get(),
    ).toEqual({
      n: 0,
    });
  });

  it('aborts a planned operation after a crash at the CAS boundary without replaying a ref write', async () => {
    const { fx, approval } = await readyApplyFixture();
    const before = refs(fx);
    const logBefore = mainReflog(fx);
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          beforeCas: () => {
            throw new FinalApplyInjectedCrash('before-cas');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    const operation = fx.db
      .prepare("SELECT id, status FROM goal_integration_ops WHERE op = 'apply_to_base'")
      .get() as { id: string; status: string };
    expect(operation.status).toBe('planned');
    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      { opId: operation.id, outcome: 'aborted', observedRef: fx.baseCommit },
    ]);
    expect(refs(fx)).toBe(before);
    expect(mainReflog(fx)).toBe(logBefore);
  });

  it('preserves a tracked user edit made after CAS and leaves the operation incomplete', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const userFile = join(fx.repo, 'docs', 'README.md');
    const editedBytes = `${readFileSync(userFile, 'utf8')}\nexternal edit after CAS\n`;
    const result = await applyApprovedGoalToBase(
      fx.db,
      { goalId: fx.goalId, approvalId: approval.id },
      {
        afterCas: () => writeFileSync(userFile, editedBytes),
      },
    );
    expect(result).toMatchObject({ outcome: 'checkout_index_sync_incomplete' });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(sourceHead);
    expect(readFileSync(userFile, 'utf8')).toBe(editedBytes);
    expect(
      (
        fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base' AND status = 'applied'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
      required: true,
      ok: false,
      reason: 'not_applied',
    });
  });

  it('preserves a non-overlapping untracked file and refuses to claim a clean applied checkout', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const userFile = join(fx.repo, 'scratch', 'notes.txt');
    const userBytes = 'unrelated file created after CAS\n';
    const result = await applyApprovedGoalToBase(
      fx.db,
      { goalId: fx.goalId, approvalId: approval.id },
      {
        afterCas: () => {
          mkdirSync(join(fx.repo, 'scratch'), { recursive: true });
          writeFileSync(userFile, userBytes);
        },
      },
    );
    expect(result).toMatchObject({ outcome: 'checkout_index_sync_incomplete' });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(sourceHead);
    expect(readFileSync(join(fx.repo, 'src', 'final-apply.txt'), 'utf8')).toBe('approved Goal content\n');
    expect(readFileSync(userFile, 'utf8')).toBe(userBytes);
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toContain('scratch/notes.txt');
    expect(
      (
        fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base' AND status = 'applied'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it.each(['afterCheckoutSync', 'beforeAppliedRecord'] as const)(
    'recovers a clean synchronized checkout exactly once after a %s crash',
    async (boundary) => {
      const { fx, approval, sourceHead } = await readyApplyFixture();
      const crash = () => {
        throw new FinalApplyInjectedCrash(boundary);
      };
      const hooks =
        boundary === 'afterCheckoutSync' ? { afterCheckoutSync: crash } : { beforeAppliedRecord: crash };
      await expect(
        applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }, hooks),
      ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
      const operation = fx.db
        .prepare("SELECT id, status FROM goal_integration_ops WHERE op = 'apply_to_base'")
        .get() as { id: string; status: string };
      expect(operation.status).toBe('planned');
      const refLog = mainReflog(fx);
      expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
        { opId: operation.id, outcome: 'completed', observedRef: sourceHead },
      ]);
      expect(mainReflog(fx)).toBe(refLog);
      expect(fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(operation.id)).toEqual(
        {
          status: 'applied',
        },
      );
      expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
        required: true,
        ok: true,
        basis: 'applied_by_turing',
      });
    },
  );

  it('treats recovery after applied bookkeeping as a no-op and preserves idempotency', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          afterAppliedRecord: () => {
            throw new FinalApplyInjectedCrash('after-applied-record');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    const log = mainReflog(fx);
    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toEqual([]);
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'already_applied',
      commit: sourceHead,
    });
    expect(mainReflog(fx)).toBe(log);
  });

  it('keeps corrupted planned provenance unresolved without moving refs', async () => {
    const { fx, approval } = await readyApplyFixture();
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          afterPlanPersist: () => {
            throw new FinalApplyInjectedCrash('corrupt-record-fixture');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    const operation = fx.db
      .prepare("SELECT id, status FROM goal_integration_ops WHERE op = 'apply_to_base'")
      .get() as { id: string; status: string };
    const before = refs(fx);
    const log = mainReflog(fx);
    fx.db.exec('DROP TRIGGER trg_goal_integration_op_identity');
    fx.db.prepare("UPDATE goal_integration_ops SET checks_json = 'not-json' WHERE id = ?").run(operation.id);
    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      { opId: operation.id, outcome: 'manual_reconciliation_required', observedRef: null },
    ]);
    expect(fx.db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(operation.id)).toEqual({
      status: 'planned',
    });
    expect(refs(fx)).toBe(before);
    expect(mainReflog(fx)).toBe(log);
    expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
      required: true,
      ok: false,
      reason: 'not_applied',
    });
  });

  it('does not let synthetic applied bookkeeping bypass reflog provenance', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          afterPlanPersist: () => {
            throw new FinalApplyInjectedCrash('synthetic-proof-fixture');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    const operation = fx.db
      .prepare(
        "SELECT id, checks_json, expected_old, new_commit FROM goal_integration_ops WHERE op = 'apply_to_base'",
      )
      .get() as { id: string; checks_json: string; expected_old: string; new_commit: string };
    const record = parseFinalApplyOperationRecord(operation.checks_json)!;
    const syntheticProof = {
      schemaVersion: 1,
      operationDigest: record.operationDigest,
      refLog: {
        message: record.reflogMessage,
        oldCommit: operation.expected_old,
        newCommit: operation.new_commit,
        lineDigest: 'f'.repeat(64),
      },
      checkout: {
        branch: 'main',
        head: sourceHead,
        baseRef: 'refs/heads/main',
        indexMatchesHead: true,
        worktreeMatchesIndex: true,
        clean: true,
        registeredCheckout: true,
        noTargetCollision: true,
      },
      verifiedAt: new Date().toISOString(),
    };
    fx.db
      .prepare(
        "UPDATE goal_integration_ops SET status = 'applied', finished_at = ?, recovery_json = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), JSON.stringify(syntheticProof), operation.id);
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
      required: true,
      ok: false,
      reason: 'not_applied',
    });
  });

  it('serializes concurrent calls for one approval to one applied operation', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const [left, right] = await Promise.all([
      applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
      applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ]);
    expect(
      [left, right].some((result) => result.outcome === 'applied' || result.outcome === 'already_applied'),
    ).toBe(true);
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(sourceHead);
    expect(
      (
        fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base' AND status = 'applied'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('fails closed when an applied operation reflog marker is duplicated', async () => {
    const { fx, approval } = await readyApplyFixture();
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'applied',
    });
    const log = mainReflog(fx);
    const latestLine = log.trimEnd().split('\n').at(-1)!;
    writeFileSync(join(fx.repo, '.git', 'logs', 'refs', 'heads', 'main'), `${log}${latestLine}\n`);
    expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
      required: true,
      ok: false,
      reason: 'not_applied',
    });
    expect(
      await applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }),
    ).toMatchObject({
      outcome: 'manual_reconciliation_required',
    });
  });

  it('does not replay CAS during recovery after a crash between ref movement and checkout sync', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    await expect(
      applyApprovedGoalToBase(
        fx.db,
        { goalId: fx.goalId, approvalId: approval.id },
        {
          afterCas: () => {
            throw new FinalApplyInjectedCrash('after-cas-before-sync');
          },
        },
      ),
    ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(sourceHead);
    expect(fx.git('rev-parse', 'HEAD')).toBe(sourceHead);
    expect(fx.git('diff', '--cached', '--name-status', '--')).toContain('final-apply.txt');
    const refsBeforeRecovery = refs(fx);
    const logBeforeRecovery = mainReflog(fx);
    const checkoutBeforeRecovery = fx.git('status', '--porcelain=v1', '--untracked-files=all');

    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      {
        op: 'apply_to_base',
        outcome: 'checkout_index_sync_incomplete',
        observedRef: sourceHead,
      },
    ]);
    expect(refs(fx)).toBe(refsBeforeRecovery);
    expect(mainReflog(fx)).toBe(logBeforeRecovery);
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(checkoutBeforeRecovery);
    expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
      required: true,
      ok: false,
      reason: 'not_applied',
    });

    // This is an explicit manual repair in the disposable fixture. Recovery itself does no Git write.
    git(fx.repo, 'read-tree', '-m', '-u', fx.baseCommit, sourceHead);
    const logBeforeReconcile = mainReflog(fx);
    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      { op: 'apply_to_base', outcome: 'completed', observedRef: sourceHead },
    ]);
    expect(mainReflog(fx)).toBe(logBeforeReconcile);
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect((await evaluateCompletion(fx.db, fx.goalId)).finalApply).toMatchObject({
      required: true,
      ok: true,
      basis: 'applied_by_turing',
    });
  });

  it.each(['beforeCheckoutSync', 'beforeReadTree'] as const)(
    'recovers an incomplete but exact ref movement without Git writes after a %s crash',
    async (boundary) => {
      const { fx, approval, sourceHead } = await readyApplyFixture();
      const crash = () => {
        throw new FinalApplyInjectedCrash(boundary);
      };
      const hooks =
        boundary === 'beforeCheckoutSync' ? { beforeCheckoutSync: crash } : { beforeReadTree: crash };
      await expect(
        applyApprovedGoalToBase(fx.db, { goalId: fx.goalId, approvalId: approval.id }, hooks),
      ).rejects.toBeInstanceOf(FinalApplyInjectedCrash);
      const beforeRefs = refs(fx);
      const beforeLog = mainReflog(fx);
      const beforeStatus = fx.git('status', '--porcelain=v1', '--untracked-files=all');
      expect(fx.git('rev-parse', 'HEAD')).toBe(sourceHead);
      expect(beforeStatus).not.toBe('');
      expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
        {
          op: 'apply_to_base',
          outcome: 'checkout_index_sync_incomplete',
          observedRef: sourceHead,
        },
      ]);
      expect(refs(fx)).toBe(beforeRefs);
      expect(mainReflog(fx)).toBe(beforeLog);
      expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(beforeStatus);
      expect(
        (
          fx.db
            .prepare(
              "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'apply_to_base' AND status = 'applied'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0);
    },
  );

  it('refuses a destination ref race and leaves a third-party commit untouched', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const thirdParty = fx.git(
      'commit-tree',
      `${fx.baseCommit}^{tree}`,
      '-p',
      fx.baseCommit,
      '-m',
      'external ref move',
    );
    const result = await applyApprovedGoalToBase(
      fx.db,
      { goalId: fx.goalId, approvalId: approval.id },
      {
        beforeCas: () => {
          git(fx.repo, 'update-ref', 'refs/heads/main', thirdParty, fx.baseCommit);
        },
      },
    );
    expect(result).toMatchObject({ outcome: 'concurrent_ref_conflict', code: 'ref_compare_and_swap_failed' });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(thirdParty);
    expect(fx.git('rev-parse', `refs/heads/turing/goal/${fx.goalId}`)).toBe(sourceHead);
    const operation = fx.db
      .prepare("SELECT id, status FROM goal_integration_ops WHERE op = 'apply_to_base'")
      .get() as { id: string; status: string };
    expect(operation.status).toBe('planned');

    git(fx.repo, 'update-ref', 'refs/heads/main', fx.baseCommit, thirdParty);
    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      { opId: operation.id, outcome: 'aborted', observedRef: fx.baseCommit },
    ]);
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  });

  it('checks the source Goal ref atomically and refuses Goal-ref movement', async () => {
    const { fx, approval, sourceHead } = await readyApplyFixture();
    const ref = `refs/heads/turing/goal/${fx.goalId}`;
    const thirdSource = fx.git(
      'commit-tree',
      `${sourceHead}^{tree}`,
      '-p',
      fx.baseCommit,
      '-m',
      'external Goal ref move',
    );
    const result = await applyApprovedGoalToBase(
      fx.db,
      { goalId: fx.goalId, approvalId: approval.id },
      {
        beforeCas: () => {
          git(fx.repo, 'update-ref', ref, thirdSource, sourceHead);
        },
      },
    );
    expect(result).toMatchObject({ outcome: 'concurrent_ref_conflict', code: 'ref_compare_and_swap_failed' });
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
    expect(fx.git('rev-parse', ref)).toBe(thirdSource);
    const operation = fx.db
      .prepare("SELECT id FROM goal_integration_ops WHERE op = 'apply_to_base'")
      .get() as { id: string };
    git(fx.repo, 'update-ref', ref, sourceHead, thirdSource);
    expect(await recoverIntegrationOps(fx.db, fx.goalId)).toMatchObject([
      { opId: operation.id, outcome: 'aborted', observedRef: fx.baseCommit },
    ]);
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
  });
});

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { FinalApplyIntent } from './finalApplyAuthority.js';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { gitTry, loadContext, repositoryObjectFormat } from '../goalGit.js';

export interface FinalApplyOperationRecord {
  schemaVersion: 1;
  kind: 'turing_goal_final_apply_operation';
  operationId: string;
  goalId: string;
  approvalId: string;
  intentDigest: string;
  intent: FinalApplyIntent;
  repositoryProjectId: string;
  repositoryIdentity: string;
  objectFormat: 'sha1' | 'sha256';
  source: { ref: string; integrationHead: string; integrationTree: string };
  destination: { ref: string; expectedBaseCommit: string; newCommit: string };
  preflight: {
    status: 'ready_for_approved_apply';
    changedPathDigest: string;
    changedPathCount: number;
    worktreeLayoutDigest: string;
    fastForward: true;
    checkoutClean: true;
    registeredCheckout: true;
  };
  reflogMessage: string;
  operationDigest: string;
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const finalApplyIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal('apply_to_base_intent'),
    goalId: z.string().min(1).max(200),
    definitionVersion: z.number().int().positive(),
    definitionHash: digest,
    source: z
      .object({
        goalRef: z.string().min(1).max(300),
        integrationHead: objectId,
        integrationTree: objectId,
      })
      .strict(),
    destination: z
      .object({
        repoIdentity: digest,
        baseBranch: z.string().min(1).max(300),
        baseRef: z.string().min(1).max(500),
        expectedBaseCommit: objectId,
      })
      .strict(),
    review: z
      .object({
        changedPathDigest: digest,
        diffStatDigest: digest,
        diffPreviewDigest: digest,
        diffPreviewTruncated: z.boolean(),
      })
      .strict(),
    intentDigest: digest,
  })
  .strict();

export const finalApplyApprovalDetailSchema = z
  .object({
    action: z.literal('apply_to_base_intent'),
    intentDigest: digest,
    repositoryProjectId: z.string().min(1).max(200),
    intent: finalApplyIntentSchema,
    reviewDisplay: z
      .object({
        diffStat: z.string().max(632),
        diffPreview: z.string().max(1_000),
      })
      .strict(),
  })
  .strict();

const operationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('turing_goal_final_apply_operation'),
    operationId: z.string().uuid(),
    goalId: z.string().uuid(),
    approvalId: z.string().min(1).max(200),
    intentDigest: digest,
    intent: finalApplyIntentSchema,
    repositoryProjectId: z.string().min(1).max(200),
    repositoryIdentity: digest,
    objectFormat: z.enum(['sha1', 'sha256']),
    source: z
      .object({
        ref: z.string().min(1).max(500),
        integrationHead: objectId,
        integrationTree: objectId,
      })
      .strict(),
    destination: z
      .object({
        ref: z.string().min(1).max(500),
        expectedBaseCommit: objectId,
        newCommit: objectId,
      })
      .strict(),
    preflight: z
      .object({
        status: z.literal('ready_for_approved_apply'),
        changedPathDigest: digest,
        changedPathCount: z.number().int().nonnegative().max(100_000),
        worktreeLayoutDigest: digest,
        fastForward: z.literal(true),
        checkoutClean: z.literal(true),
        registeredCheckout: z.literal(true),
      })
      .strict(),
    reflogMessage: z.string().regex(/^turing-final-apply:[0-9a-f-]{36}$/),
    operationDigest: digest,
  })
  .strict();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function finalApplyIntentTuple(intent: Omit<FinalApplyIntent, 'intentDigest'>): unknown[] {
  return [
    'turing-final-apply-intent',
    1,
    intent.action,
    intent.goalId,
    intent.definitionVersion,
    intent.definitionHash,
    intent.source.goalRef,
    intent.source.integrationHead,
    intent.source.integrationTree,
    intent.destination.repoIdentity,
    intent.destination.baseBranch,
    intent.destination.baseRef,
    intent.destination.expectedBaseCommit,
    intent.review.changedPathDigest,
    intent.review.diffStatDigest,
    intent.review.diffPreviewDigest,
    intent.review.diffPreviewTruncated,
  ];
}

export function computeFinalApplyIntentDigest(intent: Omit<FinalApplyIntent, 'intentDigest'>): string {
  return sha256(JSON.stringify(finalApplyIntentTuple(intent)));
}

export function sameFinalApplyIntent(left: FinalApplyIntent, right: FinalApplyIntent): boolean {
  return JSON.stringify(finalApplyIntentTuple(left)) === JSON.stringify(finalApplyIntentTuple(right));
}

export function computeFinalApplyRepositoryIdentity(
  projectId: string,
  repoRoot: string,
  gitCommonDir: string,
  scope: string,
): string {
  return sha256(
    JSON.stringify(['turing-goal-repository-identity-v1', projectId, repoRoot, gitCommonDir, scope]),
  );
}

function operationTuple(record: Omit<FinalApplyOperationRecord, 'operationDigest'>): unknown[] {
  return [
    'turing-goal-final-apply-operation-v1',
    record.schemaVersion,
    record.kind,
    record.operationId,
    record.goalId,
    record.approvalId,
    record.intentDigest,
    record.intent,
    record.repositoryProjectId,
    record.repositoryIdentity,
    record.objectFormat,
    record.source.ref,
    record.source.integrationHead,
    record.source.integrationTree,
    record.destination.ref,
    record.destination.expectedBaseCommit,
    record.destination.newCommit,
    record.preflight.status,
    record.preflight.changedPathDigest,
    record.preflight.changedPathCount,
    record.preflight.worktreeLayoutDigest,
    record.preflight.fastForward,
    record.preflight.checkoutClean,
    record.preflight.registeredCheckout,
    record.reflogMessage,
  ];
}

export function createFinalApplyOperationRecord(
  body: Omit<FinalApplyOperationRecord, 'operationDigest'>,
): FinalApplyOperationRecord {
  return { ...body, operationDigest: sha256(JSON.stringify(operationTuple(body))) };
}

export function parseFinalApplyOperationRecord(value: string): FinalApplyOperationRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = operationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { operationDigest, ...body } = parsed.data;
  if (sha256(JSON.stringify(operationTuple(body))) !== operationDigest) return null;
  const intent = body.intent as unknown as FinalApplyIntent;
  if (intent.intentDigest !== body.intentDigest || intent.goalId !== body.goalId) return null;
  const { intentDigest, ...intentBody } = intent;
  if (computeFinalApplyIntentDigest(intentBody) !== intentDigest) return null;
  if (
    body.source.ref !== intent.source.goalRef ||
    body.source.integrationHead !== intent.source.integrationHead ||
    body.source.integrationTree !== intent.source.integrationTree ||
    body.destination.ref !== intent.destination.baseRef ||
    body.destination.expectedBaseCommit !== intent.destination.expectedBaseCommit ||
    body.destination.newCommit !== intent.source.integrationHead ||
    body.repositoryIdentity !== intent.destination.repoIdentity
  )
    return null;
  const oid = body.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (
    !oid.test(body.source.integrationHead) ||
    !oid.test(body.source.integrationTree) ||
    !oid.test(body.destination.expectedBaseCommit) ||
    !oid.test(body.destination.newCommit)
  )
    return null;
  return { ...body, intent, operationDigest } as FinalApplyOperationRecord;
}

export interface FinalApplyRecoveryProof {
  schemaVersion: 1;
  operationDigest: string;
  refLog: {
    message: string;
    oldCommit: string;
    newCommit: string;
    lineDigest: string;
  };
  checkout: {
    branch: string;
    head: string;
    baseRef: string;
    indexMatchesHead: true;
    worktreeMatchesIndex: true;
    clean: true;
    registeredCheckout: true;
    noTargetCollision: true;
  };
  verifiedAt: string;
}

const recoveryProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationDigest: digest,
    refLog: z
      .object({
        message: z.string().regex(/^turing-final-apply:[0-9a-f-]{36}$/),
        oldCommit: objectId,
        newCommit: objectId,
        lineDigest: digest,
      })
      .strict(),
    checkout: z
      .object({
        branch: z.string().min(1).max(300),
        head: objectId,
        baseRef: z.string().min(1).max(500),
        indexMatchesHead: z.literal(true),
        worktreeMatchesIndex: z.literal(true),
        clean: z.literal(true),
        registeredCheckout: z.literal(true),
        noTargetCollision: z.literal(true),
      })
      .strict(),
    verifiedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export function parseFinalApplyRecoveryProof(value: string | null): FinalApplyRecoveryProof | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = recoveryProofSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function validateFinalApplyOperationApproval(db: Db, record: FinalApplyOperationRecord): boolean {
  const approval = getGoalApproval(db, record.approvalId);
  if (
    !approval ||
    approval.id !== record.approvalId ||
    approval.goalId !== record.goalId ||
    approval.gate !== 'final_apply' ||
    approval.risk !== 'high' ||
    approval.requestedBy !== 'user' ||
    approval.status !== 'approved' ||
    approval.decidedBy !== 'user' ||
    approval.intentDigest !== record.intentDigest
  )
    return false;
  const detail = finalApplyApprovalDetailSchema.safeParse(approval.detail);
  if (!detail.success) return false;
  const { intentDigest, ...intentBody } = detail.data.intent;
  return (
    detail.data.intentDigest === record.intentDigest &&
    detail.data.repositoryProjectId === record.repositoryProjectId &&
    detail.data.intentDigest === detail.data.intent.intentDigest &&
    computeFinalApplyIntentDigest(intentBody) === intentDigest &&
    sameFinalApplyIntent(detail.data.intent, record.intent) &&
    sha256(detail.data.reviewDisplay.diffStat) === record.intent.review.diffStatDigest &&
    sha256(detail.data.reviewDisplay.diffPreview) === record.intent.review.diffPreviewDigest
  );
}

const MAX_REFLOG_TAIL_BYTES = 8 * 1024 * 1024;

export function findApplyRefLogEvidence(
  commonDir: string,
  ref: string,
  expectedOld: string,
  expectedNew: string,
  message: string,
): { lineDigest: string } | null {
  if (!ref.startsWith('refs/heads/') || ref.split('/').some((part) => !part || part === '.' || part === '..'))
    return null;
  const logPath = resolve(commonDir, 'logs', ...ref.split('/'));
  const relativePath = relative(commonDir, logPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return null;
  let fd: number;
  try {
    if (!lstatSync(logPath).isFile()) return null;
    fd = openSync(logPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_REFLOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    let match: { lineDigest: string } | null = null;
    for (const line of lines) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const fields = line.slice(0, tab).split(' ');
      if (fields[0] === expectedOld && fields[1] === expectedNew && line.slice(tab + 1) === message) {
        if (match) return null;
        match = { lineDigest: sha256(line) };
      }
    }
    return match;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export async function hasVerifiedAppliedFinalApplyOperation(
  db: Db,
  goalId: string,
  integrationHead: string,
  integrationTree: string,
): Promise<boolean> {
  const rows = db
    .prepare(
      `SELECT id, goal_id, approval_id, op, expected_old, new_commit, status, checks_json, recovery_json
       FROM goal_integration_ops
       WHERE goal_id = ? AND op = 'apply_to_base' AND status = 'applied' AND new_commit = ?
       ORDER BY created_at DESC`,
    )
    .all(goalId, integrationHead) as Array<{
    id: string;
    goal_id: string;
    approval_id: string | null;
    op: string;
    expected_old: string | null;
    new_commit: string;
    status: string;
    checks_json: string;
    recovery_json: string | null;
  }>;
  for (const row of rows) {
    const record = parseFinalApplyOperationRecord(row.checks_json);
    const proof = parseFinalApplyRecoveryProof(row.recovery_json);
    if (
      !record ||
      !proof ||
      row.id !== record.operationId ||
      row.goal_id !== goalId ||
      row.approval_id !== record.approvalId ||
      row.expected_old !== record.destination.expectedBaseCommit ||
      row.new_commit !== record.source.integrationHead ||
      !validateFinalApplyOperationApproval(db, record) ||
      record.source.integrationHead !== integrationHead ||
      record.source.integrationTree !== integrationTree ||
      proof.operationDigest !== record.operationDigest ||
      proof.refLog.message !== record.reflogMessage ||
      proof.refLog.oldCommit !== record.destination.expectedBaseCommit ||
      proof.refLog.newCommit !== record.source.integrationHead ||
      proof.checkout.branch !== record.intent.destination.baseBranch ||
      proof.checkout.head !== record.source.integrationHead ||
      proof.checkout.baseRef !== record.destination.ref
    )
      continue;
    try {
      const context = loadContext(db, goalId);
      const format = await repositoryObjectFormat(context.repoRoot);
      if (format !== record.objectFormat) continue;
      const commonResult = await gitTry(context.repoRoot, ['rev-parse', '--git-common-dir']);
      if (!commonResult.ok || !commonResult.stdout.trim()) continue;
      const commonPath = commonResult.stdout.trim();
      const commonDir = realpathSync(
        isAbsolute(commonPath) ? commonPath : resolve(context.repoRoot, commonPath),
      );
      if (
        computeFinalApplyRepositoryIdentity(context.projectId, context.repoRoot, commonDir, context.scope) !==
        record.repositoryIdentity
      )
        continue;
      const tree = await gitTry(context.repoRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${record.source.integrationHead}^{tree}`,
      ]);
      if (!tree.ok || tree.stdout.trim() !== record.source.integrationTree) continue;
      const reflog = findApplyRefLogEvidence(
        commonDir,
        record.destination.ref,
        record.destination.expectedBaseCommit,
        record.source.integrationHead,
        record.reflogMessage,
      );
      if (reflog?.lineDigest === proof.refLog.lineDigest) return true;
    } catch {
      // Completion fails closed if the historical operation can no longer be independently verified.
    }
  }
  return false;
}

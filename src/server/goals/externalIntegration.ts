import { execFile as callbackExecFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { GoalApproval } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { loadContext } from '../goalGit.js';
import { canonicalJson } from './definitionHash.js';
import {
  externalIntegrationApprovalDetailSchema,
  parseExternalIntegrationApprovalDetail,
  type ExternalIntegrationApprovalDetailV2,
} from './externalIntegrationApproval.js';
import { computeFinalApplyRepositoryIdentity } from './finalApplyOperation.js';
import { getGoalApproval } from './approvals.js';
import {
  manualHandoffAttestationDatabaseFingerprint,
  readValidatedManualHandoff,
  validateManualHandoffAuthorityForExternalIntegration,
  type ManualIntegrationHandoffV1,
} from './manualHandoff.js';

const execFile = promisify(callbackExecFile);
const HASH = /^[0-9a-f]{64}$/;
const OID = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ } as const;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

const digestSchema = z.string().regex(HASH);
const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const uuidSchema = z.string().uuid();

const observationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('turing_goal_external_integration_observation'),
    goalId: uuidSchema,
    completionContractVersion: z.literal(2),
    handoff: z.object({ id: uuidSchema, digest: digestSchema }).strict(),
    definition: z
      .object({ version: z.number().int().positive(), hash: digestSchema, approvalId: uuidSchema })
      .strict(),
    review: z
      .object({
        finalReviewId: uuidSchema,
        acceptanceApprovalId: uuidSchema,
        evidenceIdentityDigest: digestSchema,
      })
      .strict(),
    repository: z
      .object({
        projectId: uuidSchema,
        identity: digestSchema,
        scope: z.string().max(1_000),
        objectFormat: z.enum(['sha1', 'sha256']),
      })
      .strict(),
    source: z
      .object({ ref: z.string().min(1).max(500), commit: objectIdSchema, tree: objectIdSchema })
      .strict(),
    destination: z
      .object({
        ref: z.string().min(1).max(500),
        expectedBaseCommit: objectIdSchema,
        expectedBaseTree: objectIdSchema,
        observedCommit: objectIdSchema,
        observedTree: objectIdSchema,
      })
      .strict(),
    proof: z
      .object({
        mode: z.literal('source_history_observed'),
        sourceAncestor: z.literal(true),
        baseAncestor: z.literal(true),
        verifierVersion: z.literal(1),
        evidenceDigest: digestSchema,
      })
      .strict(),
    observedAt: z.string().datetime(),
    actionDigest: digestSchema,
  })
  .strict();

export type ExternalIntegrationObservationV1 = z.infer<typeof observationSchema>;

const attestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('turing_goal_external_integration_attestation'),
    attestationId: uuidSchema,
    goalId: uuidSchema,
    approvalId: uuidSchema,
    completionContractVersion: z.literal(2),
    handoff: z.object({ id: uuidSchema, digest: digestSchema }).strict(),
    definition: z
      .object({ version: z.number().int().positive(), hash: digestSchema, approvalId: uuidSchema })
      .strict(),
    review: z
      .object({
        finalReviewId: uuidSchema,
        acceptanceApprovalId: uuidSchema,
        evidenceIdentityDigest: digestSchema,
      })
      .strict(),
    repository: z
      .object({
        projectId: uuidSchema,
        identity: digestSchema,
        scope: z.string().max(1_000),
        objectFormat: z.enum(['sha1', 'sha256']),
      })
      .strict(),
    source: z
      .object({ ref: z.string().min(1).max(500), commit: objectIdSchema, tree: objectIdSchema })
      .strict(),
    destination: z
      .object({
        ref: z.string().min(1).max(500),
        expectedBaseCommit: objectIdSchema,
        expectedBaseTree: objectIdSchema,
        observedCommit: objectIdSchema,
        observedTree: objectIdSchema,
      })
      .strict(),
    proof: z
      .object({
        mode: z.literal('source_history_observed'),
        sourceAncestor: z.literal(true),
        baseAncestor: z.literal(true),
        verifierVersion: z.literal(1),
        evidenceDigest: digestSchema,
      })
      .strict(),
    decision: z
      .object({
        value: z.literal('confirm_external_integration'),
        decidedBy: z.literal('user'),
        decidedAt: z.string().datetime(),
      })
      .strict(),
    observedAt: z.string().datetime(),
    actionDigest: digestSchema,
    recordDigest: digestSchema,
  })
  .strict();

export type ExternalIntegrationAttestationV1 = z.infer<typeof attestationSchema>;

interface AttestationRow {
  id: string;
  goal_id: string;
  schema_version: number;
  kind: string;
  approval_id: string;
  handoff_id: string;
  handoff_digest: string;
  completion_contract_version: number;
  definition_version: number;
  definition_hash: string;
  definition_approval_id: string;
  final_review_id: string;
  acceptance_approval_id: string;
  repository_project_id: string;
  repository_identity: string;
  repository_scope: string;
  object_format: 'sha1' | 'sha256';
  source_ref: string;
  source_commit: string;
  source_tree: string;
  destination_ref: string;
  expected_base_commit: string;
  expected_base_tree: string;
  observed_destination_commit: string;
  observed_destination_tree: string;
  proof_mode: string;
  verifier_version: number;
  evidence_digest: string;
  action_digest: string;
  record_digest: string;
  observed_at: string;
  decided_at: string;
  payload_json: string;
}

export class ExternalIntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalIntegrationError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function oidFor(format: 'sha1' | 'sha256', value: string): boolean {
  return OID[format].test(value);
}

function actionIdentity(observation: Omit<ExternalIntegrationObservationV1, 'actionDigest' | 'observedAt'>) {
  return [
    'turing-goal-external-integration-action-v1',
    observation.schemaVersion,
    observation.kind,
    observation.goalId,
    observation.completionContractVersion,
    observation.handoff.id,
    observation.handoff.digest,
    observation.definition.version,
    observation.definition.hash,
    observation.definition.approvalId,
    observation.review.finalReviewId,
    observation.review.acceptanceApprovalId,
    observation.review.evidenceIdentityDigest,
    observation.repository.projectId,
    observation.repository.identity,
    observation.repository.scope,
    observation.repository.objectFormat,
    observation.source.ref,
    observation.source.commit,
    observation.source.tree,
    observation.destination.ref,
    observation.destination.expectedBaseCommit,
    observation.destination.expectedBaseTree,
    observation.destination.observedCommit,
    observation.destination.observedTree,
    observation.proof.mode,
    observation.proof.sourceAncestor,
    observation.proof.baseAncestor,
    observation.proof.verifierVersion,
    observation.proof.evidenceDigest,
    'confirm_external_integration',
  ];
}

export function computeExternalIntegrationActionDigest(
  observation: Omit<ExternalIntegrationObservationV1, 'actionDigest'>,
): string {
  const { observedAt: _observedAt, ...identity } = observation;
  void _observedAt;
  return sha256(
    `turing-goal-external-integration-action-digest-v1\n${canonicalJson(actionIdentity(identity))}`,
  );
}

function computeEvidenceDigest(
  observation: Omit<ExternalIntegrationObservationV1, 'actionDigest' | 'observedAt' | 'proof'>,
): string {
  return sha256(
    `turing-goal-external-integration-git-evidence-v1\n${canonicalJson([
      observation.goalId,
      observation.handoff.id,
      observation.handoff.digest,
      observation.repository.projectId,
      observation.repository.identity,
      observation.repository.scope,
      observation.repository.objectFormat,
      observation.source.ref,
      observation.source.commit,
      observation.source.tree,
      observation.destination.ref,
      observation.destination.expectedBaseCommit,
      observation.destination.expectedBaseTree,
      observation.destination.observedCommit,
      observation.destination.observedTree,
      true,
      true,
      1,
    ])}`,
  );
}

function toObservation(record: ExternalIntegrationAttestationV1): ExternalIntegrationObservationV1 {
  const {
    decision: _decision,
    attestationId: _id,
    approvalId: _approvalId,
    recordDigest: _recordDigest,
    ...body
  } = record;
  void _decision;
  void _id;
  void _approvalId;
  void _recordDigest;
  const parsed = observationSchema.parse({
    ...body,
    kind: 'turing_goal_external_integration_observation',
  });
  return parsed;
}

function recordDigestBody(record: Omit<ExternalIntegrationAttestationV1, 'recordDigest'>): string {
  return sha256(`turing-goal-external-integration-record-v1\n${canonicalJson(record)}`);
}

function parseObservation(value: unknown): ExternalIntegrationObservationV1 | null {
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (
    !oidFor(item.repository.objectFormat, item.source.commit) ||
    !oidFor(item.repository.objectFormat, item.source.tree) ||
    !oidFor(item.repository.objectFormat, item.destination.expectedBaseCommit) ||
    !oidFor(item.repository.objectFormat, item.destination.expectedBaseTree) ||
    !oidFor(item.repository.objectFormat, item.destination.observedCommit) ||
    !oidFor(item.repository.objectFormat, item.destination.observedTree) ||
    item.source.ref !== `refs/heads/turing/goal/${item.goalId}` ||
    !item.destination.ref.startsWith('refs/heads/') ||
    item.destination.ref === item.source.ref ||
    item.proof.evidenceDigest !== computeEvidenceDigest(item) ||
    item.actionDigest !== computeExternalIntegrationActionDigest(item)
  )
    return null;
  return item;
}

function parseAttestation(raw: string): ExternalIntegrationAttestationV1 | null {
  try {
    const parsed = attestationSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success || canonicalJson(parsed.data) !== raw) return null;
    const record = parsed.data;
    const observation = parseObservation(toObservation(record));
    if (!observation || observation.actionDigest !== record.actionDigest) return null;
    const { recordDigest: _recordDigest, ...body } = record;
    void _recordDigest;
    if (recordDigestBody(body) !== record.recordDigest) return null;
    if (
      record.decision.decidedBy !== 'user' ||
      record.decision.value !== 'confirm_external_integration' ||
      record.completionContractVersion !== 2
    )
      return null;
    return record;
  } catch {
    return null;
  }
}

function recordMatchesRow(row: AttestationRow, record: ExternalIntegrationAttestationV1): boolean {
  return (
    row.id === record.attestationId &&
    row.goal_id === record.goalId &&
    row.schema_version === record.schemaVersion &&
    row.kind === record.kind &&
    row.approval_id === record.approvalId &&
    row.handoff_id === record.handoff.id &&
    row.handoff_digest === record.handoff.digest &&
    row.completion_contract_version === record.completionContractVersion &&
    row.definition_version === record.definition.version &&
    row.definition_hash === record.definition.hash &&
    row.definition_approval_id === record.definition.approvalId &&
    row.final_review_id === record.review.finalReviewId &&
    row.acceptance_approval_id === record.review.acceptanceApprovalId &&
    row.repository_project_id === record.repository.projectId &&
    row.repository_identity === record.repository.identity &&
    row.repository_scope === record.repository.scope &&
    row.object_format === record.repository.objectFormat &&
    row.source_ref === record.source.ref &&
    row.source_commit === record.source.commit &&
    row.source_tree === record.source.tree &&
    row.destination_ref === record.destination.ref &&
    row.expected_base_commit === record.destination.expectedBaseCommit &&
    row.expected_base_tree === record.destination.expectedBaseTree &&
    row.observed_destination_commit === record.destination.observedCommit &&
    row.observed_destination_tree === record.destination.observedTree &&
    row.proof_mode === record.proof.mode &&
    row.verifier_version === record.proof.verifierVersion &&
    row.evidence_digest === record.proof.evidenceDigest &&
    row.action_digest === record.actionDigest &&
    row.record_digest === record.recordDigest &&
    row.observed_at === record.observedAt &&
    row.decided_at === record.decision.decidedAt
  );
}

interface GitResult {
  stdout: string;
  exitCode: number;
}

async function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
  try {
    const safeEnvironment = { ...process.env };
    for (const key of Object.keys(safeEnvironment)) {
      if (/^GIT_/i.test(key)) delete safeEnvironment[key];
    }
    const result = await execFile('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...safeEnvironment,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
    });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const result = error as { code?: number | string; stdout?: string; killed?: boolean; signal?: string };
    if (typeof result.code === 'number') return { stdout: result.stdout ?? '', exitCode: result.code };
    const code = result.killed || result.signal ? 'git_timeout' : 'git_unavailable';
    throw new ExternalIntegrationError(code, 'Read-only Git verification could not complete safely.');
  }
}

async function requireGit(repoRoot: string, args: string[], code = 'git_unavailable'): Promise<string> {
  const result = await runGit(repoRoot, args);
  if (result.exitCode !== 0)
    throw new ExternalIntegrationError(code, 'Read-only Git verification was refused.');
  return result.stdout.trim();
}

function parseRefs(stdout: string): Array<{ ref: string; oid: string }> {
  const refs: Array<{ ref: string; oid: string }> = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    const separator = line.indexOf('\0');
    if (separator <= 0)
      throw new ExternalIntegrationError('git_output_invalid', 'Git returned an invalid ref listing.');
    const ref = line.slice(0, separator);
    const oid = line.slice(separator + 1);
    if (!ref.startsWith('refs/heads/') || !oidSchemaValid(oid))
      throw new ExternalIntegrationError('git_output_invalid', 'Git returned an invalid ref identity.');
    refs.push({ ref, oid });
  }
  return refs;
}

function oidSchemaValid(value: string): boolean {
  return OID.sha1.test(value) || OID.sha256.test(value);
}

async function readBranchRefs(
  repoRoot: string,
  sourceRef: string,
  destinationRef: string,
  objectFormat: 'sha1' | 'sha256',
): Promise<{ source: string; destination: string }> {
  const [sourceFormat, destinationFormat] = await Promise.all([
    requireGit(repoRoot, ['check-ref-format', sourceRef], 'source_ref_invalid'),
    requireGit(repoRoot, ['check-ref-format', destinationRef], 'destination_ref_invalid'),
  ]);
  void sourceFormat;
  void destinationFormat;
  const listing = await requireGit(repoRoot, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    'refs/heads',
  ]);
  const refs = parseRefs(listing);
  for (const wanted of [sourceRef, destinationRef]) {
    const sameFold = refs.filter(
      (entry) => entry.ref.toLocaleLowerCase('en-US') === wanted.toLocaleLowerCase('en-US'),
    );
    if (sameFold.some((entry) => entry.ref !== wanted))
      throw new ExternalIntegrationError(
        'case_ambiguous_ref',
        'A case-ambiguous branch ref prevents verification.',
      );
    if (sameFold.length !== 1 || sameFold[0]?.ref !== wanted)
      throw new ExternalIntegrationError(
        wanted === sourceRef ? 'source_ref_missing' : 'destination_ref_missing',
        'A required branch ref is missing.',
      );
    if (!OID[objectFormat].test(sameFold[0].oid))
      throw new ExternalIntegrationError(
        'git_object_invalid',
        'A branch ref has an invalid object identity.',
      );
  }
  const sourceRaw = refs.find((entry) => entry.ref === sourceRef)!.oid;
  const destinationRaw = refs.find((entry) => entry.ref === destinationRef)!.oid;
  const [sourceType, destinationType] = await Promise.all([
    requireGit(repoRoot, ['cat-file', '-t', sourceRaw]),
    requireGit(repoRoot, ['cat-file', '-t', destinationRaw]),
  ]);
  if (sourceType !== 'commit' || destinationType !== 'commit')
    throw new ExternalIntegrationError(
      'git_object_invalid',
      'A branch ref does not point directly to a commit.',
    );
  return { source: sourceRaw, destination: destinationRaw };
}

async function readTree(repoRoot: string, commit: string, format: 'sha1' | 'sha256'): Promise<string> {
  if (!OID[format].test(commit))
    throw new ExternalIntegrationError('git_object_invalid', 'A commit identity is malformed.');
  const tree = await requireGit(repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${commit}^{tree}`,
  ]);
  if (!OID[format].test(tree))
    throw new ExternalIntegrationError('git_object_invalid', 'A tree identity is malformed.');
  return tree;
}

async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new ExternalIntegrationError('git_unavailable', 'Git could not verify commit ancestry.');
}

function makeObservation(
  handoff: ManualIntegrationHandoffV1,
  repository: { identity: string; objectFormat: 'sha1' | 'sha256' },
  destination: { observedCommit: string; observedTree: string },
): ExternalIntegrationObservationV1 {
  const withoutProof = {
    schemaVersion: 1 as const,
    kind: 'turing_goal_external_integration_observation' as const,
    goalId: handoff.goalId,
    completionContractVersion: 2 as const,
    handoff: { id: handoff.handoffId, digest: handoff.handoffDigest },
    definition: {
      version: handoff.definition.version,
      hash: handoff.definition.hash,
      approvalId: handoff.definition.approvalId,
    },
    review: {
      finalReviewId: handoff.review.finalReviewId,
      acceptanceApprovalId: handoff.finalAcceptance.approvalId,
      evidenceIdentityDigest: handoff.review.evidenceIdentityDigest,
    },
    repository: {
      projectId: handoff.repository.projectId,
      identity: repository.identity,
      scope: handoff.repository.scope,
      objectFormat: repository.objectFormat,
    },
    source: { ref: handoff.source.goalRef, commit: handoff.source.commit, tree: handoff.source.tree },
    destination: {
      ref: handoff.target.baseRef,
      expectedBaseCommit: handoff.target.observedBaseCommit,
      expectedBaseTree: handoff.target.observedBaseTree,
      observedCommit: destination.observedCommit,
      observedTree: destination.observedTree,
    },
  };
  const evidenceDigest = computeEvidenceDigest(withoutProof);
  const body = {
    ...withoutProof,
    proof: {
      mode: 'source_history_observed' as const,
      sourceAncestor: true as const,
      baseAncestor: true as const,
      verifierVersion: 1 as const,
      evidenceDigest,
    },
    observedAt: new Date().toISOString(),
  };
  const actionDigest = computeExternalIntegrationActionDigest(body);
  return observationSchema.parse({ ...body, actionDigest });
}

function sameObservedIdentities(
  candidate: ExternalIntegrationObservationV1,
  fresh: ExternalIntegrationObservationV1,
): boolean {
  return candidate.actionDigest === fresh.actionDigest;
}

function assertObservationRepositoryFormat(observation: ExternalIntegrationObservationV1): void {
  const format = observation.repository.objectFormat;
  if (
    !oidFor(format, observation.source.commit) ||
    !oidFor(format, observation.source.tree) ||
    !oidFor(format, observation.destination.expectedBaseCommit) ||
    !oidFor(format, observation.destination.expectedBaseTree) ||
    !oidFor(format, observation.destination.observedCommit) ||
    !oidFor(format, observation.destination.observedTree)
  )
    throw new ExternalIntegrationError(
      'object_id_width_invalid',
      'An object ID does not match the repository format.',
    );
}

/** Read-only observation plus the exact database binding used for its short persistence recheck. */
async function buildExternalIntegrationObservationSnapshot(
  db: Db,
  goalId: string,
  handoffId: string,
): Promise<{
  observation: ExternalIntegrationObservationV1;
  authorityFingerprint: string;
  databaseFingerprint: string;
}> {
  const before = await validateManualHandoffAuthorityForExternalIntegration(db, goalId, handoffId);
  if (before.state !== 'valid')
    throw new ExternalIntegrationError(before.code, `The handoff authority is ${before.state}.`);
  const handoff = before.record;
  const context = loadContext(db, goalId);
  const repositoryBefore = await verifyRepositoryIdentity(context, handoff);
  const refsBefore = await readBranchRefs(
    context.repoRoot,
    handoff.source.goalRef,
    handoff.target.baseRef,
    repositoryBefore.objectFormat,
  );
  if (refsBefore.source !== handoff.source.commit)
    throw new ExternalIntegrationError(
      'source_changed',
      'The Goal source ref no longer names the accepted commit.',
    );
  const sourceTree = await readTree(context.repoRoot, refsBefore.source, repositoryBefore.objectFormat);
  const expectedBaseTree = await readTree(
    context.repoRoot,
    handoff.target.observedBaseCommit,
    repositoryBefore.objectFormat,
  );
  const observedTree = await readTree(
    context.repoRoot,
    refsBefore.destination,
    repositoryBefore.objectFormat,
  );
  if (sourceTree !== handoff.source.tree || expectedBaseTree !== handoff.target.observedBaseTree)
    throw new ExternalIntegrationError(
      'handoff_git_identity_invalid',
      'A handoff commit or tree identity no longer verifies.',
    );
  const [sourceAncestor, baseAncestor] = await Promise.all([
    isAncestor(context.repoRoot, refsBefore.source, refsBefore.destination),
    isAncestor(context.repoRoot, handoff.target.observedBaseCommit, refsBefore.destination),
  ]);
  if (!baseAncestor)
    throw new ExternalIntegrationError(
      'base_not_ancestor',
      'The recorded base commit is not in destination history.',
    );
  if (!sourceAncestor)
    throw new ExternalIntegrationError(
      'source_not_ancestor',
      'The accepted source commit is not in destination history.',
    );

  const refsAfter = await readBranchRefs(
    context.repoRoot,
    handoff.source.goalRef,
    handoff.target.baseRef,
    repositoryBefore.objectFormat,
  );
  const repositoryAfter = await verifyRepositoryIdentity(context, handoff);
  const after = await validateManualHandoffAuthorityForExternalIntegration(db, goalId, handoffId);
  if (after.state !== 'valid')
    throw new ExternalIntegrationError(after.code, `The handoff authority became ${after.state}.`);
  if (
    refsBefore.source !== refsAfter.source ||
    refsBefore.destination !== refsAfter.destination ||
    repositoryBefore.identity !== repositoryAfter.identity ||
    before.authorityFingerprint !== after.authorityFingerprint
  )
    throw new ExternalIntegrationError(
      'observation_changed',
      'Repository or Goal authority changed during observation.',
    );

  const observation = makeObservation(handoff, repositoryBefore, {
    observedCommit: refsBefore.destination,
    observedTree,
  });
  assertObservationRepositoryFormat(observation);
  return {
    observation,
    authorityFingerprint: after.authorityFingerprint,
    databaseFingerprint: after.databaseFingerprint,
  };
}

/** Read-only observation. It never writes refs, approval rows, handoffs or attestations. */
export async function buildExternalIntegrationObservation(
  db: Db,
  goalId: string,
  handoffId: string,
): Promise<ExternalIntegrationObservationV1> {
  return (await buildExternalIntegrationObservationSnapshot(db, goalId, handoffId)).observation;
}

async function verifyRepositoryIdentity(
  context: ReturnType<typeof loadContext>,
  handoff: ManualIntegrationHandoffV1,
): Promise<{ identity: string; objectFormat: 'sha1' | 'sha256' }> {
  const top = await requireGit(context.repoRoot, ['rev-parse', '--show-toplevel']);
  const common = await requireGit(context.repoRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  let canonicalRoot: string;
  let commonDir: string;
  try {
    canonicalRoot = realpathSync(top);
    commonDir = realpathSync(common);
  } catch {
    throw new ExternalIntegrationError(
      'repository_unavailable',
      'The registered Git directory is unavailable.',
    );
  }
  if (canonicalRoot !== context.repoRoot)
    throw new ExternalIntegrationError(
      'repository_identity_changed',
      'The registered repository root changed.',
    );
  const objectFormat = await requireGit(context.repoRoot, ['rev-parse', '--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    throw new ExternalIntegrationError(
      'unsupported_object_format',
      'The repository object format is unsupported.',
    );
  const identity = computeFinalApplyRepositoryIdentity(
    context.projectId,
    canonicalRoot,
    commonDir,
    context.scope,
  );
  if (
    context.projectId !== handoff.repository.projectId ||
    context.scope !== handoff.repository.scope ||
    identity !== handoff.repository.identity ||
    objectFormat !== handoff.repository.objectFormat
  )
    throw new ExternalIntegrationError(
      'repository_identity_changed',
      'The registered repository identity changed.',
    );
  return { identity, objectFormat };
}

export type ExternalIntegrationObservationValidation =
  | {
      state: 'valid';
      observation: ExternalIntegrationObservationV1;
      authorityFingerprint: string;
      databaseFingerprint: string;
    }
  | { state: 'stale' | 'not_integrated' | 'unavailable' | 'invalid'; code: string };

/** Rebuilds the observation and requires the same complete action identity; it never persists anything. */
export async function validateExternalIntegrationObservation(
  db: Db,
  goalId: string,
  handoffId: string,
  observation: unknown,
): Promise<ExternalIntegrationObservationValidation> {
  const parsed = parseObservation(observation);
  if (!parsed || parsed.goalId !== goalId || parsed.handoff.id !== handoffId)
    return { state: 'invalid', code: 'observation_invalid' };
  try {
    const fresh = await buildExternalIntegrationObservationSnapshot(db, goalId, handoffId);
    if (!sameObservedIdentities(parsed, fresh.observation))
      return { state: 'stale', code: 'observation_changed' };
    return {
      state: 'valid',
      observation: fresh.observation,
      authorityFingerprint: fresh.authorityFingerprint,
      databaseFingerprint: fresh.databaseFingerprint,
    };
  } catch (error) {
    return validationFailure(error);
  }
}

function validationFailure(error: unknown): ExternalIntegrationObservationValidation {
  if (error instanceof ExternalIntegrationError) {
    const staleCodes = new Set([
      'source_changed',
      'destination_ref_missing',
      'source_ref_missing',
      'repository_identity_changed',
      'handoff_git_identity_invalid',
      'observation_changed',
    ]);
    const notIntegratedCodes = new Set(['base_not_ancestor', 'source_not_ancestor']);
    const unavailableCodes = new Set(['repository_unavailable', 'git_unavailable', 'git_timeout']);
    return {
      state: unavailableCodes.has(error.code)
        ? 'unavailable'
        : notIntegratedCodes.has(error.code)
          ? 'not_integrated'
          : staleCodes.has(error.code)
            ? 'stale'
            : 'invalid',
      code: error.code,
    };
  }
  return { state: 'unavailable', code: 'repository_unavailable' };
}

export function createExternalIntegrationApprovalDetail(
  observationInput: ExternalIntegrationObservationV1,
): ExternalIntegrationApprovalDetailV2 {
  const observation = parseObservation(observationInput);
  if (!observation)
    throw new ExternalIntegrationError('observation_invalid', 'The Git observation is invalid.');
  return externalIntegrationApprovalDetailSchema.parse({
    schemaVersion: 2,
    action: 'confirm_external_integration',
    actionDigest: observation.actionDigest,
    goalId: observation.goalId,
    handoffId: observation.handoff.id,
    handoffDigest: observation.handoff.digest,
    completionContractVersion: observation.completionContractVersion,
    definitionVersion: observation.definition.version,
    definitionHash: observation.definition.hash,
    definitionApprovalId: observation.definition.approvalId,
    finalReviewId: observation.review.finalReviewId,
    acceptanceApprovalId: observation.review.acceptanceApprovalId,
    repositoryProjectId: observation.repository.projectId,
    repositoryIdentity: observation.repository.identity,
    repositoryScope: observation.repository.scope,
    objectFormat: observation.repository.objectFormat,
    sourceRef: observation.source.ref,
    sourceCommit: observation.source.commit,
    sourceTree: observation.source.tree,
    destinationRef: observation.destination.ref,
    expectedBaseCommit: observation.destination.expectedBaseCommit,
    expectedBaseTree: observation.destination.expectedBaseTree,
    observedDestinationCommit: observation.destination.observedCommit,
    observedDestinationTree: observation.destination.observedTree,
    proofMode: observation.proof.mode,
    verifierVersion: observation.proof.verifierVersion,
    evidenceDigest: observation.proof.evidenceDigest,
  });
}

function approvalMatchesObservation(
  approval: GoalApproval,
  observation: ExternalIntegrationObservationV1,
): boolean {
  const detail = parseExternalIntegrationApprovalDetail(approval.detail);
  if (!detail) return false;
  const expected = createExternalIntegrationApprovalDetail(observation);
  return (
    approval.goalId === observation.goalId &&
    approval.gate === 'final_apply' &&
    approval.risk === 'high' &&
    approval.requestedBy === 'user' &&
    approval.externalIntegrationActionDigest === observation.actionDigest &&
    approval.intentDigest === undefined &&
    canonicalJson(detail) === canonicalJson(expected)
  );
}

function recordFromObservation(
  observation: ExternalIntegrationObservationV1,
  approval: GoalApproval,
): ExternalIntegrationAttestationV1 {
  if (
    approval.status !== 'approved' ||
    approval.decidedBy !== 'user' ||
    !approval.respondedAt ||
    !approvalMatchesObservation(approval, observation)
  )
    throw new ExternalIntegrationError(
      'user_attestation_approval_required',
      'A matching approved user decision is required.',
    );
  const body = {
    schemaVersion: 1 as const,
    kind: 'turing_goal_external_integration_attestation' as const,
    attestationId: randomUUID(),
    goalId: observation.goalId,
    approvalId: approval.id,
    completionContractVersion: observation.completionContractVersion,
    handoff: observation.handoff,
    definition: observation.definition,
    review: observation.review,
    repository: observation.repository,
    source: observation.source,
    destination: observation.destination,
    proof: observation.proof,
    decision: {
      value: 'confirm_external_integration' as const,
      decidedBy: 'user' as const,
      decidedAt: approval.respondedAt,
    },
    observedAt: observation.observedAt,
    actionDigest: observation.actionDigest,
  };
  return attestationSchema.parse({ ...body, recordDigest: recordDigestBody(body) });
}

function approvalIdentityMatchesRow(
  approval: GoalApproval | undefined,
  record: ExternalIntegrationAttestationV1,
): approval is GoalApproval {
  return Boolean(
    approval &&
    approval.id === record.approvalId &&
    approval.status === 'approved' &&
    approval.decidedBy === 'user' &&
    approval.respondedAt === record.decision.decidedAt &&
    approvalMatchesObservation(approval, toObservation(record)),
  );
}

function getAttestationRow(db: Db, goalId: string, attestationId: string): AttestationRow | undefined {
  return db
    .prepare('SELECT * FROM goal_external_integration_attestations WHERE goal_id = ? AND id = ?')
    .get(goalId, attestationId) as AttestationRow | undefined;
}

function loadValidatedRecord(
  db: Db,
  goalId: string,
  attestationId: string,
): { row: AttestationRow; record: ExternalIntegrationAttestationV1 } | null {
  const row = getAttestationRow(db, goalId, attestationId);
  if (!row) return null;
  const record = parseAttestation(row.payload_json);
  if (
    !record ||
    !recordMatchesRow(row, record) ||
    record.goalId !== goalId ||
    record.attestationId !== attestationId
  )
    throw new ExternalIntegrationError(
      'attestation_invalid',
      'The stored attestation failed integrity validation.',
    );
  return { row, record };
}

export async function persistExternalIntegrationAttestation(
  db: Db,
  input: {
    goalId: string;
    handoffId: string;
    observation: unknown;
    approvalId: string;
  },
): Promise<{ record: ExternalIntegrationAttestationV1; reused: boolean }> {
  const validation = await validateExternalIntegrationObservation(
    db,
    input.goalId,
    input.handoffId,
    input.observation,
  );
  if (validation.state !== 'valid')
    throw new ExternalIntegrationError(validation.code, `The Git observation is ${validation.state}.`);
  const observation = validation.observation;
  const approval = getGoalApproval(db, input.approvalId);
  if (!approval)
    throw new ExternalIntegrationError(
      'approval_mismatch',
      'The approval does not authorize this exact observation.',
    );
  if (!approvalMatchesObservation(approval, observation))
    throw new ExternalIntegrationError(
      'approval_mismatch',
      'The approval does not authorize this exact observation.',
    );
  if (!approval || approval.status !== 'approved' || approval.decidedBy !== 'user' || !approval.respondedAt)
    throw new ExternalIntegrationError(
      'user_attestation_approval_required',
      'A matching approved user decision is required.',
    );
  const record = recordFromObservation(observation, approval);

  const persist = db.transaction(() => {
    const databaseFingerprint = manualHandoffAttestationDatabaseFingerprint(db, input.goalId);
    if (databaseFingerprint !== validation.databaseFingerprint)
      throw new ExternalIntegrationError(
        'database_authority_changed',
        'Goal authority changed before persistence.',
      );
    const currentApproval = getGoalApproval(db, input.approvalId);
    if (!currentApproval || !approvalIdentityMatchesRow(currentApproval, record))
      throw new ExternalIntegrationError(
        'approval_mismatch',
        'The approved user decision changed before persistence.',
      );
    let handoff: ManualIntegrationHandoffV1 | null;
    try {
      handoff = readValidatedManualHandoff(db, input.goalId, input.handoffId);
    } catch {
      throw new ExternalIntegrationError('handoff_invalid', 'The immutable handoff is malformed.');
    }
    if (!handoff || handoff.handoffDigest !== record.handoff.digest)
      throw new ExternalIntegrationError('handoff_invalid', 'The immutable handoff identity does not match.');

    const existing = db
      .prepare('SELECT * FROM goal_external_integration_attestations WHERE goal_id = ? AND action_digest = ?')
      .get(input.goalId, observation.actionDigest) as AttestationRow | undefined;
    if (existing) {
      const existingRecord = parseAttestation(existing.payload_json);
      if (
        !existingRecord ||
        !recordMatchesRow(existing, existingRecord) ||
        existingRecord.approvalId !== record.approvalId ||
        existingRecord.actionDigest !== record.actionDigest
      )
        throw new ExternalIntegrationError(
          'idempotency_conflict',
          'An identical action digest has conflicting authority.',
        );
      return { record: existingRecord, reused: true };
    }

    db.prepare(
      `INSERT INTO goal_external_integration_attestations (
        id, goal_id, schema_version, kind, approval_id, handoff_id, handoff_digest,
        completion_contract_version, definition_version, definition_hash, definition_approval_id,
        final_review_id, acceptance_approval_id, repository_project_id, repository_identity,
        repository_scope, object_format, source_ref, source_commit, source_tree, destination_ref,
        expected_base_commit, expected_base_tree, observed_destination_commit, observed_destination_tree,
        proof_mode, verifier_version, evidence_digest, action_digest, record_digest, observed_at,
        decided_at, payload_json
      ) VALUES (
        @id, @goal_id, @schema_version, @kind, @approval_id, @handoff_id, @handoff_digest,
        @completion_contract_version, @definition_version, @definition_hash, @definition_approval_id,
        @final_review_id, @acceptance_approval_id, @repository_project_id, @repository_identity,
        @repository_scope, @object_format, @source_ref, @source_commit, @source_tree, @destination_ref,
        @expected_base_commit, @expected_base_tree, @observed_destination_commit, @observed_destination_tree,
        @proof_mode, @verifier_version, @evidence_digest, @action_digest, @record_digest, @observed_at,
        @decided_at, @payload_json
      )`,
    ).run(attestationParams(record));
    return { record, reused: false };
  });
  try {
    return persist.immediate();
  } catch (error) {
    const existing = db
      .prepare('SELECT * FROM goal_external_integration_attestations WHERE goal_id = ? AND action_digest = ?')
      .get(input.goalId, observation.actionDigest) as AttestationRow | undefined;
    const existingRecord = existing ? parseAttestation(existing.payload_json) : null;
    if (
      existing &&
      existingRecord &&
      recordMatchesRow(existing, existingRecord) &&
      existingRecord.approvalId === record.approvalId
    )
      return { record: existingRecord, reused: true };
    if (error instanceof ExternalIntegrationError) throw error;
    throw new ExternalIntegrationError(
      'persistence_failed',
      'The attestation could not be persisted safely.',
    );
  }
}

function attestationParams(record: ExternalIntegrationAttestationV1): Record<string, string | number> {
  return {
    id: record.attestationId,
    goal_id: record.goalId,
    schema_version: record.schemaVersion,
    kind: record.kind,
    approval_id: record.approvalId,
    handoff_id: record.handoff.id,
    handoff_digest: record.handoff.digest,
    completion_contract_version: record.completionContractVersion,
    definition_version: record.definition.version,
    definition_hash: record.definition.hash,
    definition_approval_id: record.definition.approvalId,
    final_review_id: record.review.finalReviewId,
    acceptance_approval_id: record.review.acceptanceApprovalId,
    repository_project_id: record.repository.projectId,
    repository_identity: record.repository.identity,
    repository_scope: record.repository.scope,
    object_format: record.repository.objectFormat,
    source_ref: record.source.ref,
    source_commit: record.source.commit,
    source_tree: record.source.tree,
    destination_ref: record.destination.ref,
    expected_base_commit: record.destination.expectedBaseCommit,
    expected_base_tree: record.destination.expectedBaseTree,
    observed_destination_commit: record.destination.observedCommit,
    observed_destination_tree: record.destination.observedTree,
    proof_mode: record.proof.mode,
    verifier_version: record.proof.verifierVersion,
    evidence_digest: record.proof.evidenceDigest,
    action_digest: record.actionDigest,
    record_digest: record.recordDigest,
    observed_at: record.observedAt,
    decided_at: record.decision.decidedAt,
    payload_json: canonicalJson(record),
  };
}

export type ExternalAttestationState =
  'current' | 'historical' | 'stale' | 'not_integrated' | 'unavailable' | 'invalid';

export interface ExternalIntegrationValidation {
  state: ExternalAttestationState;
  record: ExternalIntegrationAttestationV1 | null;
  reason: { code: string; message: string } | null;
  currentObservation: ExternalIntegrationObservationV1 | null;
}

export async function validateExternalIntegrationAttestation(
  db: Db,
  goalId: string,
  attestationId: string,
): Promise<ExternalIntegrationValidation> {
  let stored: ReturnType<typeof loadValidatedRecord>;
  try {
    stored = loadValidatedRecord(db, goalId, attestationId);
  } catch {
    return {
      state: 'invalid',
      record: null,
      reason: reason('attestation_invalid'),
      currentObservation: null,
    };
  }
  if (!stored)
    return {
      state: 'invalid',
      record: null,
      reason: reason('attestation_not_found'),
      currentObservation: null,
    };
  const approval = getGoalApproval(db, stored.record.approvalId);
  if (!approvalIdentityMatchesRow(approval, stored.record))
    return {
      state: 'invalid',
      record: stored.record,
      reason: reason('approval_invalid'),
      currentObservation: null,
    };
  try {
    const authority = await validateManualHandoffAuthorityForExternalIntegration(
      db,
      goalId,
      stored.record.handoff.id,
    );
    if (authority.state !== 'valid') {
      return {
        state: authority.state === 'unavailable' ? 'unavailable' : 'stale',
        record: stored.record,
        reason: reason(authority.code),
        currentObservation: null,
      };
    }
    const observation = await buildExternalIntegrationObservation(db, goalId, stored.record.handoff.id);
    if (observation.actionDigest === stored.record.actionDigest)
      return { state: 'current', record: stored.record, reason: null, currentObservation: observation };
    const sameAuthority =
      observation.handoff.digest === stored.record.handoff.digest &&
      observation.source.commit === stored.record.source.commit &&
      observation.source.tree === stored.record.source.tree &&
      observation.destination.ref === stored.record.destination.ref &&
      observation.destination.expectedBaseCommit === stored.record.destination.expectedBaseCommit &&
      observation.destination.expectedBaseTree === stored.record.destination.expectedBaseTree &&
      observation.repository.identity === stored.record.repository.identity;
    if (sameAuthority)
      return {
        state: 'historical',
        record: stored.record,
        reason: reason('destination_advanced_after_observation'),
        currentObservation: observation,
      };
    return {
      state: 'stale',
      record: stored.record,
      reason: reason('authority_or_repository_changed'),
      currentObservation: observation,
    };
  } catch (error) {
    const failure = validationFailure(error);
    return {
      state: failure.state === 'valid' ? 'unavailable' : failure.state,
      record: stored.record,
      reason: reason(failure.state === 'valid' ? 'repository_unavailable' : failure.code),
      currentObservation: null,
    };
  }
}

export interface ExternalIntegrationProjection {
  state: ExternalAttestationState;
  record: ExternalIntegrationAttestationV1 | null;
  reason: { code: string; message: string } | null;
  claim: 'source_history_observed_at_recorded_time' | 'not_verified';
  contentPreservation: 'not_proven';
  goalCompletion: 'not_completed_by_attestation';
}

export async function getExternalIntegrationProjection(
  db: Db,
  goalId: string,
  attestationId: string,
): Promise<ExternalIntegrationProjection> {
  const validation = await validateExternalIntegrationAttestation(db, goalId, attestationId);
  return {
    state: validation.state,
    record: validation.record,
    reason: validation.reason,
    claim:
      validation.record && (validation.state === 'current' || validation.state === 'historical')
        ? 'source_history_observed_at_recorded_time'
        : 'not_verified',
    contentPreservation: 'not_proven',
    goalCompletion: 'not_completed_by_attestation',
  };
}

function reason(code: string): { code: string; message: string } {
  const messages: Record<string, string> = {
    attestation_invalid: 'The attestation record failed integrity validation.',
    attestation_not_found: 'No attestation exists for this Goal.',
    approval_invalid: 'The linked user approval is missing or does not match this attestation.',
    destination_advanced_after_observation:
      'The recorded observation remains historical; the destination ref has moved since then.',
    authority_or_repository_changed:
      'The Goal authority or registered repository no longer matches this observation.',
    repository_identity_changed: 'The registered repository identity changed.',
    source_changed: 'The Goal source ref no longer names the accepted commit.',
    source_not_ancestor: 'The accepted source commit is not in the current destination history.',
    base_not_ancestor: 'The recorded base commit is not in the current destination history.',
    observation_changed: 'Git or Goal authority changed during verification.',
    repository_unavailable: 'The registered repository cannot be verified safely.',
  };
  return { code, message: messages[code] ?? 'The integration evidence is stale or unavailable.' };
}

import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const uuid = z.string().uuid();

export const externalIntegrationApprovalDetailSchema = z
  .object({
    schemaVersion: z.literal(2),
    action: z.literal('confirm_external_integration'),
    actionDigest: digest,
    goalId: uuid,
    handoffId: uuid,
    handoffDigest: digest,
    completionContractVersion: z.literal(2),
    definitionVersion: z.number().int().positive(),
    definitionHash: digest,
    definitionApprovalId: uuid,
    finalReviewId: uuid,
    acceptanceApprovalId: uuid,
    repositoryProjectId: uuid,
    repositoryIdentity: digest,
    repositoryScope: z.string().max(1_000),
    objectFormat: z.enum(['sha1', 'sha256']),
    sourceRef: z.string().min(1).max(500),
    sourceCommit: objectId,
    sourceTree: objectId,
    destinationRef: z.string().min(1).max(500),
    expectedBaseCommit: objectId,
    expectedBaseTree: objectId,
    observedDestinationCommit: objectId,
    observedDestinationTree: objectId,
    proofMode: z.literal('source_history_observed'),
    verifierVersion: z.literal(1),
    evidenceDigest: digest,
  })
  .strict();

export type ExternalIntegrationApprovalDetailV2 = z.infer<typeof externalIntegrationApprovalDetailSchema>;

export function parseExternalIntegrationApprovalDetail(
  value: unknown,
): ExternalIntegrationApprovalDetailV2 | null {
  const parsed = externalIntegrationApprovalDetailSchema.safeParse(value);
  if (!parsed.success) return null;
  const detail = parsed.data;
  const oidPattern = detail.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (
    !oidPattern.test(detail.sourceCommit) ||
    !oidPattern.test(detail.sourceTree) ||
    !oidPattern.test(detail.expectedBaseCommit) ||
    !oidPattern.test(detail.expectedBaseTree) ||
    !oidPattern.test(detail.observedDestinationCommit) ||
    !oidPattern.test(detail.observedDestinationTree) ||
    detail.sourceRef !== `refs/heads/turing/goal/${detail.goalId}` ||
    !detail.destinationRef.startsWith('refs/heads/') ||
    detail.destinationRef === detail.sourceRef
  )
    return null;
  return detail;
}

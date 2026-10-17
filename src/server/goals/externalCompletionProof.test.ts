import { describe, expect, it } from 'vitest';
import {
  buildExternalCompletionAction,
  buildExternalCompletionProof,
  computeExternalCompletionActionDigest,
  computeExternalCompletionProofDigest,
  parseExternalCompletionAction,
  parseExternalCompletionProof,
  type ExternalCompletionActionBodyV1,
  type ExternalCompletionProofBodyV1,
} from './externalCompletionProof.js';

const uuid = (tail: string) => `20000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const hash = (letter: string) => letter.repeat(64);
const sha = (letter: string) => letter.repeat(40);

function actionBody(objectFormat: 'sha1' | 'sha256' = 'sha1'): ExternalCompletionActionBodyV1 {
  const objectId = (letter: string) => letter.repeat(objectFormat === 'sha1' ? 40 : 64);
  return {
    schemaVersion: 1,
    action: 'complete_goal_external_integration_v2',
    completionContractVersion: 2,
    goalId: uuid('1'),
    definition: { version: 2, hash: hash('a'), approvalId: uuid('2'), lineageDigest: hash('b') },
    integrationMode: 'external_user_attested',
    handoff: { id: uuid('3'), digest: hash('c') },
    attestation: { id: uuid('4'), actionDigest: hash('d'), recordDigest: hash('e'), approvalId: uuid('5') },
    review: { finalReviewId: uuid('6'), acceptanceApprovalId: uuid('7') },
    verificationEvidenceDigest: hash('f'),
    milestoneIdentityDigest: hash('1'),
    findingIdentityDigest: hash('2'),
    repository: { projectId: uuid('8'), identity: hash('3'), scope: 'src/', objectFormat },
    source: { ref: `refs/heads/turing/goal/${uuid('1')}`, commit: objectId('4'), tree: objectId('5') },
    destination: {
      ref: 'refs/heads/main',
      recordedBaseCommit: objectId('6'),
      recordedBaseTree: objectId('7'),
      observedCommit: objectId('8'),
      observedTree: objectId('9'),
    },
    proof: {
      mode: 'source_history_observed',
      sourceAncestor: true,
      baseAncestor: true,
      verifierVersion: 1,
      evidenceDigest: hash('4'),
    },
    proofLimitations: { contentPreservation: 'not_proven' },
    userReviewedPreflightDigest: hash('5'),
    correctionChain: {
      schemaVersion: 1,
      kind: 'turing_goal_external_integration_correction_chain',
      attestationId: uuid('4'),
      sequence: 0,
      digest: hash('6'),
      standing: 'active_uncontested',
    },
  };
}

function proofBody(objectFormat: 'sha1' | 'sha256' = 'sha1'): ExternalCompletionProofBodyV1 {
  const action = actionBody(objectFormat);
  return {
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
    gitProof: { ...action.proof, observedAt: '2026-10-10T12:00:00.000Z' },
    decision: {
      approvalId: uuid('9'),
      actionDigest: computeExternalCompletionActionDigest(action),
      decidedAt: '2026-10-10T12:01:00.000Z',
      classification: 'user_confirmed_historical_external_integration',
    },
    proofLimitations: action.proofLimitations,
    correctionChain: action.correctionChain,
    userReviewedPreflightDigest: action.userReviewedPreflightDigest,
  };
}

describe('versioned external-completion action and proof contracts', () => {
  it('builds a strict deterministic action digest bound to reviewed authority and destination', () => {
    const body = actionBody();
    const first = buildExternalCompletionAction(body);
    const second = buildExternalCompletionAction(structuredClone(body));
    expect(first).not.toBeNull();
    expect(first?.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.actionDigest).toBe(first?.actionDigest);
    expect(parseExternalCompletionAction(first)).toMatchObject({ valid: true, digest: first?.actionDigest });

    const changedDestination = structuredClone(body);
    changedDestination.destination.observedCommit = sha('a');
    expect(buildExternalCompletionAction(changedDestination)?.actionDigest).not.toBe(first?.actionDigest);
    const changedCorrection = structuredClone(body);
    changedCorrection.correctionChain.digest = hash('7');
    expect(buildExternalCompletionAction(changedCorrection)?.actionDigest).not.toBe(first?.actionDigest);
    expect(buildExternalCompletionAction({ ...body, unreviewedField: true })).toBeNull();
    expect(
      buildExternalCompletionAction({
        ...body,
        correctionChain: { ...body.correctionChain, attestationId: uuid('0') },
      }),
    ).toBeNull();
    const sha256Action = buildExternalCompletionAction(actionBody('sha256'));
    expect(sha256Action?.repository.objectFormat).toBe('sha256');
    expect(parseExternalCompletionAction(sha256Action)).toMatchObject({ valid: true });
  });

  it('rejects an action digest changed after review and enforces object format', () => {
    const action = buildExternalCompletionAction(actionBody())!;
    expect(
      parseExternalCompletionAction({
        ...action,
        destination: { ...action.destination, observedTree: sha('a') },
      }),
    ).toEqual({ valid: false, reason: 'digest_mismatch' });
    expect(
      buildExternalCompletionAction({
        ...actionBody(),
        source: { ...actionBody().source, commit: 'a'.repeat(64) },
      }),
    ).toBeNull();
  });

  it('digests the complete immutable proof body, including observations and decision timestamps', () => {
    const body = proofBody();
    const first = buildExternalCompletionProof(body);
    expect(first).not.toBeNull();
    expect(first?.proofDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parseExternalCompletionProof(first)).toMatchObject({ valid: true, digest: first?.proofDigest });
    expect(first?.proofDigest).not.toBe(first?.decision.actionDigest);

    const changedTime = structuredClone(body);
    changedTime.gitProof.observedAt = '2026-10-10T12:02:00.000Z';
    expect(buildExternalCompletionProof(changedTime)?.proofDigest).not.toBe(first?.proofDigest);
    expect(
      parseExternalCompletionProof({
        ...first!,
        source: { ...first!.source, tree: sha('a') },
        evaluation: { ...first!.evaluation, integrationTree: sha('a') },
      }),
    ).toEqual({ valid: false, reason: 'digest_mismatch' });
    expect(
      buildExternalCompletionProof({
        ...body,
        evaluation: { ...body.evaluation, integrationHead: sha('a') },
      }),
    ).toBeNull();
    expect(computeExternalCompletionProofDigest(body)).toBe(first?.proofDigest);
    const sha256Proof = buildExternalCompletionProof(proofBody('sha256'));
    expect(sha256Proof?.repository.objectFormat).toBe('sha256');
    expect(parseExternalCompletionProof(sha256Proof)).toMatchObject({ valid: true });
  });
});

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationObservation,
  GoalExternalIntegrationStoredStatus,
  GoalExternalIntegrationVerification,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import { ConfirmPanel } from './DefinitionParts';
import { GoalCompletion } from './GoalCompletion';
import { goalsApi } from './api';
import { formatTime, shortHash } from './presentation';
import { useLoad } from './useLoad';

const PENDING_PREFIX = 'turing.goalExternalIntegration.v1:';
const HASH = /^[0-9a-f]{64}$/;
const volatilePendingDigests = new Map<string, string>();
const volatilePendingKeys = new Set<string>();

type RecoveryState =
  | { state: 'idle' }
  | { state: 'posting'; digest: string }
  | { state: 'outcome_uncertain'; digest: string }
  | { state: 'reconciling'; digest: string }
  | { state: 'approved_orphan'; digest: string; approvalId: string; approvalStatus: 'pending' | 'approved' }
  | {
      state: 'attestation_validation_pending';
      digest: string;
      attestationId: string;
      approvalId: string;
    }
  | { state: 'reconciled_success'; digest: string }
  | { state: 'reconciled_absence'; digest: string }
  | { state: 'refused'; digest: string; message: string };

function pendingKey(goalId: string, handoffId: string) {
  return `${PENDING_PREFIX}${goalId}:${handoffId}`;
}

function readPendingDigest(goalId: string, handoffId: string): string | null {
  const key = pendingKey(goalId, handoffId);
  try {
    const value = window.sessionStorage.getItem(key);
    if (value && HASH.test(value)) return value;
    if (volatilePendingKeys.has(key)) return volatilePendingDigests.get(key) ?? null;
    volatilePendingDigests.delete(key);
    volatilePendingKeys.delete(key);
    return null;
  } catch {
    return volatilePendingDigests.get(key) ?? null;
  }
}

function savePendingDigest(goalId: string, handoffId: string, digest: string | null) {
  const key = pendingKey(goalId, handoffId);
  if (digest) {
    try {
      window.sessionStorage.setItem(key, digest);
      volatilePendingDigests.delete(key);
      volatilePendingKeys.delete(key);
    } catch {
      volatilePendingDigests.set(key, digest);
      volatilePendingKeys.add(key);
    }
    return;
  }
  volatilePendingDigests.delete(key);
  volatilePendingKeys.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // SQLite remains the durable recovery authority if browser storage is unavailable.
  }
}

function recoveryDigest(state: RecoveryState): string | null {
  switch (state.state) {
    case 'outcome_uncertain':
    case 'reconciling':
    case 'posting':
    case 'approved_orphan':
    case 'attestation_validation_pending':
      return state.digest;
    case 'idle':
    case 'reconciled_success':
    case 'reconciled_absence':
    case 'refused':
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredStatusFor(
  value: unknown,
  goalId: string,
  handoffId: string,
): value is GoalExternalIntegrationStoredStatus {
  if (
    !isRecord(value) ||
    value.goalId !== goalId ||
    value.handoffId !== handoffId ||
    typeof value.hasAttestation !== 'boolean' ||
    typeof value.limit !== 'number' ||
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    !Array.isArray(value.attestations) ||
    !Array.isArray(value.approvals) ||
    typeof value.attestationsHaveMore !== 'boolean' ||
    typeof value.approvalsHaveMore !== 'boolean'
  )
    return false;
  return (
    value.attestations.every(
      (row) =>
        isRecord(row) &&
        typeof row.attestationId === 'string' &&
        typeof row.approvalId === 'string' &&
        typeof row.actionDigest === 'string' &&
        HASH.test(row.actionDigest) &&
        typeof row.recordDigest === 'string' &&
        HASH.test(row.recordDigest) &&
        typeof row.observedAt === 'string' &&
        typeof row.decidedAt === 'string',
    ) &&
    value.approvals.every(
      (row) =>
        isRecord(row) &&
        typeof row.approvalId === 'string' &&
        typeof row.actionDigest === 'string' &&
        HASH.test(row.actionDigest) &&
        (row.status === 'pending' || row.status === 'approved' || row.status === 'denied') &&
        (row.decidedBy === null || row.decidedBy === 'user') &&
        typeof row.createdAt === 'string' &&
        (row.respondedAt === null || typeof row.respondedAt === 'string') &&
        (row.attestationId === null || typeof row.attestationId === 'string'),
    )
  );
}

function isAttestationProjectionFor(
  value: unknown,
  goalId: string,
  handoffId: string,
  attestationId: string,
): value is GoalExternalIntegrationAttestationProjection {
  if (!isRecord(value)) return false;
  const states = ['current', 'historical', 'not_integrated', 'stale', 'unavailable', 'invalid'];
  if (!states.includes(String(value.state))) return false;
  if (value.record === null) return value.state !== 'current' && value.state !== 'historical';
  if (!isRecord(value.record)) return false;
  const record = value.record;
  return (
    value.state !== undefined &&
    record.kind === 'turing_goal_external_integration_attestation' &&
    record.goalId === goalId &&
    record.attestationId === attestationId &&
    record.actionDigest !== undefined &&
    typeof record.actionDigest === 'string' &&
    HASH.test(record.actionDigest) &&
    typeof record.approvalId === 'string' &&
    record.approvalId.length > 0 &&
    isRecord(record.handoff) &&
    record.handoff.id === handoffId &&
    typeof record.handoff.digest === 'string' &&
    HASH.test(record.handoff.digest) &&
    typeof record.recordDigest === 'string' &&
    HASH.test(record.recordDigest) &&
    isRecord(record.decision) &&
    record.decision.value === 'confirm_external_integration' &&
    record.decision.decidedBy === 'user' &&
    typeof record.decision.decidedAt === 'string'
  );
}

function matchingAttestation(status: GoalExternalIntegrationStoredStatus, digest: string) {
  return status.attestations.find((row) => row.actionDigest === digest) ?? null;
}

function matchingApproval(status: GoalExternalIntegrationStoredStatus, digest: string) {
  return status.approvals.find((row) => row.actionDigest === digest) ?? null;
}

function verificationLabel(verification: GoalExternalIntegrationVerification): string {
  switch (verification.state) {
    case 'verified':
      return 'Source history verified at this observation';
    case 'not_integrated':
      return 'The recorded source is not present in the destination history';
    case 'stale':
      return 'The handoff or reviewed Git identity has changed';
    case 'unavailable':
      return 'Current Git evidence cannot be verified';
    case 'invalid':
      return 'The stored handoff or Git evidence is invalid';
  }
}

function attestationLabel(projection: GoalExternalIntegrationAttestationProjection): string {
  switch (projection.state) {
    case 'current':
      return 'User confirmed — source history observed';
    case 'historical':
      return 'Previously confirmed — destination has advanced';
    case 'not_integrated':
      return 'The attested source is no longer in destination history';
    case 'stale':
      return 'The attested handoff or authority is stale';
    case 'unavailable':
      return 'The saved attestation cannot be checked right now';
    case 'invalid':
      return 'The saved attestation failed integrity validation';
  }
}

function exactGitIdentityText(observation: GoalExternalIntegrationObservation): string {
  return [
    `Repository project: ${observation.repository.projectId}`,
    `Repository identity: ${observation.repository.identity}`,
    `Project scope: ${observation.repository.scope || '(repository root)'}`,
    `Object format: ${observation.repository.objectFormat}`,
    `Source ref: ${observation.source.ref}`,
    `Source commit: ${observation.source.commit}`,
    `Source tree: ${observation.source.tree}`,
    `Destination ref: ${observation.destination.ref}`,
    `Recorded base commit: ${observation.destination.expectedBaseCommit}`,
    `Recorded base tree: ${observation.destination.expectedBaseTree}`,
    `Observed destination commit: ${observation.destination.observedCommit}`,
    `Observed destination tree: ${observation.destination.observedTree}`,
    `Action digest: ${observation.actionDigest}`,
  ].join('\n');
}

export function GoalExternalIntegration({
  goalId,
  goalTitle,
  handoff,
  refresh = 0,
}: {
  goalId: string;
  goalTitle: string;
  handoff: GoalManualIntegrationHandoff;
  refresh?: number | string;
}) {
  const [recovery, setRecovery] = useState<RecoveryState>(() => {
    const digest = readPendingDigest(goalId, handoff.handoffId);
    return digest ? { state: 'outcome_uncertain', digest } : { state: 'idle' };
  });
  const [verification, setVerification] = useState<GoalExternalIntegrationVerification | null>(null);
  const [checking, setChecking] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const [reviewedConfirmation, setReviewedConfirmation] = useState<GoalExternalIntegrationObservation | null>(
    null,
  );
  const [selectedAttestationId, setSelectedAttestationId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [refusal, setRefusal] = useState('');
  const [identityCopied, setIdentityCopied] = useState(false);
  const [identityCopyFallback, setIdentityCopyFallback] = useState(false);
  const requestSequence = useRef(0);
  const submitInFlight = useRef(false);
  const reconciliationInFlight = useRef(false);
  const reconciliationSequence = useRef(0);
  const mounted = useRef(false);
  const verifiedOnce = useRef(false);
  const previousRefresh = useRef(refresh);
  const verificationRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const reconciledDigest = useRef<string | null>(null);
  const reconciliationBaseline = useRef<{
    digest: string;
    status: GoalExternalIntegrationStoredStatus | null;
  } | null>(null);
  const pendingDigest = recoveryDigest(recovery);
  const recoveryStateRef = useRef(recovery);
  const recoveryDigestRef = useRef(pendingDigest);
  const submitting = recovery.state === 'posting';
  const stored = useLoad(
    async () => {
      const status: unknown = await goalsApi.externalIntegrationStatus(goalId, handoff.handoffId);
      if (!isStoredStatusFor(status, goalId, handoff.handoffId))
        throw new Error('Saved external-integration status did not match this Goal and handoff.');
      return status;
    },
    `${goalId}:${handoff.handoffId}:external-integration-status`,
    refresh,
  );
  const attestation = useLoad<GoalExternalIntegrationAttestationProjection | null>(
    () =>
      selectedAttestationId
        ? goalsApi
            .externalIntegrationProjection(goalId, handoff.handoffId, selectedAttestationId)
            .then((projection) => {
              if (!isAttestationProjectionFor(projection, goalId, handoff.handoffId, selectedAttestationId))
                throw new Error('Saved attestation response did not match this Goal, handoff and record.');
              return projection;
            })
        : Promise.resolve(null),
    `${goalId}:${handoff.handoffId}:${selectedAttestationId ?? 'no-attestation'}`,
    refresh,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, []);

  const transitionRecovery = useCallback(
    (next: RecoveryState) => {
      recoveryStateRef.current = next;
      recoveryDigestRef.current = recoveryDigest(next);
      setRecovery(next);
      savePendingDigest(goalId, handoff.handoffId, recoveryDigest(next));
      if (recoveryDigest(next) === null) {
        reconciliationBaseline.current = null;
        reconciledDigest.current = null;
      }
    },
    [goalId, handoff.handoffId],
  );

  useEffect(() => {
    if (stored.result.state !== 'ready') return;
    const status: unknown = stored.result.data;
    if (!isStoredStatusFor(status, goalId, handoff.handoffId)) {
      if (pendingDigest)
        setRecoveryMessage(
          'Saved recovery status was malformed or belonged to another handoff. The lock remains.',
        );
      return;
    }
    if (selectedAttestationId === null && status.attestations[0])
      setSelectedAttestationId(status.attestations[0].attestationId);
    if (!pendingDigest || reconciledDigest.current === pendingDigest) return;
    const baseline = reconciliationBaseline.current;
    if (baseline?.digest === pendingDigest && baseline.status === status) return;
    const record = matchingAttestation(status, pendingDigest);
    if (record) {
      reconciledDigest.current = pendingDigest;
      transitionRecovery({
        state: 'attestation_validation_pending',
        digest: pendingDigest,
        attestationId: record.attestationId,
        approvalId: record.approvalId,
      });
      setSelectedAttestationId(record.attestationId);
      setRecoveryMessage(
        'The saved status contains the exact attestation. Its integrity and currentness are being revalidated.',
      );
      setAnnouncement('The previous request may have been recorded. Validating the saved attestation now.');
      return;
    }
    const approval = matchingApproval(status, pendingDigest);
    if (approval) {
      reconciledDigest.current = pendingDigest;
      if (approval.attestationId) {
        transitionRecovery({
          state: 'attestation_validation_pending',
          digest: pendingDigest,
          attestationId: approval.attestationId,
          approvalId: approval.approvalId,
        });
        setSelectedAttestationId(approval.attestationId);
        setRecoveryMessage(
          'The exact approval links to an attestation. Its integrity and currentness are being revalidated.',
        );
        setAnnouncement('A matching attestation was found. Validating its saved evidence now.');
        return;
      }
      if (approval.status === 'denied') {
        const message = 'The exact action was denied. This digest cannot be confirmed again.';
        transitionRecovery({ state: 'refused', digest: pendingDigest, message });
        setRefusal(message);
        setAnnouncement('The exact action was denied. No attestation was recorded.');
        return;
      }
      transitionRecovery({
        state: 'approved_orphan',
        digest: pendingDigest,
        approvalId: approval.approvalId,
        approvalStatus: approval.status,
      });
      setRecoveryMessage(
        'A matching user approval exists, but no attestation is stored. Review the same observation and explicitly confirm again to finish recording it.',
      );
      setAnnouncement('Saved approval status was found. No Git action was performed.');
      return;
    }
    if (status.attestationsHaveMore || status.approvalsHaveMore) {
      transitionRecovery({ state: 'outcome_uncertain', digest: pendingDigest });
      setRecoveryMessage(
        'The saved history is truncated and may omit this exact action. The uncertainty lock remains until the exact status can be established.',
      );
      return;
    }
    setRecoveryMessage(
      'This saved-status refresh found no matching action. The outcome remains locked until an explicit complete reconciliation establishes absence.',
    );
  }, [
    goalId,
    handoff.handoffId,
    pendingDigest,
    recovery.state,
    selectedAttestationId,
    stored.result,
    transitionRecovery,
  ]);

  useEffect(() => {
    if (!pendingDigest || !selectedAttestationId || attestation.result.state !== 'ready') return;
    const projection = attestation.result.data;
    const record = projection?.record;
    if (
      !record ||
      record.goalId !== goalId ||
      record.handoff.id !== handoff.handoffId ||
      record.attestationId !== selectedAttestationId ||
      record.actionDigest !== pendingDigest
    ) {
      setRecoveryMessage(
        'The saved projection did not prove the pending Goal, handoff and action identity. The lock remains.',
      );
      return;
    }
    if (
      recovery.state === 'attestation_validation_pending' &&
      recovery.digest === pendingDigest &&
      (record.attestationId !== recovery.attestationId || record.approvalId !== recovery.approvalId)
    ) {
      setRecoveryMessage(
        'The saved projection did not match the exact pending attestation and approval. The lock remains.',
      );
      return;
    }
    if (projection.state === 'current' || projection.state === 'historical') {
      reconciledDigest.current = pendingDigest;
      transitionRecovery({ state: 'reconciled_success', digest: pendingDigest });
      setRecoveryMessage('The exact immutable attestation was validated from saved server evidence.');
      setAnnouncement('The original confirmation was recorded and its attestation is valid.');
      return;
    }
    setRecoveryMessage(
      `The exact attestation exists, but its validation state is ${projection.state}. The uncertainty lock remains.`,
    );
  }, [
    attestation.result,
    goalId,
    handoff.handoffId,
    pendingDigest,
    recovery.state,
    selectedAttestationId,
    transitionRecovery,
  ]);

  const refreshVerification = async () => {
    verifiedOnce.current = true;
    const sequence = ++requestSequence.current;
    setVerification(null);
    setChecking(true);
    setVerificationError('');
    setRefusal('');
    setAnnouncement('Checking current Git history. This is read-only.');
    try {
      const result = await goalsApi.verifyExternalIntegration(goalId, handoff.handoffId);
      if (!mounted.current || sequence !== requestSequence.current) return;
      if (
        result.state === 'verified' &&
        (result.observation.goalId !== goalId || result.observation.handoff.id !== handoff.handoffId)
      ) {
        setVerificationError('The response did not match the selected Goal and handoff.');
        setAnnouncement('The Git observation could not be matched to the selected handoff.');
        return;
      }
      setVerification(result);
      setAnnouncement(verificationLabel(result));
    } catch (error) {
      if (!mounted.current || sequence !== requestSequence.current) return;
      setVerificationError(error instanceof Error ? error.message : 'Git verification could not be loaded.');
      setAnnouncement('Git verification could not be loaded. No confirmation was sent.');
    } finally {
      if (mounted.current && sequence === requestSequence.current) setChecking(false);
    }
  };
  verificationRefreshRef.current = refreshVerification;

  useEffect(() => {
    if (Object.is(previousRefresh.current, refresh)) return;
    previousRefresh.current = refresh;
    if (verifiedOnce.current) void verificationRefreshRef.current();
  }, [refresh]);

  const reconcile = async (digest: string) => {
    if (!mounted.current || recoveryDigestRef.current !== digest || reconciliationInFlight.current) return;
    reconciliationInFlight.current = true;
    const sequence = ++reconciliationSequence.current;
    const isLatest = () => mounted.current && sequence === reconciliationSequence.current;
    transitionRecovery({ state: 'reconciling', digest });
    setRecoveryMessage('Checking saved approval and attestation records for this exact action digest…');
    try {
      const response: unknown = await goalsApi.externalIntegrationStatus(goalId, handoff.handoffId);
      if (!isLatest()) return;
      if (!isStoredStatusFor(response, goalId, handoff.handoffId))
        throw new Error('Saved recovery status was malformed or belonged to another handoff.');
      const status = response;
      stored.reload();
      const record = matchingAttestation(status, digest);
      if (record) {
        reconciledDigest.current = digest;
        transitionRecovery({
          state: 'attestation_validation_pending',
          digest,
          attestationId: record.attestationId,
          approvalId: record.approvalId,
        });
        setSelectedAttestationId(record.attestationId);
        setRecoveryMessage(
          'The exact attestation exists. Its integrity and currentness are being revalidated.',
        );
        setAnnouncement('A matching attestation was found. Validating its saved evidence now.');
        return;
      }
      const approval = matchingApproval(status, digest);
      if (approval) {
        if (approval.attestationId) {
          reconciledDigest.current = digest;
          transitionRecovery({
            state: 'attestation_validation_pending',
            digest,
            attestationId: approval.attestationId,
            approvalId: approval.approvalId,
          });
          setSelectedAttestationId(approval.attestationId);
          setRecoveryMessage(
            'The exact approval links to an attestation. Its integrity and currentness are being revalidated.',
          );
          setAnnouncement('A matching attestation was found. Validating its saved evidence now.');
          return;
        }
        if (approval.status === 'denied') {
          const message = 'The exact user approval was denied. The same action digest cannot be used again.';
          transitionRecovery({ state: 'refused', digest, message });
          setRecoveryMessage(message);
          setRefusal(message);
          setAnnouncement('The exact action was denied. No attestation was recorded.');
          return;
        }
        transitionRecovery({
          state: 'approved_orphan',
          digest,
          approvalId: approval.approvalId,
          approvalStatus: approval.status,
        });
        setRecoveryMessage(
          'A matching approval exists without an attestation. The result is not recorded as externally integrated. Review the same verified action and explicitly confirm to finish recording.',
        );
        setAnnouncement(
          'An approval was found without a saved attestation. A separate confirmation is required.',
        );
        return;
      }
      if (status.attestationsHaveMore || status.approvalsHaveMore) {
        transitionRecovery({ state: 'outcome_uncertain', digest });
        setRecoveryMessage(
          'The saved history is truncated and may omit this exact action. The uncertainty lock remains until the exact status can be established.',
        );
        setAnnouncement('Recovery is incomplete because the bounded history does not include every record.');
        return;
      }
      transitionRecovery({ state: 'reconciled_absence', digest });
      setVerification(null);
      setVerificationError('');
      setRecoveryMessage(
        'No matching approval or attestation is stored as of this complete status read. Run a fresh Git verification before any new confirmation.',
      );
      setAnnouncement(
        'Recovery status is reconciled. No new approval or POST was created. A fresh Git check is required.',
      );
    } catch {
      if (isLatest()) transitionRecovery({ state: 'outcome_uncertain', digest });
      setRecoveryMessage(
        'Saved status could not be read. The action remains locked until a complete reconciliation succeeds.',
      );
      setAnnouncement('Recovery remains incomplete. No automatic retry was sent.');
    } finally {
      if (sequence === reconciliationSequence.current) reconciliationInFlight.current = false;
    }
  };

  const confirm = async () => {
    const reviewed = reviewedConfirmation;
    if (
      !reviewed ||
      reviewed.goalId !== goalId ||
      reviewed.handoff.id !== handoff.handoffId ||
      submitInFlight.current
    )
      return;
    const currentRecovery = recoveryStateRef.current;
    const reviewedApproval =
      stored.result.state === 'ready' && isStoredStatusFor(stored.result.data, goalId, handoff.handoffId)
        ? matchingApproval(stored.result.data, reviewed.actionDigest)
        : null;
    const exactOrphanApproval =
      currentRecovery.state === 'approved_orphan' &&
      currentRecovery.digest === reviewed.actionDigest &&
      reviewedApproval?.approvalId === currentRecovery.approvalId &&
      (reviewedApproval.status === 'pending' || reviewedApproval.status === 'approved') &&
      reviewedApproval.attestationId === null;
    if (recoveryDigestRef.current !== null && !exactOrphanApproval) return;
    reconciliationBaseline.current = {
      digest: reviewed.actionDigest,
      status: stored.result.state === 'ready' ? stored.result.data : null,
    };
    submitInFlight.current = true;
    transitionRecovery({ state: 'posting', digest: reviewed.actionDigest });
    setRefusal('');
    setAnnouncement(
      'Recording the exact reviewed user confirmation. Turing will not run Git or complete the Goal.',
    );
    try {
      const result = await goalsApi.confirmExternalIntegration(
        goalId,
        handoff.handoffId,
        reviewed.actionDigest,
      );
      if (!mounted.current) return;
      if (
        result.actionDigest !== reviewed.actionDigest ||
        typeof result.attestationId !== 'string' ||
        result.attestationId.length === 0 ||
        typeof result.approvalId !== 'string' ||
        result.approvalId.length === 0
      )
        throw new Error('The saved response did not match the reviewed action digest.');
      reconciledDigest.current = reviewed.actionDigest;
      transitionRecovery({
        state: 'attestation_validation_pending',
        digest: reviewed.actionDigest,
        attestationId: result.attestationId,
        approvalId: result.approvalId,
      });
      setSelectedAttestationId(result.attestationId);
      setRecoveryMessage('');
      stored.reload();
      setReviewedConfirmation(null);
      setAnnouncement(
        result.reusedAttestation
          ? 'The identical immutable attestation already existed and was reused. The Goal remains incomplete.'
          : 'Your confirmation was recorded. Git history was observed; Git was not changed and the Goal remains incomplete.',
      );
    } catch (error) {
      if (!mounted.current) return;
      setReviewedConfirmation(null);
      if (error instanceof ApiError && error.status === 412) {
        const message =
          'The Git or Goal evidence changed since review. Nothing was approved for the new evidence. Review a fresh observation before confirming again.';
        transitionRecovery({ state: 'refused', digest: reviewed.actionDigest, message });
        reconciledDigest.current = null;
        setAnnouncement('Reviewed evidence changed. Refreshing the read-only observation.');
        await refreshVerification();
        if (mounted.current) {
          setRefusal(message);
          setAnnouncement(
            'The reviewed evidence changed. A fresh read-only observation is shown; confirm it separately if it is correct.',
          );
        }
      } else {
        transitionRecovery({ state: 'outcome_uncertain', digest: reviewed.actionDigest });
        setRecoveryMessage(
          'The request outcome is unknown. Further confirmation is locked until saved status is reconciled.',
        );
        setAnnouncement(
          'The response was not conclusive. Checking exact saved status; no POST will be retried automatically.',
        );
        await reconcile(reviewed.actionDigest);
      }
    } finally {
      submitInFlight.current = false;
    }
  };

  const verificationIsCurrent =
    verification?.state === 'verified' &&
    verification.observation.goalId === goalId &&
    verification.observation.handoff.id === handoff.handoffId;
  const selectedApproval =
    verificationIsCurrent && stored.result.state === 'ready'
      ? matchingApproval(stored.result.data, verification.observation.actionDigest)
      : null;
  const selectedRecord =
    verificationIsCurrent && stored.result.state === 'ready'
      ? matchingAttestation(stored.result.data, verification.observation.actionDigest)
      : null;
  const deniedExactAction = selectedApproval?.status === 'denied';
  const exactOrphanApproval =
    recovery.state === 'approved_orphan' &&
    verificationIsCurrent &&
    recovery.digest === verification.observation.actionDigest &&
    selectedApproval?.approvalId === recovery.approvalId &&
    selectedApproval.attestationId === null &&
    selectedApproval.status !== 'denied';
  const canConfirm = Boolean(
    verificationIsCurrent && !deniedExactAction && (pendingDigest === null || exactOrphanApproval),
  );
  const currentProjection = attestation.result.state === 'ready' ? attestation.result.data : null;
  const projectionMatchesSelected =
    currentProjection === null ||
    currentProjection.record === null ||
    isAttestationProjectionFor(currentProjection, goalId, handoff.handoffId, selectedAttestationId ?? '');
  const copiedIdentityText = verificationIsCurrent ? exactGitIdentityText(verification.observation) : '';
  const copyGitIdentities = async () => {
    if (!verificationIsCurrent) return;
    setIdentityCopied(false);
    setIdentityCopyFallback(false);
    const clipboard = typeof window === 'undefined' ? undefined : window.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setIdentityCopyFallback(true);
      return;
    }
    try {
      await clipboard.writeText(copiedIdentityText);
      setIdentityCopied(true);
    } catch {
      setIdentityCopyFallback(true);
    }
  };

  return (
    <section
      className="surface-panel goal-external-integration"
      aria-label="External integration"
      aria-busy={submitting || checking}
    >
      <h3>External integration</h3>
      <p>
        Turing can inspect repository history after you integrate the handoff. It will not merge, change refs,
        check out branches, modify files, or complete this Goal.
      </p>
      <p className="goal-row-meta">
        Ordinary handoff currentness checks the destination at preparation time and may become stale after
        your integration. This separate read-only verifier rechecks the original handoff authority and current
        Git ancestry; only a fresh verified result can offer confirmation.
      </p>
      <div className="goal-handoff-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void refreshVerification()}
          disabled={submitting || checking}
        >
          {checking ? 'Checking Git history…' : 'Verify external integration'}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            stored.reload();
            if (selectedAttestationId) attestation.reload();
          }}
          disabled={submitting || checking}
        >
          Refresh saved status
        </button>
      </div>

      {stored.result.state === 'loading' && <p role="status">Loading saved integration records…</p>}
      {stored.result.state === 'error' && (
        <p className="form-error" role="alert">
          Saved integration status could not be loaded. {stored.result.message}
        </p>
      )}
      {stored.result.state === 'ready' &&
        stored.result.data.goalId === goalId &&
        stored.result.data.handoffId === handoff.handoffId && (
          <>
            {!stored.result.data.hasAttestation && (
              <p>No external-integration attestation is stored for this handoff.</p>
            )}
            {stored.result.data.attestationsHaveMore && (
              <p className="goal-row-meta">
                Only the latest {stored.result.data.limit} attestation records are shown.
              </p>
            )}
            {stored.result.data.approvalsHaveMore && (
              <p className="goal-row-meta">
                Only the latest {stored.result.data.limit} matching approval records are shown.
              </p>
            )}
            {stored.result.data.attestations.length > 0 && (
              <div>
                <h4>Attestation history</h4>
                <ul className="goal-plain-list goal-external-history">
                  {stored.result.data.attestations.map((row) => (
                    <li key={row.attestationId}>
                      <button
                        type="button"
                        className="goal-version"
                        aria-pressed={selectedAttestationId === row.attestationId}
                        onClick={() => setSelectedAttestationId(row.attestationId)}
                      >
                        <span>{formatTime(row.decidedAt)}</span>
                        <code>
                          {shortHash(row.actionDigest)} · {shortHash(row.recordDigest)}
                        </code>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {stored.result.data.approvals.some((row) => row.attestationId === null) && (
              <div className="goal-external-recovery" role="status">
                <h4>Approval without an attestation</h4>
                <p>
                  {stored.result.data.approvals.find((row) => row.attestationId === null)?.status === 'denied'
                    ? 'A matching user approval was denied. The same evidence cannot be confirmed again.'
                    : 'A matching approval exists, but no immutable attestation was saved. This is not proof of external integration.'}
                </p>
              </div>
            )}
          </>
        )}

      {verification === null && !verificationError && (
        <p className="goal-row-meta">
          Request a fresh read-only check after you integrate the source commit.
        </p>
      )}
      {verificationError && (
        <p className="form-error" role="alert">
          Verification could not be loaded. {verificationError}
        </p>
      )}
      {verification && (
        <>
          <h4>{verificationLabel(verification)}</h4>
          {verification.reason && (
            <p className="goal-handoff-reason">
              {verification.reason.message} ({verification.reason.code})
            </p>
          )}
          {verification.state === 'verified' && (
            <>
              <dl className="goal-handoff-identities">
                <div className="goal-handoff-identity">
                  <dt>Goal</dt>
                  <dd>
                    {goalTitle} · <code>{goalId}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Handoff</dt>
                  <dd>
                    <code>{verification.observation.handoff.id}</code> · digest{' '}
                    <code>{verification.observation.handoff.digest}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Repository project</dt>
                  <dd>
                    <code>{verification.observation.repository.projectId}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Repository identity</dt>
                  <dd>
                    <code>{verification.observation.repository.identity}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Repository scope</dt>
                  <dd>
                    <code>{verification.observation.repository.scope}</code> ·{' '}
                    {verification.observation.repository.objectFormat}
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Source ref</dt>
                  <dd>
                    <code>{verification.observation.source.ref}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Source commit</dt>
                  <dd>
                    <code>{verification.observation.source.commit}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Source tree</dt>
                  <dd>
                    <code>{verification.observation.source.tree}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Destination ref</dt>
                  <dd>
                    <code>{verification.observation.destination.ref}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Recorded base commit</dt>
                  <dd>
                    <code>{verification.observation.destination.expectedBaseCommit}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Recorded base tree</dt>
                  <dd>
                    <code>{verification.observation.destination.expectedBaseTree}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Observed destination commit</dt>
                  <dd>
                    <code>{verification.observation.destination.observedCommit}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Observed destination tree</dt>
                  <dd>
                    <code>{verification.observation.destination.observedTree}</code>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Source history</dt>
                  <dd>
                    Source commit is an ancestor of the destination: <strong>yes</strong>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Recorded base history</dt>
                  <dd>
                    Recorded base commit is an ancestor of the destination: <strong>yes</strong>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Observed at</dt>
                  <dd>
                    <time dateTime={verification.observation.observedAt}>
                      {formatTime(verification.observation.observedAt)}
                    </time>
                  </dd>
                </div>
                <div className="goal-handoff-identity">
                  <dt>Reviewed action digest</dt>
                  <dd>
                    <code>{verification.observation.actionDigest}</code>
                  </dd>
                </div>
              </dl>
              <aside className="goal-handoff-warning" aria-label="Important proof limitation">
                <strong>
                  Git confirms that the accepted source commit is part of the destination&apos;s history.
                </strong>{' '}
                This does not prove that every accepted file change survived merge resolution or later
                commits.
              </aside>
              <button type="button" className="secondary-button" onClick={() => void copyGitIdentities()}>
                Copy exact Git identities
              </button>
              {identityCopied && <p role="status">Exact Git identities copied.</p>}
              {identityCopyFallback && (
                <label className="goal-handoff-fallback">
                  Clipboard access is unavailable. Select and copy the exact identities manually.
                  <textarea
                    readOnly
                    rows={8}
                    value={copiedIdentityText}
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label="Selectable exact Git identities"
                  />
                </label>
              )}
              {selectedApproval && !selectedRecord && (
                <p className="goal-external-recovery" role="status">
                  A {selectedApproval.status} high-risk user approval exists for this exact digest, but no
                  attestation is stored. A deliberate confirmation can resume recording it.
                </p>
              )}
              {deniedExactAction && (
                <p className="form-error" role="alert">
                  This exact action was denied and cannot be confirmed again.
                </p>
              )}
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  if (canConfirm && verificationIsCurrent) setReviewedConfirmation(verification.observation);
                }}
                disabled={!canConfirm || submitting || selectedRecord !== null}
              >
                {deniedExactAction
                  ? 'This action was denied'
                  : selectedApproval && !selectedRecord && (pendingDigest === null || exactOrphanApproval)
                    ? 'Resume attestation recording'
                    : 'Confirm external integration'}
              </button>
            </>
          )}
        </>
      )}

      {pendingDigest && (
        <section className="goal-external-recovery" aria-label="Confirmation recovery">
          <h4>Confirmation recovery</h4>
          <p>
            {recoveryMessage ||
              'The previous request outcome is unknown. Confirmation remains locked until saved status is reconciled.'}
          </p>
          <p>
            Action digest: <code>{pendingDigest}</code>
          </p>
          {stored.result.state === 'error' && (
            <p>Refresh cannot clear this lock while saved status is unavailable.</p>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => void reconcile(pendingDigest)}
            disabled={submitting || checking || recovery.state === 'reconciling'}
          >
            {recovery.state === 'reconciling'
              ? 'Reconciling saved action…'
              : 'Reconcile pending confirmation'}
          </button>
        </section>
      )}
      {refusal && (
        <p className="form-error" role="alert">
          {refusal}
        </p>
      )}
      {recoveryMessage && !pendingDigest && (
        <p className="goal-row-meta" role="status">
          {recoveryMessage}
        </p>
      )}
      {announcement && (
        <p aria-live="polite" role="status">
          {announcement}
        </p>
      )}

      {selectedAttestationId && (
        <section
          className="goal-external-projection"
          aria-label="Saved attestation validation"
          aria-busy={attestation.result.state === 'loading'}
        >
          <h4>Saved attestation</h4>
          {attestation.result.state === 'loading' && (
            <p role="status">Revalidating the selected immutable attestation…</p>
          )}
          {attestation.result.state === 'error' && (
            <p className="form-error" role="alert">
              Saved attestation currentness could not be checked. {attestation.result.message}
            </p>
          )}
          {attestation.result.state === 'ready' && currentProjection && projectionMatchesSelected && (
            <>
              <p className={`goal-external-state goal-external-${currentProjection.state}`}>
                {attestationLabel(currentProjection)}
              </p>
              {currentProjection.reason && (
                <p className="goal-handoff-reason">
                  {currentProjection.reason.message} ({currentProjection.reason.code})
                </p>
              )}
              {currentProjection.record && (
                <dl className="goal-handoff-identities">
                  <div className="goal-handoff-identity">
                    <dt>Attestation ID</dt>
                    <dd>
                      <code>{currentProjection.record.attestationId}</code>
                    </dd>
                  </div>
                  <div className="goal-handoff-identity">
                    <dt>Approval ID</dt>
                    <dd>
                      <code>{currentProjection.record.approvalId}</code>
                    </dd>
                  </div>
                  <div className="goal-handoff-identity">
                    <dt>Action digest</dt>
                    <dd>
                      <code>{currentProjection.record.actionDigest}</code>
                    </dd>
                  </div>
                  <div className="goal-handoff-identity">
                    <dt>Record digest</dt>
                    <dd>
                      <code>{currentProjection.record.recordDigest}</code>
                    </dd>
                  </div>
                  <div className="goal-handoff-identity">
                    <dt>User decision time</dt>
                    <dd>
                      <time dateTime={currentProjection.record.decision.decidedAt}>
                        {formatTime(currentProjection.record.decision.decidedAt)}
                      </time>
                    </dd>
                  </div>
                </dl>
              )}
              <p className="goal-row-meta">
                This record observes source history only. It does not prove unchanged content and does not
                complete the Goal.
              </p>
            </>
          )}
          {attestation.result.state === 'ready' && !projectionMatchesSelected && (
            <p className="form-error" role="alert">
              The response did not match this Goal, handoff and selected attestation.
            </p>
          )}
        </section>
      )}

      {selectedAttestationId &&
        pendingDigest === null &&
        currentProjection?.state === 'current' &&
        projectionMatchesSelected && (
          <GoalCompletion
            key={`${goalId}:${selectedAttestationId}`}
            goalId={goalId}
            attestationId={selectedAttestationId}
            refresh={refresh}
          />
        )}

      {reviewedConfirmation && (
        <ConfirmPanel
          label="Confirm external integration"
          title="Confirm your manual integration?"
          description={`I confirm that I manually integrated this handoff into the recorded destination branch. Git ancestry is verified, not that every accepted content change remains unchanged. Turing will record my confirmation but will not execute Git operations or complete the Goal. This is a high-risk user decision for ${goalTitle}.`}
          busy={submitting}
          onCancel={() => setReviewedConfirmation(null)}
        >
          <dl className="goal-handoff-identities">
            <div className="goal-handoff-identity">
              <dt>Goal</dt>
              <dd>
                {goalTitle} · <code>{goalId}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Handoff</dt>
              <dd>
                <code>{reviewedConfirmation.handoff.id}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Source commit</dt>
              <dd>
                <code>{reviewedConfirmation.source.commit}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Destination ref</dt>
              <dd>
                <code>{reviewedConfirmation.destination.ref}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Observed destination commit</dt>
              <dd>
                <code>{reviewedConfirmation.destination.observedCommit}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Repository project</dt>
              <dd>
                <code>{reviewedConfirmation.repository.projectId}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Repository identity</dt>
              <dd>
                <code>{reviewedConfirmation.repository.identity}</code>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Observed at</dt>
              <dd>
                <time dateTime={reviewedConfirmation.observedAt}>
                  {formatTime(reviewedConfirmation.observedAt)}
                </time>
              </dd>
            </div>
            <div className="goal-handoff-identity">
              <dt>Action digest</dt>
              <dd>
                <code>{reviewedConfirmation.actionDigest}</code>
              </dd>
            </div>
          </dl>
          <p className="goal-handoff-warning">
            Git confirms source ancestry only. It does not prove every accepted file change survived
            integration. Turing will not perform Git operations or mark this Goal complete.
          </p>
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              data-confirm-safe
              disabled={submitting}
              onClick={() => setReviewedConfirmation(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              data-confirm-restore-trigger
              disabled={submitting}
              onClick={() => void confirm()}
            >
              {submitting ? 'Recording confirmation…' : 'Confirm external integration'}
            </button>
          </div>
        </ConfirmPanel>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import type {
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationObservation,
  GoalExternalIntegrationStoredStatus,
  GoalExternalIntegrationVerification,
  GoalManualIntegrationHandoff,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import { ConfirmPanel } from './DefinitionParts';
import { goalsApi } from './api';
import { formatTime, shortHash } from './presentation';
import { useLoad } from './useLoad';

const PENDING_PREFIX = 'turing.goalExternalIntegration.v1:';
const HASH = /^[0-9a-f]{64}$/;

function pendingKey(goalId: string, handoffId: string) {
  return `${PENDING_PREFIX}${goalId}:${handoffId}`;
}

function readPendingDigest(goalId: string, handoffId: string): string | null {
  try {
    const value = window.sessionStorage.getItem(pendingKey(goalId, handoffId));
    return value && HASH.test(value) ? value : null;
  } catch {
    return null;
  }
}

function savePendingDigest(goalId: string, handoffId: string, digest: string | null) {
  try {
    if (digest) window.sessionStorage.setItem(pendingKey(goalId, handoffId), digest);
    else window.sessionStorage.removeItem(pendingKey(goalId, handoffId));
  } catch {
    // Session storage only protects the current UI session; SQLite remains the durable recovery authority.
  }
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
  handoffCurrent,
  refresh = 0,
}: {
  goalId: string;
  goalTitle: string;
  handoff: GoalManualIntegrationHandoff;
  handoffCurrent: boolean;
  refresh?: number | string;
}) {
  const [pendingDigest, setPendingDigest] = useState(() => readPendingDigest(goalId, handoff.handoffId));
  const [verification, setVerification] = useState<GoalExternalIntegrationVerification | null>(null);
  const [checking, setChecking] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const [reviewedConfirmation, setReviewedConfirmation] = useState<GoalExternalIntegrationObservation | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [selectedAttestationId, setSelectedAttestationId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [refusal, setRefusal] = useState('');
  const [identityCopied, setIdentityCopied] = useState(false);
  const [identityCopyFallback, setIdentityCopyFallback] = useState(false);
  const requestSequence = useRef(0);
  const submitInFlight = useRef(false);
  const mounted = useRef(false);
  const verifiedOnce = useRef(false);
  const previousRefresh = useRef(refresh);
  const verificationRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const reconciledDigest = useRef<string | null>(null);
  const reconciliationBaseline = useRef<{
    digest: string;
    status: GoalExternalIntegrationStoredStatus | null;
  } | null>(null);
  const stored = useLoad(
    () => goalsApi.externalIntegrationStatus(goalId, handoff.handoffId),
    `${goalId}:${handoff.handoffId}:external-integration-status`,
    refresh,
  );
  const attestation = useLoad<GoalExternalIntegrationAttestationProjection | null>(
    () =>
      selectedAttestationId
        ? goalsApi.externalIntegrationProjection(goalId, handoff.handoffId, selectedAttestationId)
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

  const updatePendingDigest = (digest: string | null) => {
    setPendingDigest(digest);
    savePendingDigest(goalId, handoff.handoffId, digest);
    if (digest === null) reconciliationBaseline.current = null;
  };

  useEffect(() => {
    if (stored.result.state !== 'ready') return;
    const status = stored.result.data;
    if (status.goalId !== goalId || status.handoffId !== handoff.handoffId) return;
    if (selectedAttestationId === null && status.attestations[0])
      setSelectedAttestationId(status.attestations[0].attestationId);
    if (!pendingDigest || reconciledDigest.current === pendingDigest) return;
    const baseline = reconciliationBaseline.current;
    if (baseline?.digest === pendingDigest && baseline.status === status) return;
    const record = matchingAttestation(status, pendingDigest);
    if (record) {
      reconciledDigest.current = pendingDigest;
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
        setSelectedAttestationId(approval.attestationId);
        setRecoveryMessage(
          'The exact approval links to an attestation. Its integrity and currentness are being revalidated.',
        );
        setAnnouncement('A matching attestation was found. Validating its saved evidence now.');
        return;
      }
      setRecoveryMessage(
        approval.status === 'denied'
          ? 'The exact action was denied. This digest cannot be confirmed again.'
          : 'A matching user approval exists, but no attestation is stored. Review the same observation and explicitly confirm again to finish recording it.',
      );
      setAnnouncement('Saved approval status was found. No Git action was performed.');
      return;
    }
    if (status.attestationsHaveMore || status.approvalsHaveMore) {
      setRecoveryMessage(
        'The saved history is truncated and may omit this exact action. The uncertainty lock remains until the exact status can be established.',
      );
      return;
    }
    reconciledDigest.current = pendingDigest;
    updatePendingDigest(null);
    setRecoveryMessage(
      'No matching approval or attestation is stored as of the latest successful status read. Verify again before any new confirmation.',
    );
    setAnnouncement('Recovery status was read. No confirmation was repeated automatically.');
  }, [goalId, handoff.handoffId, pendingDigest, selectedAttestationId, stored.result]);

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
    )
      return;
    if (projection.state === 'current' || projection.state === 'historical') {
      reconciledDigest.current = pendingDigest;
      updatePendingDigest(null);
      setRecoveryMessage('The exact immutable attestation was validated from saved server evidence.');
      setAnnouncement('The original confirmation was recorded and its attestation is valid.');
      return;
    }
    setRecoveryMessage(
      `The exact attestation exists, but its validation state is ${projection.state}. The uncertainty lock remains.`,
    );
  }, [attestation.result, goalId, handoff.handoffId, pendingDigest, selectedAttestationId]);

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
    if (!mounted.current) return;
    setRecoveryMessage('Checking saved approval and attestation records for this exact action digest…');
    try {
      const status = await goalsApi.externalIntegrationStatus(goalId, handoff.handoffId);
      if (!mounted.current || status.goalId !== goalId || status.handoffId !== handoff.handoffId) return;
      stored.reload();
      const record = matchingAttestation(status, digest);
      if (record) {
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
          setSelectedAttestationId(approval.attestationId);
          setRecoveryMessage(
            'The exact approval links to an attestation. Its integrity and currentness are being revalidated.',
          );
          setAnnouncement('A matching attestation was found. Validating its saved evidence now.');
          return;
        }
        setRecoveryMessage(
          approval.status === 'denied'
            ? 'The exact user approval was denied. The same action digest cannot be used again.'
            : 'A matching approval exists without an attestation. The result is not recorded as externally integrated. Review again and explicitly confirm to finish recording.',
        );
        setAnnouncement('An approval was found without a saved attestation.');
        return;
      }
      if (status.attestationsHaveMore || status.approvalsHaveMore) {
        setRecoveryMessage(
          'The saved history is truncated and may omit this exact action. The uncertainty lock remains until the exact status can be established.',
        );
        setAnnouncement('Recovery is incomplete because the bounded history does not include every record.');
        return;
      }
      updatePendingDigest(null);
      setRecoveryMessage(
        'No matching approval or attestation is stored as of this successful status read. Verify again before any new confirmation.',
      );
      setAnnouncement('Recovery status is reconciled. No new approval or POST was created.');
    } catch {
      setRecoveryMessage(
        'Saved status could not be read. The action remains locked until a complete reconciliation succeeds.',
      );
      setAnnouncement('Recovery remains incomplete. No automatic retry was sent.');
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
    reconciliationBaseline.current = {
      digest: reviewed.actionDigest,
      status: stored.result.state === 'ready' ? stored.result.data : null,
    };
    submitInFlight.current = true;
    setSubmitting(true);
    updatePendingDigest(reviewed.actionDigest);
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
      if (result.actionDigest !== reviewed.actionDigest)
        throw new Error('The saved response did not match the reviewed action digest.');
      updatePendingDigest(null);
      reconciledDigest.current = reviewed.actionDigest;
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
        updatePendingDigest(null);
        reconciledDigest.current = null;
        const changedEvidenceMessage =
          'The Git or Goal evidence changed since review. Nothing was approved for the new evidence. Review a fresh observation before confirming again.';
        setAnnouncement('Reviewed evidence changed. Refreshing the read-only observation.');
        await refreshVerification();
        if (mounted.current) {
          setRefusal(changedEvidenceMessage);
          setAnnouncement(
            'The reviewed evidence changed. A fresh read-only observation is shown; confirm it separately if it is correct.',
          );
        }
      } else {
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
      if (mounted.current) setSubmitting(false);
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
  const canConfirm = Boolean(
    verificationIsCurrent &&
    handoffCurrent &&
    !deniedExactAction &&
    (!pendingDigest || pendingDigest !== verification.observation.actionDigest || selectedApproval),
  );
  const currentProjection = attestation.result.state === 'ready' ? attestation.result.data : null;
  const projectionMatchesSelected =
    currentProjection === null ||
    currentProjection.record === null ||
    (currentProjection.record.goalId === goalId &&
      currentProjection.record.handoff.id === handoff.handoffId &&
      currentProjection.record.attestationId === selectedAttestationId);
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
      {!handoffCurrent && (
        <p className="goal-handoff-reason" role="status">
          This handoff is not current, so it cannot authorize a new external-integration confirmation. Saved
          attestations remain available for historical review.
        </p>
      )}
      <div className="goal-handoff-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void refreshVerification()}
          disabled={!handoffCurrent || submitting || checking}
        >
          {checking ? 'Checking Git history…' : 'Verify external integration'}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            stored.reload();
            if (selectedAttestationId) attestation.reload();
            if (pendingDigest) void reconcile(pendingDigest);
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
                onClick={() =>
                  setReviewedConfirmation(verificationIsCurrent ? verification.observation : null)
                }
                disabled={!canConfirm || submitting || selectedRecord !== null}
              >
                {deniedExactAction
                  ? 'This action was denied'
                  : selectedApproval && !selectedRecord
                    ? 'Resume attestation recording'
                    : 'Confirm external integration'}
              </button>
            </>
          )}
        </>
      )}

      {pendingDigest && (
        <div className="goal-external-recovery" role="status">
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
        </div>
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

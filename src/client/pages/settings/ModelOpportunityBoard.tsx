import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { GoalOpportunityAdmissionTarget } from '../../../shared/goalApi';
import type { ModelOpportunityObservation } from '../../../shared/types';
import { api } from '../../api';

type BoardState = {
  observations: ModelOpportunityObservation[];
  retentionDays: number;
  refreshRequired: boolean;
  targets: GoalOpportunityAdmissionTarget[];
};

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}

const originLabel = (item: ModelOpportunityObservation) =>
  `${item.claimKind === 'provider-advertised' ? 'Advertised' : 'Locally discovered'} · ${item.sourceClass}`;

export function ModelOpportunityBoard({
  onNotice,
  onChanged,
}: {
  onNotice: (message: string) => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<BoardState | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [observations, admissions] = await Promise.all([
        api.modelOpportunities(),
        api.opportunityAdmissionTargets(),
      ]);
      setState({ ...observations, targets: admissions.targets });
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Model observations could not be loaded.');
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      await api.refreshProviders();
      const observationsLoaded = await load();
      onChanged();
      onNotice(
        observationsLoaded
          ? 'Provider discovery finished and its observations were recorded.'
          : 'Provider discovery finished, but saved observations could not be reloaded.',
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Provider discovery could not be recorded.';
      setError(message);
      onNotice(message);
    } finally {
      setBusy(false);
    }
  };

  const actionKey = (target: GoalOpportunityAdmissionTarget) =>
    `${target.goalId}:${target.definitionVersion}:${target.poolId}:${target.memberIndex}`;

  const validate = async (target: GoalOpportunityAdmissionTarget) => {
    const key = actionKey(target);
    setActiveAction(key);
    setError('');
    try {
      const result = await api.startRouteValidation(target.member, target.roles);
      onNotice(
        `Exact-route validation queued (${result.profiles.length} checks). Wait for the run to finish, then refresh this board.`,
      );
      onChanged();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Route validation could not be queued.';
      setError(message);
      onNotice(message);
    } finally {
      setActiveAction(null);
    }
  };

  const admit = async (target: GoalOpportunityAdmissionTarget) => {
    const key = actionKey(target);
    setActiveAction(key);
    setError('');
    try {
      await api.requestOpportunityAdmission(target.goalId, target.definitionVersion, {
        poolId: target.poolId,
        memberIndex: target.memberIndex,
      });
      const observationsLoaded = await load();
      onChanged();
      onNotice(
        observationsLoaded
          ? 'Admission requested. Approve the exact pool-member request in Goal approvals.'
          : 'Admission request was created, but the board could not reload. Approve it in Goal approvals.',
      );
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : 'Opportunity admission could not be requested.';
      setError(message);
      onNotice(message);
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <section
      className="surface-panel settings-section model-opportunity-board"
      aria-labelledby="model-opportunity-title"
    >
      <div className="panel-title-row">
        <div>
          <h2 id="model-opportunity-title">Model opportunities</h2>
          <p>Read-only provider and local discovery history. Loading this board never starts discovery.</p>
        </div>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={14} aria-hidden="true" />
          {busy ? 'Refreshing…' : 'Refresh observations'}
        </button>
      </div>
      <p className="model-opportunity-retention">
        Raw observations are retained for {state?.retentionDays ?? 90} days. An approved admission proof stays
        valid for its exact Goal definition until a later approved definition replaces it.
      </p>
      {error && (
        <p className="model-opportunity-error" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p role="status">Loading saved observations…</p>}
      {state?.observations.length === 0 && (
        <p role="status">
          No observations yet. Refresh to record a provider catalog or local adapter discovery.
        </p>
      )}
      {state && state.observations.length > 0 && (
        <div
          className="model-opportunity-table-scroll"
          role="region"
          aria-label="Scrollable model observations"
          tabIndex={0}
        >
          <div className="model-opportunity-table" role="table" aria-label="Model observations">
            <div className="model-opportunity-row model-opportunity-head" role="row">
              <span role="columnheader">Model</span>
              <span role="columnheader">Provenance</span>
              <span role="columnheader">Cost</span>
              <span role="columnheader">Observed</span>
            </div>
            {state.observations.map((item) => (
              <div className="model-opportunity-row" role="row" key={item.id}>
                <span role="cell" className="model-opportunity-model">
                  <strong>{item.displayName}</strong>
                  <small>
                    {item.backendId} · {item.providerId} · {item.modelId}
                  </small>
                  {!item.valid && (
                    <small className="model-opportunity-error">
                      Stored evidence failed its integrity check.
                    </small>
                  )}
                </span>
                <span role="cell">
                  {originLabel(item)}
                  <small>
                    {item.refreshOutcome === 'success'
                      ? 'Successful observation'
                      : `Refresh ${item.refreshOutcome}`}
                  </small>
                </span>
                <span role="cell" className={`model-opportunity-cost cost-${item.costClass}`}>
                  {item.costClass === 'unknown' ? 'Price unknown' : item.costClass}
                  {item.adapterVersion && <small>Adapter {item.adapterVersion}</small>}
                </span>
                <span role="cell" className="model-opportunity-time">
                  {timestamp(item.observedAt)}
                  <small>Checked {timestamp(item.checkedAt)}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {state && state.targets.length > 0 && (
        <div className="model-opportunity-admissions" aria-label="Proposed Goal pool admissions">
          <h3>Proposed Goal pools</h3>
          <p>Admissions are per Goal and bind one exact model, route identity and observation set.</p>
          {state.targets.map((target) => {
            const key = actionKey(target);
            const isBusy = activeAction === key;
            const canValidate =
              target.evidencePath === 'locally-discovered' && target.eligibility === 'validation_required';
            const canAdmit =
              target.eligibility === 'ready' &&
              target.admissionStatus !== 'pending' &&
              target.admissionStatus !== 'approved';
            return (
              <article className="model-opportunity-admission" key={key}>
                <div>
                  <strong>{target.displayName}</strong>
                  <small>
                    {target.goalTitle} · v{target.definitionVersion} · {target.poolLabel} · member{' '}
                    {target.memberIndex + 1}
                  </small>
                  <small>
                    {target.evidencePath === 'provider-advertised'
                      ? 'Provider advertised'
                      : target.evidencePath === 'locally-discovered'
                        ? 'Locally discovered'
                        : 'Observation evidence unavailable'}
                    {target.evidencePath === 'locally-discovered'
                      ? ` · ${target.eligibility === 'ready' ? 'Turing validated' : 'Turing validation required'}`
                      : ''}
                    {target.admissionStatus === 'pending' ? ' · awaiting your approval' : ''}
                    {target.admissionStatus === 'approved' ? ' · admitted' : ''}
                    {target.admissionStatus === 'denied' ? ' · previous request denied' : ''}
                  </small>
                  <small>
                    {target.backendId} · {target.providerId} · {target.modelId}
                  </small>
                  <small>
                    <span className={`model-opportunity-cost cost-${target.costClass}`}>
                      {target.costClass === 'unknown' ? 'Price unknown' : target.costClass}
                    </span>
                    {' · '}
                    {target.billingLane} billing lane
                  </small>
                  <small>Used by: {target.roles.join(', ') || 'no Goal role'}</small>
                </div>
                {canValidate && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isBusy}
                    onClick={() => void validate(target)}
                  >
                    {isBusy ? 'Queueing…' : 'Validate exact route'}
                  </button>
                )}
                {canAdmit && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={isBusy || target.roles.length === 0}
                    onClick={() => void admit(target)}
                  >
                    {isBusy
                      ? 'Requesting…'
                      : target.admissionStatus === 'denied'
                        ? 'Request admission again'
                        : 'Request admission'}
                  </button>
                )}
                {target.eligibility === 'identity_unavailable' && (
                  <span role="status">
                    Refresh provider observations to resolve the exact route identity.
                  </span>
                )}
                {target.eligibility === 'evidence_invalid' && (
                  <span role="status">
                    The observation binding is invalid; edit and save the proposed definition again.
                  </span>
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className="model-opportunity-footnote">
        Discovery is not execution approval. Cache and failed observations are not evidence of current
        availability; a cost label never changes the route’s billing lane.
      </p>
    </section>
  );
}

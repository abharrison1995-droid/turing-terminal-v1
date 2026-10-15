import { useEffect, useRef, useState } from 'react';
import { Monitor, Plus, Smartphone } from 'lucide-react';
import type { DashboardSnapshot } from '../../shared/types';
import { probeMachine, type MachineProfile } from '../machineProfiles';
import { activeStatuses, humanize } from './shared/runStatus';
import { PageHeading } from './shared/parts';
import { formatDate } from './shared/format';

export function MachinesPage({
  snapshot,
  profiles,
  onAddProfile,
  onRemoveProfile,
  onReachability,
  onSelectProfile,
}: {
  snapshot: DashboardSnapshot;
  profiles: MachineProfile[];
  onAddProfile: (origin: string, name: string) => boolean;
  onRemoveProfile: (origin: string) => void;
  onReachability: (origin: string, reachability: 'online' | 'offline') => void;
  onSelectProfile: (profile: MachineProfile) => void;
}) {
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const onReachabilityRef = useRef(onReachability);
  const profilesRef = useRef(profiles);
  onReachabilityRef.current = onReachability;
  profilesRef.current = profiles;
  const otherOrigins = profiles
    .map((profile) => profile.origin)
    .filter((profileOrigin) => profileOrigin !== window.location.origin)
    .sort();
  const probeKey = otherOrigins.join('|');

  useEffect(() => {
    if (!probeKey) return;
    let active = true;
    const check = () => {
      void Promise.all(
        profilesRef.current
          .filter((profile) => profile.origin !== window.location.origin)
          .map(async (profile) => {
            const reachability = await probeMachine(profile);
            if (active) onReachabilityRef.current(profile.origin, reachability);
          }),
      );
    };
    check();
    const timer = window.setInterval(check, 20_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [probeKey]);

  const currentProfile = profiles.find((profile) => profile.origin === window.location.origin);
  const activeRuns = snapshot.runs.filter((run) => activeStatuses.has(run.status)).length;
  return (
    <main className="page-content">
      <PageHeading
        title="Machines"
        description="Choose a directly paired desktop master. Runs stay on the machine selected in this browser."
        actions={<span className="status-pill status-ready">{profiles.length} saved</span>}
      />
      <section className="surface-panel machine-list-panel">
        <div className="panel-title-row">
          <div>
            <h2>Machine profiles</h2>
            <p>Profiles are stored on this device. Pair this browser separately with every master.</p>
          </div>
          <Monitor size={17} className="muted-icon" />
        </div>
        {profiles.map((profile) => {
          const selected = profile.origin === window.location.origin;
          const status = selected ? 'online' : profile.reachability;
          return (
            <div className="machine-card-row" key={profile.origin}>
              <span className="machine-symbol machine-symbol-large">
                <Monitor size={19} />
              </span>
              <div className="machine-card-main">
                <strong>
                  {profile.name}
                  {selected ? ' · selected' : ''}
                </strong>
                <span>
                  {profile.hostname && profile.os ? `${profile.hostname} · ${profile.os}` : profile.origin}
                </span>
                {profile.machineId && <small>Machine ID {profile.machineId}</small>}
                <small>
                  {selected
                    ? `${snapshot.projects.length} projects · ${activeRuns} active runs · ${snapshot.providers.filter((provider) => provider.detected).length} providers detected`
                    : `Last reachable ${profile.lastSeenAt ? formatDate(profile.lastSeenAt) : 'not yet checked'}`}
                </small>
              </div>
              <span className={`status-pill status-${status}`}>
                {status === 'unknown' ? 'Checking' : humanize(status)}
              </span>
              <button
                className={selected ? 'quiet-button' : 'secondary-button'}
                disabled={selected}
                onClick={() => onSelectProfile(profile)}
              >
                {selected ? 'Selected' : 'Connect'}
              </button>
              {!selected && (
                <button
                  className="quiet-button"
                  aria-label={`Remove ${profile.name}`}
                  onClick={() => onRemoveProfile(profile.origin)}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
        {currentProfile && (
          <div className="machine-capability-row">
            <span>{snapshot.projects.length} projects on selected machine</span>
            <span>{activeRuns} active runs</span>
            <span>
              {snapshot.providers.filter((provider) => provider.detected).length} provider CLIs detected
            </span>
          </div>
        )}
      </section>
      <section className="surface-panel settings-section machine-profile-form">
        <div className="panel-title-row">
          <div>
            <h2>Add a desktop master</h2>
            <p>Enter its Tailscale Serve HTTPS address. Its pairing cookie stays scoped to that address.</p>
          </div>
          <Plus size={17} className="muted-icon" />
        </div>
        <div className="form-grid-two">
          <label className="form-field">
            <span>Machine name</span>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="form-field">
            <span>Serve address</span>
            <input
              value={origin}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://desktop.tailnet.ts.net"
              onChange={(event) => setOrigin(event.target.value)}
            />
          </label>
        </div>
        <button
          className="primary-button align-right"
          disabled={!name.trim() || !origin.trim()}
          onClick={() => {
            if (onAddProfile(origin, name)) {
              setName('');
              setOrigin('');
            }
          }}
        >
          <Plus size={14} /> Save machine profile
        </button>
      </section>
      <section className="connection-unavailable">
        <span>
          <Smartphone size={20} />
        </span>
        <div>
          <h2>Direct machine selection</h2>
          <p>
            Connect opens the chosen master in this browser and carries only profile metadata. That master
            then serves its own projects, providers, approvals, and runs; no request is rerouted if it is
            unavailable.
          </p>
          <strong>
            Each master must be online through Tailscale Serve and paired on this browser before it can be
            controlled.
          </strong>
        </div>
      </section>
    </main>
  );
}

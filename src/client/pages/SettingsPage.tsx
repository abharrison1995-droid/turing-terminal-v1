import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  Laptop,
  Monitor,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Smartphone,
} from 'lucide-react';
import QRCode from 'qrcode';
import type { DashboardSnapshot, ProjectProfile, StageKind, TuringRule } from '../../shared/types';
import { api } from '../api';
import { MeteredBudgetSettingsPanel, OpenRouterSettings } from './settings/MeteredProviderSettings';
import { desktop, isDesktopShell, setMasterApiBase, type DesktopRuntime } from '../desktop';
import { makePairingQrUrl } from '../pairingQr.js';
import { decodeVapidPublicKey, pushSubscriptionStorageKey } from '../pushNotifications.js';
import { PageHeading } from './shared/parts';
import { SettingsCard } from './shared/SettingsCard';
import { humanize } from './shared/runStatus';
import { formatDate } from './shared/format';
import { stageLabels } from './shared/stageMeta';
import { ProviderSetup } from './settings/ProviderSetup';
import { ModelOpportunityBoard } from './settings/ModelOpportunityBoard';
import type { SettingsIntent } from './shared/settingsIntent';

export function SettingsPage({
  snapshot,
  onNotice,
  onChanged,
  intent,
  intentSignal,
  onReturnToWorkflows,
}: {
  snapshot: DashboardSnapshot;
  onNotice: (message: string) => void;
  onChanged: () => void;
  /** Set when another page sent the person here to finish a setup step. */
  intent?: SettingsIntent;
  /** Bumps for every request, so asking for the same card twice opens it twice. */
  intentSignal?: number;
  onReturnToWorkflows?: () => void;
}) {
  const [name, setName] = useState(snapshot.machine.name);
  const [notifications, setNotifications] = useState(
    () => typeof Notification !== 'undefined' && Notification.permission === 'granted',
  );
  const [pushConfig, setPushConfig] = useState<{
    enabled: boolean;
    publicKey: string | null;
    reason: string | null;
  } | null>(null);
  const pushStorageKey = pushSubscriptionStorageKey(window.location.origin);
  const [pushSubscribed, setPushSubscribed] = useState(() =>
    Boolean(window.localStorage.getItem(pushStorageKey)),
  );
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNotice, setPushNotice] = useState('');
  useEffect(() => {
    let live = true;
    void api
      .webPushConfig()
      .then((config) => {
        if (live) setPushConfig(config);
      })
      .catch((reason) => {
        if (live) setPushNotice(reason instanceof Error ? reason.message : 'Push readiness is unavailable.');
      });
    return () => {
      live = false;
    };
  }, []);
  const updateMachineName = async () => {
    try {
      await api.renameMachine(name);
      onChanged();
      onNotice('Machine name updated.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Machine name could not be saved.');
    }
  };
  const enableNotifications = async () => {
    if (!('Notification' in window)) {
      onNotice('Browser notifications are not supported here.');
      return;
    }
    const result = await Notification.requestPermission();
    setNotifications(result === 'granted');
    onNotice(
      result === 'granted'
        ? 'Browser notifications enabled for this browser.'
        : 'Notification permission was not granted.',
    );
  };
  const enableClosedPush = async () => {
    setPushBusy(true);
    setPushNotice('');
    try {
      if (!pushConfig?.enabled || !pushConfig.publicKey)
        throw new Error(pushConfig?.reason ?? 'Closed-client Web Push is not configured on this master.');
      if (!('serviceWorker' in navigator) || !('PushManager' in window))
        throw new Error('This browser does not support Web Push. Open-client notifications may still work.');
      if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        setNotifications(permission === 'granted');
        if (permission !== 'granted') throw new Error('Notification permission was not granted.');
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidPublicKey(pushConfig.publicKey),
        }));
      const value = subscription.toJSON();
      if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth)
        throw new Error('The browser returned an incomplete Web Push subscription.');
      const saved = await api.savePushSubscription({
        endpoint: value.endpoint,
        keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
      });
      window.localStorage.setItem(pushStorageKey, saved.id);
      setPushSubscribed(true);
      setPushNotice('Closed-client Web Push is enabled for this browser.');
    } catch (reason) {
      setPushNotice(reason instanceof Error ? reason.message : 'Web Push could not be enabled.');
    } finally {
      setPushBusy(false);
    }
  };
  const disableClosedPush = async () => {
    setPushBusy(true);
    try {
      const id = window.localStorage.getItem(pushStorageKey);
      if (id) await api.deletePushSubscription(id);
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        await subscription?.unsubscribe();
      }
      window.localStorage.removeItem(pushStorageKey);
      setPushSubscribed(false);
      setPushNotice('Closed-client Web Push was disabled for this browser.');
    } catch (reason) {
      setPushNotice(reason instanceof Error ? reason.message : 'Web Push could not be disabled.');
    } finally {
      setPushBusy(false);
    }
  };
  useEffect(() => {
    if (!intent || !intentSignal) return;
    const target =
      intent.target === 'openrouter' ? '[aria-label="OpenRouter"]' : '#providers-connections-section';
    window.requestAnimationFrame(() => document.querySelector(target)?.scrollIntoView?.({ block: 'start' }));
  }, [intent, intentSignal]);
  const notificationSummary = `${notifications ? 'Browser notifications on' : 'Browser notifications off'} · ${pushSubscribed ? 'closed-client push on' : 'closed-client push off'}`;
  return (
    <main className="page-content">
      <PageHeading
        title="Settings"
        description="Local master identity, provider health, and safety boundaries."
      />
      {intent?.returnTo === 'workflows' && onReturnToWorkflows && (
        <div className="workflow-banner" role="status">
          <div>
            <strong>Your workflow draft is kept</strong>
            <p>
              Finish this step here, then go back. Nothing was saved, added or enabled in the workflow by
              coming here.
            </p>
            <button type="button" className="secondary-button" onClick={onReturnToWorkflows}>
              Back to Workflows
            </button>
          </div>
        </div>
      )}
      <div className="settings-grid">
        <DesktopSettingsCard />
        <section className="surface-panel settings-section" id="providers-connections-section">
          <ProviderSetup
            providers={snapshot.providers}
            workflows={snapshot.workflows}
            onNotice={onNotice}
            onChanged={onChanged}
            intentServiceId={intent?.target === 'providers' ? intent.serviceId : undefined}
            openSignal={intent?.target === 'providers' ? intentSignal : undefined}
          />
        </section>
        <ModelOpportunityBoard onNotice={onNotice} onChanged={onChanged} />
        <section className="surface-panel settings-section">
          <SettingsCard
            id="machine-identity"
            summary={snapshot.machine.name}
            defaultOpen={true}
            head={
              <div className="panel-title-row">
                <div>
                  <h2>Machine identity</h2>
                  <p>Shown in run previews and machine selection.</p>
                </div>
                <Laptop size={17} className="muted-icon" />
              </div>
            }
          >
            <label className="form-field">
              <span>Machine name</span>
              <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            <button className="primary-button align-right" onClick={() => void updateMachineName()}>
              <Save size={14} />
              Save name
            </button>
            <div className="settings-readonly-row">
              <span>Hostname</span>
              <strong>{snapshot.machine.hostname}</strong>
            </div>
            <div className="settings-readonly-row">
              <span>Operating system</span>
              <strong>{snapshot.machine.os}</strong>
            </div>
          </SettingsCard>
        </section>
        <TailscaleReadinessCard />
        <section className="surface-panel settings-section">
          <SettingsCard
            id="permission-modes"
            summary="Supervised, Normal, YOLO and ENIGMA"
            defaultOpen={false}
            head={
              <div className="panel-title-row">
                <div>
                  <h2>Permission modes</h2>
                  <p>Turing mediates supported providers through project-scoped tools and approval policy.</p>
                </div>
                <Shield size={17} className="muted-icon" />
              </div>
            }
          >
            <PermissionInfo
              name="Supervised"
              text="Read-only requests proceed. File changes, commands, Git operations, and unfamiliar actions wait for your approval. Secret access and project-boundary escapes are always denied."
            />
            <PermissionInfo
              name="Normal"
              text="Routine edits and configured build/test/lint scripts proceed. Deletes, commits, pushes, merges, rollbacks, and unfamiliar operations ask first."
            />
            <PermissionInfo
              name="YOLO"
              text="Routine edits and deletes run autonomously. Push, merge, rollback, network, and destructive Git actions remain approval-gated."
            />
            <PermissionInfo
              name="ENIGMA"
              text="Broad supported project edits and deletes may run without approval after explicit per-run activation. Secret and out-of-project access remain denied; push, merge, rollback, network, and destructive Git actions still require approval."
            />
          </SettingsCard>
        </section>
        <OpenRouterSettings
          onNotice={onNotice}
          openSignal={intent?.target === 'openrouter' ? intentSignal : undefined}
        />
        <MeteredBudgetSettingsPanel onNotice={onNotice} />
        <RulesSettings projects={snapshot.projects} onNotice={onNotice} />
        <PairingSettings onNotice={onNotice} />
        <section className="surface-panel settings-section">
          <SettingsCard
            id="notifications"
            summary={notificationSummary}
            defaultOpen={false}
            attention={pushNotice !== ''}
            head={
              <div className="panel-title-row">
                <div>
                  <h2>Notifications</h2>
                  <p>Browser notifications for this device.</p>
                </div>
                <Bell size={17} className="muted-icon" />
              </div>
            }
          >
            <div className="toggle-line">
              <span className="notification-setting-copy">
                <strong>{notifications ? 'Notifications enabled' : 'Notifications disabled'}</strong>
                <small>
                  {isDesktopShell()
                    ? 'Browser notifications appear while the desktop app is open. Use the paired mobile PWA for closed-client Web Push.'
                    : 'Browser notifications appear while Turing Terminal is open. Closed-client Web Push is configured separately below.'}
                </small>
              </span>
              <button
                className="secondary-button"
                onClick={() => void enableNotifications()}
                disabled={notifications}
              >
                {notifications ? <Check size={14} /> : <Bell size={14} />}
                {notifications ? 'Enabled' : 'Enable notifications'}
              </button>
            </div>
            {isDesktopShell() ? (
              <div className="settings-boundary">
                <Bell size={15} />
                <span>
                  Closed-client Web Push remains available from the paired mobile PWA in your browser.
                </span>
              </div>
            ) : (
              <>
                <div className="toggle-line push-notification-line">
                  <span className="notification-setting-copy">
                    <strong>{pushSubscribed ? 'Closed-client push enabled' : 'Closed-client push'}</strong>
                    <small>
                      {pushConfig?.enabled
                        ? 'The master sends standards-based Web Push. Browser vendor push relays deliver while this page is closed.'
                        : (pushConfig?.reason ?? 'Checking master push configuration…')}
                    </small>
                  </span>
                  {pushSubscribed ? (
                    <button
                      className="secondary-button"
                      onClick={() => void disableClosedPush()}
                      disabled={pushBusy}
                    >
                      {pushBusy ? 'Disabling…' : 'Disable push'}
                    </button>
                  ) : (
                    <button
                      className="secondary-button"
                      onClick={() => void enableClosedPush()}
                      disabled={pushBusy || !pushConfig?.enabled}
                    >
                      <Bell size={14} /> {pushBusy ? 'Enabling…' : 'Enable closed-client push'}
                    </button>
                  )}
                </div>
                {pushNotice && <div className="inline-callout quota-feedback">{pushNotice}</div>}
              </>
            )}
          </SettingsCard>
        </section>
      </div>
      <div className="settings-boundary">
        <AlertTriangle size={16} />
        <span>
          <strong>Bind the master to loopback.</strong> For remote phone access, use Tailscale Serve over
          HTTPS; Turing requires both a paired device token and the Tailscale user identity header.
        </span>
      </div>
    </main>
  );
}

function DesktopSettingsCard() {
  const [runtime, setRuntime] = useState<DesktopRuntime | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    if (!isDesktopShell()) return;
    void desktop
      .runtime()
      .then(setRuntime)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Desktop status could not be read.'),
      );
  }, []);
  useEffect(() => {
    if (!isDesktopShell()) return;
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  if (!isDesktopShell()) return null;

  const desktopSummary = runtime ? runtime.status : error ? 'Status unavailable' : 'Loading status…';
  const toggleKeepOpen = async () => {
    if (!runtime) return;
    setBusy(true);
    setError('');
    try {
      await desktop.setKeepMasterOnClose(!runtime.keepMasterOnClose);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The close preference could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const toggleLogin = async () => {
    if (!runtime) return;
    setBusy(true);
    setError('');
    try {
      await desktop.setStartAtLogin(!runtime.startAtLogin);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The sign-in preference could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const restartMaster = async () => {
    setBusy(true);
    setError('');
    try {
      const runtime = (await desktop.restartMaster()) ?? (await desktop.runtime());
      setMasterApiBase(runtime.masterUrl);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Desktop Master could not be restarted.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface-panel settings-section">
      <SettingsCard
        id="desktop-application"
        summary={desktopSummary}
        defaultOpen={false}
        attention={Boolean(error || runtime?.error)}
        head={
          <div className="panel-title-row">
            <div>
              <h2>Desktop application</h2>
              <p>Bundled Master process, startup options, and local system readiness.</p>
            </div>
            <Monitor size={17} className="muted-icon" />
          </div>
        }
      >
        {runtime ? (
          <>
            <div className="settings-readonly-row">
              <span>Desktop Master</span>
              <strong>
                {runtime.status}
                {runtime.port ? ` · 127.0.0.1:${runtime.port}` : ''}
              </strong>
            </div>
            <div className="settings-readonly-row">
              <span>Version</span>
              <strong>{runtime.version}</strong>
            </div>
            <div className="settings-readonly-row">
              <span>Application data</span>
              <strong>{runtime.dataPath}</strong>
            </div>
            <div className="settings-readonly-row">
              <span>System readiness</span>
              <strong>
                {runtime.tools.filter((tool) => tool.installed).length}/{runtime.tools.length} optional tools
                found
              </strong>
            </div>
            <div className="capability-tags desktop-readiness-tags">
              {runtime.tools.map((tool) => (
                <span key={tool.id} className={tool.installed ? 'readiness-available' : 'readiness-missing'}>
                  {tool.installed ? '✓' : '○'} {tool.name}
                </span>
              ))}
            </div>
            <div className="toggle-line">
              <span className="notification-setting-copy">
                <strong>Keep Master running when this window closes</strong>
                <small>
                  On by default. Turn it off to stop a Master started by this app when the window closes.
                </small>
              </span>
              <button
                className="secondary-button"
                onClick={() => void toggleKeepOpen()}
                disabled={busy || !runtime}
              >
                {runtime.keepMasterOnClose ? 'On' : 'Off'}
              </button>
            </div>
            <div className="toggle-line">
              <span className="notification-setting-copy">
                <strong>Start Turing Terminal when I sign in</strong>
                <small>
                  Runs in the background at login. Optional tools are never installed automatically.
                </small>
              </span>
              <button
                className="secondary-button"
                onClick={() => void toggleLogin()}
                disabled={busy || !runtime}
              >
                {runtime.startAtLogin ? 'On' : 'Off'}
              </button>
            </div>
            {runtime.error && <div className="form-error">{runtime.error}</div>}
            {error && <div className="form-error">{error}</div>}
            <div className="desktop-diagnostics-actions">
              <button
                className="secondary-button"
                onClick={() => void restartMaster()}
                disabled={busy || (runtime.status === 'Running' && !runtime.startedByApp)}
              >
                <RefreshCw size={14} /> Restart Master
              </button>
              <button className="secondary-button" onClick={() => void desktop.openLogFolder()}>
                Open log folder
              </button>
            </div>
            <small>Logs: {runtime.logPath}</small>
            {runtime.tools.some((tool) => !tool.installed) && (
              <p>
                Missing optional command-line tools only disable their related integrations. Install and sign
                in to a tool to make it available.
              </p>
            )}
          </>
        ) : (
          <p>{error || 'Loading desktop status…'}</p>
        )}
      </SettingsCard>
    </section>
  );
}

function TailscaleReadinessCard() {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.tailscaleReadiness>>['tailscale'] | null>(
    null,
  );
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    setError('');
    void api
      .tailscaleReadiness()
      .then((result) => setState(result.tailscale))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Tailscale readiness check failed.'),
      );
  }, []);
  useEffect(() => refresh(), [refresh]);
  const tailscaleSummary = error
    ? 'Check failed'
    : !state
      ? 'Checking…'
      : state.connectionHealth === 'ready'
        ? 'Connection ready'
        : 'Connection needs attention';
  return (
    <section className="surface-panel settings-section tailscale-readiness">
      <SettingsCard
        id="tailscale-readiness"
        summary={tailscaleSummary}
        defaultOpen={false}
        attention={Boolean(error) || (state !== null && state.connectionHealth !== 'ready')}
        head={
          <div className="panel-title-row">
            <div>
              <h2>Tailscale readiness</h2>
              <p>Local CLI check for this master; the Serve identity is checked on the request itself.</p>
            </div>
            <RefreshCw size={16} className="muted-icon" />
          </div>
        }
      >
        {error ? (
          <div className="form-error">{error}</div>
        ) : state ? (
          <>
            <div className="settings-readonly-row">
              <span>Connection</span>
              <strong
                className={state.connectionHealth === 'ready' ? 'readiness-good' : 'readiness-attention'}
              >
                {state.message}
              </strong>
            </div>
            <div className="settings-readonly-row">
              <span>Tailscale</span>
              <strong>
                {state.installed
                  ? state.running
                    ? 'Installed · running'
                    : 'Installed · stopped'
                  : 'Not installed'}
              </strong>
            </div>
            {state.hostname && (
              <div className="settings-readonly-row">
                <span>This machine</span>
                <strong>
                  {state.hostname}
                  {state.ips.length ? ` · ${state.ips.join(', ')}` : ''}
                </strong>
              </div>
            )}
            <div className="settings-readonly-row">
              <span>Serve → loopback master</span>
              <strong>
                {state.serveConfigured === null
                  ? 'Could not inspect'
                  : state.serveConfigured
                    ? 'Configured'
                    : 'Not configured'}
              </strong>
            </div>
            <div className="settings-readonly-row">
              <span>Identity header on this request</span>
              <strong>{state.identityHeaderPresent ? 'Present' : 'Not present · local request'}</strong>
            </div>
            <small className="readiness-footnote">
              {state.identityObservation} Peer devices and tailnet account details are never returned.
            </small>
          </>
        ) : (
          <div className="settings-readonly-row">
            <span>Connection</span>
            <strong>Checking…</strong>
          </div>
        )}
        <button className="secondary-button align-right" onClick={refresh}>
          <RefreshCw size={14} /> Check again
        </button>
      </SettingsCard>
    </section>
  );
}

function PairingSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.pairingRequests>>['requests']>([]);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof api.pairedDevices>>['devices']>([]);
  const [newCode, setNewCode] = useState<{
    id: string;
    code: string;
    expiresAt: string;
    qrDataUrl: string | null;
  } | null>(null);
  const [serveOrigin, setServeOrigin] = useState(window.location.origin);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [requestResult, deviceResult] = await Promise.all([api.pairingRequests(), api.pairedDevices()]);
      setRequests(requestResult.requests);
      setDevices(deviceResult.devices);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Paired device status could not be loaded.');
    }
  }, [onNotice]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!newCode) return;
    let live = true;
    const qrUrl = makePairingQrUrl(serveOrigin, newCode.id);
    if (!qrUrl) {
      setNewCode((current) =>
        current?.id === newCode.id && current.qrDataUrl !== null ? { ...current, qrDataUrl: null } : current,
      );
      return () => {
        live = false;
      };
    }
    void QRCode.toDataURL(qrUrl, { width: 240, margin: 2 })
      .then((qrDataUrl) => {
        if (!live) return;
        setNewCode((current) =>
          current?.id === newCode.id && current.qrDataUrl !== qrDataUrl ? { ...current, qrDataUrl } : current,
        );
      })
      .catch(() => {
        if (live)
          setNewCode((current) => (current?.id === newCode.id ? { ...current, qrDataUrl: null } : current));
      });
    return () => {
      live = false;
    };
  }, [newCode, serveOrigin]);
  const createRequest = async () => {
    setBusy(true);
    try {
      const result = await api.createPairingRequest();
      setNewCode({
        id: result.request.id,
        code: result.request.code,
        expiresAt: result.request.expiresAt,
        qrDataUrl: null,
      });
      await load();
      onNotice('Short-lived pairing QR and fallback code created. Use them only on the device being paired.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Pairing request could not be created.');
    } finally {
      setBusy(false);
    }
  };
  const approve = async (id: string) => {
    try {
      await api.approvePairingRequest(id);
      await load();
      onNotice('Device pairing approved.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Device pairing could not be approved.');
    }
  };
  const deny = async (id: string) => {
    try {
      await api.denyPairingRequest(id);
      await load();
      onNotice('Pairing request denied.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Pairing request could not be denied.');
    }
  };
  const revoke = async (id: string, name: string) => {
    try {
      await api.revokePairedDevice(id);
      await load();
      onNotice(`${name} was revoked.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Device could not be revoked.');
    }
  };
  const awaitingCount = requests.filter((request) => request.status === 'awaiting_approval').length;
  const pairingSummary = `${devices.length} ${devices.length === 1 ? 'device' : 'devices'} paired · ${awaitingCount} awaiting approval`;
  return (
    <section className="surface-panel settings-section pairing-settings">
      <SettingsCard
        id="paired-devices"
        summary={pairingSummary}
        defaultOpen={true}
        attention={newCode !== null || awaitingCount > 0}
        head={
          <div className="panel-title-row">
            <div>
              <h2>Paired devices</h2>
              <p>
                Remote access uses Tailscale Serve. Each device needs desktop approval and an expiring token.
              </p>
            </div>
            <Smartphone size={17} className="muted-icon" />
          </div>
        }
      >
        <button className="secondary-button" onClick={() => void createRequest()} disabled={busy}>
          <Plus size={14} /> Create pairing code
        </button>
        <label className="form-field pairing-origin-field">
          <span>HTTPS Tailscale Serve address for QR</span>
          <input
            value={serveOrigin}
            onChange={(event) => setServeOrigin(event.target.value)}
            placeholder="https://desktop.example.ts.net"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        {newCode && (
          <div className="pairing-code-display">
            {newCode.qrDataUrl ? (
              <img src={newCode.qrDataUrl} alt="Short-lived Turing Terminal device pairing QR code" />
            ) : (
              <small>QR needs an HTTPS Serve origin with no path or query. Use the manual code below.</small>
            )}
            <strong>{newCode.code}</strong>
            <small>
              Enter this on the phone before {formatDate(newCode.expiresAt)}. Keep this code private.
            </small>
            <small>
              QR contains only the Serve origin and short-lived request ID; no code or credentials.
            </small>
          </div>
        )}
        <div className="pairing-settings-list">
          <strong>Requests</strong>
          {requests.length ? (
            requests.slice(0, 6).map((request) => (
              <div className="pairing-device-row" key={request.id}>
                <span>
                  <strong>{request.deviceName}</strong>
                  <small>
                    {request.tailscaleLogin ?? 'Waiting for phone'} · expires {formatDate(request.expiresAt)}
                  </small>
                </span>
                <span className={`status-pill status-${request.status}`}>{humanize(request.status)}</span>
                {request.status === 'awaiting_approval' && (
                  <span className="pairing-request-actions">
                    <button className="secondary-button" onClick={() => void approve(request.id)}>
                      Approve
                    </button>
                    <button className="secondary-button" onClick={() => void deny(request.id)}>
                      Deny
                    </button>
                  </span>
                )}
              </div>
            ))
          ) : (
            <small>No pairing requests.</small>
          )}
        </div>
        <div className="pairing-settings-list">
          <strong>Devices</strong>
          {devices.length ? (
            devices.map((device) => (
              <div className="pairing-device-row" key={device.id}>
                <span>
                  <strong>{device.name}</strong>
                  <small>
                    {device.tailscaleLogin ?? 'Tailscale identity unavailable'} · last seen{' '}
                    {device.lastSeenAt ? formatDate(device.lastSeenAt) : 'never'}
                  </small>
                </span>
                <span className={`status-pill status-${device.status}`}>{humanize(device.status)}</span>
                <small>Expires {formatDate(device.expiresAt)}</small>
                <button className="quiet-button" onClick={() => void revoke(device.id, device.name)}>
                  Revoke
                </button>
              </div>
            ))
          ) : (
            <small>No devices are paired.</small>
          )}
        </div>
      </SettingsCard>
    </section>
  );
}

function RulesSettings({
  projects,
  onNotice,
}: {
  projects: ProjectProfile[];
  onNotice: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [rules, setRules] = useState<TuringRule[]>([]);
  const [scope, setScope] = useState<TuringRule['scope']>('global');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState(0);
  const [mandatory, setMandatory] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [appliesToAll, setAppliesToAll] = useState(true);
  const [appliesTo, setAppliesTo] = useState<StageKind[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stageKinds = Object.keys(stageLabels) as StageKind[];

  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) setProjectId(projects[0]?.id ?? '');
  }, [projects, projectId]);

  const loadRules = useCallback(async () => {
    try {
      const result = await api.rules(projectId || undefined);
      setRules(result.rules);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rules could not be loaded.');
    }
  }, [onNotice, projectId]);
  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const clearForm = () => {
    setEditingId(null);
    setScope('global');
    setName('');
    setDescription('');
    setContent('');
    setPriority(0);
    setMandatory(false);
    setEnabled(true);
    setAppliesToAll(true);
    setAppliesTo([]);
  };
  const editRule = (rule: TuringRule) => {
    setEditingId(rule.id);
    setScope(rule.scope);
    setProjectId(rule.projectId ?? projectId);
    setName(rule.name);
    setDescription(rule.description);
    setContent(rule.content);
    setPriority(rule.priority);
    setMandatory(rule.mandatory);
    setEnabled(rule.enabled);
    setAppliesToAll(rule.appliesTo.length === 0);
    setAppliesTo(rule.appliesTo);
  };
  const saveRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !content.trim()) return;
    if (!appliesToAll && appliesTo.length === 0) {
      onNotice('Choose at least one stage or enable “Apply to all workflow stages.”');
      return;
    }
    setBusy(true);
    try {
      await api.saveRule(
        {
          scope,
          projectId: scope === 'project' ? projectId : null,
          name: name.trim(),
          description: description.trim(),
          content: content.trim(),
          enabled,
          priority,
          mandatory,
          appliesTo: appliesToAll ? [] : appliesTo,
        },
        editingId ?? undefined,
      );
      await loadRules();
      clearForm();
      onNotice(editingId ? 'Rule updated. New runs will use its new version.' : 'Rule created.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rule could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const toggleRule = async (rule: TuringRule) => {
    try {
      await api.saveRule({ ...rule, enabled: !rule.enabled }, rule.id);
      await loadRules();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rule could not be updated.');
    }
  };
  const removeRule = async (rule: TuringRule) => {
    try {
      await api.deleteRule(rule.id);
      await loadRules();
      if (editingId === rule.id) clearForm();
      onNotice('Rule deleted. Saved run snapshots remain unchanged.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rule could not be deleted.');
    }
  };

  const rulesSummary = `${rules.filter((rule) => rule.enabled).length} of ${rules.length} rules enabled`;
  return (
    <section className="surface-panel settings-section rules-settings">
      <SettingsCard
        id="global-project-rules"
        summary={rulesSummary}
        defaultOpen={true}
        head={
          <div className="panel-title-row">
            <div>
              <h2>Global and project rules</h2>
              <p>
                New runs snapshot enabled rules. Mandatory rules rank first; within that level project rules
                precede global rules, then higher priority wins.
              </p>
            </div>
            <Shield size={17} className="muted-icon" />
          </div>
        }
      >
        <label className="form-field">
          <span>Project rules to manage</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Select a project</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <form className="rule-editor-form" onSubmit={(event) => void saveRule(event)}>
          <div className="form-grid-two">
            <label className="form-field">
              <span>Scope</span>
              <select value={scope} onChange={(event) => setScope(event.target.value as TuringRule['scope'])}>
                <option value="global">Global</option>
                <option value="project" disabled={!projectId}>
                  Selected project
                </option>
              </select>
            </label>
            <label className="form-field">
              <span>Priority (-100 to 100)</span>
              <input
                type="number"
                min={-100}
                max={100}
                value={priority}
                onChange={(event) => setPriority(Math.max(-100, Math.min(100, Number(event.target.value))))}
              />
            </label>
          </div>
          <label className="form-field">
            <span>Rule name</span>
            <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="form-field">
            <span>Description</span>
            <input
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Instruction</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              maxLength={8_000}
              rows={4}
              required
              placeholder="Describe a durable project convention or restriction."
            />
          </label>
          <label className="rule-flag">
            <input
              type="checkbox"
              checked={mandatory}
              onChange={(event) => setMandatory(event.target.checked)}
            />
            Mandatory: lower-priority rules cannot override this rule
          </label>
          <label className="rule-flag">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enabled for new runs
          </label>
          <label className="rule-flag">
            <input
              type="checkbox"
              checked={appliesToAll}
              onChange={(event) => setAppliesToAll(event.target.checked)}
            />
            Apply to all workflow stages
          </label>
          {!appliesToAll && (
            <div className="rule-stage-grid">
              {stageKinds.map((kind) => (
                <label className="rule-flag" key={kind}>
                  <input
                    type="checkbox"
                    checked={appliesTo.includes(kind)}
                    onChange={(event) =>
                      setAppliesTo((current) =>
                        event.target.checked ? [...current, kind] : current.filter((item) => item !== kind),
                      )
                    }
                  />
                  {stageLabels[kind]}
                </label>
              ))}
            </div>
          )}
          <div className="rule-form-actions">
            {editingId && (
              <button type="button" className="secondary-button" onClick={clearForm}>
                Cancel edit
              </button>
            )}
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !name.trim() || !content.trim() || (scope === 'project' && !projectId)}
            >
              <Save size={14} />
              {editingId ? 'Save rule' : 'Add rule'}
            </button>
          </div>
        </form>
        <div className="managed-rule-list">
          {rules.map((rule) => (
            <article className={`managed-rule ${rule.enabled ? '' : 'managed-rule-disabled'}`} key={rule.id}>
              <div>
                <strong>{rule.name}</strong>
                <small>
                  {rule.scope} · priority {rule.priority} · {rule.mandatory ? 'mandatory' : 'advisory'}
                  {rule.appliesTo.length
                    ? ` · ${rule.appliesTo.map((kind) => stageLabels[kind]).join(', ')}`
                    : ' · all stages'}
                </small>
                <p>{rule.description || rule.content}</p>
              </div>
              <div className="managed-rule-actions">
                <button className="quiet-button" onClick={() => void toggleRule(rule)}>
                  {rule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="quiet-button" onClick={() => editRule(rule)}>
                  Edit
                </button>
                <button className="quiet-button danger-text" onClick={() => void removeRule(rule)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
          {!rules.length && <div className="empty-inline">No global or selected project rules yet.</div>}
        </div>
      </SettingsCard>
    </section>
  );
}

function PermissionInfo({
  name,
  text,
  disabled = false,
}: {
  name: string;
  text: string;
  disabled?: boolean;
}) {
  return (
    <div className={`permission-info ${disabled ? 'permission-disabled' : ''}`}>
      <span className={`permission-dot ${disabled ? '' : 'permission-dot-on'}`} />
      <div>
        <strong>
          {name}
          {disabled && <small>Unavailable</small>}
        </strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

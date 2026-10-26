import { useEffect, useState } from 'react';
import { LoaderCircle, Smartphone } from 'lucide-react';
import { api } from '../api';
import { parsePairingRequestId } from '../pairingQr.js';

export function DevicePairingPage({ onPaired }: { onPaired: () => void }) {
  const [deviceName, setDeviceName] = useState('My phone');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [qrRequestId] = useState(() => parsePairingRequestId(window.location.href));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!qrRequestId) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('pairRequest');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [qrRequestId]);

  useEffect(() => {
    if (!requestId || (!qrRequestId && !code)) return;
    let live = true;
    const check = async () => {
      try {
        const result = await api.completePairing(requestId, qrRequestId ? undefined : code);
        if (!live || !('deviceId' in result)) return;
        onPaired();
      } catch (reason) {
        if (!live) return;
        const message = reason instanceof Error ? reason.message : 'Pairing status could not be checked.';
        setError(message);
        if (message.toLowerCase().includes('expired') || message.toLowerCase().includes('already completed'))
          setRequestId('');
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [requestId, code, qrRequestId, onPaired]);

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const result = qrRequestId
        ? await api.claimPairingRequest(qrRequestId, deviceName.trim())
        : await api.claimPairing(code.trim().toUpperCase(), deviceName.trim());
      setRequestId(result.requestId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The pairing code could not be used.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pairing-page">
      <section className="pairing-panel surface-panel">
        <span className="pairing-mark">
          <Smartphone size={22} />
        </span>
        <h1>Connect this device</h1>
        <p className="pairing-description">
          Open this page through the desktop’s Tailscale Serve address. Scan its short-lived QR or enter the
          fallback code. The desktop owner must approve this device before it can view runs.
        </p>
        <label className="form-field">
          <span>Device name</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} />
        </label>
        {qrRequestId ? (
          <div className="inline-callout">
            QR pairing request detected. The desktop owner must approve this phone.
          </div>
        ) : (
          <label className="form-field">
            <span>Pairing code</span>
            <input
              value={code}
              onChange={(event) =>
                setCode(
                  event.target.value
                    .toUpperCase()
                    .replace(/[^A-F0-9]/g, '')
                    .slice(0, 16),
                )
              }
              autoCapitalize="characters"
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={16}
              placeholder="16-character code"
              disabled={Boolean(requestId)}
            />
          </label>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {requestId ? (
          <div className="pairing-waiting" role="status">
            <LoaderCircle size={16} className="spin" /> Waiting for desktop approval…
          </div>
        ) : (
          <button
            className="primary-button pairing-submit"
            onClick={() => void claim()}
            disabled={busy || (!qrRequestId && code.length !== 16) || !deviceName.trim()}
          >
            {busy ? 'Requesting approval…' : 'Request approval'}
          </button>
        )}
        <small className="pairing-expiry-note">
          Pairing codes expire after five minutes. Provider credentials remain on the desktop.
        </small>
      </section>
    </main>
  );
}

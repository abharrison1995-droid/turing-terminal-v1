import { AlertTriangle, RefreshCw } from 'lucide-react';

export interface ConnectionBannerProps {
  /** The latest refresh error. The last successful snapshot stays on screen beneath the banner. */
  message: string;
  onRetry: () => void;
  /** Passed only in the desktop shell, where restarting the bundled master is a real recovery action. */
  onRestart?: () => void;
}

/** A refresh failed after a snapshot loaded: the page keeps its data and says so. Not used on first-load failure. */
export function ConnectionBanner({ message, onRetry, onRestart }: ConnectionBannerProps) {
  return (
    <div className="global-error" role="status" aria-live="polite">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        <strong>Showing last known data</strong> <span>{message}</span>
      </span>
      <button onClick={() => onRetry()}>
        <RefreshCw size={14} aria-hidden="true" /> Retry
      </button>
      {onRestart && (
        <button onClick={() => onRestart()}>
          <RefreshCw size={14} aria-hidden="true" /> Restart Master
        </button>
      )}
    </div>
  );
}

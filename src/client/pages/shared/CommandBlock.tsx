import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/**
 * A command shown for the person to run themselves on the Desktop Master. Turing never runs it. The copy button only
 * puts the text on the clipboard of this device, which is not necessarily the Desktop Master.
 */
export function CommandBlock({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // The clipboard is unavailable; the command stays selectable on screen.
    }
  };
  return (
    <div className="command-block">
      <span className="command-block-label">{label}</span>
      <div className="command-block-line">
        <code tabIndex={0} aria-label={`${label}: ${command}`}>
          {command}
        </code>
        <button
          type="button"
          className="quiet-button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

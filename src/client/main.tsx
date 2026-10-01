/// <reference types="vite-plugin-pwa/client" />
import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { desktop, isDesktopShell, setMasterApiBase, type DesktopRuntime } from './desktop';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

function DesktopStartupError({ runtime, onRestart }: { runtime: DesktopRuntime; onRestart: () => void }) {
  return (
    <main className="desktop-startup-error">
      <div className="desktop-startup-card">
        <div className="desktop-startup-mark">TT</div>
        <p className="eyebrow">TURING TERMINAL · {runtime.version}</p>
        <h1>Desktop Master could not start</h1>
        <p>{runtime.error ?? 'The local Master is offline.'}</p>
        <div className="desktop-startup-actions">
          <button className="primary-button" onClick={onRestart}>
            Restart Master
          </button>
          <button className="secondary-button" onClick={() => void desktop.openLogFolder()}>
            Open logs
          </button>
        </div>
        <small>Diagnostic files: {runtime.logPath}</small>
      </div>
    </main>
  );
}

async function start() {
  if (!isDesktopShell()) {
    registerSW({ immediate: true });
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
    return;
  }

  root.render(<main className="desktop-startup-loading">Starting Turing Terminal…</main>);
  try {
    const runtime = await desktop.runtime();
    setMasterApiBase(runtime.masterUrl);
    if (runtime.status === 'Running' && runtime.masterUrl) {
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      );
      return;
    }
    root.render(<DesktopStartupError runtime={runtime} onRestart={() => void restart()} />);
  } catch (error) {
    root.render(
      <main className="desktop-startup-error">
        Turing Terminal could not check its Desktop Master: {String(error)}
      </main>,
    );
  }
}

async function restart() {
  try {
    const runtime = await desktop.restartMaster();
    setMasterApiBase(runtime.masterUrl);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (error) {
    const runtime = await desktop.runtime();
    root.render(
      <DesktopStartupError runtime={{ ...runtime, error: String(error) }} onRestart={() => void restart()} />,
    );
  }
}

void start();

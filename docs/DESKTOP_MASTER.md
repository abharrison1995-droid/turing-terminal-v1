# Desktop Master

The local Desktop Master, not the React page, owns the workflow engine, SQLite state, provider child processes, execution broker, approval waiters, and run recovery. Closing or refreshing a browser does not cancel an active run. The desktop window may also be hidden while the Master continues running.

## Run the master

Build once, then run the service independently of the browser:

```sh
npm run build
npm start
```

The API binds to `127.0.0.1:4317` by default. A packaged desktop Master uses a per-user data directory and may select a later loopback port if 4317 is occupied by another service. Desktop **Settings** shows the active port; configure Tailscale Serve to that port for phone access. Keep `TT_HOST` loopback-only. Turing trusts Tailscale Serve's user identity headers only because its backend listens on loopback, and still requires a separately approved device cookie.

For development, `npm run dev` starts Vite and the service together. The Vite page at `http://127.0.0.1:5173` proxies API requests to the local master.

## Persistence and restart behavior

Run, stage, approval, event, usage, rule, and broker operation records persist in SQLite. If the browser closes, a running workflow continues as long as the Node service remains running. If the service stops or the machine restarts, active provider processes are interrupted; startup reconciles their runs to a paused state for explicit inspection and resume. The application does not claim that an in-flight provider request survived a service restart.

## Packaged desktop lifecycle

The Tauri 2 shell bundles a platform-built Node runtime, the existing compiled Master, migrations, and production dependencies. A desktop launch validates a responding Turing health endpoint before reusing it, otherwise starts one bundled Master on an available loopback port. A second desktop launch focuses the existing window.

Closing the window hides it and keeps the Master running by default. The desktop preference can instead stop the child process started by that shell; it does not terminate a Master managed by another process. An unexpected Master exit is reported, logged, and can be manually restarted without an automatic crash loop. Startup registration is opt-in and per-user on Windows and Linux.

User state remains outside installed app files:

- Linux: data under `$XDG_DATA_HOME/turing-terminal/data` or `~/.local/share/turing-terminal/data`, settings under `$XDG_CONFIG_HOME/turing-terminal` or `~/.config/turing-terminal`, logs under `$XDG_STATE_HOME/turing-terminal/logs` or `~/.local/state/turing-terminal/logs`.
- Windows: `%LOCALAPPDATA%\TuringTerminal\data`, `config`, and `logs`.

Normal users install the Windows NSIS installer or Linux `.deb`; the AppImage is portable. See [Windows installation](INSTALL_WINDOWS.md), [Linux installation](INSTALL_LINUX.md), and [Packaging](PACKAGING.md). The previous archive/service scripts remain developer packaging helpers and are not required for normal desktop installation.

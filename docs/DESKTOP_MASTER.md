# Desktop Master

The local Node.js service, not the React page, owns the workflow engine, SQLite state, provider child processes, execution broker, approval waiters, and run recovery. Closing or refreshing the browser does not cancel an active run. Reopening the page reloads the persisted dashboard and run history from the master.

## Run the master

Build once, then run the service independently of the browser:

```sh
npm run build
npm start
```

The API binds to `127.0.0.1:4317` by default. The database lives in `~/.turing-terminal/`; set `TT_DATA_DIR` to an owner-only directory to place it elsewhere. Turing applies POSIX `0700`/`0600` permissions where available. Keep `TT_HOST` loopback-only. For authenticated phone access, run `tailscale serve --bg 4317` and follow the pairing steps in [Mobile](MOBILE.md). Turing trusts Tailscale Serve's user identity headers only because its backend listens on loopback, and still requires a separately approved device cookie.

For development, `npm run dev` starts Vite and the service together. The Vite page at `http://127.0.0.1:5173` proxies API requests to the local master.

## Persistence and restart behavior

Run, stage, approval, event, usage, rule, and broker operation records persist in SQLite. If the browser closes, a running workflow continues as long as the Node service remains running. If the service stops or the machine restarts, active provider processes are interrupted; startup reconciles their runs to a paused state for explicit inspection and resume. The application does not claim that an in-flight provider request survived a service restart.

## Desktop packages and background startup

Packages require Node.js 22 or newer. Each artifact contains the built app, migrations, and platform-built production dependencies; Node remains an installed runtime requirement.

On Linux x64, run `npm run package:linux` to build `turing-terminal-linux-x64-v1.0.0.tar.gz`. The package includes `packaging/linux/install-user-service.sh`. Run it as the signed-in desktop user:

```sh
bash packaging/linux/install-user-service.sh ./turing-terminal-linux-x64-v1.0.0.tar.gz
```

It installs under `~/.local/share/turing-terminal`, keeps SQLite data under `~/.local/share/turing-terminal-data`, and creates a user-level `systemd` service. Inspect it with `systemctl --user status turing-terminal.service`; stop it with `systemctl --user stop turing-terminal.service`. It does not use root.

On Windows x64, run `npm run package:windows` from PowerShell to build `turing-terminal-windows-x64-v1.0.0.zip`. Extract the archive and run `install-user-startup.ps1` in PowerShell. It installs a per-user Task Scheduler logon task with limited privileges, puts data under `%LOCALAPPDATA%\TuringTerminal\data`, and starts the master hidden from the visible desktop. Remove the `Turing Terminal Master` task in Task Scheduler to stop startup. This Windows package and task have not been physically built or tested in this Linux environment; the GitHub Actions Windows runner is configured to build the ZIP.

The Linux artifact is built and smoke-checked separately before release. Service installation on a physical desktop, unattended restart after sign-in, Windows package generation, and Windows task startup still need platform acceptance. The UI can be opened or reconnected independently while the master remains running. Tailscale Serve must run on the same desktop and proxy to the loopback service.

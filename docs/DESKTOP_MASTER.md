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

## Background startup and packaging

There is no bundled installer or service-manager integration yet. On Linux, an operator can run `npm start` under a user `systemd` service with `Restart=on-failure`; on Windows, the equivalent is a Task Scheduler logon task running `node dist-server/server/index.js`. Use the repository's absolute path and a dedicated data directory in either configuration. Keep service output and the database directory private. Tailscale Serve must run on the same desktop and proxy to the loopback service.

Automatic installation, upgrades, credential-store integration, Windows/Linux packaging, and unattended startup behavior have not been validated as part of this build.

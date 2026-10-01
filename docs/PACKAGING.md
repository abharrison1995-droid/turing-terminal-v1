# Desktop packaging

## Build layout

Turing Terminal uses a thin Tauri 2 desktop shell around the existing React UI and Fastify Desktop Master. Tauri serves the built desktop UI from its packaged app origin. The UI calls the loopback-only Master over HTTP using the selected loopback port. The Master continues to serve the normal same-origin PWA, manifest, service worker, pairing, authentication, and notification endpoints to browsers and phones.

`npm run desktop:prepare` builds the frontend and server, installs only production npm dependencies into a staging directory, and copies the current Node executable into `src-tauri/resources/runtime/`. The staged app, migrations, and runtime are bundled as Tauri resources. No machine-specific app data is staged. The normal installer therefore does not need Node or npm.

The shell checks ports 4317–4348. It reuses a responding Master only when `/api/health` identifies the Turing Terminal service as loopback-only. If a port is occupied by another service, it tries the next port and starts a bundled Master there. Failure to find a port or start the Master is shown with a log-folder action. The shell does not run a restart loop; desktop settings offers a bounded manual restart.

## Build packages

Build on the native target OS so native Node dependencies and installer formats match that OS:

```sh
npm ci
npm run desktop:build:linux
npm run desktop:release
```

On Windows PowerShell:

```powershell
npm ci
npm run desktop:build:windows
npm run desktop:release
```

Linux produces a Debian package and AppImage. Windows produces a per-user NSIS setup executable. Build scripts do not call AI providers or need provider credentials. The AppImage bundles the app runtime and WebKit/GTK libraries; compatibility still depends on the host system's glibc baseline and graphics drivers. CI builds Linux packages on Ubuntu 22.04.

The desktop shell depends on the operating system's WebView implementation. Debian packages declare GTK 3 and WebKitGTK 4.1. The Windows installer uses the WebView2 bootstrapper if the Microsoft WebView2 runtime is missing. Node.js is included; Git, Tailscale, OpenCode, Codex, Claude Code, and Cline remain optional external tools.

## Data, lifecycle, and security

Mutable state stays outside the installation folder:

- Linux data: `$XDG_DATA_HOME/turing-terminal/data` or `~/.local/share/turing-terminal/data`
- Linux settings: `$XDG_CONFIG_HOME/turing-terminal` or `~/.config/turing-terminal`
- Linux logs: `$XDG_STATE_HOME/turing-terminal/logs` or `~/.local/state/turing-terminal/logs`
- Windows data, settings, and logs: `%LOCALAPPDATA%\TuringTerminal\{data,config,logs}`

The app applies owner-only POSIX permissions to its data, config, and log directories. Uninstall removes app files but keeps these user folders. Closing the desktop window hides the window and leaves the Master running by default; an opt-out setting stops only the Master process started by this shell. Login startup is opt-in and per-user. Single-instance handling focuses the existing window.

Tauri IPC is available only to the bundled local frontend. The Master accepts CORS requests only from Tauri's local app origins (`tauri://localhost` and `http://tauri.localhost`). The local Master continues to bind only to loopback. It does not return secrets in its health response or the desktop readiness list. Packaged app dependencies are built from the production lockfile; staging excludes developer dependencies, databases, env files, and provider credentials.

## Artifact naming

`npm run desktop:release` collects available package outputs under `dist/release/1.0.0-rc1/` and emits SHA-256 checksums and release notes. CI builds Windows and Linux on native runners and combines the packages into a workflow artifact. It does not create a GitHub Release or publish a package.

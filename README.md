# Turing Terminal V1

```text
+=================================================================+
|  T U R I N G   T E R M I N A L                                |
|  LOCAL-FIRST AI WORKFLOW CONTROL ROOM                            |
+=================================================================+
```

Turing Terminal runs coding workflows from a private desktop master. It connects provider CLIs to your projects through a permission-aware tool broker, then gives you a browser/PWA for previews, approvals, progress, diffs, and usage.

The master, project files, provider sign-ins, and run history stay on your computer. Remote phone access is optional and uses Tailscale Serve plus explicit device approval.

## Install on Linux

Requirements: Linux x64, Node.js 22 or newer, npm, Git, and a signed-in desktop user session with systemd.

Clone the repository and build the package:

```sh
git clone https://github.com/abharrison1995-droid/turing-terminal-v1.git
cd turing-terminal-v1
npm ci
npm run package:linux
```

Install and start the per-user master service:

```sh
bash packaging/linux/install-user-service.sh ./turing-terminal-linux-x64-v1.0.0.tar.gz
```

Open **http://127.0.0.1:4317** in your browser. The service starts in your user session and keeps running when you close the browser.

Useful service commands:

```sh
systemctl --user status turing-terminal.service
systemctl --user restart turing-terminal.service
journalctl --user -u turing-terminal.service -f
systemctl --user stop turing-terminal.service
```

The installer stores the app in `~/.local/share/turing-terminal` and private run data in `~/.local/share/turing-terminal-data`. It does not require root.

## Install on Windows

Requirements: 64-bit Windows, Node.js 22 or newer, npm, Git, and PowerShell.

From PowerShell, clone the repository and build the Windows package:

```powershell
git clone https://github.com/abharrison1995-droid/turing-terminal-v1.git
Set-Location .\turing-terminal-v1
npm ci
npm run package:windows
```

Extract the package and install the per-user startup task:

```powershell
Expand-Archive -LiteralPath .\turing-terminal-windows-x64-v1.0.0.zip -DestinationPath .\turing-terminal-windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\turing-terminal-windows\install-user-startup.ps1 -PackageDirectory .\turing-terminal-windows
```

Open **http://127.0.0.1:4317** in your browser. The master starts hidden when you sign in and runs with your normal user privileges. Its data is stored under `%LOCALAPPDATA%\TuringTerminal\data`.

To stop the startup task, open Task Scheduler and remove **Turing Terminal Master**, or run:

```powershell
Unregister-ScheduledTask -TaskName 'Turing Terminal Master' -Confirm:$false
```

The package commands build platform-specific production dependencies on the machine where you run them. The Linux package has been built and smoke-tested; build the Windows package on Windows.

## How to use Turing Terminal

1. **Sign in to a provider on the master computer.** Install and authenticate a supported CLI such as OpenAI Codex, Claude Code, OpenCode, or Cline. Turing uses the CLI's supported sign-in flow and does not need provider API keys for the subscription-backed paths.
2. **Add a project.** In the browser, open **Projects** and register the local project folder that the workflow may access.
3. **Choose a workflow.** Start with a saved workflow or create one. Assign a detected provider and model to each AI stage; add build/test steps, approval gates, or other stages as needed.
4. **Review the preview.** Check the target machine and project, permission mode, provider/model assignments, approval gates, retry bounds, and runtime limits before starting.
5. **Start and supervise the run.** Follow stage progress, respond to approval or clarification requests, and inspect the final diff and review findings. Runs belong to the desktop master, so closing the browser does not stop them.
6. **Use the phone (optional).** On the desktop, configure Tailscale Serve with `tailscale serve --bg 4317`, open the Serve address on your phone, create a pairing QR in **Settings → Paired devices**, and approve the phone on the desktop. See [Mobile setup](docs/MOBILE.md).

Provider sign-in and workflow data live on the master computer. Read [Security](docs/SECURITY.md) before running workflows against important projects.

## Development

To run the development UI and local master instead of installing a package:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on **http://127.0.0.1:4317**. The master binds to loopback; do not expose its port directly to a LAN or the public internet.

Check the project with:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Documentation

- [Desktop Master and packaging](docs/DESKTOP_MASTER.md)
- [Provider setup](docs/PROVIDERS.md)
- [Provider capability matrix](docs/PROVIDER_CAPABILITY_MATRIX.md)
- [Security and trust boundaries](docs/SECURITY.md)
- [Workflows](docs/WORKFLOWS.md)
- [Usage accounting and estimates](docs/USAGE_ACCOUNTING.md)
- [Mobile access](docs/MOBILE.md)
- [Live Tailscale acceptance](docs/LIVE_TAILSCALE_ACCEPTANCE.md)
- [Live multi-machine acceptance](docs/LIVE_MULTIMACHINE_ACCEPTANCE.md)
- [Claude subscription validation](docs/CLAUDE_VALIDATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

# Turing Terminal V1

```text
+=================================================================+
|  T U R I N G   T E R M I N A L                                |
|  LOCAL-FIRST AI WORKFLOW CONTROL ROOM                            |
+=================================================================+
```

Turing Terminal runs coding workflows from a private desktop master. It connects provider CLIs to your projects through a permission-aware tool broker, then gives you a browser/PWA for previews, approvals, progress, diffs, and usage.

The master, project files, provider sign-ins, and run history stay on your computer. Remote phone access is optional and uses Tailscale Serve plus explicit device approval.

## Install on Windows

Download `Turing-Terminal-Setup-x64-1.0.0-rc3.exe` from a successful **Desktop installers** workflow run in this repository. Double-click the installer, then launch **Turing Terminal** from the Start Menu. This release candidate is unsigned, so Windows may show an Unknown Publisher or SmartScreen warning. See [Windows installation](docs/INSTALL_WINDOWS.md).

## Install on Linux

Download `turing-terminal_1.0.0-rc3_amd64.deb` and open it with your distribution's software installer, or use the portable `Turing-Terminal-x86_64-1.0.0-rc3.AppImage`. The app appears in your application menu after the `.deb` install. See [Linux installation](docs/INSTALL_LINUX.md).

Both desktop packages bundle Node.js for Turing Terminal itself. You do not need Node, npm, a terminal setup, or a source checkout. Git, Tailscale, and provider tools remain optional separate installs. Downloading GitHub Actions artifacts requires signing in to GitHub. RC3 is for acceptance testing. The Goal Engine and the dark interface were merged after RC2, so an RC3 build carries them; no `v1.0.0-rc3` tag has been cut and no RC3 installer build exists yet, so build from source to try the current app. Release state and the remaining physical checks are in [V1 readiness](docs/V1_READINESS.md).

## How to use Turing Terminal

1. **Sign in to a provider on the master computer.** Install and authenticate a supported CLI such as OpenAI Codex, Claude Code, OpenCode, or Cline. Turing uses the CLI's supported sign-in flow and does not need provider API keys for the subscription-backed paths.
2. **Add a project.** In the browser, open **Projects** and register the local project folder that the workflow may access.
3. **Choose a workflow.** Start with a saved workflow or create one. Set workflow-level or stage-kind model defaults, then add per-stage overrides where needed. Add build/test steps, approval gates, or an optional Orchestrator as needed.
4. **Review the preview.** Check the target machine and project, permission mode, connection profile and billing lane for each AI stage, exact model and variant, context estimates and limits, approval gates, retry bounds, and runtime limits. Subscription Only and Lock Providers are on by default; verify the billing summary before starting.
5. **Start and supervise the run.** Follow stage progress, respond to approval or clarification requests, and inspect the final diff and review findings. Runs belong to the desktop master, so closing the browser does not stop them.
6. **Use the phone (optional).** Install and sign in to Tailscale separately. In desktop **Settings**, note the Master port, configure Tailscale Serve to proxy HTTPS to `127.0.0.1:<that-port>`, open the Serve address on your phone, create a pairing QR in **Settings → Paired devices**, and approve the phone on the desktop. See [Mobile setup](docs/MOBILE.md).

Provider sign-in and workflow data live on the master computer. Read [Security](docs/SECURITY.md) before running workflows against important projects.

## Development

To run the development UI and local master instead of installing a package:

Install dependencies with `npm ci` on Linux or macOS, or `npm ci --ignore-scripts` in Windows PowerShell. Then start the app:

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on **http://127.0.0.1:4317**. The master binds to loopback; do not expose its port directly to a LAN or the public internet.

Build native packages on their target operating system with `npm run desktop:build:linux` or `npm run desktop:build:windows`. See [Packaging](docs/PACKAGING.md) and [Releasing](docs/RELEASING.md).

Check the project with:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm run docs:links
```

## Documentation

The full index is [docs/README.md](docs/README.md). Start with:

- [Architecture](docs/ARCHITECTURE.md)
- [Development](docs/DEVELOPMENT.md)
- [V1 readiness](docs/V1_READINESS.md)
- [Goal Engine (Grand Projects)](docs/goals/GOAL_ENGINE.md)
- [Desktop Master and packaging](docs/DESKTOP_MASTER.md)
- [Install on Windows](docs/INSTALL_WINDOWS.md)
- [Install on Linux](docs/INSTALL_LINUX.md)
- [Packaging details](docs/PACKAGING.md)
- [Release process](docs/RELEASING.md)
- [RC3 release notes (draft, not cut)](docs/RELEASE_NOTES_1.0.0-rc3.md)
- [Provider setup](docs/PROVIDERS.md)
- [Provider capability matrix](docs/PROVIDER_CAPABILITY_MATRIX.md)
- [Model configuration](docs/MODEL_CONFIGURATION.md), [context management](docs/CONTEXT_MANAGEMENT.md) and [billing safety](docs/BILLING_SAFETY.md)
- [Security and trust boundaries](docs/SECURITY.md)
- [Workflows](docs/WORKFLOWS.md)
- [Usage accounting and estimates](docs/USAGE_ACCOUNTING.md)
- [Mobile access](docs/MOBILE.md)
- [Live Tailscale acceptance](docs/LIVE_TAILSCALE_ACCEPTANCE.md)
- [Live multi-machine acceptance](docs/LIVE_MULTIMACHINE_ACCEPTANCE.md)
- [Claude subscription validation](docs/CLAUDE_VALIDATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

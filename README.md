# Turing Terminal V1

Turing Terminal is a local-first control plane for AI-assisted software workflows. The desktop-side service owns projects, provider CLIs, child processes, SQLite state, and credentials; the browser/PWA is a control surface.

## Current implementation status

This repository contains a local-first desktop control flow with a persistent Node.js master, project discovery, editable saved workflows, run preview, persisted stages/events, provider CLI execution, a per-run execution broker, policy-controlled file and command tools, optional prompt refinement with explicit user confirmation, build/test/shell/conditional/notification stages, rules snapshots, review findings, bounded remediation, approval pauses, interventions, cancellation, history, diffs, and locally observed usage. A live ChatGPT-subscription Codex run created and read a fixture file through the broker; see [live provider validation](docs/LIVE_PROVIDER_VALIDATION.md).

## V1 scope boundaries

- The desktop UI is served by a local Node.js Desktop Master in a browser/PWA; Windows/Linux installers and OS service-manager integration are not packaged.
- The PWA is responsive and caches its static shell. Remote phone access is available through Tailscale Serve after a desktop-approved device pairing; the master still refuses non-loopback binding. The Machines page stores device-local profiles and opens the selected master directly; pairing is per master and requests never fail over. Native push remains unavailable.
- Provider actions pass through Turing's per-run broker. Supervised, Normal, YOLO, and deliberately confirmed ENIGMA modes apply different broker rules; credential access and out-of-project paths remain denied, Git pushes always require approval, and merges/rollbacks always require explicit approval.
- Planning, optional prompt refinement, implementation, build/test, brokered shell commands, review/consolidation, remediation, final gate, checkpoint/commit/push/merge/rollback, human approval, structured conditional branches, and foreground-browser notification stages execute. Automatic retry policy and notification delivery after the browser closes remain incomplete.
- Global/project rules and immutable run snapshots are implemented. Subscription quota/reset telemetry, usage ceilings, API-equivalent cost estimates, and exhaustion forecasts are unavailable. Usage figures are locally observed or provider-reported only when emitted by a CLI.
- Git workflow stages require a clean repository and isolated worktree. They restrict changes to the registered project subtree, record operation/approval results, never force-push, and preserve ignored files during restore. Turing-managed Git stages suppress repository hooks and commit signing. The worktree is not an OS sandbox and does not restrict network or arbitrary package-script execution.

Treat these boundaries as part of the product behavior, not as enabled features. See [Security](docs/SECURITY.md) and [Workflows](docs/WORKFLOWS.md) before configuring a provider run.

## Development

Requirements: Node.js 22 or later, npm, and Git. Provider execution is optional during development; install and authenticate a supported provider CLI on the machine that will run jobs.

```sh
npm install
npm run dev
```

The development UI is served at `http://127.0.0.1:5173`; the API listens on `http://127.0.0.1:4317`. The service binds to loopback only. For remote phone access, use Tailscale Serve and the desktop-approved pairing flow described in [Mobile](docs/MOBILE.md); do not bind the service directly to a network interface.

```sh
npm run typecheck
npm test
npm run build
```

The SQLite database is created in `~/.turing-terminal/` by default. `TT_DATA_DIR` can select another private data directory. `TT_HOST` and `TT_PORT` change the listen address and port; network binding is intentionally not the default.

## Provider setup

- OpenAI Codex CLI: authenticate with ChatGPT using `codex login`; Turing discovers models from the signed-in local app server and does not use OpenAI API-key billing.
- OpenCode: install the official CLI, authenticate through its own `opencode auth` flow, and use its dynamic model list. The adapter invokes the selected model through `opencode run`; it does not ask for OpenAI API keys.
- Claude Code: authenticate using the official Claude Code CLI/subscription flow. Turing invokes `claude -p` with the selected model. It does not extract or transmit Claude credentials.
- Cline: install the official Cline CLI and authenticate with its own supported OAuth/provider setup. The CLI can use ChatGPT Subscription and ClinePass as documented by Cline.

See [Provider capability matrix](docs/PROVIDER_CAPABILITY_MATRIX.md) for current documented support and limits.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Desktop Master](docs/DESKTOP_MASTER.md)
- [Providers](docs/PROVIDERS.md)
- [Live provider validation](docs/LIVE_PROVIDER_VALIDATION.md)
- [Security](docs/SECURITY.md)
- [Workflows](docs/WORKFLOWS.md)
- [Usage accounting](docs/USAGE_ACCOUNTING.md)
- [Mobile](docs/MOBILE.md)
- [Development](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Security status

The master refuses non-loopback binding. Remote control requires both a Tailscale Serve user identity and a desktop-approved, expiring device cookie. Provider credentials stay on the desktop. Device-local machine profiles open one selected master origin at a time; see [Mobile](docs/MOBILE.md) for the pairing and switching limits.

# Phase 2 baseline audit

Audited 2026-10-01 before Phase 2 implementation changes.

## Repository and current architecture

The repository is a local-first TypeScript application: React/Vite PWA, Fastify local service, SQLite migrations, CLI provider adapters, and a durable server-side `RunEngine`. Workflow snapshots and run/stage/event/approval/usage records are persisted. Provider processes are spawned by the service; UI reloads reconnect through API state. Git worktrees are created for clean repositories when the workflow enables isolation.

The production build includes a static PWA shell. The service binds to loopback. Remote pairing, device authentication, Tailscale access, and multi-machine routing are not implemented. The PWA does not cache API responses.

## Baseline checks

| Check                  | Result                                       |
| ---------------------- | -------------------------------------------- |
| `npm test`             | Pass: 49 tests across 21 files               |
| `npm run typecheck`    | Pass                                         |
| `npm run lint`         | Pass                                         |
| `npm run format:check` | Pass                                         |
| `npm run build`        | Pass; client PWA and server TypeScript build |

The supplied baseline mentioned 45 passing tests. The repository currently has 49 passing tests, so the count differs by four; no test failures were observed. Dependency audit was not part of the prescribed baseline commands, so this audit does not independently reconfirm the previously reported zero-vulnerability result.

## Implementation surfaces inspected

- `src/server/runEngine.ts`: persisted run lifecycle, provider invocation, build/test stages, approvals, review/remediation, worktree setup, usage events.
- `src/server/providers.ts`: OpenCode, Claude Code, and Cline CLI adapters; provider calls run as local child processes with structured output parsing and process-tree cancellation.
- `src/server/git.ts` and `src/server/commandPolicy.ts`: read-only diff/checkpoint operations, worktree commands, and package-script allowlist.
- `src/server/security.ts`: child environment filtering and output redaction.
- `migrations/001_initial.sql` through `003_stage_backend.sql`: projects, workflows, runs, stages, events, approvals, interventions, device/pairing tables, review findings, provider backend IDs.
- `src/client/App.tsx`, `vite.config.ts`, and `docs/MOBILE.md`: responsive PWA, installable static shell, offline shell caching, API network-only behavior; no remote pairing flow.
- `src/server/app.ts`, `src/server/runEngine.ts`, and `docs/USAGE_ACCOUNTING.md`: local invocation/process duration and returned token accounting; quota and reset telemetry unavailable.
- Current tests cover API, run/worktree behavior, provider parsing, workflow validation, command policy, environment/output secret handling, project scanning, Git diff and network binding.

## Material gaps confirmed

1. Provider CLIs can invoke their own filesystem and shell tools. Turing records the outer provider process and can redact its output, but it does not mediate each tool operation or enforce project boundaries against a provider's own tools. Existing approval stages are workflow pauses, not tool approvals. YOLO and ENIGMA run creation is deliberately rejected until enforceable mediation exists.
2. Workflow stages for notification are skipped; conditional branches, shell command nodes, commit, merge, and rollback do not have runtime handlers. Git checkpoint only records state.
3. Global/project rules and immutable effective-rule snapshots are absent. Project instruction files are read into prompts, but there is no managed prioritized rules model.
4. Prompt refinement/clarification is absent. Interventions are persisted and added to prompts on later calls, but the current running child is aborted and must be resumed; there is no stage-scoped impact/action audit.
5. Device and pairing tables exist in the initial schema but there are no authenticated pairing/session routes. No Tailscale or multi-machine transport is enabled.
6. Browser notification permission can be enabled, but workflow notification delivery is not implemented.
7. Usage is locally observed. Provider token fields are recorded only when recognized structured output contains them; allowance/reset values are not queried. No live subscription-authenticated job has been validated in this baseline.
8. Provider capabilities currently omit explicit subscription-authentication and tool-mediation fields and need verification against current official docs before integration changes.

## Intended closure order

1. Verify documented provider capabilities and correct the capability matrix.
2. Add an enforceable execution boundary and operation audit. Until a provider's tool calls can be controlled, do not represent that adapter as safely mediated or start a live implementer run through it.
3. Add policy tests for materially different permission modes, project-scope enforcement, and secret protections.
4. Add rules and immutable run snapshots, then conditional and other missing workflow semantics with hard bounds.
5. Implement deliberate Git commit/merge/rollback paths with approval and preservation checks.
6. Complete persistent-service packaging documentation, authenticated remote pairing/Tailscale, mobile controls, machine routing, notifications, and usage validation.
7. Run acceptance checks and record actual limitations; do not claim unsupported provider behavior or remote security.

## Phase 2 implementation follow-up

The implementation has since added the Turing execution broker and permission policy, subscription-backed Codex CLI validation, global/project rules snapshots, conditional branches, prompt refinement with persisted user confirmation, notification-stage browser delivery, first-class Git checkpoint/commit/push/merge/restore operations, and device pairing through Tailscale Serve. Git push and merge/restore remain approval-gated; remote requests require a Tailscale Serve user identity and a separately approved, expiring device cookie. See the feature-specific docs for boundaries and test evidence.

Phase 2 is not fully accepted as V1. Device-local machine profiles now let the user select a master by opening its own origin; a two-master routing acceptance run has not been performed. Pairing uses a manually entered code rather than a QR, and a physical phone/Tailscale round-trip has not been run. Web Push after the browser closes, automatic retry/run-duration policies, provider allowance/reset telemetry, exhaustion forecasts, and API-equivalent price estimates remain unavailable. Windows/Linux installers and unattended service setup are also not packaged. The original baseline sections above describe the audited pre-implementation state and are retained as history.

## Final local validation — 2026-10-01

- `npm run format`: completed; `npm run format:check`: passed.
- `npm run typecheck`: passed; `npm run lint`: passed.
- `npm test -- --reporter=dot`: passed, **79 tests across 17 files**.
- `npm run build`: passed; generated the client PWA and compiled the server.
- `npm audit --omit=dev`: reported **0 vulnerabilities**.
- Production smoke: started the built master with a temporary data directory; `/api/health`, `/`, `/manifest.webmanifest`, `/sw.js`, `/api/dashboard`, and `/api/pairing/devices` all returned HTTP 200. Temporary data was removed afterward.
- Production-source scan found only user-facing HTML/CSS placeholder text; no TODO/FIXME/mock/stub/temporary markers.
- The Tailscale CLI is not installed in this environment, so actual Serve headers, phone pairing, and two-master routing could not be exercised. API pairing tests use simulated headers and are not end-to-end proof.

These checks establish local build and test health, not completion of the V1 acceptance scenarios that need a phone, a live tailnet, and two registered desktop masters.

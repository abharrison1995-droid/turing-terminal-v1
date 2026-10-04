# V1 readiness

This is the canonical release tracker. When another document disagrees with it about release state, this one wins until it is corrected. Update it with evidence whenever a gate changes; never mark an item passed from a mock or unit test when the item says live or physical.

## Current baseline

| Field          | Value                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch         | `master`                                                                                                                                         |
| Baseline HEAD  | `115855ee1347a87ca1c3f02ec0a2f6650ce43477` (merge of Phase 3.6), plus a docs-only correction commit on top                                       |
| Version        | `1.0.0-rc2`                                                                                                                                      |
| Phase          | Phase 3.6 complete (provider, billing, decision, context, usage architecture; migration 014)                                                     |
| Date checked   | 2026-10-04                                                                                                                                       |
| Classification | **Release candidate, pre-Goal-Engine baseline.** Not a final 1.0.0. RC2 is the known-good build immediately before the final V1 scope expansion. |
| Git tag        | `v1.0.0-rc2` marks the last known-good release candidate before the Goal Engine. RC1 (`v1.0.0-rc1`) is superseded.                               |

## Software gates

Run on Linux 6.8 (x64), Node v22.23.1, npm 10.9.8, from a clean `npm ci`.

| Gate                   | Status | Evidence                                                                                                                                                                                                                                              |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`               | Pass   | 627 packages added, 0 vulnerabilities                                                                                                                                                                                                                 |
| `npm run format:check` | Pass   | All files conform to Prettier                                                                                                                                                                                                                         |
| `npm run lint`         | Pass   | ESLint clean                                                                                                                                                                                                                                          |
| `npm run typecheck`    | Pass   | Client and server `tsc` clean                                                                                                                                                                                                                         |
| `npm test`             | Pass   | 32 test files, 172 tests, all passing                                                                                                                                                                                                                 |
| `npm run build`        | Pass   | Client, PWA service worker, and server build                                                                                                                                                                                                          |
| `npm audit --omit=dev` | Pass   | 0 vulnerabilities                                                                                                                                                                                                                                     |
| Native installer CI    | Pass   | `Desktop installers` run 37232178911 (`workflow_dispatch` on `3363f98`, 2026-10-04): Linux gate + `.deb`/AppImage build + smoke; Windows NSIS build, quiet install, startup, PWA manifest, uninstall; release bundle merged. Not physical acceptance. |
| Ordinary push/PR CI    | Pass   | `.github/workflows/ci.yml` (push to `master`, PRs to `master`; deterministic, no credentials). Run 37232084823 green on `3363f98`, 2026-10-04.                                                                                                        |

## Live provider state

"Deterministic" means automated tests with mocked or fixture responses. "Live" means a real account and provider call recorded in a validation document.

| Provider            | Deterministic validation                                              | Live validation                                                                                                                          | Pending                                                          |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Codex (ChatGPT sub) | Adapter, args, lane, snapshots                                        | Planner → Implementer → Reviewer broker run on 2026-10-01 (RC1-era code); see [LIVE_PROVIDER_VALIDATION.md](LIVE_PROVIDER_VALIDATION.md) | Re-run on RC2+ code before final                                 |
| Claude Code         | Adapter, auth gating, mediation flags                                 | **None.** Auth detected; run hit HTTP 429 weekly limit, zero tokens                                                                      | Post-reset check in [CLAUDE_VALIDATION.md](CLAUDE_VALIDATION.md) |
| OpenCode Go         | Subscription-only workflow with `high`/`max` variants, exact route    | **None**                                                                                                                                 | Live auth, catalog, and run; PAYG fallback is unverifiable       |
| ClinePass           | Exact-route preservation, usage-billing blocked in Subscriptions Only | **None**                                                                                                                                 | Live run; Cline has no documented catalog call                   |
| OpenRouter          | Mocked HTTP: budgets, reservation, telemetry, price ceilings          | **None** (no live request was made for RC2)                                                                                              | Live key, metered stage, reconciliation                          |
| Decision Layer/Jev  | Mocked responses: rules, judges, UNCERTAIN escalation, consent        | **None**                                                                                                                                 | Live Jev request (optional feature)                              |

## Physical acceptance

None of these has been performed on real devices. CI smoke tests do not count.

| Area                     | Status  | Procedure                                                              |
| ------------------------ | ------- | ---------------------------------------------------------------------- |
| Windows install and run  | Pending | [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md), [RELEASING.md](RELEASING.md) |
| Linux install and run    | Pending | [INSTALL_LINUX.md](INSTALL_LINUX.md)                                   |
| iPhone / PWA / Tailscale | Pending | [LIVE_TAILSCALE_ACCEPTANCE.md](LIVE_TAILSCALE_ACCEPTANCE.md)           |
| Push notifications       | Pending | Included in the Tailscale acceptance checklist                         |
| Two-master isolation     | Pending | [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md)     |

## Known blockers for 1.0.0

1. Grand Project Planner / Goal Engine not implemented.
2. Model Opportunity Layer not implemented.
3. No physical acceptance evidence (table above).
4. Claude Code, OpenCode Go, ClinePass live validation outstanding.

## Known non-blocking limitations

- Windows installer is unsigned (Unknown Publisher / SmartScreen). Signing needs an approved process.
- Provider-side PAYG fallback (OpenCode Go balance, ClinePass overflow, ChatGPT credits, Claude extra usage) cannot be verified by Turing; Run Preview says so.
- Provider allowance and reset are not queried for CLI backends.
- Cline CLI has no documented model catalog; explicit model/provider values are required.
- OpenRouter and the Decision Layer are optional and off by default.
- Light theme only.

## V1 scope still to implement

Two capabilities remain before final acceptance. After they land, V1 enters strict feature freeze.

1. **Grand Project Planner / Goal Engine.** Persistent orchestration above the bounded workflow engine: structured Goal Contract, milestones, evidence, role-based route blueprint (pinned routes and explicitly authorised pools), periodic and blocking reviews, hard bounds, resumable across restarts. Executes as many ordinary bounded runs; does not rewrite `RunEngine`.
2. **Model Opportunity Layer.** Extends the existing model catalog (Last Known semantics preserved) with observation history, an Opportunity Board, refresh policy, and optional notifications. Distinguishes provider-advertised, locally discovered, and Turing-validated models. Never rewrites active workflows or Goals and never allows a silent free-to-metered transition.

## Hardening after feature freeze

Push/PR CI, full regression, migration coverage, restart/recovery, Goal resume, route-pool correctness, catalog failure behaviour, no free-to-PAYG transition, live provider validation, physical installs, iPhone/Tailscale, multi-master isolation, security review, package verification, documentation reconciliation. Then cut the next RC (expected RC3).

## Exit criteria for `1.0.0`

All must have recorded evidence in this file:

1. Goal Engine and Model Opportunity Layer complete and feature freeze observed.
2. Full software gate green on the release commit, enforced by push/PR CI.
3. Native installer CI green on the release tag; checksums recorded.
4. Windows and Linux physical installs verified.
5. iPhone pairing over Tailscale, remote approval/intervention, reconnect, and notifications verified.
6. Two-master isolation verified.
7. Live validation passed for each provider the release documents as supported, or that provider is explicitly documented as unvalidated.
8. Restart/recovery, including Goal resume, verified.
9. No free-to-metered silent transition (tests plus live check where possible).
10. Security review complete; no open high-severity findings.
11. Documentation reconciled; no stale RC wording in active docs.
12. Version bumped to `1.0.0` only after items 1-11.

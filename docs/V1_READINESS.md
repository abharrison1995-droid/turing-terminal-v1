# V1 readiness

This is the canonical release tracker. When another document disagrees with it about release state, this one wins until it is corrected.

Rules for editing it:

- Update it with evidence whenever a gate changes.
- Never mark an item passed from a mock or unit test when the item says live or physical.
- Keep it current. Replace a row that is out of date; do not append amendments below it.

The stage-by-stage record up to 2026-10-20 is frozen in [history/V1_READINESS_LOG.md](history/V1_READINESS_LOG.md).

**V1 is not release-ready.**

## Current baseline

| Field            | Value                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date checked     | 2026-10-20                                                                                                                                                                                              |
| Branch           | `master` at `5316527` (merge of PR #5)                                                                                                                                                                  |
| Version          | `1.0.0-rc2` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src/shared/version.ts`                                                                                          |
| Last tag         | `v1.0.0-rc2` (2026-10-04). It predates the Goal Engine and the UI overhaul. No later release candidate has been cut.                                                                                    |
| Merged since RC2 | Goal Engine (PR #3, 2026-10-17, `cc57c0e`) and its follow-ups `2f14d20` and `5d35453`; UI overhaul (PR #4, 2026-10-20, `bade6b8`); desktop installer artifact retention (PR #5, 2026-10-20, `5316527`). |
| Repository       | Public since 2026-10-17, so hosted runners are free. A pre-change scan found only test fixtures with placeholder keys.                                                                                  |

## Software gates

| Gate                   | Status                    | Evidence                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push/PR CI (`ci.yml`)  | Pass                      | Run 39394928435 on `5316527`, 2026-10-20. Runs the full gate below.                                                                                                                                                                                                              |
| Local full gate        | Pass                      | 2026-10-20, Linux 6.8, clean `npm ci` (629 packages), code identical to `5316527`: `format:check`, `lint`, `typecheck`, `npm test` (**210 files / 3,818 tests**), `build`, `npm audit --omit=dev`. The build keeps its existing Vite warning that the main chunk exceeds 500 kB. |
| `npm audit --omit=dev` | Pass                      | 0 vulnerabilities. The full-tree `npm audit` reports 2 critical advisories in dev-only `shell-quote` (via `concurrently`); see [Open decisions](#open-owner-decisions).                                                                                                          |
| Native installer CI    | Not run on current master | Last success: run 37232871368 on the `v1.0.0-rc2` tag (`2ae9dfc`), 2026-10-04: Linux gate, `.deb`/AppImage build and smoke; Windows NSIS build, quiet install, startup, uninstall. Not physical.                                                                                 |

## Feature scope

| Capability                                                                          | State on `master`                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow engine, providers, billing lanes, usage ledger, Decision Layer, OpenRouter | As shipped in RC2.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Queued-run crash recovery (HR-Q4)                                                   | Ordinary queued runs are started once after a restart (`recoverQueuedRunsAfterRestart`). Owner accepted the code (decision d3e4, 2026-10-17, `c775a6b`). Restart qualification on the release build is outstanding.                                                                                                                                                                                                      |
| Queued-run cancellation                                                             | Ordinary queued runs can be cancelled and will not start (`0701f9f`). Goal-owned and probe runs are refused.                                                                                                                                                                                                                                                                                                             |
| Goal Engine (Grand Projects)                                                        | Merged, but production constructs `DisabledGoalExecutor` (`src/server/index.ts`). Goals can be defined, approved, persisted, recovered and authored through user-pinned authoring runs, but no proposal, child or review run starts from a Goal. A production Goal therefore cannot reach handoff; the handoff, attestation, completion and correction paths below are exercised by fake-provider end-to-end tests only. |
| Goal delivery                                                                       | Manual handoff only. Turing never writes the user's base branch. The checked-out-worktree writer `applyApprovedGoalToBase` is quarantined because it can overwrite ignored files.                                                                                                                                                                                                                                        |
| Goal completion                                                                     | Version-2 completion: the user attests external integration, Turing observes ancestry, and a separate recorded user decision completes the Goal with a proof. Desktop-only routes; paired remote callers get 403 `desktop_required`. Attestations can be disputed, withdrawn or superseded through an append-only ledger. Ancestry is checked; content preservation is not proven.                                       |
| Goal production qualification                                                       | Not started. Planned as a separate stage (7C.3 in [GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md](GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md)) after the open Goal decisions below.                                                                                                                                                                                                                                       |
| Model Opportunity Layer                                                             | V1 scope. Not started.                                                                                                                                                                                                                                                                                                                                                                                                   |
| UI overhaul                                                                         | Merged. Dark theme only, new shell, workspaces, mobile PWA layout and skull branding. An owner-approved exception to the feature freeze; it does not start the Model Opportunity Layer.                                                                                                                                                                                                                                  |

## Live provider state

"Deterministic" means automated tests with mocked or fixture responses. "Live" means a real account and provider call recorded in a validation document. No live provider run has been made since RC2.

| Provider            | Deterministic validation                                              | Live validation                                                                                                                          | Pending                                                          |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Codex (ChatGPT sub) | Adapter, args, lane, snapshots                                        | Planner → Implementer → Reviewer broker run on 2026-10-01 (RC1-era code); see [LIVE_PROVIDER_VALIDATION.md](LIVE_PROVIDER_VALIDATION.md) | Re-run on current code                                           |
| Claude Code         | Adapter, auth gating, mediation flags                                 | **None.** Auth detected; the run hit an HTTP 429 weekly limit with zero tokens                                                           | Post-reset check in [CLAUDE_VALIDATION.md](CLAUDE_VALIDATION.md) |
| OpenCode Go         | Subscription-only workflow with `high`/`max` variants, exact route    | **None**                                                                                                                                 | Live auth, catalog and run; PAYG fallback is unverifiable        |
| ClinePass           | Exact-route preservation, usage billing blocked in Subscriptions Only | **None**                                                                                                                                 | Live run; Cline has no documented catalog call                   |
| OpenRouter          | Mocked HTTP: budgets, reservation, telemetry, price ceilings          | **None**                                                                                                                                 | Live key, metered stage, reconciliation                          |
| Decision Layer/Jev  | Mocked responses: rules, judges, UNCERTAIN escalation, consent        | **None**                                                                                                                                 | Live Jev request (optional feature)                              |

## Physical and live acceptance

CI smoke tests do not count. On 2026-10-15 the owner deferred the remaining iPhone and Tailscale rows and all physical Windows checks to the end of the verification programme. Deferral is scheduling only; these gates stay open.

| Area                                  | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows install and run               | Pending | Procedure: [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md), [RELEASING.md](RELEASING.md)                                                                                                                                                                                                                                                                                                   |
| Linux install and run                 | Pending | Procedure: [INSTALL_LINUX.md](INSTALL_LINUX.md). The owner's live Master runs from a source build, not an installed package.                                                                                                                                                                                                                                                        |
| iPhone PWA over Tailscale             | Partial | 2026-10-15, physical iPhone ([LIVE_TAILSCALE_ACCEPTANCE.md](LIVE_TAILSCALE_ACCEPTANCE.md)): Serve to loopback, remote approval, intervention with pause and resume, run persistence across a PWA relaunch, and revocation (401 afterwards) passed. 2026-10-20: the owner reports QR pairing works on the new build ([ui/EVIDENCE.md](ui/EVIDENCE.md)); not independently checked.   |
| iPhone rows not yet recorded          | Open    | QR claim method, manual-code pairing, the 30-second locked-phone interval, home-screen installation, push notifications, and the UI checklist in [ui/UI5_SCOPE.md](ui/UI5_SCOPE.md) §7 (insets, keyboard, landscape, offline).                                                                                                                                                      |
| Desktop-only Goal routes over Serve   | Pass    | 2026-10-15 from the iPhone: all five routes returned 403 (the `desktop_required` code was inferred from source). 2026-10-17 from a disposable second paired browser: all five returned 403 `desktop_required`, device administration returned 403, and Goal, approval and run tables were unchanged. See [GOAL_ENGINE_CLOSURE_2026-10-17.md](GOAL_ENGINE_CLOSURE_2026-10-17.md) §4. |
| Live Tailscale verification (overall) | Partial | Not waived. Owner condition (O1, 2026-10-13): a remote request misclassified as local that reaches a desktop-only Goal route is a blocking defect.                                                                                                                                                                                                                                  |
| Two-master isolation                  | Pending | Procedure: [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md)                                                                                                                                                                                                                                                                                                       |
| Restart and recovery on release build | Pending | Includes HR-Q4 and Goal resume.                                                                                                                                                                                                                                                                                                                                                     |

## Blockers for 1.0.0

1. Model Opportunity Layer not implemented.
2. Goal Engine production qualification not started; production runs `DisabledGoalExecutor`.
3. Owner decisions that change Goal completion semantics (content-verified integration, recovery copy) are open. They should be settled before the UI exposes them further.
4. Physical and live acceptance incomplete (table above), including live Tailscale and the HR-Q4 restart qualification.
5. Live provider validation outstanding for Claude Code, OpenCode Go and ClinePass; Codex needs a re-run on current code.
6. Native installer CI not run on current `master`; no release candidate cut since RC2.

## Open owner decisions

| Decision                        | Record                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content-verified integration    | Approve or reject a new versioned policy that refuses merges discarding accepted Goal work, and decide whether the current ancestry-only policy stays available. [GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md](GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md) |
| Stuck-Goal recovery copy        | Confirm the should-fix: abandon waits for in-flight work, and "pause then abandon" applies only from `running`. [GOAL_ENGINE_CLOSURE_2026-10-17.md](GOAL_ENGINE_CLOSURE_2026-10-17.md) §7                                                                   |
| X1 authentication wording       | Accept, amend or reject the proposed wording. [SECURITY.md](SECURITY.md) still calls S1b pending, although O1 was approved on 2026-10-13. [GOAL_X1_AUTH_WORDING_PROPOSAL.md](GOAL_X1_AUTH_WORDING_PROPOSAL.md)                                              |
| S1b process boundary (O2)       | O1 is approved for V1, conditionally: a same-user local process is not distinguished from the desktop UI. O2, a verified process boundary, may be deferred past V1. [GOAL_TRUSTED_CALLER_BOUNDARY.md](GOAL_TRUSTED_CALLER_BOUNDARY.md)                      |
| Dev-only `shell-quote` advisory | Delegated by the owner on 2026-10-20: take the safest fix in a separate dependency change.                                                                                                                                                                  |

## Known non-blocking limitations

- The Windows installer is unsigned (Unknown Publisher / SmartScreen). Signing needs an approved process.
- Provider-side PAYG fallback (OpenCode Go balance, ClinePass overflow, ChatGPT credits, Claude extra usage) cannot be verified by Turing; Run Preview says so.
- Provider allowance and reset are not queried for CLI backends.
- Cline CLI has no documented model catalog; explicit model and provider values are required.
- OpenRouter and the Decision Layer are optional and off by default.
- Dark theme only; there is no theme switch.
- Goal completion proves ancestry at an observed time, not content preservation or later ref state. Git observation and SQLite persistence are not atomic, and the per-Goal lock is in-process only; cross-process CAS is not qualified.
- Goal Git behaviour is tested on Linux (Git 2.43) only; Windows is unverified.
- A reload or second window bypasses the client-side guard against a duplicate completion or correction write; server idempotency is authoritative.
- Accessibility is checked by jsdom tests and static scans. No WCAG 2.2 AA conformance is claimed.

## Hardening before release

Full regression, migration coverage, restart and recovery (including Goal resume), route-pool correctness, catalog failure behaviour, no free-to-PAYG transition, live provider validation, physical installs, iPhone over Tailscale, multi-master isolation, security review, package verification, and documentation reconciliation. Then cut the next release candidate (expected RC3).

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

# V1 readiness

This is the canonical release tracker. When another document disagrees with it about release state, this one wins until it is corrected.

Rules for editing it:

- Update it with evidence whenever a gate changes.
- Never mark an item passed from a mock or unit test when the item says live or physical.
- Keep it current. Replace an item that is out of date; do not append amendments below it.

The stage-by-stage record up to 2026-10-20 is frozen in [history/V1_READINESS_LOG.md](history/V1_READINESS_LOG.md).

**V1 is not release-ready.**

## Current baseline

- **Date checked:** 2026-10-21.
- **Branch:** `master` at `6533844` (`6533844281d2ff9cf688286188ac35596b2bbb22`); local and public `master` agree. Current development HEAD is `e6120c1` (`e6120c1905db5ee7a5f20333c029c555a805cd5e`), not `master`.
- **Version:** `1.0.0-rc2` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src/shared/version.ts`.
- **Last tag:** `v1.0.0-rc2` (2026-10-04). It predates the Goal Engine and the UI overhaul. No RC3 has been cut.
- **Merged since RC2:** Goal Engine (PR #3, 2026-10-17, `cc57c0e`) and its follow-ups `2f14d20` and `5d35453`; UI overhaul (PR #4, 2026-10-20, `bade6b8`); desktop installer artifact retention (PR #5, 2026-10-20, `5316527`). The accepted Goal composition commit `e6120c1` is the current development HEAD, not the pushed `master`.
- **Repository:** Public since 2026-10-17, so hosted runners are free. A pre-change scan found only test fixtures with placeholder keys.

## Recent durable progress

- **Goal production composition accepted deterministically.** Development commit `e6120c1` enables `createProductionGoalComposition` with `TuringGoalExecutor`, `ResolvedGoalRunPlanProvider` and `requireResolvedRoutes`. Acceptance passed 292 tests across nine selected Goal suites plus `format:check`, `lint` and `typecheck`. It proves the exact persisted route, isolation, manual handoff, and the user's base staying untouched until user action. It is not live-provider, physical-device or release qualification, and `applyApprovedGoalToBase` remains quarantined. `master` CI does not cover this development commit.
- **Model Opportunity Layer design independently accepted.** Author job `2e8be4f50f2b4bfd9a73d83af7f18b12` (`opencode-go/deepseek-v4.1-flash`); review job `2a1f800fc3f0470cbc324afd2b6efc6a` (`opencode-go/glm-5.2`, ACCEPT). Implementation has not started. The observation schema/writer must wait for the owner's observation-history retention decision.
- **Audit evidence refreshed on the master tree.** At `6533844`, `npm audit --json` and `npm audit --omit=dev` both exit 0 with 0 vulnerabilities, and `npm ls shell-quote --all` shows `shell-quote@1.12.0`. No dependency change was made.

## Software gates

- **Push/PR CI (`ci.yml`): Pass on `master`.** Run 161 ([39523812376](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/39523812376)) succeeded on `6533844`, 2026-10-21. This is not CI for development HEAD `e6120c1`.
- **Goal production-composition acceptance: Pass (deterministic).** `e6120c1`: 292 tests across nine selected Goal suites plus `format:check`, `lint`, `typecheck`; proves exact persisted route, isolation, manual handoff, and base untouched until user action. Provider boundary faked; not live/physical/release qualification.
- **Local full gate: Last recorded on `5316527`.** 2026-10-20, Linux 6.8, clean `npm ci` (629 packages), code identical to `5316527`: `format:check`, `lint`, `typecheck`, `npm test` (**210 files / 3,818 tests**), `build`, `npm audit --omit=dev`. The build keeps its existing Vite warning that the main chunk exceeds 500 kB. Not re-recorded here on `6533844` or `e6120c1`.
- **`npm audit` on master tree `6533844`: Pass.** `npm audit --json` and `npm audit --omit=dev` both exit 0 with 0 vulnerabilities; `npm ls shell-quote --all` shows `shell-quote@1.12.0`. No dependency change was made.
- **Native installer CI: Not run on current master.** No desktop-installer run occurred on current `master`. Last success: run 37232871368 on the `v1.0.0-rc2` tag (`2ae9dfc`), 2026-10-04: Linux gate, `.deb`/AppImage build and smoke; Windows NSIS build, quiet install, startup, uninstall. Not physical.

## Feature scope (development HEAD `e6120c1`)

The publicly pushed `master` is `6533844`. The accepted Goal composition below is on the development HEAD and is not covered by CI run 161.

- **Workflow engine, providers, billing lanes, usage ledger, Decision Layer, OpenRouter:** As shipped in RC2.
- **Queued-run crash recovery (HR-Q4):** Ordinary queued runs are started once after a restart (`recoverQueuedRunsAfterRestart`). Owner accepted the code (decision d3e4, 2026-10-17, `c775a6b`). Restart qualification on the release build is outstanding.
- **Queued-run cancellation:** Ordinary queued runs can be cancelled and will not start (`0701f9f`). Goal-owned and probe runs are refused.
- **Goal Engine (Grand Projects):** Accepted at `e6120c1`: production calls `createProductionGoalComposition`, which wires `TuringGoalExecutor` through `ResolvedGoalRunPlanProvider` with `requireResolvedRoutes`. Goals can be defined, approved, persisted, recovered and authored; proposal, child, review and verification runs now go through ordinary persisted runs on the exact route. Deterministic acceptance only; not live-provider, physical-device or release qualification.
- **Goal delivery:** Manual handoff only. Turing never writes the user's base branch. The checked-out-worktree writer `applyApprovedGoalToBase` is quarantined because it can overwrite ignored files.
- **Goal completion:** Version-2 completion: the user attests external integration, Turing observes ancestry, and a separate recorded user decision completes the Goal with a proof. Desktop-only routes; paired remote callers get 403 `desktop_required`. Attestations can be disputed, withdrawn or superseded through an append-only ledger. Ancestry is checked; content preservation is not proven.
- **Goal production qualification:** Deterministic production-composition qualification passed at `e6120c1` (292 tests across nine selected Goal suites). Live-provider, physical-device, Windows and release qualification are not started.
- **Model Opportunity Layer:** V1 scope. Design independently accepted (author job `2e8be4f5…`, `opencode-go/deepseek-v4.1-flash`; review job `2a1f800f…`, `opencode-go/glm-5.2`, ACCEPT). Implementation not started. The observation schema/writer is blocked on the owner's observation-history retention decision.
- **UI overhaul:** Merged. Dark theme only, new shell, workspaces, mobile PWA layout and skull branding. An owner-approved exception to the feature freeze; it does not start the Model Opportunity Layer.

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

- **Windows install and run: Pending.** Procedure: [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md), [RELEASING.md](RELEASING.md).
- **Linux install and run: Pending.** Procedure: [INSTALL_LINUX.md](INSTALL_LINUX.md). The owner's live Master runs from a source build, not an installed package.
- **iPhone PWA over Tailscale: Partial.** 2026-10-15, physical iPhone ([LIVE_TAILSCALE_ACCEPTANCE.md](LIVE_TAILSCALE_ACCEPTANCE.md)): Serve to loopback, remote approval, intervention with pause and resume, run persistence across a PWA relaunch, and revocation (401 afterwards) passed. 2026-10-20: the owner reports QR pairing works on the new build ([ui/EVIDENCE.md](ui/EVIDENCE.md)); not independently checked.
- **iPhone rows not yet recorded: Open.** QR claim method, manual-code pairing, the 30-second locked-phone interval, home-screen installation, push notifications, and the UI checklist in [history/ui/UI5_SCOPE.md](history/ui/UI5_SCOPE.md) §7 (insets, keyboard, landscape, offline).
- **Desktop-only Goal routes over Serve: Pass.** 2026-10-15 from the iPhone: all five routes returned 403 (the `desktop_required` code was inferred from source). 2026-10-17 from a disposable second paired browser: all five returned 403 `desktop_required`, device administration returned 403, and Goal, approval and run tables were unchanged. See [GOAL_ENGINE_CLOSURE_2026-10-17.md](history/goals/GOAL_ENGINE_CLOSURE_2026-10-17.md) §4.
- **Live Tailscale verification (overall): Partial.** O1 was conditionally accepted for V1 on 2026-10-13, with live Tailscale identity-header/Host behaviour verification as its condition; O2 may be post-V1. This is not an open owner choice. The condition is not waived: a remote request misclassified as local that reaches a desktop-only Goal route is a blocking defect.
- **Two-master isolation: Pending.** Procedure: [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md).
- **Restart and recovery on release build: Pending.** Includes HR-Q4 and Goal resume.

## Blockers for 1.0.0

1. Model Opportunity Layer not implemented. The design is accepted; the observation schema/writer waits for the observation-history retention decision.
2. Goal production composition is accepted deterministically at `e6120c1`, but it is not live-provider, physical-device or release qualified. `master` CI does not cover `e6120c1`, and `applyApprovedGoalToBase` remains quarantined.
3. Completion-policy decision open: ancestry-only completion versus a versioned content-verified policy.
4. Physical and live acceptance incomplete (list above), including live Tailscale identity-header/Host verification and the HR-Q4 restart qualification.
5. Live provider validation outstanding for Claude Code, OpenCode Go and ClinePass; Codex needs a re-run on current code.
6. Native installer CI not run on current `master`; no release candidate cut since RC2.

## Open owner decisions

- **Completion policy:** Choose ancestry-only completion or a new versioned content-verified policy, and whether ancestry-only stays available. [GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md](proposals/GOAL_CONTENT_VERIFIED_INTEGRATION_DESIGN.md).
- **Observation-history retention:** Decide how long the Model Opportunity Layer keeps observation history. Not recorded yet; blocks the observation schema/writer.

## Known non-blocking limitations

- Stuck-Goal recovery copy remains unresolved but is non-material: abandon waits for in-flight work, and "pause then abandon" applies only from `running`.
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

Full regression, migration coverage, restart and recovery (including Goal resume), route-pool correctness, catalog failure behaviour, no free-to-PAYG transition, live provider validation, physical installs, iPhone over Tailscale, live Tailscale identity-header/Host verification (the O1 condition), multi-master isolation, security review, package verification, and documentation reconciliation. Implement the Model Opportunity Layer only after the observation-history retention decision. Then cut the next release candidate (expected RC3).

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

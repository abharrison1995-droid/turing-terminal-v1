# V1 readiness

This is the canonical release tracker. When another document disagrees with it about release state, this one wins until it is corrected.

Rules for editing it:

- Update it with evidence whenever a gate changes.
- Never mark an item passed from a mock or unit test when the item says live or physical.
- Keep it current. Replace an item that is out of date; do not append amendments below it.

The stage-by-stage record up to 2026-10-20 is frozen in [history/V1_READINESS_LOG.md](history/V1_READINESS_LOG.md).

**V1 is not release-ready.**

## Current baseline

- **Date checked:** 2026-10-22.
- **Branch:** Public local and remote `master` remain at `6533844` (`6533844281d2ff9cf688286188ac35596b2bbb22`); local and public `master` agree. GitHub CI run [39523812376](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/39523812376) passes on that SHA. **That is a `master` result and is not validation of the current development branch.** The current development branch is `codex/v1-release-preparation-2026-10-21` at HEAD `cdc590a` (`cdc590a606add1076a572eb85b317429dd3d1c9e`), not `master`.
- **Version:** `1.0.0-rc3` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src/shared/version.ts`. `.github/workflows/desktop-installers.yml` triggers on the `v1.0.0-rc3` tag and collects RC3-named artifacts, so package, Tauri, Cargo and installer configuration are consistently prepared for `1.0.0-rc3`. **No RC3 tag, artifact or release exists.** The latest cut and the last installer success are RC2-era.
- **Last tag:** `v1.0.0-rc2` (2026-10-04). It predates the Goal Engine and the UI overhaul. No RC3 has been cut.
- **Merged since RC2:** Goal Engine (PR #3, 2026-10-17, `cc57c0e`) and its follow-ups `2f14d20` and `5d35453`; UI overhaul (PR #4, 2026-10-20, `bade6b8`); desktop installer artifact retention (PR #5, 2026-10-20, `5316527`). The accepted Goal composition commit `e6120c1` is the accepted Goal production-composition baseline, not the pushed `master`.
- **Repository:** Public since 2026-10-17, so hosted runners are free. A pre-change scan found only test fixtures with placeholder keys.

## Recent durable progress

- **Goal production composition present and deterministically tested on the current development line.** Production calls `createProductionGoalComposition`, wiring `TuringGoalExecutor` through `ResolvedGoalRunPlanProvider` with `requireResolvedRoutes` (accepted at `e6120c1`: 292 tests across nine selected Goal suites plus `format:check`, `lint` and `typecheck`). That composition is present on development HEAD `cdc590a`. It proves the exact persisted route, isolation, manual handoff, and the user's base staying untouched until user action. It is not live-provider, physical-device or release qualification; restart and release qualification are outstanding, and `applyApprovedGoalToBase` remains quarantined. `master` CI does not cover this development branch.
- **Model Opportunity Layer design accepted; retention approved; implementation not started.** Prior revision accepted: author job `2e8be4f50f2b4bfd9a73d83af7f18b12` (`opencode-go/deepseek-v4.1-flash`); independent review job `2a1f800fc3f0470cbc324afd2b6efc6a` (`opencode-go/glm-5.2`, ACCEPT). Correction patch job `d86d409d59d841949ba581ebb163534f` (`opencode-go/beam-free`) was independently reviewed ACCEPT by job `d71b755ad25049b19eef37174bdf545b` (`opencode-go/minimax-m3.1-flash-free`). The owner approved the retention decision on 2026-10-21: 90 days, references for active admission held through expiry, deletes performed by an explicit job. The observation storage, writer, readers and retention job remain unimplemented. A separate question about historical-proof semantics after retention expiry was asked and is unanswered; no outcome is chosen here. A cost-wording correction is pending review and is not integrated.
- **Model Opportunity Layer documentation reconciliation.** Docs commit `67f94b8` (docs-only) on Goal production-composition baseline `e6120c1`. Worker/reviewer evidence: `88a8d04af0054df5a574f3cbd79232a9` (deepseek), `8b88289051974397b80af107d2713833` (glm-5.2 ACCEPT), `926d8ab9570e4f54bfcbfd42615e536e` (glm-5.3-flash), `6a8195dbb54f4a6aa5563894838983fb` (glm-5.3 ACCEPT). Root checks: docs:links (90 Markdown), format:check, git diff --check passed. The corrected revision was independently reviewed ACCEPT by `d71b755ad25049b19eef37174bdf545b`; no observation schema/writer has been implemented.
- **Model Opportunity Layer wording corrections (review `9295a89374954d0f89e4329bf6051399`).** Non-blocking wording only: chronology in the design status/traceability block (review `d25027e1…` returned REVISE; correction `d86d409d…` plus ACCEPT review `d71b755a…` address it), §8 row 5 clarified as binding-only proof sites before retention versus DB-backed observation-dependent reproof/durable-reference proof retention-gated, and `loadStoredEnvironment` clarified to read observations only after the migration is approved and exists. No product decision, ID, citation, policy or source claim changed.
- **Audit evidence refreshed on the master tree.** At `6533844`, `npm audit --json` and `npm audit --omit=dev` both exit 0 with 0 vulnerabilities, and `npm ls shell-quote --all` shows `shell-quote@1.12.0`. No dependency change was made.
- **Startup deferral.** Development commit `3558d38` (`3558d388ef2997e87c6a98cc32a13d3b228fe5d7`) defers startup work. Implementer job `5cf062ba84244597b40f205d0703ee28` (`opencode-go/deepseek-v4.1-flash`, timed out but diff returned); independent review `dcb28a2e383f4c5ba5e3c486d2a99964` (`opencode-go/beam-free`, ACCEPT); correction patch jobs `cbf7c4e7e2174e42907c06b7ca352f07` and `d7a5667c786f4c2fbc8b7ad3d03b0352` (`opencode-go/glm-5.3-flash`). Root validation passed: six focused suites / 164 tests, plus `format:check`, `lint` and `typecheck`. Reviewer noted direct authoring/route-probe deferred-start and end-to-end listener-bind-failure tests remain coverage opportunities; they are not claimed as passed. V1 remains not release-ready.
- **Goal completion-policy decisions approved (2026-10-21).** A new content verifier applies to new completions; ancestry-only records for older completions are historical and immutable. The comparison target is the first merge commit that contains the source. Changed paths carrying Git LFS filters are refused. The changed-path set is capped at 10,000 and fails closed above the cap. A mismatch is never a success through Policy B. The verifier performs no Git writes.
- **Content-verified comparison core implemented at `cdc590a`.** The only implementation on this development line is the pure comparator `src/server/goals/contentTreeComparison.ts` plus its test file `src/server/goals/contentTreeComparison.test.ts`: 26 focused tests passed, with `typecheck`, `lint` and Prettier passing. The raw Git collector, LFS enforcement, the migration and persistence, completion wiring and API/UI wiring remain pending. Evidence: MiniMax Free implementation job `89cd319aba41475fb99ffbbdfb2e571b`; REVISE reviews `1b66509f8c32475981f8f4279547d774` and `2769eb44755c49a5a977fb4c32fb1d2c`; correction jobs `57042f04c7964a28aee05b5c0a31e21d` and `93d96a2975dc43dc94564a2d8cf46be9`; final Beam Free behaviour review ACCEPT `8715faeed82044668fe183ce5a387364`; formatting jobs `4b10f092a01747dcb192beb2c3d07aaa` and `a597526669734c0d9af11f9e4202887a`; formatting review `a2ce12091c24493295a47b646eeb0d61` (ACCEPT). This is a deterministic pure function under test. It is not a live-provider, physical-device or release capability, and no completion uses it yet.

## Software gates

- **Push/PR CI (`ci.yml`): Pass on `master`.** Run 161 ([39523812376](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/39523812376)) succeeded on `6533844`, 2026-10-21. Verified recheck: local and public `master` both `6533844281d2ff9cf688286188ac35596b2bbb22`; latest `ci.yml` run `39523812376` succeeded on that SHA. **This is a `master` result only; it is not validation of the current development branch `cdc590a`.**
- **Goal production-composition acceptance: Pass (deterministic).** `e6120c1`: 292 tests across nine selected Goal suites plus `format:check`, `lint`, `typecheck`; proves exact persisted route, isolation, manual handoff, and base untouched until user action. The composition is present on development HEAD `cdc590a`. Provider boundary faked; not live/physical/release qualification.
- **Local full gate: Last recorded on `5316527`.** 2026-10-20, Linux 6.8, clean `npm ci` (629 packages), code identical to `5316527`: `format:check`, `lint`, `typecheck`, `npm test` (**210 files / 3,818 tests**), `build`, `npm audit --omit=dev`. The build keeps its existing Vite warning that the main chunk exceeds 500 kB. **No full gate has run on the current development HEAD `cdc590a`.** Not re-recorded here on `6533844` or `cdc590a`.
- **`npm audit` on master tree `6533844`: Pass.** `npm audit --json` and `npm audit --omit=dev` both exit 0 with 0 vulnerabilities; `npm ls shell-quote --all` shows `shell-quote@1.12.0`. No dependency change was made.
- **Native installer CI: Not run for RC3.** The workflow is prepared for the `v1.0.0-rc3` tag, but **no RC3 tag, artifact or release exists**, so no desktop-installer run occurred for RC3. Last success: run 37232871368 on the `v1.0.0-rc2` tag (`2ae9dfc`), 2026-10-04: Linux gate, `.deb`/AppImage build and smoke; Windows NSIS build, quiet install, startup, uninstall. Not physical.

## Feature scope (development HEAD `cdc590a` on branch `codex/v1-release-preparation-2026-10-21`)

The publicly pushed `master` is `6533844`. The accepted Goal composition below is on the development HEAD and is not covered by CI run 161.

- **Workflow engine, providers, billing lanes, usage ledger, Decision Layer, OpenRouter:** As shipped in RC2.
- **Queued-run crash recovery (HR-Q4):** Ordinary queued runs are started once after a restart (`recoverQueuedRunsAfterRestart`). Owner accepted the code (decision d3e4, 2026-10-17, `c775a6b`). Restart qualification on the release build is outstanding.
- **Queued-run cancellation:** Ordinary queued runs can be cancelled and will not start (`0701f9f`). Goal-owned and probe runs are refused.
- **Goal Engine (Grand Projects):** Accepted at `e6120c1` and present on development HEAD `cdc590a`: production calls `createProductionGoalComposition`, which wires `TuringGoalExecutor` through `ResolvedGoalRunPlanProvider` with `requireResolvedRoutes`. Goals can be defined, approved, persisted, recovered and authored; proposal, child, review and verification runs go through ordinary persisted runs on the exact route. Deterministic acceptance only; not live-provider, physical-device or release qualification.
- **Goal delivery:** Manual handoff only. Turing never writes the user's base branch. The checked-out-worktree writer `applyApprovedGoalToBase` is quarantined because it can overwrite ignored files.
- **Goal completion:** Version-2 completion: the user attests external integration, Turing observes ancestry, and a separate recorded user decision completes the Goal with a proof. Desktop-only routes; paired remote callers get 403 `desktop_required`. Attestations can be disputed, withdrawn or superseded through an append-only ledger. Ancestry is checked; content preservation is not proven. The policy approved on 2026-10-21 adds a new content verifier for new completions (first merge commit containing the source as the comparison target, LFS-filtered changed paths refused, a 10,000 changed-path cap that fails closed above the cap, mismatch never a success through Policy B, no Git writes), and keeps ancestry-only records for older completions historical and immutable. That verifier is not wired: only the pure comparator `src/server/goals/contentTreeComparison.ts` exists, so the collector, LFS enforcement, persistence, completion and API/UI wiring are still pending.
- **Goal production qualification:** Deterministic production-composition qualification passed at `e6120c1` (292 tests across nine selected Goal suites) and the composition is present at `cdc590a`. Live-provider, physical-device, Windows and release qualification are not started, and restart qualification on a release build is outstanding.
- **Model Opportunity Layer:** V1 scope. Design revision accepted (author job `2e8be4f5…`, `opencode-go/deepseek-v4.1-flash`; review job `2a1f800f…`, `opencode-go/glm-5.2`, ACCEPT); correction patch job `d86d409d…` (`opencode-go/beam-free`) independently reviewed ACCEPT by `d71b755a…` (`opencode-go/minimax-m3.1-flash-free`). Retention approved 2026-10-21: 90 days, references for active admission held through expiry, deletes by an explicit job. Implementation has not started: the observation storage, writer, readers and retention job are unimplemented. The historical-proof semantics question after retention expiry is open and unanswered. A cost-wording correction is pending review and not integrated. Non-observation contract/approval/cost/evaluator work can proceed.
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
- **Owner-reported connectivity (not independently checked):** the owner reports phone/remote connectivity and provider connections work. This does not count as live provider workflow, billing, Tailscale identity-header/Host verification, or physical-device acceptance.
- **iPhone rows not yet recorded: Open.** QR claim method, manual-code pairing, the 30-second locked-phone interval, home-screen installation, push notifications, and the UI checklist in [history/ui/UI5_SCOPE.md](history/ui/UI5_SCOPE.md) §7 (insets, keyboard, landscape, offline).
- **Desktop-only Goal routes over Serve: Pass.** 2026-10-15 from the iPhone: all five routes returned 403 (the `desktop_required` code was inferred from source). 2026-10-17 from a disposable second paired browser: all five returned 403 `desktop_required`, device administration returned 403, and Goal, approval and run tables were unchanged. See [GOAL_ENGINE_CLOSURE_2026-10-17.md](history/goals/GOAL_ENGINE_CLOSURE_2026-10-17.md) §4.
- **Live Tailscale verification (overall): Partial.** O1 was conditionally accepted for V1 on 2026-10-13, with live Tailscale identity-header/Host behaviour verification as its condition; O2 may be post-V1. This is not an open owner choice. The condition is not waived: a remote request misclassified as local that reaches a desktop-only Goal route is a blocking defect.
- **Two-master isolation: Pending.** Procedure: [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md).
- **Restart and recovery on release build: Pending.** Includes HR-Q4 and Goal resume.

## Blockers for 1.0.0

1. Model Opportunity Layer not implemented. Design revision accepted: author job `2e8be4f50f2b4bfd9a73d83af7f18b12` (`opencode-go/deepseek-v4.1-flash`); independent review job `2a1f800fc3f0470cbc324afd2b6efc6a` (`opencode-go/glm-5.2`, ACCEPT). Correction patch `d86d409d59d841949ba581ebb163534f` (`opencode-go/beam-free`) received independent ACCEPT from `d71b755ad25049b19eef37174bdf545b` (`opencode-go/minimax-m3.1-flash-free`). Retention is approved (2026-10-21: 90 days; references for active admission held through expiry; deletes by an explicit job), but the observation storage, writer, readers and retention job are unimplemented. The historical-proof semantics question after retention expiry is open and unanswered. The cost-wording correction is pending review and is not integrated.
2. Goal production composition with `TuringGoalExecutor` and resolved route planning is present on the development line and deterministically tested at `cdc590a`, but it is not live-provider, physical-device or release qualified. `master` CI does not cover this development branch, `applyApprovedGoalToBase` remains quarantined, and restart and release qualification are outstanding.
3. The content-verified completion policy is approved (2026-10-21) but not implemented. At `cdc590a` only the pure comparator exists; the raw Git collector, LFS enforcement, migration and persistence, completion wiring and API/UI wiring are pending, so no completion currently uses the new verifier.
4. Physical and live acceptance incomplete (list above), including live Tailscale identity-header/Host verification and the HR-Q4 restart qualification.
5. Live provider validation outstanding for Claude Code, OpenCode Go and ClinePass; Codex needs a re-run on current code.
6. Native installer CI has not run for RC3: the workflow is prepared for the `v1.0.0-rc3` tag, but no RC3 tag, artifact or release exists. The latest cut and the last installer success are RC2-era.

## Open owner decisions

- **Model Opportunity Layer historical-proof semantics after retention expiry.** Asked 2026-10-21 and unanswered. No outcome is chosen here. It does not block the observation storage, writer, readers or retention job.

## Known non-blocking limitations

- Stuck-Goal recovery copy remains unresolved but is non-material: abandon waits for in-flight work, and "pause then abandon" applies only from `running`.
- The Windows installer is unsigned (Unknown Publisher / SmartScreen). Signing needs an approved process.
- Provider-side PAYG fallback (OpenCode Go balance, ClinePass overflow, ChatGPT credits, Claude extra usage) cannot be verified by Turing; Run Preview says so.
- Provider allowance and reset are not queried for CLI backends.
- Cline CLI has no documented model catalog; explicit model and provider values are required.
- OpenRouter and the Decision Layer are optional and off by default.
- Dark theme only; there is no theme switch.
- Goal completion proves ancestry at an observed time, not content preservation or later ref state. The approved content-verified verifier is not wired into completion yet, so the same limit still applies. Git observation and SQLite persistence are not atomic, and the per-Goal lock is in-process only; cross-process CAS is not qualified.
- Goal Git behaviour is tested on Linux (Git 2.43) only; Windows is unverified.
- A reload or second window bypasses the client-side guard against a duplicate completion or correction write; server idempotency is authoritative.
- Accessibility is checked by jsdom tests and static scans. No WCAG 2.2 AA conformance is claimed.

## Hardening before release

Full regression, migration coverage, restart and recovery (including Goal resume), route-pool correctness, catalog failure behaviour, no free-to-PAYG transition, live provider validation, physical installs, iPhone over Tailscale, live Tailscale identity-header/Host verification (the O1 condition), multi-master isolation, security review, package verification, and documentation reconciliation. The content-verified completion work still needs its Git collector, LFS enforcement, migration and persistence, and completion and API/UI wiring before it can be relied on. The Model Opportunity Layer observation storage, writer, readers and retention job are unimplemented against the approved 90-day retention, and the historical-proof semantics question after retention expiry is still open. Non-observation contract, approval, cost and evaluator work can proceed. Then cut the next release candidate (expected RC3).

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

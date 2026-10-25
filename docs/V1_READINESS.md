# V1 readiness

This is the canonical release tracker. When another document disagrees with it about release state, this one wins until it is corrected.

Rules for editing it:

- Update it with evidence whenever a gate changes.
- Never mark an item passed from a mock or unit test when the item says live or physical.
- Keep it current. Replace an item that is out of date; do not append amendments below it.

The stage-by-stage record up to 2026-10-20 is frozen in [history/V1_READINESS_LOG.md](history/V1_READINESS_LOG.md).

**V1 is not release-ready.**

## Current baseline

- **Date checked:** 2026-10-25.
- **Development branch:** `codex/v1-release-preparation-2026-10-21`, implementation commit `763bf0f` (`feat: complete v1 goal verification and model opportunities`), based on `c8d3bc4` (`fix: block replacement of content verification evidence`). The local software gate passed; PR #15's GitHub CI run [40208316817](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40208316817) also passed on initial PR head `e7aa9a5`.
- **Public `master`:** `6533844281d2ff9cf688286188ac35596b2bbb22`. GitHub CI run [39523812376](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/39523812376) succeeded on this SHA on 2026-10-21.
- **Version:** `1.0.0-rc3` is configured in package, Tauri, Cargo and shared version files; the installer workflow is configured for the `v1.0.0-rc3` tag. No RC3 tag, artifact or release exists. The latest tag is `v1.0.0-rc2` (2026-10-04); latest installer success is [run 37232871368](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/37232871368) on `2ae9dfcde9d140dc453f6e423823d0ae9632b240` (RC2).
- **OpenCode Go catalogue and review:** refreshed 2026-10-24. It lists `opencode-go/beam-free` at catalogue cost $0 and the explicitly requested `opencode-go/glm-5.3-flash` and `opencode-go/deepseek-v4.1-flash`. Two read-only Beam Free reviews completed with no actionable findings. The GLM-5.3-Flash and DeepSeek V4.1 Flash review attempts timed out before returning findings; approximate costs were $0.2234 and $0.0943 respectively. Catalogue availability is not proof of account access or Turing-provider qualification.
- **Implementation and review record:** Implementation proceeded with GPT-6.1 Low at the owner's direction. OpenCode Go jobs: Beam Free broad review `f5582da5438440bf9f89c3cbc41cdd0e` and focused review `941b1672bd424ab69883baa869d53a28` reported no actionable findings; focused test reviews `384e14e51c3942b0abe416e9718d5d24` and `d8325328192d4f5a9789ec302fc9e648` identified missing assertions that were added, and final follow-up `b8a76037bc384e7ca001d5481e0f6083` confirmed them. Board review `0332cf28cb41446dbad2f8f95695f252` identified ambiguous refresh/admission reload notices; those were clarified and covered by UI tests. Its follow-up `0042e934b66e45e5b423337c0905d189` found no remaining issues. The paid GLM-5.3-Flash and DeepSeek V4.1 Flash reviews (`36d3b8a2bf7a4741bfa40c6494872acf`, `f748e1cb2fde47f080553f87d6786a97`) timed out without findings. Reviewers changed no files.
- **Repository:** Public since 2026-10-17; hosted runners are available.

## Implemented scope on the development line

- **Goal production composition:** Production constructs `TuringGoalExecutor` through `ResolvedGoalRunPlanProvider` with `requireResolvedRoutes`; the deterministic qualification accepted at `e6120c1` covers exact persisted routes, isolation, handoff and leaving the user's base untouched until user action. `applyApprovedGoalToBase` remains quarantined. This is not live-provider, physical-device or release qualification.
- **Goal content verification:** Migration 033 adds immutable `content-verified-v1` verifier-version-2 evidence without rewriting migration-027 ancestry-only proof rows. New completion review reads changed paths at the first destination-history commit containing the accepted source, refuses LFS-filtered paths, caps work at 10,000 changed paths, and fails closed on observation errors. A known mismatch is shown during preflight and can be recorded only after explicit user acknowledgement; it always produces `content_mismatch_disclosed`, with downstream trust and unqualified success false. The reviewed evidence digest is bound into the approved action and proof and stored atomically with the terminal transition. The Git collector/comparator performs no Git writes. Older ancestry-only completions remain immutable and historical.
- **Model Opportunity Layer:** Migration 034 and the current source add observation history with provenance, refresh/failure outcomes, verified readers, a read-only Opportunity Board, exact first-use admission through the existing approval system, and conservative MOP-only reservation estimates. Decision Layer behavior and the shared legacy estimator remain unchanged. Exact persisted OpenRouter Goal routes are required for the MOP estimate; no provider or billing substitution is introduced.
- **Opportunity retention and admissions:** Raw observations have 90-day retention. Admission references hold observations until the admission expires; an explicit bounded retention job removes eligible raw data and records its work. The immutable admission proof remains valid for the accepted definition after raw-data expiry and is retired when that definition is superseded, so the next definition cycle requires fresh evidence. This follows the owner's approved decision; raw data is not used to rewrite active snapshots.
- **Completion mismatch policy:** Policy B is implemented: a user may explicitly acknowledge and record a known mismatch, but the result cannot count as successful delivery or be trusted downstream. The UI identifies the mismatch. Historical ancestry-only proofs are not reclassified as verified.
- **User-owned runtime and data:** This work does not write to the user's base branch, change live Master configuration, edit credentials or change Tailscale configuration. Task scratch directories and the Hugging Face cache are preserved.

## Software gates

- **Public push/PR CI:** Pass on `master` only: [run 39523812376](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/39523812376), SHA `6533844281d2ff9cf688286188ac35596b2bbb22`.
- **Development PR CI:** PR #15's required CI passed on initial PR head `e7aa9a5`: [run 40208316817](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40208316817), and on the readiness-update head `31672e4`: [run 40210473113](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/40210473113).
- **Clean dependency install:** `npm ci` passed on the current working tree (629 packages); it reported zero vulnerabilities after the lockfile remediation.
- **Formatting, lint, typecheck:** `npm run format:check`, `npm run lint` and `npm run typecheck` passed after the final source changes on 2026-10-24. Formatting was rerun after this readiness-record update.
- **Full tests:** The current-tree `npm test` gate passed on 2026-10-24: 232 test files and 4,118 tests passed in 1,234.59 seconds. This includes the previously stale fixtures/assertions, completion mismatch and proof-binding cases, and Model Opportunity Board tests.
- **Build, production dependency audit, documentation links and package scan:** `npm run build`, `npm audit --omit=dev`, `npm run docs:links` (92 Markdown files) and `npm run package:scan` passed after the final source changes. Documentation links were rerun after this readiness-record update. The build reports one non-failing large-chunk warning. No local-state, private-key or recognized credential patterns were found in the package scan.
- **Native installer CI:** No RC3 run exists. The last success is the RC2 run above; it built and smoke-tested Linux `.deb`/AppImage and Windows NSIS. This is not a physical-install result.

## Remaining release qualification

### Live providers

Deterministic tests use mocks or fixtures. They do not prove a real provider call, billing lane or quota behavior. The owner reports phone/remote connectivity and provider connections work; that report has not been independently checked and does not prove a complete live workflow.

| Provider           | Recorded live evidence                                                                                                                            | Remaining                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex subscription | Planner → Implementer → Reviewer run on 2026-10-01, RC1-era code; see [LIVE_PROVIDER_VALIDATION.md](LIVE_PROVIDER_VALIDATION.md).                 | Re-run on current code.                                                                                                                                                                                                                                                     |
| Claude Code        | The recorded attempt hit HTTP 429 with zero tokens; see [CLAUDE_VALIDATION.md](CLAUDE_VALIDATION.md).                                             | Post-reset validation.                                                                                                                                                                                                                                                      |
| OpenCode Go        | No Turing live-provider workflow recorded on current code. The OpenCode model catalogue is available, but does not prove provider authentication. | Bounded subscription-backed call on the exact free route where available; stop on quota exhaustion and never fall back to PAYG. Paid fallback is only `glm-5.3-flash`, then `deepseek-v4.1-flash`, if the free route is unavailable and the subscription lane is confirmed. |
| ClinePass          | No live run recorded.                                                                                                                             | Bounded live run; document its catalog limitation and subscription-only billing boundary.                                                                                                                                                                                   |
| OpenRouter         | Mocked HTTP coverage only.                                                                                                                        | Optional live-key, metered-stage and reconciliation validation.                                                                                                                                                                                                             |
| Decision Layer/Jev | Mocked coverage only; optional and off by default.                                                                                                | No V1 live gate unless enabled for release scope.                                                                                                                                                                                                                           |

### Physical, remote and restart checks

- **Windows install and run:** Pending. Use [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md) and [RELEASING.md](RELEASING.md).
- **Linux install and run:** Pending. Use [INSTALL_LINUX.md](INSTALL_LINUX.md).
- **iPhone PWA over Tailscale:** Partial. The 2026-10-15 physical-device record covers Serve, remote approval, pause/resume, persistence across PWA relaunch and revocation. The owner reports QR pairing on the newer build; that report is not independently checked. QR/manual-code pairing, locked-phone interval, home-screen install, notifications and the remaining UI checklist still need evidence.
- **Live Tailscale identity-header/Host verification:** Pending; it is an O1 V1 condition. A request misclassified as local and reaching a desktop-only Goal route is a release blocker.
- **Desktop-only Goal routes over Serve:** Pass in the recorded 2026-10-17 disposable paired-browser check: all five routes returned 403 `desktop_required`, device administration returned 403 and Goal/approval/run tables were unchanged. See [GOAL_ENGINE_CLOSURE_2026-10-17.md](history/goals/GOAL_ENGINE_CLOSURE_2026-10-17.md) §4.
- **Two-master isolation:** Pending. Procedure: [LIVE_MULTIMACHINE_ACCEPTANCE.md](LIVE_MULTIMACHINE_ACCEPTANCE.md).
- **Restart and recovery on a release build:** Pending, including HR-Q4 and Goal resume.
- **Security and package review:** Independent read-only OpenCode Beam Free architecture/security, content-verification, test and Board reviews reported no remaining actionable findings. The paid GLM-5.3-Flash and DeepSeek V4.1 Flash review attempts timed out without returning findings. Package scan passed; verify release package contents and record checksums before RC3 approval.

## Blockers for 1.0.0

1. Run a bounded current-code OpenCode Go subscription-backed validation on the exact free route when available; stop on quota and do not use PAYG fallback. Validate any provider documented as supported or explicitly document it as unvalidated.
2. Complete pending physical Windows/Linux install, iPhone PWA/Tailscale, live Tailscale identity/Host, two-master and release-build restart/recovery checks.
3. After those gates and owner approval, run RC3 installer CI, verify package contents and publish checksums. No RC3 tag or publication is authorized by this tracker.

## Known non-blocking limitations

- Provider-side billing fallback and subscription allowance cannot always be queried by Turing; preview text must continue to disclose unverifiable fallback.
- Provider allowance/reset are not queried for CLI backends. Cline CLI has no documented model catalog; explicit provider/model values are required.
- Git/SQLite observation cannot be atomic. Goal completion uses a per-process lock; cross-process compare-and-swap is not qualified.
- Goal Git behavior has been tested on Linux; Windows behavior remains unverified until physical qualification.
- A reload or second window can bypass the client-side duplicate-write guard; server idempotency remains authoritative.
- Accessibility checks use jsdom/static scans; no WCAG 2.2 AA conformance is claimed.
- The Windows installer is unsigned; signing requires an approved process.
- OpenRouter and the Decision Layer/Jev remain optional and off by default.

## Exit criteria for `1.0.0`

All items need evidence recorded here:

1. Goal Engine and Model Opportunity Layer complete and feature freeze observed.
2. Full software gate green on the release commit and push/PR CI green on that commit.
3. RC3 native installer CI green, package contents verified and checksums recorded.
4. Windows and Linux physical installs verified.
5. iPhone pairing over Tailscale, remote approval/intervention, reconnect and notifications verified.
6. Two-master isolation verified.
7. Current live validation passed for each provider documented as supported, or that provider explicitly documented as unvalidated.
8. Restart and recovery, including Goal resume, verified on the release build.
9. No free-to-metered silent transition, with deterministic and bounded live evidence where possible.
10. Security review complete with no open high-severity findings.
11. Active documentation reconciled; no stale RC wording.
12. Version changed to `1.0.0` only after items 1–11.

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

| Gate                   | Status | Evidence                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`               | Pass   | 627 packages added, 0 vulnerabilities                                                                                                                                                                                                                                                                                                         |
| `npm run format:check` | Pass   | All files conform to Prettier                                                                                                                                                                                                                                                                                                                 |
| `npm run lint`         | Pass   | ESLint clean                                                                                                                                                                                                                                                                                                                                  |
| `npm run typecheck`    | Pass   | Client and server `tsc` clean                                                                                                                                                                                                                                                                                                                 |
| `npm test`             | Pass   | 32 test files, 172 tests, all passing                                                                                                                                                                                                                                                                                                         |
| `npm run build`        | Pass   | Client, PWA service worker, and server build                                                                                                                                                                                                                                                                                                  |
| `npm audit --omit=dev` | Pass   | 0 vulnerabilities                                                                                                                                                                                                                                                                                                                             |
| Native installer CI    | Pass   | `Desktop installers` run 37232178911 (`workflow_dispatch` on `3363f98`, 2026-10-04): Linux gate + `.deb`/AppImage build + smoke; Windows NSIS build, quiet install, startup, PWA manifest, uninstall; release bundle merged. Re-run on the `v1.0.0-rc2` tag push (`2ae9dfc`, run 37232871368): all three jobs green. Not physical acceptance. |
| Ordinary push/PR CI    | Pass   | `.github/workflows/ci.yml` (push to `master`, PRs to `master`; deterministic, no credentials). Run 37232084823 green on `3363f98`, 2026-10-04.                                                                                                                                                                                                |

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

Known RC2 defect to fix here: `reconcileInterruptedRuns` ignores `queued` runs, so an ordinary run queued at crash time is never restarted (design Q4). Deliberately not fixed in the Goal Stage 0A extraction.

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

## Stage 7C.1 bounded evidence — 2026-10-09

This checkpoint records deterministic evidence on `feature/grand-project-goal-engine`, accepted at `3a0d4130b53d4252ee4253e412364c73bc2e8694` (parent `30f2415afc9a16d56a145c0a29ab3ee8059bf5f6`). It supplements the historical RC2 baseline above; it does not revise RC2 release claims or mark the full Goal Engine release-ready. Scenario-by-scenario evidence is in [GOAL_E2E_ACCEPTANCE_MATRIX.md](GOAL_E2E_ACCEPTANCE_MATRIX.md).

- **End-to-end fake-provider-proven:** a real temporary SQLite/Git/registered-project harness traverses the production Goal supervisor, definition and approval APIs, `TuringGoalExecutor`, run-plan resolution, launcher, `RunEngine`, provider broker, Goal-ref CAS, verifier/evidence collection, final review, final acceptance, and final-apply preflight. The same suite covers denial, out-of-scope refusal, cycle-bound refusal, same-family review refusal, queued-proposal restart, and an ordinary finite-run regression.
- **Integration/unit evidence retained:** Git operation recovery, read-only preflight statuses, billing/refusal rules, stale evidence, approval idempotency, and the production disabled-executor boundary remain supported by their focused suites as classified in the acceptance matrix.
- **Production boundary:** production still constructs `DisabledGoalExecutor`. No production execution feature or final-apply writer/API was added. Final apply remains a read-only preflight boundary; no user/base branch was changed by these fixtures.
- **Not established:** fake identities are test fixtures only. No live provider/account/allowance, real model call, installer, desktop, phone, or physical acceptance was used. This evidence does not establish release readiness. Stage 7C.2A was accepted and frozen at `3a69f33b6d8eda175736a93f0044324e86b07f6c`; Stage 7C.2B is the current implementation candidate, and 7C.3 has not started.
- **Validation and CI:** exact committed-tree gate results and the PR #3 CI run are recorded in the Stage 7C.1 checkpoint report, after the pushed commit and CI complete.

## Stage 7C.2A final-apply authority — accepted and frozen

This bounded checkpoint is frozen at `3a69f33b6d8eda175736a93f0044324e86b07f6c`, the direct child of accepted `3a0d4130b53d4252ee4253e412364c73bc2e8694` on `feature/grand-project-goal-engine`. It does not change RC2 release claims or declare the Goal Engine release-ready.

- **Authority contract:** [GOAL_FINAL_APPLY_AUTHORITY.md](GOAL_FINAL_APPLY_AUTHORITY.md) defines the immutable prospective intent, repository identity, strict completion/preflight eligibility, duplicate and stale-request behavior, the async-validation interval, and the future 7C.2B recovery/concurrency contract.
- **Implemented:** server-owned version 1 `FinalApplyIntent`, deterministic canonical SHA-256 digest, registered repository identity, current completion proof and read-only preflight, high-risk user-only approval through `goal_approvals`, digest immutability/uniqueness migration, and a read-only validator for later use. The existing approval decision route revalidates prospective intents; there is no public request endpoint or final-apply execution route.
- **Hard boundary:** approval alone cannot move a ref or satisfy completion. Final apply remains unavailable; base-ref crash recovery remains unimplemented. Production still uses `DisabledGoalExecutor`. No provider/model call or visual-design work was included.
- **Validation:** committed-tree gate passed: `npm ci`, `format:check`, lint, typecheck, build, `npm audit --omit=dev` (0 production vulnerabilities), and literal `npm test` (**112 files / 1,782 tests passed**). `npm ci` reported the existing two critical full-tree dependency findings; the existing Vite 557.63 kB chunk warning remains. PR #3 CI is checked after push and recorded in the review report.
- **Accepted scope:** Stage 7C.2A is independently accepted and frozen. Stage 7C.2B implements and qualifies the internal writer while keeping production activation disabled. Live-provider and physical acceptance remain pending.

## Stage 7C.2B guarded final apply — implementation candidate

The 7C.2B implementation is committed at `83897af0a0311a331bff14e5f14ff1bb166292c2`, a direct child of the accepted 7C.2A SHA above, and pushed to PR #3. It adds an internal-only final-apply writer, durable operation identity in migration 024, atomic source-ref verification and destination compare-and-swap, checkout/index synchronization, and observation-only crash recovery. It does not add a production HTTP/UI execution action or enable Goal execution. The committed-tree gate passed: `npm ci`, `format:check`, lint, typecheck, build, `npm audit --omit=dev` (0 production vulnerabilities), and literal `npm test` (**114 files / 1,808 tests passed**). One initial parallel local test run hit a 5-second timeout in an untouched supervisor test; that test passed alone and the subsequent literal full run passed without timeout changes. CI passed on the implementation commit in [PR #3 run 37979362847](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/37979362847). `npm ci` reported two critical full-tree dependency advisories and the build emitted the existing Vite large-chunk warning. Independent safety review subsequently rejected the candidate for an ignored-file overwrite race; see Stage 7C.2B.1 below. 7C.2B is not accepted, and 7C.3 has not started.

## Stage 7C.2B.1 non-destructive checkout remediation — blocked

The final-boundary regression reproduces data loss on the rejected candidate: an ignored user file created after the last collision scan is overwritten by `git read-tree -m -u`, which exits successfully; the service records the operation as applied and completion appears clean. Additional disposable Git tests show that ordinary untracked collisions, tracked edits, symlinks, index interference, file/directory transitions, and permission failures are generally refused, but `read-tree` can partially update earlier paths before a later permission failure. These observations were made on Linux 6.8, Git 2.43.0, Node 22.23.1; Windows behavior is unverified.

No safe operation-level, cross-platform live-checkout synchronization replacement was established. More scans and a staged tree do not protect the final write into the live checkout. A ref-only update to a branch that is not checked out anywhere is recommended for separate authority/completion design review; it is not implemented because it changes the approval contract. No migration 025 or production writer change was made. Production final apply remains unreachable, `DisabledGoalExecutor` remains active, and this checkpoint is blocked pending independent review. Stage 7C.3 has not started. See [GOAL_FINAL_APPLY_AUTHORITY.md](GOAL_FINAL_APPLY_AUTHORITY.md) and [GOAL_E2E_ACCEPTANCE_MATRIX.md](GOAL_E2E_ACCEPTANCE_MATRIX.md) for the decision record and test details.

**Validation on `b930f1421cd71800fa83a392792b57faf2b8fc24`:** the exact full-authority reproduction passed as a characterization on both the current source and a detached worktree at `b544ff1`; the disposable Git filesystem suite passed **10/10**. Format, lint, and typecheck passed locally. [PR #3 CI run 37984475694](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/37984475694) passed the full gate with **115 test files / 1,819 tests**, build, and `npm audit --omit=dev` (0 production vulnerabilities). `npm ci` reported two critical full-tree dependency advisories. The green gate validates the evidence package; it does not resolve the data-loss defect or safety blocker.

## Stage 7C.2B.2 ref-only architecture investigation — manual handoff recommended

This is a design and disposable-repository characterization checkpoint, not production implementation or independent acceptance. It answers the Stage 7C.2B.1 suggestion to consider updating an unoccupied base ref without synchronizing a checkout.

- **Decision:** Approach C, immutable manual handoff, is the V1 safety boundary. Approach A is rejected: Linux/Git 2.43.0 characterization deterministically shows a linked worktree checkout can start after `worktree list --porcelain -z` and before `git update-ref` CAS. CAS succeeds although that worktree's symbolic `HEAD` resolves to the new commit while its index/files remain at the old tree. Ref CAS protects expected ref identity, not worktree occupancy.
- **Delivery ref:** Approach B avoids updating the user's base ref, but a create-only ref update can change the resolved `HEAD` of an unborn linked worktree that already names the new ref. It also duplicates `refs/heads/turing/goal/<goal-id>` without a demonstrated V1 benefit. Delivery is not base application.
- **Manual handoff/completion:** Turing should provide exact source/base identities, verified evidence and read-only inspection instructions without mutating refs or worktrees. This is “ready for manual integration,” not `finalApply.ok` and not completion under current `applyToBase: "required"`. A distinct `applied_externally` path remains a user assertion and is not implemented here. `evaluateCompletion()` is unchanged.
- **Historical contracts:** 7C.2A `apply_to_base_intent` and 7C.2B operation/recovery records retain their original meanings. They must not be converted into delivery or handoff authority. A future implementation must preserve approvals/operation history and fail closed on old/malformed records.
- **Production boundary:** no production writer, endpoint, UI action, migration, or completion change. `applyApprovedGoalToBase()` remains quarantined; production still uses `DisabledGoalExecutor`. Stage 7C.3 has not started.
- **Platform/test scope:** eleven new deterministic cases use temporary repositories, including checkout/ref races, source and destination movement, common-dir ref versus linked-worktree index lock behavior, prunable linked-worktree metadata, delivery collisions, fresh-process reflog observation, and SHA-1/SHA-256. Linux 6.8 / Git 2.43.0 / Node 22.23.1 were available. Windows behavior is unverified. The original ignored-file overwrite regression remains unchanged. No user repository was used for Git mutations.

See [GOAL_FINAL_APPLY_REF_ONLY_DECISION.md](GOAL_FINAL_APPLY_REF_ONLY_DECISION.md) for the evidence matrix, revised authority/completion proposal, recovery model, compatibility plan, threat model, user workflow, and proposed next stages. Exact pushed SHA, gate and CI results are recorded after the checkpoint commit and push.

## Stage 7C.2B.3 immutable manual handoff — implementation candidate

Stage 7C.2B.2's Approach C decision now has an internal server-side implementation candidate: an explicit handoff builder/persister, immutable migration-025 record, fresh current/stale validation, and bounded read-only projection. It binds the approved definition, user acceptance, independent review, evaluator-selected evidence, repository identity, exact Goal source commit/tree, recorded base commit/tree, full changed-path identity, and bounded preview identity. The new real Goal E2E path prepares a handoff only after the existing completion requirements pass and confirms that `final_apply_required` remains.

The handoff does not modify Git, create a Goal operation/approval/attestation, transition Goal status, or satisfy completion. There is still no execution endpoint, Apply button, desktop review surface, or external-attestation workflow. The rejected checked-out-worktree writer remains quarantined and production continues to use `DisabledGoalExecutor`. SHA-1/SHA-256 and Linux Git non-mutation evidence use disposable repositories; Windows behavior is unverified.

This is not release readiness or independent acceptance. The Stage 7C.2B.3 checkpoint is pending review; Stage 7C.2B.4 and 7C.3 have not started. See [GOAL_MANUAL_HANDOFF_CONTRACT.md](GOAL_MANUAL_HANDOFF_CONTRACT.md), [GOAL_FINAL_APPLY_AUTHORITY.md](GOAL_FINAL_APPLY_AUTHORITY.md), and [GOAL_E2E_ACCEPTANCE_MATRIX.md](GOAL_E2E_ACCEPTANCE_MATRIX.md) for implementation boundaries and evidence.

## Stage 7C.2B.3a amended-definition approval compatibility — remediation candidate

Independent review found that the handoff service's definition-approval check accepted only the initial `definition` gate, although the supported amendment service approves a child version through the `amendment` gate. The targeted remediation derives the required gate from `parent_version`, verifies the current Goal pointer and the complete user-approved/hash-valid superseded lineage to root version 1, and retains all acceptance, review, evidence, repository, source, and completion checks.

The regression prepares a valid version 1 handoff, performs a real version 2 amendment and reapproval with fresh version 2 evidence/review/acceptance, keeps the source Git commit unchanged, and verifies that the old handoff becomes stale while the new one has a distinct current identity. Negative cases cover invalid approval identity and lineage, old review/acceptance/evidence, and system decisions. Migration 018 already enforces the same root-versus-child gate mapping; no migration 026 or completion change is needed. The candidate remains pending independent review; `DisabledGoalExecutor` stays active, the unsafe checked-out-worktree writer remains quarantined, and Stages 7C.2B.4, 7C.2B.5, and 7C.3 have not started.

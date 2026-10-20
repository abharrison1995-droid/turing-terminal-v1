# Goal Engine closure report, 2026-10-17

Status: Owner decision d3e4 (2026-10-17) applied. This report does **not** declare V1 ready, does **not** merge PR #3, and does **not** activate any unsafe Git writer.

## 1. Summary

| Item                              | Outcome                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HR-Q4 (queued-run crash/restart)  | **Accepted in code** by the owner for the implemented scope at `c775a6b`. Final physical and release-candidate restart qualification is still outstanding.              |
| Queued-run user cancellation      | **Fixed** in `0701f9f`, with focused tests. Hosted CI for `0701f9f` was blocked by billing. The exact head `d2dcd52` passed (section 3).                                |
| Live Tailscale `desktop_required` | **Performed** from a disposable second paired browser through the real Serve origin. All checks passed. The genuine iPhone session is **no longer active** (section 4). |
| Content-discarding merges         | **Assessed.** Requires an owner decision on a new versioned policy before any implementation (section 5).                                                               |
| Cross-attestation stuck Goals     | **Assessed.** Fail-closed behaviour is in place. The recovery copy gap is addressed in `2a3430b` (section 7).                                                           |
| X1                                | **Defined as a proposal** for owner acceptance (section 8).                                                                                                             |

## 2. Accepted changes this round

- **HR-Q4 acceptance.** The owner accepted the implemented HR-Q4 scope at `c775a6b`. This is recorded in `docs/V1_READINESS.md`. Final physical and release-candidate restart qualification remains a release gate.
- **Queued-run user cancellation (`0701f9f`).**
  - `POST /api/runs/:id/cancel` previously returned 409 for a queued run, because `RunEngine.cancel` only handles active runs. A queued run could therefore still start later.
  - New `cancelOrdinaryQueuedRun` in `src/server/runLauncher.ts` cancels only ordinary queued runs, through the existing compare-and-set `cancelQueuedRun`. A queued run owned by a Goal or a route probe is refused (`runCancellationOwner` in `src/server/serialize.ts`). An executing Goal-owned run stays stoppable through `RunEngine`, because the Goal supervisor has no other cancel path and a wedged Goal run must be stoppable. The Goal-owned refusal reads "This run belongs to a Grand Project, which starts and retires it. It cannot be cancelled here." A repeated Stop on a run that is already cancelled returns 200 (idempotent) unless something is still executing it. The run projection's `cancellable` flag is true for stoppable executing runs and for queued runs with no owner.
  - A run already claimed by restart recovery is `not-queued` and cannot be cancelled through this path.
  - `RunEngine.publishRunStatus` is a small public method that publishes `run_updated` for a run the engine did not drive. It is generic and carries no cancellation policy.
  - `RunEngine.cancel`, `cancelQueuedRun`, the Goal supervisor and the probe reconciler are unchanged.
  - The client shows "Queued run cancelled. It will not start." on success.
  - Tests: four in `runLauncher.test.ts` (cancel without start, idempotent repeat, cancelled-before-restart not started, recovery-claimed run not cancelled), one in `goalRunOrigin.test.ts` (Goal-owned refusal), one in `routeProbe.test.ts` (probe refusal). RED was confirmed first.
- **Local gate on `0701f9f`:** typecheck, lint, `format:check`, build and `npm audit --omit=dev` (0 vulnerabilities, the CI command) pass. Full `vitest run`: 167 files, 3371 tests, all passing.

## 3. Hosted CI and what is blocked

- Push to `feature/grand-project-goal-engine` fast-forwarded `1054b25..0701f9f`.
- Hosted run `39026030332` (`gate`) for `0701f9f` **failed without starting**: GitHub reported failed payments or a spending limit. This was an account billing block, not a test result. Re-runs of `39037113089` for `d2dcd52` failed the same way.
- **Resolved 2026-10-17:** the repository was changed from private to public, which gives standard hosted runners unlimited free minutes. Re-running `39037113089` on `d2dcd52` started and finished with **`gate` success** (exact SHA). This covers `0701f9f` and the documentation in `d2dcd52`.
- Owner decision: the repository is now public, so its code, commit history and issues are visible to anyone. Check that nothing sensitive is in the history. The scan before the change found only test fixtures with placeholder keys.
- Separate pre-existing finding: local `npm audit` (including dev dependencies) reports two critical advisories for `shell-quote` through `concurrently`, a dev-only tool. CI runs `npm audit --omit=dev`, which passes. A lockfile change to fix it is a dependency decision and was not made here.

## 4. Live Tailscale verification (disposable second paired browser)

**Method.** The built-in browser could not reach the Serve origin (`Failed to fetch`). A headless Chromium with a fresh, disposable profile was used on this machine instead. It was driven over the DevTools protocol and holds its own cookies. No cookie was extracted, printed, exported or injected. Pairing used the page's own API calls. The pairing code was held in memory and never printed or placed in a URL.

**Steps and results.**

1. Pairing request created over loopback by the desktop side.
2. Claim, approve and complete ran through the page's own origin (`https://alex-ms-7c02.tail28c2c6.ts.net`). Complete returned 201 and set the disposable device cookie. The page's readiness request then returned 200 as a paired remote session.
3. Device administration from the page returned `403` ("available on the desktop only"). Remote classification is confirmed.
4. Five fixed, deliberately invalid POSTs with a `{}` body, each returned **`403 desktop_required`**:
   - `/api/goals/no-such-goal/handoffs/no-such-handoff/external-integration/attestations/no-such-attestation/corrections`
   - `/api/goals/no-such-goal/handoffs/no-such-handoff/external-integration/attest`
   - `/api/goals/no-such-goal/completion-decision`
   - `/api/goals/no-such-goal/completion`
   - `/api/goals/no-such-goal/attestation-corrections/no-such-approval/decision`
5. Read-only snapshot (`scratchpad/snapshot.sh`) before and after. Goal, approval, run, run-event and stage tables are **unchanged**. The only differences are `device_sessions` (+1, the disposable device) and `pairing_requests` (+4, from attempts and the pairing flow).
6. Disposable device revoked over loopback (HTTP 200). The page's readiness then returned **401**.
7. The headless browser was stopped and its profile deleted.

**Caveats.**

- This is a disposable browser session. It is **not** physical iPhone interaction and must not be cited as one. The genuine-iPhone dashboard test is a separate gate.
- The live Master runs build `ba59308` from the `fix/pairing-empty-json-body` worktree. The remote-guard and desktop-only route code in `app.ts` and `goalRoutes.ts` is unchanged since `67af34f`, the commit the live build's boundary matches. The cancellation route in `app.ts` differs and is **not** exercised by the live Master. (`ba59308` is not present in this repository, so this was checked against `67af34f`.)
- The four extra `pairing_requests` rows are pending or expired requests from the attempts. They have no effect on Goal state.

## 5. IPhone session finding (needs owner attention)

- The genuine iPhone session, device "My phone", is **revoked**: `revoked_at` `2026-10-15T21:28:07Z`.
- The Master log records a loopback `DELETE /api/pairing/devices/992cb154-…` at exactly that instant. The DELETE was **not** issued in this session. The earlier summary's note that the session was active is out of date.
- This session did not re-pair, un-revoke or change the phone. **Owner action:** re-pair the iPhone if you want it active again, and confirm whether that revocation was intended.

## 6. Content-discarding merges (product decision, assessment only)

**Owner rule (d3e4).** A merge that demonstrably discards accepted Goal work must not count as successful delivery. Ancestry is not proof of content preservation.

**Current behaviour, from code.**

- `src/server/goals/externalIntegration.ts` observes integration by ancestry only: `isAncestor(source, destination)` and `isAncestor(expectedBase, destination)` (around lines 640–660). It records `observedTree` for the destination but **never compares it with the source tree** for content.
- The accepted v2 contract (`docs/GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md`, Policy B "user-accountable historical integration", line 337) already states that `merge -s ours` can satisfy ancestry while accepted content is absent. It allows completion only after an explicit separate user decision that discloses Turing did not prove content preservation.
- The `-s ours` path appears in test kits only (`goalLifecycleKit.ts:917`, `goalV2TestKit.ts`). It is characterised, not prevented.

**Three categories.**

| Category                | Meaning                                                                     | Status today                                               |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Known content loss      | Source paths changed by the Goal are absent or different in the destination | Not detected. No check exists.                             |
| Unverified preservation | Ancestry holds, but content is not compared                                 | Current Policy B. Accepted as historical, with disclosure. |
| Verified preservation   | Each source change is present in the destination                            | Not implemented.                                           |

**Smallest safe design for owner approval (not implemented).**

- A new **versioned** verification policy, for example `content-verified-v1`, used only for new completions.
- For each path changed between the expected base and the accepted source, require the destination blob to equal the source blob. For a fast-forward, the destination tree must equal the source tree. A `-s ours` merge fails because the destination blob differs.
- Conflict resolutions that change content are refused under this policy. The user can use Policy B only after an explicit decision, as today.
- Evidence is a new record with its own digest. Existing v2 records and completion proofs are **not** rewritten and remain historical.
- No migration of existing records is required. Adding the new policy needs its own migration and tests.

**Decision needed.** Owner approves or rejects the policy, and confirms whether Policy B stays available for existing Goals.

## 7. Cross-attestation stuck Goals (assessment, fail-closed)

**Current classifier** (`src/server/goals/completionAuthorityPolicy.ts`):

- Class 6 (completed) if a terminal proof exists. Terminal Goals never reopen.
- Class 5 (fail closed) if any completion row is invalid, history is unreadable, or the cap is exceeded.
- Class 4 if another attestation's decision is still eligible.
- Class 2 (own decision reuse) if the selected attestation's own decision exists.
- Class 3 if decisions exist but none is eligible.
- Class 1 if there are no decisions.

Withdrawn, disputed and superseded authority is not treated as eligible. Fail-closed behaviour matches the owner's rule.

**Recovery copy gap: addressed in `2a3430b`.** The corrected-attestation and invalid-history refusals now name the ways forward. Caveats:

- Before `2a3430b`, the copy for withdrawn, disputed and superseded attestations gave no next action, and the invalid-history copy said only to refresh.
- The "pause then abandon" option is only correct from `running`. From `needs_user` or `blocked`, abandon is direct. Abandon is refused while a Goal run is non-terminal or an integration operation is still planned, so the copy should say that abandon waits for in-flight work. This is a should-fix from review, pending the owner's confirmation.

**Recovery options** the owner asked to be explained:

- **Fresh attestation.** Requires a new external attestation with current authority.
- **Manual reconciliation.** The user reconciles the Git state, then re-attests.
- **New Goal.** The user starts again. Terminal Goals never reopen.
- **Abandonment.** The route exists (`POST /api/goals/:goalId/abandon`) and is legal from `draft`, `ready`, `needs_user`, `blocked` and `paused`. It is refused while Goal work is in flight (`goal_work_in_flight`).

Coverage: `completionAuthorityPolicy.test.ts` has 49 test cases that reference classes 1–6, and they passed in the full suite run (section 2).

## 8. X1 (proposal, awaiting owner acceptance)

The full locations, the conflicting statements and the proposed wording are in [GOAL_X1_AUTH_WORDING_PROPOSAL.md](GOAL_X1_AUTH_WORDING_PROPOSAL.md). Summary:

- The owner must decide whether S1b (same-user local process) is accepted. Four records say O1 was approved for V1 on 2026-10-13, conditionally. Four others (`docs/SECURITY.md:49` and `docs/V1_READINESS.md:167`, `:348`, `:353`) still say it is pending. These must be reconciled.
- The conditional part of O1 is that live Tailscale verification is not waived. The `desktop_required` check is done. Identity-header handling is still pending.

## 9. Remaining gates before release

1. Hosted CI: `gate` passed on `d2dcd52` (section 3). Re-check CI on the latest head after any further push.
2. Physical iPhone verification, including re-pairing the genuine iPhone (section 5).
3. Physical Windows verification.
4. Live provider verification.
5. Final physical and release-candidate restart qualification for HR-Q4.
6. Owner decision on the content-verified merge policy (section 6).
7. Owner decision on stuck-Goal recovery copy (section 7).
8. Owner acceptance of X1 wording (section 8).
9. Resolve or accept the dev-only `shell-quote` advisory (section 3).

## 10. Before the Model Opportunity Layer and UI integration

- The gates in section 9 that concern the Goal Engine's completion and integration semantics (items 6 and 7) should be decided first, because the UI will expose them.
- The cancellation and HR-Q4 behaviour should be re-verified against the release build, not only the Master running an older worktree.
- No Model Opportunity Layer work should begin until PR #3's status is decided by the owner. This report does not merge or close it.

# Goal Engine autonomous implementation progress

Durable checkpoint for the Haiku 5.5 High implementer / Sonnet 5.5 Medium independent reviewer cycle on
`feature/grand-project-goal-engine`. PR #3 stays open and unmerged. No production deployment, release, or merge
is authorized by this record. Each stage is accepted only on the exact pushed SHA with a successful hosted CI run
and a Sonnet PASS on that SHA. Verdicts and CI results are recorded only after they are observed.

## Current state

- Stage D.2 (7C.2B.5D.2, attestation correction authority): **ACCEPTED** on `8a9dc80f98d7e399e5df51daab2784f4ca2b21ea`.
  - Hosted CI run 38096171842: success on the exact SHA (https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/38096171842).
  - Sonnet 5.5 Medium fresh re-review of `8a9dc80`: PASS, no high or medium findings. Two minor doc imprecisions, corrected in the docs-only commit that follows this record.
  - Gate on `8a9dc80`: format, lint, typecheck, build and `npm audit --omit=dev` (0 vulnerabilities) passed; `npm test` 122 files, 2002 tests passed.
- Stage 7C.2B.5D.1a baseline accepted: `0a401bcc2358e7436e087909abf1c361a40ddb54`.
- The docs-only commit that records this acceptance and corrects the two imprecisions is a new HEAD. It inherits no acceptance from `8a9dc80`. It is verified separately by the gate and its own hosted CI run.
- PR #3: open, unmerged.
- Next action: D.3.0A formal completion-contract reconciliation (Sonnet /plan), covering the five design decisions D1–D5 and the three blockers B1–B3 recorded below.
- Limits retained for D.2 (also in `docs/V1_READINESS.md`): restart tests are not OS-kill qualification; the 026→028 fixture does not prove full historical chain validity; completion standing is D.3; the correction API and UI are D.4; post-completion correction approval through the ordinary command is blocked and must be fixed in D.4C; cross-process CAS qualification is separate.

## Stage log (append-only)

### 7C.2B.5D.1a: accepted

- Parent: `8dcc830619ae98fbf6239f536cd9c45f1768f025`. Candidate: `0a401bcc2358e7436e087909abf1c361a40ddb54`.
- CI: hosted run 38085975315 succeeded on the exact SHA.
- Sonnet 5.5 Medium verdict: PASS. Non-blocking notes: a low-severity `issueCompletionProof()` call on a refusal
  path, and an unverified parent-behaviour claim in the docs.
- Reviewer verification gap closed by the implementer: six new negative regressions were run against the parent
  `8dcc830` source in a scratch worktree. All six fail there, which reproduces the corrupted-definition bypass.
  They pass on `0a401bc`. Scratch worktree removed.

### 7C.2B.5D.2: attestation correction authority

Commits, in order:

- `35e7d4a` D.2a: append-only correction authority core (migration 028, pure schemas and digests, service,
  approval column and gate, tests).
- `4f92637` migration head expectation 027 → 028 in `db.test.ts` (count 27 → 28).
- `6766381` D.2b: read-only correction history route and its tests. Local gate passed (122 files, 1981 tests).
  - Hosted run 38090255646 **failed**: `src/server/goals/finalApply.test.ts`, "reproduces ignored user-file
    replacement at the final read-tree boundary", timed out at Vitest's 5000 ms default. That file has no
    correction-code imports. The test takes about 3.6 s alone.
- `aafc7b7` test-only fix committed by the user (Alex Harrison), not by this implementer. It adds a `30_000` ms
  timeout to that characterization test. No assertions changed.
- `7b7ada9` D.2 review remediation. Hosted run 38091022322: **success** on the exact SHA.
  - `loadVerifiedChain` verifies the replacement attestation's approval identity, not only its record digest.
    Test: 'reports a supersession as invalid when its replacement approval no longer matches the replacement'.
    Confirmed by mutation: the test fails without the identity check.
  - `recordUserConfirmationEvidence` explicitly refuses approvals carrying a correction action digest. Test:
    'refuses a correction approval as user-confirmation evidence'.
- `faf0985` D.2 gap closure: restart and fresh-connection coverage, rollback on a failing later write, damaged-row
  fail-closed after restart, 026→028 migration upgrade with a seeded historical attestation, SHA-1 and SHA-256
  withdraw and supersede with no ref movement, completion-predicate table, cross-Goal approval refusal, and
  documentation. Hosted run 38092373327: **success** on the exact SHA.
- D.2 review remediation commit (this checkpoint's commit; SHA recorded in the next checkpoint):
  - Pins the pending-approval refusal to `approval_required` (was a bare `toThrow()`).
  - Pins the direct-SQL malformed-row, cross-Goal forged-row, and migration correction refusals to the exact
    migration 028 trigger message, not a catch-all or a `UNIQUE|...` alternation. The forged cross-Goal row is
    refused by the trigger before the foreign-key check, and that is what the test now asserts.
  - Pins the approval-detail immutability refusal in `goalSchema.test.ts` to `goal approval identity is immutable`.
  - Renames the completion-predicate test so it states that it covers the pure predicate only.
  - Corrects the stale status line at the top of `docs/GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md`.
  - Gives the two Git-fixture `it.each` blocks (withdraw, supersede; SHA-1 and SHA-256) an explicit `30_000` ms
    timeout. Measured isolated durations: withdraw 0.58–0.67 s, supersede 0.87 s, so 30 s leaves about 30x
    headroom and a real hang still fails. The full suite passed under the default single-worker configuration
    without the timeout, so the change is defensive for loaded runners, and it is recorded as such.

Sonnet 5.5 Medium reviews of D.2:

- Review of `6766381`: PASS. Two medium findings, both addressed in `7b7ada9`.
- Review of `7b7ada9`: PASS. Two low findings, not blocking.
- Review of `faf0985`: PASS with limits. Four low findings (listed above). Also reported: four `it.each` tests
  timed out at 5000 ms when four test files ran concurrently. The same tests pass in isolation, and the timeout
  change above addresses them.

Limits that must be stated at D.2 acceptance:

- "Restart" in the correction tests means closing the SQLite connection and reopening the database file. It is
  not an operating-system kill of a process mid-transaction. A true crash harness is not built.
- The migration upgrade test uses fabricated, historical-shaped attestation digests. It shows that rows survive
  026→028 unchanged. It does not show that real chain validation passes for a historical attestation.
- Completion-standing projection and any completion consumer are deferred to D.3. `attestationCorrectionStandingAllowsCompletion`
  is tested but has no caller.
- Correction write route and desktop correction UI are deferred to D.4. D.2 exposes service functions and a
  read-only history route.
- A cross-format replacement inside one Goal cannot be constructed, because the Goal engine binds one repository
  per Goal. Cross-Goal replacement is refused.
- A supersession is not re-evaluated when its replacement is later disputed or withdrawn. The original stays
  `superseded`, which is non-authoritative. This is the fail-closed direction and is documented in the design doc.

## Remediation iterations

- D.1a: 0 substantive remediation iterations.
- D.2: 2 substantive remediation iterations. `7b7ada9` answered the `6766381` review (two medium findings).
  The review-remediation commit after `faf0985` answered the `faf0985` review (four low findings). The `faf0985`
  gap closure was a planned stage deliverable, not counted as a review remediation.
- CI-only fix: the `finalApply` timeout after `6766381` was handled by the user's `aafc7b7`, not counted as a
  review remediation.
- Budget: the four-attempt limit per phase is not reached.

## Open validation risk (recorded during the docs-only acceptance commit)

- On the docs-only commit's first `npm test`, five tests in `src/server/goals/supervisorRemediation.test.ts` and
  `src/server/goals/routeProbe.test.ts` hit the 5000 ms default timeout (5 to 8 s observed). The same two files pass
  63 of 63 in isolation, with the slowest test at 529 ms. A second full `npm test` on the same tree passed 122 files
  and 2002 tests. The first failing run is recorded here, not treated as a pass.
- Load during the failing run was about 4 on 12 cores, with desktop applications running. The cause is not proven.
- Action for hardening (H.x): measure and reduce fixture cost, or set a justified per-test timeout with measured
  headroom in those specific tests. Do not raise global timeouts to hide failures.

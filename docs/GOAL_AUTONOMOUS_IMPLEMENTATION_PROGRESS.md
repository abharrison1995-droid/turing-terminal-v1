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
- Accepted checkpoint: D.3.1-pre-b `30e9b49ef2287e17db454376dac9b8788bf2ac89` (CI run 38098931320 success; Sonnet 5.5 Medium PASS, low notes only).
- User decisions approved in chat (D.3 authorization directive): **D1** exact-attested-tip for version-2 completion; **D4** narrowly guarded user-initiated v2 `running → completed` transition with a dedicated proof-bound authority, not a generic user actor edge. D2, D3 and D5 are resolved as recommended in the D.3.0A plan. The D.3.0B contract documentation follows these decisions.
- Next action: close the seven D.3.1 negative-test items, complete D.3.0B documentation, then the D.3 sub-phases D.3A–D.3G, each planned by Sonnet, implemented by Haiku and independently reviewed by Sonnet.
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

### D.3.1-pre-b: enable valid version-2 manual handoffs: ACCEPTED on `30e9b49`

- Parent: `c66db2a0ab3a9b8c7e273140362585a16fe21cfc`. Candidate: `30e9b49ef2287e17db454376dac9b8788bf2ac89`.
- Changes: the approved completion-authority reader moved to `approvedCompletionAuthority.ts` as a pure code move,
  with a read-only `approvedCompletionPolicyMode` accessor. `ensureCompletionReady` branches on the validated mode;
  version 1 keeps its original assertion. The v2 evaluator marker is a handoff precondition only, never completion.
- Local gate on the committed tree: format, lint, typecheck, build, `npm audit --omit=dev` (0), `npm test` 122 files and
  2009 tests passed. The first full run failed one exported-surface test; the reader move fixed it without editing the test.
- Hosted CI: run 38098931320 on the exact SHA: **success** (verified with `gh run view`; https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/38098931320).
- Sonnet 5.5 Medium review of `30e9b49`: PASS, no blocking findings. Targeted rerun of `completion.test.ts` and
  `manualHandoff.test.ts` 128 of 128 passed; `tsc -p tsconfig.server.json` clean. Low, non-blocking:
  1. No direct test of the null-mode fail-closed assert in `ensureCompletionReady` for a Goal with no approved version,
     a non-current version, a corrupted hash, or a lineage failure. The code maps these to null by reading; a test is owed.
  2. The "source ref moves" v2 test does not first assert the observation is `valid` before the move.
  3. The remaining v2 regressions were not recorded in any document until this entry. They are open work, listed below.
- Remaining D.3.1 regressions not yet covered: base-ref movement; new findings invalidating readiness;
  stale-after-manual-integration with separate external verification; historical pre-v2 attestation not valid as v2 evidence.

### D.3.1 closure (A1–A7 tests) and D.3.0B contract docs: ACCEPTED on `3ce365b`

- Commits: `068dd0d` test(goals): 19 closure tests in `manualHandoff.test.ts` (A1 ×4, A2 ×2, A3 ×2, A4a ×3, A4b, A4c, A5 ×2, A6a ×2, A6b ×2). `3ce365b` docs(goals): CCv2r1 and D1–D5 contract (five docs).
- Production code unchanged. `git diff 30e9b49 -- migrations` is empty.
- Gate, run independently by the lead on `3ce365b` after `npm ci`: format, lint, typecheck, build, `npm audit --omit=dev` (0), `npm test` 122 files and 2028 tests all pass. Focused `manualHandoff.test.ts`: 112 of 112.
- Sonnet 5.5 Medium review of `3ce365b`: PASS. Low, non-blocking notes:
  1. A3 and A4a–c check `repositoryState` and row counts but not Goal `status` or the absence of `goal_external_completion_proofs` rows. Add in the next test pass.
  2. A5 does not assert the approval count is unchanged.
  3. A2, A3(a), A4b and A6a reuse the first approval id rather than creating a second approval, because of the unique index on `(goal_id, external_integration_action_digest)`. Rejection codes stay exact.
  4. A1 cannot reach the `policyMode !== null` assert at `manualHandoff.ts:627` through a public path (recorded as F1).
- Docs-to-code checks by the reviewer: the action digest excludes `observedAt`; the proof digest covers the whole body including it. The reserved identifiers are labelled reserved and not implemented.
- Hosted CI: run 38101198242 on `3ce365b`: **success** (verified with `gh run view`).

### D.3B v2 fixture kit and D.3C read-only completion preflight: candidate `3ca0a63`, pending hosted CI and review

- Commits: `450938c` test(goals): extract reusable v2 Goal fixture kit (D.3B), `goalV2TestKit.ts`; `manualHandoff.test.ts` 112 of 112 before and after. `3ca0a63` feat(goals): read-only external completion preflight (D.3C), `externalCompletionPreflight.ts` (new) and two test files.
- Authority: the preflight is read-only and mints no approval, proof or terminal authority. Its report sets `authority` literals to false, sets `actionFields` to null when refused, and `contentPreservation` is `not_proven` in every report. D4 is not implemented; the preflight does not reference `transitionGoal`.
- Local gate on `3ca0a63`, run by the lead: format, lint, typecheck, build, `npm audit --omit=dev` (0), `npm test` 124 files and 2054 tests passed.
- Held out of the commit (not weakened, no production edit): four planned tests whose expected codes were unreachable.
  1. T6b: expected `definition_not_approved`; observed `goal_not_running` (a draft Goal; the status check runs first).
  2. T11a source ref moved, T11b project path swapped, T11d `.git` renamed: expected `attestation_stale` (`source_changed`, `repository_identity_changed`) and `git_unavailable`; observed `completion_not_ready` with null detail, because `evaluateCompletion` fails first with `goal_ref_unavailable`.
     Consequence: the `stale` and `git_unavailable` mappings in the preflight's git-observation branch have no committed test. Sonnet is asked to judge whether this gap is blocking.
- Kit: `integratedExternalFixture` gained an opt-in `running` option (default off). `v2AttestedFixture` uses it.
- Sonnet 5.5 Medium review of `3ca0a63`: **PASS**. Authority, check order, D1 exact-tip, digest goldens (independently recomputed), kit extraction and migrations all verified by the reviewer. Gap judgement: not blocking. The reviewer confirmed the mappings are reachable through the destination-ref and repository-identity scenarios and recommended two follow-up tests.
- Low follow-ups, all non-blocking, to be closed in a later hardening or D.3G pass:
  1. `refused()` calls `finish()`, which can throw `preflight_internal_invalid` from inside the catch if a `detail` fails the code pattern. Retry with `detail: null` or catch inside `refused`.
  2. T12b static guard: the verb regex is uppercase-only; the `.prepare(` scan matches only single-quoted literals; no event-publishing identifier is listed.
  3. No committed test forces `preflight_unavailable` or `preflight_internal_invalid`.
  4. `v2AttestedFixture` always passes `running: true`; only the preflight tests use it.
  5. Coverage follow-up: a test that deletes the destination ref expecting `attestation_stale` / `destination_ref_missing`, and one that repoints to a clone that keeps the goal ref expecting `repository_identity_changed`.
- Hosted CI: run 38103923762 on `3ca0a63`, still in progress when this entry was written. Acceptance requires success.

### Session checkpoint: D.3C verification and reviewer availability (lead)

- Verified at session start: branch `feature/grand-project-goal-engine`; local HEAD and `origin` both `3ca0a631d915e0ca992e1d830d7ba9153546b49b`; PR #3 open, not draft, not merged; hosted CI run 38103923762 `success` on that exact SHA.
- D.3C (`3ca0a63`): Sonnet 5.5 Medium review PASS with five low, non-blocking follow-ups (listed under the D.3B/D.3C stage entry). Accepted as PASS by Sonnet. Full acceptance under the mandatory standard is NOT recorded yet, because the GPT-6 SOL Low review is required and is unavailable (see below).
- GPT-6 SOL (Low): NOT AVAILABLE in this session. The available subagent models are Claude models only (sonnet, opus, haiku, fable). No SOL review has been performed or fabricated. Under the mandatory directive, no stage may be marked accepted on Sonnet and Haiku reviews alone. Work proceeds on planning and implementation only; acceptance is withheld until a SOL review is available or the user changes the standard.
- Next: Sonnet plan for D.3C hardening and D.3D (`d3d_plan.md` in scratchpad); Haiku implements after plan.

### User acceptance-standard decision (recorded by the lead)

- The user stated in chat that Sonnet 5.5 Medium is accepted as the equivalent of the GPT-6 SOL Low review while SOL is unavailable, and that a Sonnet Medium PASS plus the full validation gate and exact-SHA hosted CI counts as full acceptance.
- Scope: this substitution is the user's decision for this programme. It does not claim that a SOL review was performed. Stage records must state "SOL Low: waived by user, not performed" where a SOL verdict would otherwise appear.
- Earlier D.3B/D.3C/D.3.1 acceptance notes that said "acceptance withheld pending SOL" are superseded by this decision only where Sonnet PASS, the full gate and exact-SHA CI are all recorded.

### D.3C read-only completion preflight: ACCEPTED on `3ca0a63` (D.3B fixture kit `450938c` included)

- Acceptance basis under the user's standard above: full local gate on `3ca0a63` (124 files, 2054 tests); hosted CI run 38103923762 `success` on that exact SHA; Sonnet 5.5 Medium PASS (no blocking findings). SOL Low: waived by user, not performed.
- Low follow-ups carried into the D.3C hardening commit in progress (Haiku, from the plan `d3d_plan.md` section 2): `refused()` never throws; stricter static read-only guard; targeted tests for `preflight_unavailable` and `preflight_internal_invalid`; explicit running helper in the v2 fixture; destination-ref and repository-identity negative tests. Four held-out tests (T6b, T11a, T11b, T11d) remain unimplemented; the plan records why their absence does not weaken the gate.
- Until the hardening commit is accepted on its own SHA, the follow-ups stay open.

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

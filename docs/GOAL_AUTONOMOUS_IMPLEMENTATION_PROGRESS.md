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

### D.3C hardening (`d17dc30`) and D.3D user completion decision (`d97a528`, docs `5d3b489`): candidate `7bd4297`

- Implementer: Haiku 5.5 High. Plan: Sonnet 5.5 Medium (`d3d_plan.md`). Trailers: Haiku on each commit. Migrations unchanged (`git diff 3ca0a63 HEAD -- migrations` empty).
- Lead gate on `7bd4297` (clean committed tree): format, lint, typecheck, build, `npm audit --omit=dev` (0), `npm test` 126 files and 2103 tests all passed.
- Sonnet 5.5 Medium review of `7bd4297`: PASS. Targeted: 75 of 75 decision and preflight tests; typecheck clean. Inertness table: every completion-approval consumer guarded (decideGoalApprovalAsUser, bindExactGate, recordUserConfirmationEvidence, freshness user_confirmation, evaluateCompletion, checkCompletionProof, transitionGoal, completeGoal, supervisor). SOL Low: waived by user, not performed.
- Review follow-ups. None blocks D.3D. All must close before D.3E starts:
  1. Concurrency: no committed concurrent test. Test 16 is serial only. Observed behaviour: concurrent identical decisions give one success and one fail-closed `preflight_refused / observation_changed`. D.3E must serialize per Goal or retry once on `observation_changed`, and add a committed concurrent test asserting one row, two events and one success.
  2. No direct test of the completion-approval guards in `evidence.ts:410` and `freshness.ts:137-138`. The `freshness.ts` change also tightens correction approvals, which is untested.
  3. Static guard D19b is weaker than the plan. It is case-sensitive and single-space, and it does not flag a production caller of `readExternalCompletionDecision` or `listExternalCompletionDecisions`. The preflight `FORBIDDEN_IDENTIFIERS` omits `externalCompletionDecision`; the import check covers it.
  4. `completionRows` matches any row with the action string in `detail_json`; only raw SQL can create such a row. Fail-closed; no fix needed before D.3E.
  5. Docs: state that `'user'` means an authenticated app control (loopback, or Tailscale login plus paired device), not a verified person. Add in D.3E docs.
- Disclosed gaps, non-blocking for D.3D: test 5 (changed lineage) not implemented; test 19 supervisor-with-proof leg untestable (no proof writer before D.3E).
- CI: run 38136541904 on `7bd4297`, in progress at this entry. Acceptance requires success.
- Next action after CI success: accept D.3C hardening and D.3D on `7bd4297` under the user's standard; then Sonnet 5.5 Medium `/plan` for D.3E, the highest-risk stage.

### CI result on `7bd4297` and timeout fix `3848522` (lead verification)

- Hosted CI run 38136541904 on `7bd4297`: **failure**. The gate's `npm test` failed two cases: `A3 refuses destination-ref movement for version 2 without ancestry-based acceptance (sha1)` and `(sha256)`, each `Test timed out in 5000ms`. The other 125 files passed. The lead's local gate on `7bd4297` had passed; the runner was slower. `7bd4297` is therefore NOT an accepted SHA, even though the Sonnet review returned PASS on it.
- Fix `3848522` (test-only, one line): `30_000` ms added to the `it.each` block, which covers both sha1 and sha256. Hosted CI run 38137370538 on `3848522`: **success**.
- Acceptance status: D.3D code is unchanged between `7bd4297` and `3848522`. Acceptance must still be recorded on a reviewed, CI-green SHA; the timeout-only commit needs its own small Sonnet review before D.3D is accepted on `3848522`.
- Timeout policy (decided by the lead, per the user's request): no global or CI-only timeout increase. Real-Git integration tests will use one shared named constant, applied explicitly per test with measured justification. A static guard test will fail when a test that creates a Goal repository or fixture omits an explicit timeout, so the same omission cannot recur silently. Root-cause fixture-cost reduction remains in H.5.

### ACCEPTED: D.3C hardening (`d17dc30`) and D.3D user completion decision (`d97a528`, docs `5d3b489`) on `3848522`

- Accepted SHA: `3848522` (includes `7bd4297`; the only change since `7bd4297` is one test timeout line).
- Acceptance basis under the user's standard (Sonnet Medium plus full gate plus exact-SHA CI; SOL waived by user, not performed):
  - Sonnet 5.5 Medium on `7bd4297`: PASS (decision authority, inertness table, concurrency judgement, test quality).
  - Sonnet 5.5 Medium on `3848522`: PASS, no findings (one-line timeout change, per-test only, config unchanged).
  - Lead gate on `7bd4297` (clean tree): format, lint, typecheck, build, audit 0, `npm test` 126 files and 2103 tests passed. Hosted CI on `7bd4297` (run 38136541904): **failure**, two A3 cases timed out at 5000 ms; fixed by `3848522`.
  - Hosted CI on `3848522` (run 38137370538): **success**.
- Open follow-ups that MUST close before D.3E starts (non-blocking for D.3D, blocking for D.3E):
  1. Committed concurrent-duplicate test and per-Goal serialization (or one retry on `observation_changed`) so duplicate decisions reuse instead of refusing.
  2. Direct tests for the completion-approval guards in `evidence.ts:410` and `freshness.ts:137-138`, including the correction-approval tightening in `freshness.ts`.
  3. Stronger static guard (D19b): case-insensitive, whitespace-tolerant proof-insert check; flag production callers of `readExternalCompletionDecision` and `listExternalCompletionDecisions`; add `externalCompletionDecision` to the preflight forbidden identifiers.
  4. Docs sentence: `'user'` means an authenticated app control (loopback, or Tailscale login plus paired device), not a verified person.
  5. Timeout guard and shared constant for real-Git integration tests (decided; see the CI entry above).
- Disclosed gaps, non-blocking: test 5 (changed lineage) not implemented; test 19 supervisor-with-proof leg untestable until a proof writer exists.
- Next action: Sonnet 5.5 Medium `/plan` for D.3E, including follow-ups 1–5.

### D.3E atomic version-2 Goal completion: candidate chain (lead record; final review pending)

- Authorised base: `160fa2b` (CI green). Owner decision recorded: accept `160fa2b` as the reconciled base; do not re-ask.
- Commits on `feature/grand-project-goal-engine`, each gated on the exact tree and pushed fast-forward only:
  - D.3D follow-ups F1, F2, F3, F5: `1d9cac4` (per-Goal FIFO lock, retry-once on `observation_changed`, `.immediate()` decision
    transaction), `073d196` (completion approvals refused as final-apply authority, allow-list length 7 to 8), `e150d95`
    (30 s real-Git timeout constant, AST timeout guard, hardened static guard). Hosted CI green on `e150d95`.
  - Commit 2, terminal authority: `e884a7d` (`externalCompletionTerminal.ts`, `activeWork.ts`, `EXTERNAL_COMPLETION_REASON`,
    proof payload helper). Hosted CI run 38161289548 success. Independent Sonnet Medium: PASS WITH NON-BLOCKING FINDINGS.
  - Commit 3a, completion service: `d6ab8ad` (`externalCompletion.ts`, preflight identity fields). Hosted CI run 38163968111
    success on the exact SHA. Independent Sonnet Medium: PASS WITH NON-BLOCKING FINDINGS (test gaps moved to 3b).
  - Commit 3b, adversarial matrix and hardening: `207219e`. Gate on the exact tree: format, lint, typecheck, build,
    `npm audit --omit=dev` 0 vulnerabilities, `npm test` 133 files and 2346 tests passed. Hosted CI run 38167906897
    success on the exact SHA. Independent Sonnet Medium: PASS WITH NON-BLOCKING FINDINGS, no blocking findings.
- Non-blocking findings carried to the final D.3E review:
  1. A transient SQLite read failure during replay is reported as `completion_corrupt/integrity_check_failed`, not
     `completion_read_failed`. Fail-closed, but the label is misleading. Disclose or correct in a later commit.
  2. In-transaction read errors surface as `completion_persistence_failed` or `database_busy`, not `completion_read_failed`.
     Fail-closed, mislabelled.
  3. The `action_identity` branch and the second action-digest comparison after the re-read have no direct test.
  4. The drift seam test asserts counts and the Goal row, but not a full event-log comparison.
  5. `decision_action_mismatch` and `reviewed_preflight_changed` are tested only through a seam that replaces the report. The
     `decision_action_mismatch` setup cannot occur in production because the report digest binds the action fields.
  6. A destination advanced after observation still completes on the attested commit (the stated D1 behaviour). The proof
     records the observed commit, which is no longer the live tip. Must be disclosed in the final review.
- Not produced by a real service path, recorded as untested: `destination_changed` (structurally unreachable),
  requirement 17 (observation from another run; no producing path), definition amendment, milestone skip, pending final
  review, handoff tamper, active run, blocking finding, supersede.
- Deviations from the plan's predicted codes (all fail-closed): denied decision row gives `decision_corrupt/approval_fields_invalid`;
  denied attestation gives `preflight_refused/correction_standing_unavailable`; failed replay read gives
  `completion_corrupt/integrity_check_failed`.
- Commit 4 documentation: `a6d73f8` (contract design, proof contract, V1_READINESS D4 row; Haiku, gate format, lint and typecheck
  only). A lead follow-up corrects the stale identifier-table rows in `docs/V1_READINESS.md`.
- Commit 3c, coverage gaps and contract-doc correction: `a3199cc`, amended before push to `b769eb0` (corrected commit body).
  Adds service-path tests for decision lineage, attestation approval gate, risk, requester and respondedAt tampers, base tree and
  base history, pending final review, deleted deliverable, post-preflight drift (milestone, finding, acceptance, active cycle and
  non-terminal run), and committed-completion read-back. Replaces a vacuous approval assertion. Corrects the design doc (as-implemented
  observation note under §7, rows 4, 9, 12, 21, G1-G3 and G5-G7 statuses, coverage gaps). Reasons for not-producible cases are in the design doc.
- Full gate on the exact `b769eb0` tree: format, lint, typecheck, build, `npm audit --omit=dev` 0, `npm test` 133 files and 2362 tests passed.
- First full `npm test` run on the 3c tree FAILED one test: `goalHandoff.test.tsx` "requires a deliberate confirmation to resume an approved orphan"
  (a `findByText` wait exceeded the default 1000 ms at about 1.1 s under full-suite load). The file passed 3 of 3 in isolation and the
  second full run passed. The first failing run is recorded here, not treated as a pass. Fixed in the same commit by a per-call
  5000 ms wait and a 15000 ms per-test timeout on that one test; no global timeout changed.
- Final whole-path review on `b769eb0` (Sonnet Medium): PASS WITH NON-BLOCKING FINDINGS, no blocking findings. Non-blocking findings:
  a stale test title (fixed), a stale line reference (fixed), an inaccurate row-12 enforcement label (fixed), a stale V1_READINESS
  active-work statement (fixed), this progress record not updated (this entry), a per-test timeout not aligned with the enclosed wait
  (fixed), and an evidence-invalidation drift gap not named in the coverage list (fixed).
- Hosted CI on `b769eb0` (run 38174971561): success on the exact SHA.
- Follow-up `7ed1a0b` applies the review findings (docs, one test title, one per-test timeout; no production code).
  Hosted CI on `7ed1a0b` (run 38176520728): success on the exact SHA. Focused re-review (Sonnet Medium) of `7ed1a0b`: PASS WITH
  NON-BLOCKING FINDINGS, no blocking findings; it confirmed each fix against source and that no production code changed since `b769eb0`.
- **D.3E ACCEPTED on `7ed1a0b`** under the stage rule: hosted CI green on the exact SHA and a Sonnet Medium PASS (whole-path review on
  `b769eb0`, delta re-review on `7ed1a0b`). Accepted with these disclosed residual risks, all in `docs/GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md`:
  the Git/SQLite TOCTOU window (a ref that moves after the Git read still completes on the observed commit); `contentPreservation`
  `not_proven`; the in-process per-Goal lock; the error-label deviations; no service-path test for a reused observation (not producible
  through the service input) or for a definition amendment, a supersede or a handoff tamper; `destination_changed` unreachable; no route or UI;
  Windows unverified.
- Non-blocking items still open, not gating D.3E: the planned operation and `apply_to_base` active-work blockers are covered at terminal
  and unit level only; the `completion_decision_requires_dedicated_service` code is referenced by a route refusal and a test, and is
  recorded in the contract doc.
- Next action: D.3F. D.3G, D.4, the Model Opportunity Layer, V1 hardening and V1 qualification have not started. D.3F is planned by Sonnet
  Medium, implemented by Haiku, reviewed and gated under the same rules before any work begins.

### D.3F historical completion standing (lead record; stage not yet accepted)

Commits on `feature/grand-project-goal-engine`, each with hosted CI green on its exact SHA and an independent Sonnet review:

- `7f89727` pure completion-standing classifier and proof-row count helper. CI success (run 38179501425). Focused Sonnet review: PASS WITH NON-BLOCKING FINDINGS.
- `f2c4dd0` read-only reader `readGoalCompletionStanding` (no writes, no Git; it reads the goals row, the proof, the correction projection and the other attestations). CI success (run 38182589431). Sonnet review: PASS WITH NON-BLOCKING FINDINGS.
- `bf983f6` correction standings, independence tests, core-rule snapshots, consumer guard. Reviewed with `8ada747` below.
- `8ada747` reason-code and correction-time-rule tests. CI success (run 38187984044). Sonnet Medium review of `bf983f6` and `8ada747`: PASS WITH NON-BLOCKING FINDINGS, no blocking findings.
- `1152537` additive `completionStanding` on `GET /api/goals/:goalId`, the shared mirror type, tests W1 to W3, and two stale-comment corrections. CI success (run 38190847538). Gate passed locally on the exact tree (137 files, 2432 tests, audit 0). Sonnet Medium review: PASS WITH NON-BLOCKING FINDINGS, no blocking findings.

Decisions (owner-authorised recommended defaults; disclosed here for the stage record):

- Q1 `reconciliation_required` when a superseded attestation's replacement is not `active_uncontested`.
- Q2 names `invalid_unverified` and `historical_legacy`.
- Q3 a legacy completion is not trusted downstream.
- Q4 the replay result is unchanged; its JSDoc states that it is historical identity only.
- Q5 the standing is exposed as an additive field on `GET /api/goals/:goalId`. Deviation from the plan: it is composed in the route layer, not inside `getGoalDetail`. A read-model import would close a cycle through `activeWork` and `externalCompletionDecision`. The route already imports the read model, so no new cycle appears.
- Q6 `otherAttestations` is capped at 20 with a truncation flag.

Core rules, as pinned by tests in `completionStandingService.test.ts`: a later correction (dispute, withdrawal or supersession) before or after completion never deletes the completion, rewrites `completed_at`, rewrites the proof, reopens the Goal, launches remediation, or invents a replacement. The whole-database snapshot comparison covers dispute and withdrawal (A7). Supersession is covered at field level only (A4, A5), because it goes through the same correction service. Standing suppresses an unqualified success claim. A valid independent attestation B is not invalidated when attestation A is withdrawn (B5).

Residual risks and open items at this point:

- `correction_mapping_unclassifiable` and `chain_identity_mismatch` are not producible through the database. Only the pure classifier fallback is tested for them.
- A SQLite fault on the goal-row read throws the raw error, because a missing or corrupt row has no status to report. This is an accepted deviation. On the GET route it is not mapped to a domain error and is not tested.
- The shared mirror in `src/shared/goalApi.ts` is checked against the server types in one direction only (server assignable to shared). There is no reverse check.
- The independent-attestation tests use a test-only ref reset (`completedWithIndependent`) to create attestations at the proof tip. The service accepts that real-Git state. The replacement attestation used in the supersede tests is stale after that reset, which limits realism.
- W2 reads its expected `status` from the same row the reader reads.
- The duplicate `goal_ineligible` assertion at `src/server/goals/completionStandingService.test.ts:1748` (test-quality only, not a D.3F rule) is still present next to the C6 test at :1471. Open; not blocking.
- `GET /api/goals/:goalId` makes two separate reads, `getGoalDetail` and then the standing reader, not one transaction. A correction that lands between them could make the two disagree. Accepted for D.3F; the standing itself is a single read transaction.

Final whole-stage review: Sonnet Medium on `9b442a1` returned PASS WITH NON-BLOCKING FINDINGS, with no blocking findings. It verified each core rule against code and tests, the suppression and independence rules, before- and after-completion coverage, the read-only reader and route, and that the migrations are unchanged from `3e6848a`. Hosted CI on `9b442a1` (run 38192756562) is green on the exact SHA.

D.3F ACCEPTED on `9b442a1` under the stage rule, with the residuals above. A follow-up docs-only commit corrects three statements in this record that the final review found too broad (the reader's read description, the snapshot coverage, and the two-read route residual). It changes no code.

Not done: D.3G, D.4, the Model Opportunity Layer, V1 hardening and V1 qualification have not started. Physical Windows, iPhone, live Tailscale and live provider gates remain pending.

### D.3G complete backend lifecycle qualification (lead record; D.3 parent-stage review pending)

Plan: `d3g_plan.md` (Sonnet). Commits on `feature/grand-project-goal-engine`, each with hosted CI green on its exact SHA and an independent Sonnet review:

- `49d2f87` test kit only: `objectFormat` on `realRunHarness`; a `merge` strategy on `integratedExternalFixture`. CI success (run 38197644580). Sonnet review: PASS.
- `81dab46` normal two-parent merge completion (sha1 and sha256) and the `merge -s ours` disclosure (sha1). CI success (run 38200966386). Sonnet review: PASS WITH NON-BLOCKING FINDINGS.
- `fa9c37e` post-completion destination movement, repeated requests, v1 beside v2, and cross-Goal isolation. CI success (run 38204773368). Sonnet review: PASS WITH NON-BLOCKING FINDINGS.
- `4f1e4c3` restart, injected write faults (proof insert, recorded event, terminal update, state event) with reopen and retry, and after-commit replay. CI success (run 38208083892). Sonnet review: PASS.
- `4c6f94a` PRODUCTION FIX, found by the real-execution test. The supervisor never requested the final-acceptance gate for a version-2 Goal: `external_completion_not_activated` was not a user-terminal failure, so the Goal parked in `completion_pending` and acceptance was unreachable. The fix accepts that one code for the gate only under its own v2 signal (`finalApply.reason`). Completion still goes only through `completeGoal` and the external decision. CI success (run 38212307619). Authority review: PASS. Non-blocking: no test for a v2 Goal with an extra non-user-terminal failure, which the condition correctly refuses.
- `5559f15` real-execution v2 lifecycle (sha1 and sha256) through the real supervisor, the real approve, decision and handoff routes, real Git, attestation, completion, reopen, and a corrected completion (dispute). Plus a same-family refusal (sha1). CI success (run 38216120808). Sonnet review: PASS WITH NON-BLOCKING FINDINGS (header disclaimer missing, now added; route-validation seeding not listed as a fake, now listed; old supervisor not explicitly stopped before restart).

Coverage, mapped to the 13 lifecycle steps and 13 required conditions in the owner's D.3G text. Stated precisely, following the D.3 parent-stage review:

- Real-execution path (`goalLifecycleQualification.test.ts`, sha1 and sha256): steps 1 to 13 for a dispute through the real supervisor, real routes, real Git, real review and real acceptance. This is the only path that runs review and acceptance through the supervisor.
- Withdraw and supersede after real execution are NOT covered in the real-execution path. They are covered only by the completion-standing service suite, which uses the acceptance fixture.
- The `externalCompletionLifecycle.test.ts` scenarios (normal merge, `merge -s ours`, destination movement, repeats, v1 beside v2, cross-Goal in two databases, restart and injected faults) start from the acceptance fixture. Their review and acceptance are fixture-seeded with fixture independence, not produced by the supervisor. This is a real limit on the independent-review and user-acceptance steps for those scenarios, and the file's comments now say so.
- `merge -s ours` is covered for sha1 only.
- Cross-Goal isolation is two databases only.
- Invalid stored records, and the independent and corrected attestation rules, are covered by the completion-standing service suite, not by the lifecycle files.
- The D.3E and D.3F suites cover the remaining service-level rules.

The owner should decide whether the fixture-seeded scenarios must be re-run through the real supervisor before D.3 is treated as complete. This record does not claim that they have been. The same-family refusal is observed as `review_queue_error` with `plan_unavailable`; it is attributed to the family check only by contrast with the passing different-family run, not proven.

Residuals and gaps, stated as found:

- Cross-Goal isolation in one database is NOT producible with the fixtures: a second Goal in the same project needs an accepted final review, and producing that through the fixtures would require the independence bypass. The claim is tested with two databases only, and the test says so.
- Destination movement after completion is refused with `goal_not_running` (detail `completed`), because the status check runs before the completion-already-recorded check. This is the observed code.
- The restart is a fresh supervisor and app on the same data root after the old ones are no longer used. It does not kill a process, and the old supervisor is not explicitly stopped.
- Crash durability is simulated only through injected write faults and reopen. OS-level crash durability, WAL recovery after a killed process, and partial-fsync behaviour are NOT proven.
- SHA-256 is covered in the real-execution path (sha256 merge), and the supervisor fix was found by the sha1 path.
- Settings row: openDatabase re-seeds `goal_builtin_workflow_conflicts` on every open, so reopen comparisons exclude `settings.updated_at` only; key and value are still compared.
- The `ours` completion reads `unqualifiedSuccessAllowed: true` with `contentPreservation: not_proven`. This is an OBSERVED value, pending an owner decision on whether a not-proven content-preservation completion may read as unqualified success. It is not treated as intended behaviour.
- The v2 gate condition has no test for a v2 Goal with an extra non-user-terminal failure (non-blocking).
- Windows, physical iPhone, live Tailscale and live provider validation remain PENDING. No test here cites a fake provider as live evidence.

D.3G status. The D.3 parent-stage Sonnet review ran on `8f7f68f`: PASS WITH NON-BLOCKING FINDINGS, no blocking finding, migrations unchanged from `3e6848a`. Its findings were that the first record overstated coverage, and that one file comment claimed no fixture bypass when the scenarios use the acceptance fixture. Both are corrected in `ff56c14`, which is comment and docs only. Hosted CI on `ff56c14` (run 38219269533) is green on the exact SHA. `8f7f68f`'s CI run was cancelled because `ff56c14` superseded it; it is not a failure.

**D.3 ACCEPTED on `ff56c14`** under the stage rule: the parent-stage Sonnet review (on `8f7f68f`, plus the comment-only delta) passed with non-blocking findings, and hosted CI is green on the exact SHA. Accepted with the disclosed limits above, and with these OPEN OWNER DECISIONS, which are not settled by this record:

1. Whether the `externalCompletionLifecycle.test.ts` scenarios (normal merge, `ours`, destination movement, repeats, v1 beside v2, cross-Goal, restart and faults) must be re-run through the real supervisor. Today they seed review and acceptance through the acceptance fixture with fixture independence. Only `goalLifecycleQualification.test.ts` runs review and acceptance through the supervisor.
2. Whether a completion with `contentPreservation: not_proven` may read as `unqualifiedSuccessAllowed: true`. The current value is pinned as observed and is not treated as intended.
3. Withdraw and supersede after real execution are not covered in the real-execution path (they are covered in the completion-standing service suite).
4. The duplicate `goal_ineligible` assertion from D.3F is still present.
5. The v2 gate condition has no test for a v2 Goal with an extra non-user-terminal failure.

Windows, physical iPhone, live Tailscale and live provider validation remain PENDING. D.4 and later stages have not started.

### D.4A authenticated completion API: ACCEPTED on `3cdc888` (lead record)

Commits, in order: `b011fac` (shared If-Match parser), `34bd58d` (read-only preflight and status routes), `cfc739d` (user completion decision POST), `e2abffd` (completion POST by exact action digest), `3cdc888` (status derived from the completion standing; guard allow-lists narrowed to the D.4A route callers). The plan is `scratchpad/d4a_plan.md` (Sonnet Medium).

Routes: `GET /api/goals/:goalId/completion-preflight?attestationId=` (read-only, ETag = report digest); `POST /api/goals/:goalId/completion-decision` (If-Match = reviewed preflight digest, strict body, user decision only); `POST /api/goals/:goalId/completion` (If-Match = exact action digest of a stored decision; the attestation and reviewed digest come from that stored row, never from the request); `GET /api/goals/:goalId/completion[?actionDigest=]` (read-only status).

Corrections made during the stage, all disclosed:

- T3 (slice 3): a digest made stale by a correction returns `409 preflight_refused` (`attestation_disputed`), not the planned `412`. The correction check refuses the disputed attestation before the digest comparison (`externalCompletionPreflight.ts`). Still no write. The 412 path stays pinned by the substituted-digest test.
- Status defect (caught by the static guard, not by behaviour tests): the first status GET derived `state` from the historical stored completion, which still reads `completed` after a dispute or withdrawal. Fixed in `3cdc888`: `state` comes from the completion standing (`completed` only when uncontested; `contested` for other v2 standings; `legacy` for v1). The status record carries no `preflightDigest`. The POST response keeps it.
- Guard allow-lists: `goalAuthorityStaticGuard.test.ts` now names `goals/externalCompletionApi.ts` (decision reader, read-only), and `goals/goalRoutes.ts` (decision recorder, completion service). The guard reasons said "no route caller yet". This is the stage that adds those callers. Reviewed as narrow, not a loosening.

Evidence: full gate on `3cdc888` green (format, lint, typecheck, `npm test` 140 files / 2496 tests, build, `npm audit --omit=dev` 0 vulnerabilities, migrations diff empty). Independent Sonnet Medium review: `VERDICT: PASS WITH NON-BLOCKING`, no blocking findings. Hosted CI on `3cdc888`: run 38227589845, success.

Non-blocking follow-ups (not blocking D.4A):

1. The generic approval route returns `200 changed:false` for an already-approved completion approval. It writes nothing. Optional hardening: refuse completion rows there regardless of status.
2. A second independent attestation cannot complete once any completion decision exists (preflight refuses; pinned by T11). Conservative and fail-closed. Revisit in D.4C/D.4E.
3. `toCompletionRecord` returns no record when `completedAt` is null. Not reachable for a valid version-2 completion, per the terminal reader's agreement check.
4. Preflight can return `429 verification_busy` under load (shared verification slot). Clients should retry.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. Stage D.4B (desktop completion UI) not started.

### D.4B desktop completion UI: ACCEPTED on `5a06d49` (lead record)

Commits: `6f1f8a4` (client API and pure completion model), `4e6de7e` (read-only review panel in the Handoff tab), `5aca8f7` (Record completion decision and Complete Goal controls, mobile assertion), `5a06d49` (test-only: timer, Goal switch and pre-existing decision never complete the Goal). Plan: `scratchpad/d4b_plan.md` (Sonnet Medium).

Behaviour: `GoalCompletion` is mounted in the Handoff tab of the desktop cockpit only. "Record completion decision" posts with the preflight digest as If-Match and completes nothing. "Complete Goal" appears only after a recorded decision, has its own acknowledgement, and posts with the stored action digest as If-Match. The completion POST is reachable only from the Complete Goal click handler. The mobile cockpit has no completion control (`goalMobile.test.tsx`).

Decisions made during the stage (lead, disclosed):

- The decision control is labelled "Record completion decision", not the plan's "Confirm external integration". The existing attestation button already uses that name on the same tab. The review agreed, and the owner may choose otherwise.
- Raw field names and codes are never printed. The plan's observed-pair line was replaced by plain sentences: "Content preservation: not proven."
- The completed heading "Completed on your decision" sits beside the not-proven line. Owner decision 2 remains open, so this copy is provisional.

Evidence: full gate on `5a06d49` green (format, lint, typecheck, `npm test` 142 files / 2608 tests, build, `npm audit --omit=dev` 0, migrations diff empty). Independent review of `3e538b2..5aca8f7`: `VERDICT: PASS WITH NON-BLOCKING`, no blocking findings. Hosted CI on `5a06d49`: run 38236306160, success. The timer, Goal-switch and pre-existing-decision cases were added after review and are covered by that CI run.

Non-blocking follow-ups:

1. Implementer report misnamed the file of one edit (`goalHandoff.test.tsx` vs `goalCompletion.test.tsx`). No existing assertion was weakened; the repository is the authority.
2. "Completed on your decision" could bind the not-proven wording into the same string (review suggestion, for D.4F).
3. A 503 on a read-only preflight GET shows the "do not assume it failed or succeeded" wording. Accurate, but odd for a read. For D.4F.
4. D.4F: authenticated-user wording ("your decision"), contrast of the Record and Complete controls against the attestation ConfirmPanel on the same tab, hash overflow, screen-reader behaviour, late responses after a Goal switch, retryable 429 on Complete.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. D.4C (correction authority) not started.

### D.4C post-completion correction authority: ACCEPTED on `55fed93` (lead record)

Commits, in order: `29bb14a` (generic route refuses every correction approval with `correction_decision_requires_dedicated_service`), `883ad0c` (one existing D.3F expectation updated to that code), `caf1b83` (dedicated user correction-decision service, one outer transaction), `3da78be` (authenticated route `POST /api/goals/:goalId/attestation-corrections/:approvalId/decision`), `55fed93` (static guard rule for the new service). Plan: `scratchpad/d4c_plan.md` (Sonnet Medium).

Behaviour: the route accepts one strict decision (approved or denied) for one approval. The gate is the existing correction approval, which the service decides as the user and then appends. The If-Match digest is the reviewed action digest. A stale chain, a mismatched action, or a second disallowed correction is refused, and nothing is written. A completed Goal's stored completion, its completion time, its proof and its events are untouched; only the correction standing changes. A withdrawal of attestation A leaves an independent attestation B active.

Deviations and changes (disclosed):

- The plan's claim that `idempotency_conflict` is reachable was wrong. Migration 028's unique index on the correction action digest already covers it, so the code path is defensive only.
- `883ad0c` changes one existing assertion in `manualHandoff.test.ts`: a completed Goal's generic refusal now reports the dedicated code instead of `goal_terminal`. The pending-status and empty-history assertions are unchanged. Independent review judged this legitimate and not a weakening.
- The route is not reachable end to end until D.4D adds the request route, as planned. The decision is exercised by tests that create the gate through the service.

Evidence: full gate on `55fed93` green (format, lint, typecheck, `npm test` 144 files / 2639 tests, build, `npm audit --omit=dev` 0, migrations diff empty). Independent review of `d58345e..55fed93`: `VERDICT: PASS WITH NON-BLOCKING`, no blocking findings. Hosted CI on `55fed93`: run 38243466534, success.

Non-blocking follow-ups:

1. The route's generic 503 fallback (`attestation_correction_unavailable`) has no test. Add one in D.4D.
2. After the decision commits, the route reads the completion standing. If that read threw, the client would get 503 although the decision persisted. A retry returns `reused: true`, so nothing is lost. Edge case only.
3. The plan did not name the existing test whose expectation changed (see deviations above).

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. D.4D (correction request route and interface) not started.

### D.4D correction request route and desktop interface: ACCEPTED on `b3c91bb` (lead record)

Commits: `4f30dfd` (correction request service and two new refusal codes), `5723a86` (request POST and read additions on the history GET), `af76c1a` (static guard rules), `4235cb9` (client API, shared types, pure correction model), `4d20d25` (desktop correction controls), `b3c91bb` (test-only: no mutation on SSE and tab or Goal switches; generic route refuses a pending correction gate on a completed Goal). Plan: `scratchpad/d4d_plan.md` (Sonnet Medium).

Behaviour: the request POST only creates a pending approval gate; it writes no correction row and changes no standing. The decision is a separate user action on the D.4C route. The compare-and-set token is the chain position, which the server computes itself. A stale value gets `409 correction_chain_changed` and nothing is written. Supersede names its replacement in the body, which is part of the reviewed action; an invalid replacement gets `422 replacement_invalid`. An identical pending request returns the same gate. The history GET is read-only (whole-database tests and a writer-name scan of its handler). The desktop panel has three separate actions, each with a confirm step; the decide controls appear only after a successful request; nothing is sent on render, refresh, SSE, or navigation.

Deviations and decisions (disclosed):

- `getAttestationCorrectionChainPosition` lives in `attestationCorrection.ts`, not the request module, because its private helpers are needed there (plan section 2).
- The design line cited in the plan was off by two lines (line 67, not 65).
- Dispute and withdraw copy adds the design's sentence that a completed Goal "will remain historically completed". The copy states that the completion is not changed, and it never claims content preserved or work verified.
- Mobile shows only "Corrections: Made on the desktop interface." It does not show the correction standing, because the phone cockpit has no attestation data. Less informative than the plan, but safe.
- The decision gate is shown inline, not in a confirm panel. The three request actions use the confirm panel.
- A pending gate that survives a reload needs its explanation re-entered, because only its digest is stored. The UI says so and disables Confirm until the same text is entered. Decline is always available.

Evidence: full gate on `b3c91bb` green (format, lint, typecheck, `npm test` 149 files / 2751 tests, build, `npm audit --omit=dev` 0, migrations diff empty). Independent review of `88711c0..4d20d25`: `VERDICT: PASS WITH NON-BLOCKING`, no blocking findings. The review's coverage gaps (generic refusal on a completed Goal; SSE and tab or Goal switch no-POST tests) were closed in `b3c91bb`, as test-only changes.

CI: the first hosted run on `b3c91bb` (38251886834) was cancelled, with no later push to supersede it. It was re-run once; the re-run is success on the same SHA. The cancellation cause is unknown and is recorded here, not assumed to be a failure.

Non-blocking follow-ups:

1. The service's in-transaction `persistence_failed` path is untested; the 503 tests inject the fault at the service entry. Cover in a later stage.
2. A pending gate with an unreadable row is counted, not repaired, and does not block the service. Recorded as residual.
3. Explanation wording is lost on reload by design. A mistyped re-entry produces `explanation_invalid` at decision time, and the gate stays pending.
4. D.4F: mobile correction standing display, contrast of the three request actions against the attestation confirm panel, screen-reader behaviour.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. D.4E (unknown-outcome recovery) not started.

### D.4E unknown-outcome recovery: ACCEPTED on `ec66162` (lead record)

Commits: `dd4cf39` (server recovery tests: lost response, real in-transaction fault via SQLite trigger, post-commit read fault, invalid row, 21-attestation truncation), `b30d660` (pure client recovery model and response-shape guard; `call()` gains opt-in `requireBody`), `2d2893d` (completion wiring), `ec66162` (correction wiring). Plan: `scratchpad/d4e_plan.md` (Sonnet Medium). Implementation: Haiku. No server production behaviour change; the stage is tests and client code only.

Behaviour: after an unknown outcome (lost response, 5xx, unreadable 2xx body) the UI shows "Turing could not confirm the result" and reads the saved state. It never auto-retries and never sets a timer. Nothing is stored locally. A recorded decision is shown as saved; a completion or correction is shown as saved only after a read confirms it. A held completion digest is never re-sent after a changed review. A held correction explanation is reopened only when the chain position still matches; otherwise the UI shows "history changed" and sends nothing. The attestation list is capped at 20 and the UI now says so when the list is truncated, never "clean" or "no other".

Changed existing assertions (both reviewed as legitimate):

- `goalCompletion.test.tsx`: the `external_completion_unavailable` row (503 showing "Do not assume it failed or succeeded") is replaced by the recovery tests. A 503 is now an unknown outcome read back from the saved state.
- `goalCorrection.test.tsx`: the unreadable-request sentence is replaced by the plan's wording ("cannot confirm whether yours was saved. Do not send it again.").

Deviations (disclosed):

- The client `call()` and `UnreadableResponseError` live in `src/client/api.ts`; the write wrappers are in `src/client/goals/api.ts`.
- The no-timer check is a static file scan in `unknownOutcome.test.ts`, not a write-only test assertion.
- Component recovery tests were appended to the existing `goalCompletion.test.tsx` and `goalCorrection.test.tsx`, not a new `unknownOutcomeRecovery.test.tsx`.
- Request again blocks only the held request while a pending row is unreadable. Blocking all requests broke the existing "no raw code or field name" test.

Evidence:

- Full gate on `ec66162`: format, lint, typecheck, `npm test` 151 files / 2,826 tests, build, `npm audit --omit=dev` 0 vulnerabilities, migrations diff against `160fa2b` empty.
- Hosted CI on `ec66162`: run 38262588176, `gate` job success (including `npm test`, build, and `npm audit --omit=dev`).
- Independent review of `6a51bf3..ec66162` (Sonnet Medium): `VERDICT: PASS WITH NON-BLOCKING`, no blocking findings. Review file: `scratchpad/d4e_review.md`.

Non-blocking follow-ups:

1. `COMPLETION_RECOVERY_COPY.completeAbsent` is unreachable when the read shows `decided`. The text shown then is accurate but loses the "may still finish" caution after an unconfirmed Complete. Tighten in D.4F.
2. Adopting a pending correction gate does not compare chain position. The server still checks the explanation digest, so this is safe but looser than the plan wording. Tighten in D.4F.
3. The post-commit read-fault test (S6) stubs the standing reader and has no completion-decision variant. Cover later.
4. `npm ci` (full tree, not production) reports two critical advisories in dev-only dependencies. The production audit is clean. Record for a dependency review before V1 hardening.
5. The cross-attestation stuck-Goal question (a Goal can be left unable to complete if the decided attestation is later corrected) is still an open owner decision. D.4E did not change it.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. D.4F (accessibility and mobile) not started.

### D.4R cross-attestation completion recovery: Slice 0 ACCEPTED on `bd67cb0` (lead record)

Scope: a source-grounded design only (`docs/GOAL_CROSS_ATTESTATION_RECOVERY_DESIGN.md`), with no production change. Scratchpad inputs: `scratchpad/d4r_slice0_design.md`, `scratchpad/d4r_slice0_review.md`, `scratchpad/d4r_s0_reconciliation.md`.

- Independent Sonnet Medium review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`. Policy soundness passed: no path found to two live authorities, retargeting, a decision over corrupt history, or double completion.
- The review's note on Git-stale attestations is recorded in design section 11.1: a stale, uncorrected A keeps blocking B until it is disputed, withdrawn or superseded. Slice 4 adds the test "correct a Git-stale A, then record B".
- Reconciliation: accepted. The design header still describes the read-only reconciliation state at `b233312`. This is cosmetic and is left as is.
- Hosted CI on `bd67cb0`: run 38284180415, success (job `gate`).
- Gate: the design-only commit's gate log ends `GATE_EXIT=0`, 151 files and 2,826 tests passed.

### D.4R Slice 1: read-only completion authority classifier: ACCEPTED on `54986de` (lead record)

Commits: `2f7761b` (extract the completion decision readers into `externalCompletionDecisionRows.ts`, add `countCompletionRows`, add the read-only classifier `completionAuthorityPolicy.ts` and its tests), then `54986de` (remediation). Implementer: Haiku 5.5 High. Independent reviews: Sonnet 5.5 Medium on `2f7761b` (`scratchpad/d4r_s1_review.md`) and on `54986de` (`scratchpad/d4r_s1r_review.md`).

Behaviour: `classifyCompletionAuthority(db, goalId, selectedAttestationId)` is read-only (SELECT only). It returns one of six classes, with precedence 6 > 5 > 4 > 2 > 3 > 1. Class 5 covers history that is invalid or unreadable, including more than 50 decision rows, and it fails closed. The canonical policy digest is sha256 over `turing-goal-external-completion-policy-v1`, a NUL separator and the canonical JSON body, with entries sorted by decision id. Nothing calls the classifier yet, so public behaviour is unchanged.

Changes made in remediation `54986de`: the classifier now checks the empty correction-chain digest (it mirrors `computeEmptyCorrectionChainIdentity` as a private constant, with a parity test, because importing the preflight would create a cycle), and every read is wrapped so that an unreadable row fails closed as class 5.

Evidence:

- Gate on `2f7761b`: `GATE_EXIT=0` (`scratchpad/d4r_s1_gate_2f7761b.log`). Gate on `54986de`: `GATE_EXIT=0` (`scratchpad/d4r_s1r_gate_54986de.log`). Full `npm test` on each.
- Hosted CI on `54986de`: run 38293438128, success. `2f7761b` has no separate hosted run recorded in the run list.
- Independent review of `54986de`: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`, 36 of 36 classifier tests passing.

Non-blocking follow-ups (carried forward):

1. The `goal_mismatch` reason branch is unreachable and untested.
2. The `row_unreadable` reason is effectively unreachable and untested.
3. `canonicalJson` and `policyDigest` run inside `classification()` outside any try. A throw there is still fail closed through `preflight_unavailable` once Slice 2a consumes it, but a direct test is missing.

### D.4R Slice 2a: preflight integration of the classifier: ACCEPTED on `211f900` (lead record)

Commit: `211f900` (parent `54986de`). Reconciliation before implementation: `scratchpad/d4r_s2_reconciliation.md` (GO with flips 1-9 and the T-TX4 change). Implementer: Haiku 5.5 High. Independent review: Sonnet 5.5 Medium (`scratchpad/d4r_s2a_review.md`).

Behaviour: `readSnapshot` runs the classifier inside its existing transaction, after the goal-status and definition checks. Outcome map: class 6 refuses `completion_already_recorded` (detail null); class 5 refuses `completion_history_invalid` (detail is the classifier reason); class 4 refuses `completion_already_recorded` with detail `competing_decision`, and the option is never consulted; class 2 refuses unless `options.allowRecordedDecision === true`; classes 1 and 3 proceed. `SnapshotIdentity` gains `policy_class` and `policy_digest`, appended last, so existing key order is unchanged. No migration, no new option, no new report fact, and the public signature is unchanged.

Flipped tests (each was pinned to the old bypass or to the old refusal code; all are listed as the reconciliation required):

- `completionAuthorityPolicy.test.ts`: the class 3 case is now a fresh attestation that becomes ready after a correction on the earlier one.
- `externalCompletionDecision.test.ts`: D17b now expects `completion_history_invalid`. D12 uses the `action` returned by `seedCompletion`, which is a setup-only change.
- `externalCompletionApi.test.ts`: T11 pins that a decision for Y while X is an eligible competing decision is refused. The POST returns 409 and writes nothing.
- `externalCompletionTerminal.test.ts`: T-TX4 (both variants) now asserts the terminal refusal, with the database snapshot unchanged. The reconciliation required a lead sign-off for this change. This record is that sign-off, and the independent review examined it (finding 8).
- `externalCompletion.test.ts`: F5, F6 and F7 now expect `completion_history_invalid` instead of `correction_standing_unavailable` or `attestation_invalid`.
- `goalAuthorityStaticGuard.test.ts`: the classifier entry allow-list gains the preflight, and the seeded violation moves to negative controls.

Evidence:

- Gate on `211f900`: `GATE_EXIT=0` (`scratchpad/d4r_s2a_gate_211f900.log`). Full `npm test` 152 files and 2,902 tests passed; `npm audit --omit=dev` 0 production vulnerabilities.
- Hosted CI on `211f900`: run 38301018507, success. The run list shows this as one run with conclusion success.
- Independent review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`. The reviewer ran only `completionAuthorityPolicy.test.ts` (42 of 42), not the other flipped files, so their pass state rests on the gate.

Deviations and residual risks:

1. F3 (`externalCompletionDecision.ts:173`): the decision POST for a competing attestation returns detail `completion_already_recorded`, not `competing_decision`, because only `reasons[0].code` is passed on. The public GET still reports `competing_decision`. Fixed in Slice 2b with an explicit mapping. Both refusals write nothing.
2. Test reachability is reduced. The terminal `approval_status` check and the own-attestation check 6 are now reached only as defence in depth, because the classifier pre-empts them in tests (F4 to F7). A direct unit test is planned in Slice 2c.
3. Client copy: "A completion has already been recorded" overstates a competing decision, and `completion_history_invalid` falls to generic copy. Fixed in Slice 3.
4. The stored CI cancellation history for `211f900` is not visible in the run list, which shows one run. Earlier cancellation notes are not cited as evidence in this record.

### D.4R Slice 2b: decision recording follows completion authority class: ACCEPTED on `215a2da` (lead record)

Commit: `215a2da` (parent `fcb629c`, which records the Slice 0, 1 and 2a acceptance). Reconciliation: `scratchpad/d4r_s2b_brief.md` (Sonnet 5.5 Medium, GO). Implementer: Haiku 5.5 High (uncommitted working tree; the lead gated and committed). Independent review: Sonnet 5.5 Medium (`scratchpad/d4r_s2b_review.md`).

Behaviour: the decision transaction runs the classifier first, before the identity compare and before any write. Class 1 and class 3 record. Class 2 reuses only the decision for the selected attestation, and a different digest for it is `decision_conflict`. Class 4 refuses with `competing_decision` (409). The pre-Git path maps a preflight `competing_decision` detail explicitly, so the code is no longer lost (finding F3 is fixed). Class 5 and class 6 refuse before any write. `classifyCompletionRows` no longer skips other-attestation decisions. `allowRecordedDecision` is not widened and no migration was added.

Flipped and added tests:

- Flipped: `externalCompletionApi.test.ts` T11, the Y POST now asserts 409 `competing_decision` with no `detail`. The status table gains `competing_decision: 409`.
- Added: `externalCompletionDecision.test.ts` D22 (class 4 refused before Git, nothing changes) and D23 (dispute and withdraw variants: B records, A's row unchanged, repeat returns the existing decision with `reused: true`).
- Added: `externalCompletionDecisionSeams.test.ts` D11b (class 4 raced after the Git read is refused as `competing_decision`, which shows the classifier runs before the identity compare) and D11c (class 5 raced after the Git read is refused as `completion_history_invalid`).
- Static guard: `classifier_entry` gains `externalCompletionDecision.ts`, as the reconciliation required. This is the only guard change.

Evidence:

- Gate on the working tree, run by the lead: format, lint and typecheck exit 0; `npm test` 152 files and 2,907 tests passed; build exit 0; `npm audit --omit=dev` 0 vulnerabilities. Logs are in `scratchpad/d4r_s2b_lead_*.log`.
- Hosted CI on `215a2da`: run 38309687759, success.
- Independent review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`, no blocking findings.

Deviations and residual risks:

1. The in-transaction class 5 reports `completion_history_invalid` (preflight class 5 code), not `decision_corrupt`. This matches the pre-Git path. This is a product choice the owner should confirm.
2. Class 2 reuse does not require the own decision to be eligible. A race that disputes A after A's decision can return A's existing, now-ineligible decision. The review found no double-authority path. Slice 2c must show the terminal refuses that decision, as a test.
3. Test gaps from review: no test drives the UNIQUE-violation path to class 4 or 5, and the supersede variant of D23 is missing. Carry to Slice 2c or Slice 4.
4. Finding for the D17 title (now stale wording) is cosmetic.

### D.4R Slice 2c: terminal consume follows completion authority class: ACCEPTED on `d952df2` (lead record)

Commits: `d952df2` (the Slice 2c change), then `036d098` (a CI-only timeout change, below). Reconciliation: `scratchpad/d4r_s2c_brief.md` (Sonnet 5.5 Medium, GO; it found that the reuse-after-race gap is already closed in production by check 6 through the terminal's identity read, so 2c is classifier wiring, tests and the 2b gap tests). Implementer: Haiku 5.5 High (uncommitted working tree; the lead gated and committed). Independent review: Sonnet 5.5 Medium (`scratchpad/d4r_s2c_review.md`).

Behaviour: the terminal's own-attestation check is now classifier-driven. Consume proceeds only for class 2 with exactly one own entry that matches the held decision id and action digest and is eligible. Classes 4, 5 and 6 are refused at the identity read before the check runs, so their branches are defensive. An ineligible decision on another attestation is tolerated. An eligible competing decision still blocks. The proof writer is unchanged: it is the only INSERT into the terminal proof table, and `goal_not_running` and the proof-count guards still gate it. `externalCompletion.ts` is unchanged. No migration, no change to `allowRecordedDecision`, no client or `src/shared` change.

Tests:

- New: `externalCompletionTerminalSeams.test.ts` B4 (approval set to denied after the identity read gives `approval_status`) and B5 (own decision disputed inside the transaction gives `own_decision_ineligible`). These use a one-shot `afterIdentity` hook on a wrapper around `readPreflightSnapshotIdentity`, reset in `afterEach`.
- New in `externalCompletionTerminal.test.ts`: B1 (a disputed first decision does not block a later eligible B; one proof; a second consume is refused), B2 (a stale A after B is decided is refused as `completion_already_recorded`), B3 (dispute, withdraw and supersede of the only decision are refused as `attestation_*`).
- New in `externalCompletionDecision.test.ts`: D23 gains a supersede variant.
- New in `externalCompletionDecisionSeams.test.ts`: D11d (a pending same-digest row written in the hook trips the UNIQUE path and re-classifies as class 5) and D11e (an eligible competing decision written in the hook re-classifies as class 4).
- Static guard: `classifier_entry` gains `externalCompletionTerminal.ts`, with one negative control.
- Flipped: none. The only change to an existing test is a comment in T11.

Only B5 exercises the new terminal branch directly. B1 to B4 would also pass on the Slice 2b logic, and the commit message says so.

Evidence:

- Gate on the working tree, run by the lead: format, lint and typecheck exit 0; `npm test` 153 files and 2,918 tests passed; build exit 0; `npm audit --omit=dev` 0 vulnerabilities. Logs are in `scratchpad/d4r_s2c_lead_*.log`.
- Independent review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`, no blocking findings.
- Hosted CI on `036d098`: run 38320429746, success, 17.1 minutes.

CI cancellations and their cause (recorded here because the earlier notes did not explain them):

- Run 38311650042 on `6540002` (the Slice 2b record commit) was cancelled at 20.2 minutes.
- Run 38316496887 on `d952df2` was cancelled at 20.3 minutes. A same-SHA re-run (the same run ID) was cancelled at 20.3 minutes too, with no superseding push.
- The gate job has `timeout-minutes: 20`. Successful runs on this branch took 16.6 to 19.9 minutes (17.7 for `215a2da`, 19.9 for `fcb629c`). The two cancellations stopped at the limit, so the cause is the job's wall-clock budget, not a test failure.
- Change in `036d098`: the timeout is raised to 30 minutes. The gate steps, the test set and every assertion are unchanged. This is a CI budget change, not a test change, and it is disclosed here so the owner can review it. The earlier cancellations on `b233312`, `211f900` and `bd67cb0` remain recorded as unexplained, because I have no durations for them.

Deviations and residual risks:

1. B6 (a second same-attestation decision inside the transaction) was dropped. The API test T11 covers the two-decision case as `decision_conflict`.
2. The terminal's class 4, 5 and 6 branches and the own-id and own-digest mismatch branches have no direct test. Class 4, 5 and 6 are refused at the identity read first, so these branches are defensive only.
3. The in-transaction class 5 reason of the decision path (`completion_history_invalid`) is still a product choice for the owner.

### D.4R Slice 3: status eligibility, copy and explicit attestation selection: ACCEPTED on `47bd3de` (lead record)

Commit: `47bd3de` (parent `7561b6e`). Reconciliation: `scratchpad/d4r_s3_brief.md` (Sonnet 5.5 Medium, GO). Implementer: Haiku 5.5 High, in two passes (uncommitted working tree; the lead gated, reviewed and committed). Independent review: Sonnet 5.5 Medium (`scratchpad/d4r_s3_review.md`).

Behaviour:

- The completion status exposes `eligibility` and `correctionStanding` on each decision. Both come from correction standing only. Git is never used for eligibility, so an uncorrected Git-stale attestation stays eligible. The status reports `state: decided` only when an eligible decision exists. The classifier runs read-only with an empty selection. No route, write or migration is added.
- The client no longer auto-selects the first attestation. The selection is held by the cockpit, is cleared when the Goal changes, and only applies to the handoff it was made in. A selection does nothing on its own: Record and Complete still need their own explicit clicks.
- A competing decision is no longer described as "A completion has already been recorded". `completion_history_invalid` has its own sentence, and no raw code or field name is printed.

Decisions made during this slice (the lead's, disclosed):

1. The five remount and tab-switch tests were not changed in their bodies. The lead chose to keep the selection across Handoff remounts (keyed to the Goal and handoff) rather than add selection clicks inside those tests, because their names describe recovering the saved decision after a remount.
2. Two Goal-switch tests each gained one selection click on Goal B and one on the first Goal after the return. Explicit selection requires these clicks, because the removed auto-select used to make them unnecessary. No assertion changed.
3. The D.4E recovery selections in `GoalExternalIntegration` still select the attestation the user just submitted or created. They are unchanged, because they are not the auto-select the plan asked to remove.
4. The selection props on `GoalExternalIntegration` are optional, with local-state fallback, so direct renders in `goalHandoff.test.tsx` still compile.

Flipped tests (all disclosed and reviewed as legitimate):

- F1 and F2 (`externalCompletionApi.test.ts`): `toEqual` additions for `eligibility` and `correctionStanding` on the invalid and contested views.
- F3 (`goalCompletion.test.tsx`): the blocked-by-another-decision sentence changed. The old sentence is retired copy; the other assertions are kept.
- F4: the `decisionRow` fixture gains the two new fields.
- F5: `openHandoffTab` and `openPageHandoffTab` each gain one click on the attestation-history control (helper setup, not an assertion).
- F6: `externalCompletionApi.ts` joins the `classifier_entry` allow-list, with one negative control.

Evidence:

- Gate on the working tree, run by the lead: format, lint, typecheck, build and `npm audit --omit=dev` exit 0 (0 vulnerabilities).
- `npm test`, first run: 152 files passed, 1 test failed, 2,945 passed. The failure was `goalHandoff.test.tsx` "requires a deliberate confirmation to resume an approved orphan without replaying POST automatically". Its 5-second wait for a message ran out under full-suite load. The test is unchanged from `HEAD`, has a comment recording an earlier load flake, and passes on its own (38 of 38).
- `npm test`, rerun once: 153 files and 2,946 tests passed. The first failure is recorded here, not counted as a clean pass. It is a residual load-sensitivity risk, and it belongs in the hardening list (H.x), not in a global timeout change.
- Hosted CI on `47bd3de`: run 38328257945, success, 20.7 minutes. This is above the old 20-minute job limit, which is why the timeout was raised in `036d098`.

Review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`, no blocking findings. The non-blocking notes are carried forward:

1. The remount and tab-switch tests get their selection click through the shared Handoff helper, not in their own bodies. Their assertions are unchanged, as intended. Noted here for the record.
2. `row_unreadable` is a new `invalidReason` fallback that is not documented in the design. The client never prints it.
3. The `goalId`/`handoffId` guard in `GoalHandoff` must be kept if this code is refactored. It makes the single render before the clearing effect safe.

CI cancellation note: the cause of the two earlier cancellations (`6540002` and `d952df2`) is recorded under Slice 2c above. The 20-minute job limit is the cause for those runs.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. Slice 4 (21-case adversarial qualification) and Slice 5 (documentation, whole-programme review, final report) not started. Owner decisions from the D.3 record and the cross-attestation stuck-Goal question remain open. The owner should also confirm the in-transaction class-5 reason (`completion_history_invalid`, not `decision_corrupt`).

### D.4R Slice 4: adversarial qualification of the 21 cases: ACCEPTED on `93c6e4f` (lead record, with one partial and one seeded case)

Commit: `93c6e4f` (test-only; parent `98720fc`). Reconciliation: `scratchpad/d4r_s4_brief.md` (Sonnet 5.5 Medium, GO; it noted that the design's test anchors had drifted and that the B-after-A flow needed new tests). Implementer: Haiku 5.5 High (uncommitted working tree; the lead gated, reviewed and committed). Independent review: Sonnet 5.5 Medium (`scratchpad/d4r_s4_review.md`).

What was added: `src/server/goals/completionRecoveryQualification.test.ts` (52 tests across the 21 cases, sha1 and sha256 where the case is parametrised), and Q1b in `goalLifecycleQualification.test.ts`. Q1's assertions are unchanged; its setup moved into a helper `driveToVerifiedHandoff`. No production code, migration, route or hook was touched.

Case results:

| #   | Result        | Test(s)                                                                                      |
| --- | ------------- | -------------------------------------------------------------------------------------------- |
| 1   | PASS          | QR01 (dispute variant; B recorded and completed)                                             |
| 2   | PASS          | QR02 (withdrawn A allows B)                                                                  |
| 3   | PASS          | QR03 (superseded A gives no decision for B; no retarget)                                     |
| 4   | PASS          | QR04 (eligible A, including Git-stale uncorrected A, blocks every route to B)                |
| 5   | PASS          | QR05 (six seeded corrupt-history variants)                                                   |
| 6   | PASS          | QR06a (A-side), QR06b (B-side)                                                               |
| 7   | PASS          | QR07 (tampered B attestation)                                                                |
| 8   | PASS          | QR08a (record), QR08b (Complete)                                                             |
| 9   | PASS          | QR09 (destination changes, both formats)                                                     |
| 10  | PARTIAL       | QR10a (criterion stale), QR10b (pending review); stale acceptance not asserted for B after A |
| 11  | PASS          | QR11a (Complete refuses `active_work`), QR11b (record refused; see pins)                     |
| 12  | PASS          | QR12i and QR12ii (real windows); QR12iii (seam)                                              |
| 13  | PASS          | QR13a, b, c (seam retry and fail-closed paths)                                               |
| 14  | PASS          | QR14 (identical concurrent requests: one row, one proof)                                     |
| 15  | PASS (seam)   | QR15 (B/C concurrency via seam; no true OS parallelism)                                      |
| 16  | PASS          | QR16 (A and B corrected, C completes, one proof)                                             |
| 17  | PASS (seeded) | QR17 (seeded B row; the public path is asserted separately as `goal_not_running`)            |
| 18  | PASS          | QR18 (lost response: no duplicate row, proof or event)                                       |
| 19  | PASS          | QR19 (digest, attestation and Goal bindings)                                                 |
| 20  | PASS          | QR20 (B after corrected decided A: one proof, one event pair)                                |
| 21  | PASS          | QR21 (dispute, withdraw and supersede after B completes: standing only)                      |

Stale-A stale-correction test, Q1b: PASS on sha1 and sha256. A is decided; a real destination commit advances the tip; A's preflight reports `destination_advanced_after_observation`; B is blocked with whole state unchanged. After a real dispute of A, B records and completes separately, and an exact replay writes nothing.

Partials and seeded cases (disclosed):

1. Case 10 is partial. Stale acceptance for a single attestation is covered by `externalCompletionSeams.test.ts` at lines 351 and 418. Those anchors, not the design's D8, are the existing cover, and no B-after-A repeat exists.
2. Case 17 is seeded. The seeded B row uses the same primitives as the decision service, and the public path is asserted too.
3. Case 15 is seam-based. It proves the classifier logic on the interleaving, not OS-level parallelism.

Observed-behaviour pins (accepted by review; each refuses with nothing written):

- A stale or advanced tip reports `destination_advanced_after_observation`, not `attestation_stale` (Q1b, case 8).
- Recording B while a verification cycle is open is refused as `preflight_refused` with detail `active_work`. Complete returns `active_work` directly (QR11a and QR11b). Review noted this is stricter than the design text.
- A record of B after A completes is refused as `goal_not_running` before `completion_already_recorded`. The class-6 record refusal is not reachable through the public path (QR17).
- A's id with B's digest gives `competing_decision`, not `attestation_disputed`, because the eligible B blocks A (QR19).
- The first differing identity key is `policy_digest` (QR12iii).
- QR21 supersede moves the tip, attests and restores B's tip, because the same-tip observation has a unique-digest collision.

Evidence:

- Gate on the working tree, run by the lead: format, lint, typecheck, build and `npm audit --omit=dev` exit 0 (0 vulnerabilities).
- `npm test`, first run: 153 files passed, 1 test failed, 2,999 passed. The failure was `goalHandoff.test.tsx` "requires a deliberate confirmation to resume an approved orphan without replaying POST automatically". It is the same test as in Slice 3. It times out a 5-second wait for a message under full-suite load, the test is unchanged from `HEAD`, and it passes on its own.
- `npm test`, rerun once: 154 files and 3,000 tests passed. The first failure is recorded here, not counted as a clean pass.
- Hosted CI on `93c6e4f`: run 38336542437, success, 21.6 minutes. That is inside the 30-minute job limit set in `036d098`, but the headroom is shrinking as the suite grows.
- Independent review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`, 52 of 52 tests passing when run alone, no blocking findings.

Non-blocking items carried forward:

1. Cite `externalCompletionSeams.test.ts:351` and `:418` as the case 10 acceptance anchors (the design's D8 is wrong for this).
2. QR08b (stale B) is a plain decided Goal, not a B-after-A test; QR19 has no separate wrong-handoff assertion.
3. The design's note for case 11 needs updating to match the observed `active_work` behaviour; the comment near lines 950-957 needs tidying.
4. Keep the seam and seeded labels for QR15 and QR17 in the final report.

Hardening risks recorded for Slice 5 and the owner:

- The `goalHandoff.test.tsx` orphan-resume test has now failed under full-suite load twice (Slices 3 and 4), and passed on rerun both times. It has a comment recording an earlier load flake. Its 5-second wait is the cause of record for the failure. It is a residual risk for H.x (measure and reduce fixture cost, or a justified per-test timeout with measured headroom). Global timeouts must not be raised to hide it.
- CI gate duration: 21.6 minutes on this SHA, against a 30-minute limit. Track it in H.x.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale, live provider gates. Slice 5 (documentation, the whole-programme Sonnet review, the final report with the 21/21 matrix and the case 10 and 17 caveats) not started. Owner decisions from the D.3 record and the cross-attestation stuck-Goal question remain open. The owner should also confirm the in-transaction class-5 reason (`completion_history_invalid`, not `decision_corrupt`).

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

## D.4R Slice 5: documentation and final review (status)

Recorded 2026-10-13. Parent HEAD for this slice: `786c64b`. Slice 5 documentation is committed as `12eb221`. Hosted CI on `12eb221`: run 38338582774, success, 16.2 minutes (format, lint, typecheck, test, build and audit, as the workflow runs them). The docs commit touches no source, test or migration file, so the tests are unchanged from `93c6e4f`, which passed the full gate.

Files changed by this slice (documentation only; no source, test or migration file changed):

- `docs/GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md`: new dated section "Cross-attestation completion recovery (D.4R, accepted)" stating the owner policy.
- `docs/GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md`: new dated note that correction standing now gates cross-attestation completion.
- `docs/V1_READINESS.md`: one status entry for the D.4R workstream.
- `docs/GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md`: this section. No existing D.4R record was changed.

Commits that carry this slice: `12eb221` (documentation). The Slice 4 record that precedes it is `786c64b`.

Whole-programme review: `VERDICT: PASS WITH NON-BLOCKING FINDINGS`, Sonnet 5.5 Medium, read-only, over `bd67cb0` to `12eb221` (`scratchpad/d4r_whole_review.md`). No blocking finding. The review checked: every write path runs the classifier or preflight inside its transaction; `allowRecordedDecision` is class-2-only at its three callers; the classifier is read-only; eligibility uses correction standing only; the client never records or completes on render, selection, remount or switch; `competing_decision` maps to 409; V1 is declared not release-ready; no migration changed.

Non-blocking findings from the whole-programme review, carried forward as follow-ups:

1. The header comment in `externalCompletionDecision.ts` (around lines 21-24) describes the pre-D.4R behaviour and is stale.
2. The D.3 candidate paragraph in `V1_READINESS.md` (around line 311) says a concurrent duplicate decision is refused rather than reused. That was true at D.3, and it is a historical record. It is not a current claim, but it should not be read as one.
3. The classifier's isolation guard forbids the preflight, decision, terminal, route and lock modules. It does not forbid the Git or child-process imports reachable through `externalIntegration.js`. The imports used are DB-only readers, but a tighter guard would make the isolation claim exact.
4. The decision service can return `reused: true` for a decision whose attestation was disputed in a narrow race. The terminal refuses it (`own_decision_ineligible`, seam test B5). No test drives that race through the decision service itself.
5. The in-transaction class-5 reason is `completion_history_invalid`, while the pre-lock check and the terminal return `decision_corrupt`. This is the owner decision recorded in the Slice 2b record.

Final report: the final report is the lead's message for this workstream, not a repository file. It states the matrix as 21 cases with case 10 partial, case 15 seam-based and case 17 seeded. It does not claim a bare 21 of 21.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale and live provider gates. PR #3 is open and has not been merged. D.4F (accessibility and mobile) has not started.

## D.4F: accessibility, mobile visibility and completion/correction UX hardening

### D.4F.0 audit and plan: ACCEPTED as planning (lead record, no production change)

Starting point verified before any mutation: local HEAD, `origin/feature/grand-project-goal-engine` and the accepted D.4R checkpoint are all `3e3f926`. The working tree was clean, the branch contained the checkpoint, PR #3 was open and unmerged at that head, and it was the only worktree. Planner: Sonnet 5.5 Medium, read-only (`scratchpad/d4f0_audit.md`). Verdict: PLAN: GO.

Scope of this record: a source-grounded inventory of the accepted D.4R client, server and mobile code, the accessibility support that already exists, the gaps, and the D.4E follow-ups F1 to F4. No production file was changed.

Findings that shape the slices:

- The D.4E follow-ups are confirmed in source. F1: the "may still finish" caution is lost when the read still shows the decision recorded. F2: correction adoption does not compare the chain position. F3: a read-only preflight 503 uses write-uncertain wording. F4: a busy Record ignores `retryable`, while a busy Complete honours it.
- The phone shows "Completed" for any completed Goal, including a disputed one. The phone already receives `completionStanding`, and nothing reads it. The fix is client-only.
- No axe or jest-dom library is installed. Role, name, focus-order and static CSS scans need no new dependency. jsdom cannot show layout or screen-reader output.
- The cycle scan of `src/client` finds no cycles at HEAD. The rule for any shared helper is a new leaf module.
- The timer static scan in `unknownOutcome.test.ts` forbids timers in the completion and correction files. A timed live-region clear is therefore not allowed.

Owner flags (not implemented; recorded for decision):

1. **G14, pending correction approval on the phone.** The phone lists a pending correction approval with Approve and Deny. The server refuses the decision, and the refusal text is confusing. The fix is a server read-projection change at `readModel.ts:1065-1073`. This is a server file, so it needs an owner decision.
2. **No server enforcement of desktop-only.** Nothing on the Goal completion or correction routes checks whether the caller is remote or mobile. The acceptance matrix already says paired phones can call the API directly. Copy and documents must say the phone interface offers no completion or correction control. They must not say the phone is prevented from calling the API. Adding server enforcement would change authority and needs an owner decision.
3. **F4 behaviour.** A busy Record will keep its acknowledgement and offer a manual retry, as a busy Complete already does. This changes the D.4E record expectation for busy Record. The alternative, keeping the re-review and fixing only the copy, is an owner choice.

Mapping of the directive's 20 test requirements to the planned slices:

| Directive test                                                      | Planned slice                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| 1 No completion POST before the explicit Complete action            | D.4F.1 (existing tests kept; new keyboard walk)      |
| 2 No decision POST before the explicit Record action                | D.4F.1 (existing tests kept)                         |
| 3 No correction POST on render, refresh, remount, SSE or navigation | D.4F.2 (late-response and navigation pins)           |
| 4 Decision distinct from terminal completion                        | D.4F.1 (copy and headings)                           |
| 5 Keyboard access to supported controls                             | D.4F.1 (keyboard walk)                               |
| 6 No focus stolen by background reads                               | D.4F.1 (read refusals do not focus)                  |
| 7 Deliberate errors and refusals get accessible feedback            | D.4F.1 (persistent live region; alerts for refusals) |
| 8 Correction approval boundaries preserved                          | D.4F.2 (existing correction tests kept)              |
| 9 Mobile shows standing with no completion or correction control    | D.4F.3                                               |
| 10 Unverified standing never shown as successful verification       | D.4F.1 and D.4F.3                                    |
| 11 Late responses cannot contaminate another Goal                   | D.4F.2                                               |
| 12 Switching attestation does not reuse prior authority             | D.4F.2 (existing D.4R tests kept)                    |
| 13 Unknown write outcomes blocked until reconciliation              | D.4F.2 (existing D.4E tests kept)                    |
| 14 Read-only failures do not claim a write may have persisted       | D.4F.2 (F3)                                          |
| 15 Retryable 429 never silently retries a write                     | D.4F.2 (F4)                                          |
| 16 Pending correction not resumed against a changed chain           | D.4F.2 (F2)                                          |
| 17 Historical completion and later correction visually distinct     | D.4F.1                                               |
| 18 D.4R cross-attestation recovery still functional                 | D.4F.4 (full regression)                             |
| 19 Existing authenticated desktop workflows intact                  | D.4F.4 (full regression)                             |
| 20 No new authority path, proof writer or terminal transition       | D.4F.4 (static guards and no-migration diff)         |

### D.4F.1 desktop presentation and accessibility: ACCEPTED on `cd8ab18` (lead record)

Baseline at `7eded75`: the full canonical gate passed (154 files, 3,000 tests). Code commit `cd8ab18` (fast-forward from `7eded75`) changes the completion and correction panels, the confirm-dialog heading levels, the touch and wrap CSS, and the handoff reason copy. Tests: 155 files and 3,048 tests on the final tree, all green. Hosted CI for `cd8ab18` (run 38375032426): one `gate` job, success, about 22 minutes against the 30-minute limit.

Planning and implementation: a Sonnet read-only planner produced the reconciliation brief (GO). A Haiku implementer wrote the RED and PIN tests first, then the production changes, and did not commit or push. The first independent Sonnet review returned REQUEST CHANGES with one blocking finding: a lost write armed focus, so a later failed read could take it. That was fixed with a `failed` helper that arms focus only when the refusal is new, and verified RED-then-GREEN by test K6b. A fresh independent Sonnet review of the final tree returned APPROVE.

Accessible behaviour checked by tests (jsdom): one persistent polite status region from first render in each panel; refusal alerts stay separate and take focus only after the user's own click; focus follows the user's own finished write (Complete checkbox after a Record is read back; panel heading after a Complete) and returns to the opening action after Cancel or Escape; standing is a labelled and described group; Record and Complete are named groups; correction dialog headings are level 5. Static CSS checks cover the 44px touch targets at 680px and below, wrapping, distinct contested, invalid and legacy colours, and the light-theme contrast pairs in `a11yTokens.test.ts`.

Changed existing assertion (one, approved in the brief): `goalCompletion.test.tsx` ~995 changed from `findByRole('status')` to `waitFor` with the same exact string. The old form could return the persistent region before its text arrived, so it passed by timing. It is no weaker.

Not claimed and not verified: WCAG 2.2 AA conformance or certification; screen-reader output and announcement timing; rendered layout (the empty status region uses a visually-hidden pattern, not yet checked in a browser); the real tab order; focus-visible rendering. The `.goal-completion button` selector also matches the correction section; harmless (wrap and touch height), recorded for D.4F.4. Reopen-focus after a cancel the reducer ignores has no dedicated test.

Deferred, not changed: attribution wording ("Completed on your decision", "You disputed", "Disputed by you") stays until D.4F.2; `GoalExternalIntegration.tsx` line 877 still prints a raw code, pinned by `goalHandoff.test.tsx`; G14 (pending correction approvals shown with Approve and Deny on the phone) and S1 (no server-side desktop-only enforcement) remain owner decisions.

### D.4F.2 recovery and async safety: ACCEPTED on `4c02286` (lead record)

Baseline `cd8ab18` plus the D.4F.1 record (`89e9409`). Code commit `4c02286` (fast-forward from `89e9409`). Full canonical gate on the final tree: 155 files and 3,081 tests, all green (baseline 3,048; the 33 new tests are the RED and PIN cases). Hosted CI for `4c02286` (run 38382257249): one `gate` job, success, about 24 minutes against the 30-minute limit.

Planning and implementation: a Sonnet read-only planner returned GO on a reconciliation brief with three lead decisions (F1 restores the caution in the decided path; F4 option A-min; attribution change made now). A Haiku implementer wrote the RED and PIN tests first, then the production changes, and committed nothing. A fresh independent Sonnet review of the final tree returned APPROVE with no blocking findings.

What changed, by follow-up:

- F1: after a lost Complete, a read that still shows the decision recorded keeps the caution that the Goal may still finish, and keeps Complete on the stored digest.
- F2: a pending correction is adopted as an actionable gate only when its sequence and previous digest fit the current chain tip. A stale row, or an on-screen gate the chain has overtaken, shows out of date with Confirm disabled and Decline kept. A reviewing draft closes when the chain position moves, so it cannot be sent from the old position.
- F3: an unreadable preflight read says the review could not be read and that the check changed nothing. Write failures keep the reconciling wording.
- F4 (option A-min): a busy Record (`completion_busy` and bare 429) keeps its digest and acknowledgement and offers a manual retry, as a busy Complete already does. `verification_busy` stays non-retryable. No automatic retry exists under any option.
- Attribution (N-full): the completed heading now reads "Completed on a recorded decision. Turing has not proven content preservation." Qualifiers and correction labels no longer say "by you", because the client has no evidence of who decided. Copy shown after the user's own click is unchanged.

Changed existing assertions (old behaviour, new behaviour, why superseded, all recorded in the commit message): the lost-Complete decided notice, the completed heading in several tests (the negative checks now assert the new heading, so they are not vacuous), and the disputed label. No assertion was weakened to a looser matcher. A refused preflight route was added to the second Goal in the correction test fixture; that is a fixture change, not an assertion change.

Not claimed and not verified: WCAG 2.2 AA conformance or certification; screen-reader output; rendered layout; the real focus order in a browser; phone enforcement (none exists server-side: S1). The pending-correction copy "waiting for your decision" and the request-confirmation line "Your ..." are kept because they follow the user's own action or ask for a decision; `UNCONFIRMED_RESULT` text that says "Do not assume" is no longer reachable from a read. Residual, recorded not fixed: a remount while a write is in flight can show the control again (P5e); no in-panel Check again outside the reconciling state (P1d).

### D.4F.3 mobile read-only standing: ACCEPTED on `f4c555f` (lead record)

Baseline `4184371` (the D.4F.2 record). Code commit `f4c555f` (fast-forward from `4184371`). Full canonical gate on the final tree: 157 files and 3,166 tests, all green (baseline 3,081). Hosted CI for `f4c555f` (run 38388594277): one `gate` job, success, about 27 minutes against the 30-minute limit. This is the closest run to the limit so far. The CI timeout is still the approved 30 minutes, and it is not raised here.

Planning and implementation: a Sonnet read-only planner returned GO (the phone list and `presentation.ts` stay as they are; the desktop Overview card and phone list "Completed" are disclosed limits, because fixing them needs a server or read-projection change). A Haiku implementer wrote the RED and PIN tests first, then the production changes, and committed nothing. A fresh independent Sonnet review of the final tree returned APPROVE with no blocking findings.

What changed: the phone compact view shows the saved completion standing as a read-only section after the next-action card. The section has no button, form or link, makes no request, and Refresh stays GET-only. A standing is shown as settled only when the stored status is completed and the saved standing carries the complete, uncontested claim. A completed status alone is never a success headline. Contested, legacy and invalid standings show their own copy; a missing standing reads "Standing could not be read"; unknown values fail closed. A parity test compares the phone copy with the desktop copy for the same states.

Changed existing assertions: none. `goalMobile.test.tsx` is byte-for-byte unchanged (checked by `git diff`).

Not claimed and not verified: WCAG 2.2 AA conformance or certification; rendered layout and narrow-width wrapping; screen-reader output; the amber and red text contrast on the phone (jsdom cannot show it). Non-blocking notes from review, recorded and not changed: the unreadable and unrecognised states use the base text colour (the card and pill tone mark them as attention states); an invalid standing with a missing claim reads "not recognised" rather than "could not be verified", and still fails closed.

Owner items still open: G14 (pending correction approvals with Approve and Deny on the phone) and S1 (no server desktop-only enforcement). The phone can still show "Completed" in list rows and the desktop Overview card; the fix needs a server or read-projection change.

### D.4F.4 qualification, remediation and whole-stage review: ACCEPTED on `c886397` (lead record)

Baseline `1c8858b` (the D.4F.3 record commit, on top of the `f4c555f` code). Code commit `c886397` (fast-forward from `1c8858b`). Full canonical gate on the final tree: 158 files and 3,232 tests, all green. Hosted CI for `c886397` (run 38397998652): one `gate` job, success, about 15 minutes against the 30-minute limit.

Qualification: a new jsdom suite (`completionCorrectionQualification.test.tsx`, 60 cases, fixtures in `qualificationKit.ts`) maps the 20 D.4F requirements to behaviour: write surface, keyboard path, focus rules, read-failure wording, reconciliation, attested-standing mapping, the phone's read-only view, and the timer rule. Requirement 12 (switching attestation drops authority) passed on its first run against unchanged production code.

Real gaps found by the suite and fixed: (1) a completion review whose preflight body is unusable showed no alert, only "Check again"; it now shows the read-unavailable refusal (requirement 14). (2) A correction history whose body is unusable crashed the panel during render; it is now treated as a failed read (`load_failed`, historyUnavailable copy). Both are guarded (`isUsablePreflight`, `isUsableCorrectionHistory`), with RED-first unit and component tests. No existing assertion changed.

Whole-stage independent review (Sonnet, read-only, across D.4F.1 to D.4F.4): APPROVE. It checked that no completion or correction write is reachable from a read, render, SSE, focus or remount; that no server, shared or migration file changed in D.4F (empty diff against `7eded75`); that the guards accept every real success shape; and that every removed test line is either superseded copy or a change recorded in the stage records. Non-blocking follow-ups, recorded and not changed: (a) the qualification file does not assert that server text is absent from the DOM in QF04 and QF05, so a regression that printed server text would pass; (b) one "Complete is disabled" check in QF02 is conditional, so it is not enforced for every state that renders the button; (c) the phone note "It has no control to complete a Goal or to correct a completion" should not be read as phone enforcement, because S1 stays open; (d) the V1 readiness document's older D.4 scope sentences now carry a dated note rather than being rewritten.

Changed existing assertions across D.4F (the complete list, for the final report): the `findByRole('status')` to `waitFor` change at `goalCompletion.test.tsx` ~995 (D.4F.1); the lost-Complete notice to `completeStillRecorded` and the mount-read notice to "A completion decision is recorded…" (D.4F.2, the mount-read change was missing from the D.4F.2 record and is listed here); and the attribution heading, qualifier and label strings (D.4F.2). Each is an exact string, superseded by the copy change that the record explains.

Not claimed: WCAG 2.2 AA conformance or certification; rendered layout; screen-reader output; the real tab order; phone contrast; phone enforcement (none exists server-side, S1). Owner items still open: G14 and S1. The phone list rows and the desktop Overview card still say "Completed" for any completed Goal (a read-projection change, owner decision). `GoalExternalIntegration.tsx` line 877 still prints a raw code (pinned).

Stage result: D.4F is accepted for its scope, as recorded in the readiness document's D.4F status section. V1 is NOT release-ready, and this workstream does not qualify V1 by itself.

Still pending and not performed: physical Windows, physical iPhone, live Tailscale and live provider gates. PR #3 is open and has not been merged. The next hardening stage is not started; the owner decides between the G14 and S1 decisions and the read-projection change first.

## 2026-10-13 amendment: GH.1–GH.4 acceptance evidence

Dated 2026-10-13. Branch `feature/grand-project-goal-engine`, HEAD `1cbe58a`. This amendment is additive. Earlier entries are unchanged. The "Current state" section at the top records the D.2 checkpoint and is not updated here. This record does not declare V1 release-ready, does not resolve GH.6 items, and does not claim live Tailscale, physical device, live provider, WCAG conformance or content verification.

Status:

| Slice                                         | Commits              | Hosted CI (gate job)         | Status   |
| --------------------------------------------- | -------------------- | ---------------------------- | -------- |
| GH.1 desktop-only Goal authority routes (S1a) | `be0685e`, `d7b55d2` | run 38425090559 on `d7b55d2` | Accepted |
| GH.2 completion authority                     | `471e64d`            | run 38433826179 on `471e64d` | Accepted |
| GH.3a dedicated approval routing (G14)        | `77c1434`, `cdda8a2` | run 38439563605 on `77c1434` | Accepted |
| GH.3b unqualified Completed (CS-1)            | `24d1ea6`            | run 38444959765 on `24d1ea6` | Accepted |
| GH.4 in-flight writes (P5e), U1, U2           | `1cbe58a`            | run 38449862041 on `1cbe58a` | Accepted |

No independent review verdict is cited in this amendment for GH.1, GH.2, GH.3a or GH.3b. Their acceptance rests on the owner's decision and the CI records above.

### GH.1 desktop-only Goal authority routes (S1a)

- Commits: `be0685e` (implementation) and `d7b55d2` (`SECURITY.md` wording correction and follow-up).
- Hosted CI: run 38425090559, green on `d7b55d2`.
- Changed: five POST routes for user-only Goal completion and correction refuse paired remote callers with HTTP 403, code `desktop_required`. The check runs first in each handler. The signal is the existing remote predicate supplied through `requireDesktopCaller`. No User-Agent, viewport, device-type or `x-forwarded` header is used as a boundary.
- Verified: hosted CI green on `d7b55d2`. The record for this amendment does not name the automated test or tests that cover the 403 refusal, so none is cited here.
- Not verified: live Tailscale Serve behaviour, including identity-header injection, client-supplied header handling, Host rewriting and remote/local classification. Tailscale is not installed on the verification machine. This is not waived and not passed. It remains a blocking pre-V1 item.
- Owner decision (2026-10-13): S1b option O1 approved for V1, conditionally. The owner's stated condition: live Tailscale Serve verification is not waived. Identity-header injection, client-supplied header handling, Host rewriting and remote/local classification must be tested live, and any remote request misclassified as local that reaches a desktop-only Goal route is a blocking security defect. The residual same-user local-process trust model is accepted and documented in `docs/GOAL_TRUSTED_CALLER_BOUNDARY.md` and `docs/SECURITY.md`. O2 may be deferred past V1.
- Follow-ups: live Tailscale verification (blocking pre-V1).

### GH.2 completion authority

- Commit: `471e64d`. Hosted CI: run 38433826179, green on `471e64d`.
- Changed: class-2 exact own-decision reuse now requires attestation eligibility (R1). The duplicate D3-4 test is removed; its body was verified identical to the retained copy. D3-5 adds an extra v2 gate negative test; `supervisor.ts` is not modified. C5: class 5 keeps `completion_history_invalid`, and the difference from `decision_corrupt` is documented and pinned. U4 and X6 are addressed. The classifier policy docblock is moved only.
- Verified by automated test: the D3-5 negative test and the C5 pin, both added by this commit. This record does not name the test covering R1, U4 or X6.
- Not verified: live provider, physical device and live Tailscale behaviour. None is part of this slice.
- Follow-ups: none recorded.

### GH.3a dedicated approval routing (G14)

- Commits: `77c1434` and `cdda8a2`. Hosted CI: run 38439563605, green on `77c1434`. No hosted run for `cdda8a2` itself is recorded here. The later GH.3b run (38444959765, on `24d1ea6`) builds a tree that includes it.
- Changed: dedicated correction and completion approvals show a read-only line and no generic Approve or Deny. Malformed `detail_json` fails closed per row (SyntaxError only), so the inbox read does not fail as a whole. Server authority is unchanged.
- Gate at that point: 163 files, 3,291 tests passing.
- Verified: the gate above, and hosted CI on `77c1434`. Test names are not cited here.
- Also changed in this slice: the `readModel.ts` projection (the dedicated-decision flag, and per-row fail-closed reads of approval detail), the shared predicates in `approvals.ts`, and the `dedicatedDecision` field in `goalApi.ts`.
- Not verified: physical phone rendering.
- Follow-ups: none recorded.

### GH.3b unqualified Completed (CS-1)

- Commit: `24d1ea6`. Hosted CI: run 38444959765, green on `24d1ea6`.
- Changed: the Goal list and the desktop Overview show a standing-aware label. Unqualified "Completed" is not shown for contested or non-trusted completions. Standing is read from the database only, with no Git access. The import cycle is avoided by composing the list standing in the route layer.
- Verified: hosted CI green on `24d1ea6`. Test names are not cited here.
- Not verified: the phone list is not recorded as covered by this slice. The `GoalMobileCockpit` phone header still shows bare "Completed" for contested Goals (GH.4 follow-up d).
- Follow-ups: GH.4 follow-up (d).

### GH.4 in-flight writes (P5e), U1, U2

- Commit: `1cbe58a`. Hosted CI: run 38449862041, green on `1cbe58a`. Gate on the committed tree: 165 files, 3,307 tests passing.
- Status: **accepted.** An independent Sonnet re-review (read-only, 2026-10-13) of the synchronous-throw fix returned **APPROVE** with no blocking defects. It confirmed that all four launch points settle the registry entry exactly once on every path, that no timer, storage or retry was added, and that the regression test fails if the try/catch is removed. Focused tests: 4 files, 123 of 123 passing. Follow-ups are carried to GH.6 below. The re-review did not read the qualification and handoff test edits line by line.
- Changed: bounded client in-flight registry (cap 16; no eviction of in-flight entries; settle-once on every path; no timers; no storage). Duplicate UI submission is blocked while a matching write is in flight. Server idempotency remains authoritative. U1: `GoalExternalIntegration` prints the plain reason only. U2: qualification tests assert that no server text and no raw codes render.
- Independent review: REQUEST-CHANGES on a synchronous-throw registry leak. Fixed in the same commit with a regression test.
- Verified by automated test: the synchronous-throw regression test, and the U2 qualification assertions.
- Not verified: live provider, physical device and live Tailscale behaviour. A reload or another window bypasses the in-flight registry.
- Retained follow-ups, recorded for GH.6:
  - (a) Duplicate-submit window: a read that started before another panel's write settled can briefly show a control the server would reuse rather than duplicate.
  - (b) The registry lives in page memory only, so a reload or another window bypasses it.
  - (c) The other three launch points have no individual synchronous-throw test.
  - (d) The `GoalMobileCockpit` phone header still shows bare "Completed" for contested Goals.
  - (e) `GoalHandoff.tsx:524` prints `ApiError.code`.
  - (f) `clearInflightWritesForTests` is exported from a production module.
  - (g) The U6 orphan-resume test flakes under six-file batch load (about 5.1 s; failed 2 of 5 runs).
  - (h) Queued-run crash/restart defect HR-Q4: a mandatory pre-release V1 blocker, not waived.

### Owner decisions recorded (2026-10-13)

1. S1b option O1 approved for V1, conditionally (see GH.1). O2 may be deferred post-V1.
2. D3-2 interim option (1) approved, with a semantic guard. The full consumer audit is still pending in GH.6.
3. HR-Q4 confirmed as a mandatory V1 blocker. It may not be waived or classified as non-blocking.

### Still open after this amendment

- Live Tailscale verification: blocking pre-V1 item. Not performed, not waived, not passed.
- HR-Q4: mandatory pre-release V1 blocker.
- GH.4: accepted (re-review APPROVE, above). Its follow-ups (a) to (h) remain open for GH.6.
- GH.6: follow-ups (a) to (h) above, the D3-2 consumer audit, and the cross-attestation stuck-Goal owner question (the item marked "still an open owner decision" in the D.4E record). The stuck-Goal question is not resolved by this amendment.
- Physical Windows, physical iPhone and live provider gates remain pending.
- V1 is not release-ready.

## 2026-10-15 amendment: GH.5, GH.6 and HR-Q4 record

Dated 2026-10-15. Branch `feature/grand-project-goal-engine`, HEAD `392064d` when written. This amendment is additive. It does not declare V1 release-ready, does not pass live Tailscale verification, does not resolve the X1 text, and does not decide the owner questions listed at the end.

### Status

| Item                                                   | Commits                                    | Hosted CI (exact SHA)                                                       | Status                                                          |
| ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| HR-Q4 queued-run restart (mandatory blocker)           | `2ba3a22`, `3e77b60`, `c775a6b`            | run 38477357295 on `c775a6b`, success, 26 min 20 s                          | Fixed in code. Still a mandatory blocker until owner acceptance |
| GH.5b real-supervisor lifecycle qualification          | `b3e7a35`, `e2190e9`                       | run 38461824692 on `e2190e9` (tip covering `b3e7a35`), success, 26 min 45 s | Accepted, with the changed-assertion record below               |
| GH.5c completion classifier isolation                  | `63c82bb`                                  | same tip as above                                                           | Accepted, with residuals below                                  |
| GH.6a D3-2 consumer audit and Boolean guard            | `245049d`, `e2190e9`                       | same tip as above                                                           | Accepted                                                        |
| GH.6b phone standing label and handoff copy            | `0028c5e`, `e7b9125`                       | same tip as above                                                           | Accepted, with the changed-assertion record below               |
| GH.6c in-flight registry follow-ups                    | `674038f`, `a539292`, `2769fd1`, `0be7fa7` | run 38469115407 on `0be7fa7`, success, 25 min 57 s                          | Accepted after focused re-review (APPROVE)                      |
| GH.6d U6 orphan-resume measurement                     | none                                       | n/a                                                                         | Not reproduced on a quiet machine. Residual recorded            |
| GH.6e documentation                                    | this amendment                             | pending on the commit that carries it                                       | In progress. X1 text still needed from the owner                |
| GH.6f final independent review over `1cbe58a..c775a6b` | none                                       | n/a                                                                         | APPROVE. No blocking findings. Non-blocking items below         |

Intermediate commits between `5deed09` and `e2190e9` have no hosted run on their own SHA. Each is covered by the next pushed tip's run. Test-count progression in this amendment: 165 files and 3,307 tests (GH.4 gate); 167 files and 3,365 tests (gate on `c775a6b`, including the HR-Q4 fix and the wiring assertion).

### HR-Q4: queued ordinary runs after a restart

- Defect: a run persisted as `queued` before the engine started it was never started after a restart.
- Fix: `recoverQueuedRunsAfterRestart` in `src/server/runLauncher.ts`, wired in `src/server/index.ts` immediately after `engine.reconcileInterruptedRuns()`. It claims each run by a compare-and-set `queued` to `preparing` update, committed with its `run_recovered_after_restart` event, before `engine.start`. Goal-owned runs (`goal_cycle_id`, authoring runs included) and route-probe runs are excluded, because their owners start them.
- Why it moved: the first version kept the selection in `RunEngine`. That failed the static guard in `goalStage4a.test.ts`, which forbids Goal identifiers in `runEngine.ts`. The guard was not changed. The selection now sits with the launcher, which already owns queued-run start policy.
- Reviews: focused re-review APPROVE on the authoring follow-up (`3e77b60`); independent review APPROVE on the move (`c775a6b`). The move review's non-blocking suggestion, a static wiring assertion for `index.ts`, was added to `supervisor.test.ts`.
- Residual: if `engine.start` ever threw synchronously, startup would stop with the remaining claimed runs in `preparing`. The current `start` does not throw synchronously, so this is recorded and not fixed.

### GH.5 real-supervisor lifecycle qualification and classifier isolation

- GH.5b (`b3e7a35`): real-supervisor lifecycle qualification for withdraw, supersede, a second Goal, and `merge -s ours`. A review-stage provider-call assertion that could never match (no `final-reviewer` role exists) was changed to `REVIEW_STAGE_ROLES`. An independent mutation check confirmed the new assertion is not vacuous. The Q1 title was corrected to the observed reason `same_model` (`e2190e9`).
- GH.5c (`63c82bb`): a runtime spy on `node:child_process` and `goalGit.js` (pass-through, with `promisify.custom`), and a TypeScript-parser closure walk over 46 modules with a write-capable ratchet of 16 members, in `completionAuthorityPolicy.test.ts`. The static closure still reaches `finalApply.ts` through a dynamic import in `goalGit.ts`. This residual is recorded, not fixed. The write-scan is a heuristic.

### GH.6a D3-2 consumer audit and standing Booleans

- `src/server/goals/completionStanding.ts`: `trusted` and `unqualifiedSuccessAllowed` are both true only for a version-2 completion with uncontested standing. `contentPreservation` is `'not_proven'` for version 2 and `'not_applicable'` otherwise. `completionStandingIsContentVerified` is the constant `false`. The completion-standing Boolean guard test asserts these values.
- Consumer audit: `docs/GOAL_D32_CONSUMER_AUDIT.md`, corrected in `e2190e9`. Each consumer of the standing is listed. Migration 027 holds `contentPreservation`.
- Final review found no path that reports content as proven, and no client copy claiming content was preserved.

### GH.6b phone standing and handoff copy

- `0028c5e`: the phone cockpit header shows the saved standing label for completed Goals. This closes GH.4 follow-up (d).
- `e7b9125`: the handoff preparation refusal prints only the error message, not the raw refusal code. This closes GH.4 follow-up (e).

### GH.6c in-flight registry follow-ups

- Known-window test (`2769fd1`, `0be7fa7`): counts status GETs, one before and one after the write settles. It fails under a notify-all mutation (line 385 of `goalWriteRemount.test.tsx`). A first review requested changes because the test was not tied to the mechanism. That was fixed in `48ac4c4`, and the focused re-review returned APPROVE.
- Synchronous throws: all four launch points (`requestCorrection`, `decideCorrection`, `recordCompletionDecision`, `completeGoal`) have tests that settle the entry, send nothing, and show the saved-history copy.
- `clearInflightWritesForTests` (`674038f`): throws outside Vitest test mode. It is still exported from a production module, so this follow-up is mitigated, not closed.

### GH.6d U6 measurement

- Five isolated runs of the `goalHandoff.test.tsx` orphan-resume test all passed, at 163 to 186 ms each, on a quiet machine.
- The earlier flake (about 5.1 s under six-file batch load, failing 2 of 5) was not reproduced. It is recorded as a residual. It is not a known cause, and the test is not weakened.

### Changed assertions (GH.5 and GH.6)

Each change is recorded with its reason. None of them removes a check without a replacement.

1. `src/client/goals/mobileStanding.test.tsx` M-P3 (about lines 117 to 128) and M-R10 (about lines 325 to 337): `toHaveTextContent('Completed')` became a per-case standing label. Reason: the header now shows the saved standing (`0028c5e`). The change is stricter. M-R6 gained a null case, and H1 to H3 were added.
2. `src/server/goals/goalLifecycleQualification.test.ts` Q1 same-family case: the provider-call check changed from the vacuous `final-reviewer` role to `REVIEW_STAGE_ROLES`. The title was corrected to the observed reason `same_model`. Reason: the old check could never match. Coverage effect: the lifecycle-level `same_family` branch is no longer exercised separately. The branch is covered by unit tests in `src/server/goals/independence.test.ts` (reasons at about lines 95 and 171).
3. `src/server/goals/goalLifecycleQualification.test.ts` destination-head check (moved to `goalLifecycleKit.ts`): keyed by integration strategy (`DEFAULT_INTEGRATION`: `sha1` to fast-forward, `sha256` to two-parent merge, as before), instead of by object format. A `merge -s ours` case was added. Equivalent for the default mapping.
4. `src/client/goals/goalHandoff.test.tsx` B1 (new) and the refusal copy change (`e7b9125`): the refusal prints the error message only.
5. `src/client/goals/goalWriteRemount.test.tsx` known-window test (`2769fd1`, `0be7fa7`): changed to count status GETs and observe the notify scope, as described above.
6. `src/server/goals/completionAuthorityPolicy.test.ts` (`63c82bb`): the runtime spy and the closure ratchet were added. Nothing was removed.

### GH.4 follow-ups: status

| Follow-up | Status                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| (a)       | Open and pinned. A read that started before another panel's write settled can briefly show a reusable control. The server decides the write. |
| (b)       | Open. The registry lives in page memory only, so a reload or another window bypasses it.                                                     |
| (c)       | Closed. Synchronous-throw tests exist for all four launch points (GH.6c).                                                                    |
| (d)       | Closed (`0028c5e`).                                                                                                                          |
| (e)       | Closed (`e7b9125`).                                                                                                                          |
| (f)       | Mitigated (`674038f`). Throws outside test mode, still exported from a production module.                                                    |
| (g)       | Residual. Not reproduced on a quiet machine (GH.6d).                                                                                         |
| (h)       | Fixed in code (`c775a6b`). Mandatory blocker until owner acceptance.                                                                         |

### Live Tailscale Serve verification (2026-10-15): partial

- Tailscale is installed and logged in on the verification machine, and Serve proxies HTTPS to the desktop Master on `127.0.0.1:4317`. The tailnet hostname is not recorded in this repository.
- The running Master was started from a worktree at `1cbe58a`. `src/server/app.ts` and `src/server/goals/goalRoutes.ts` are unchanged between `1cbe58a` and `HEAD`, so the probed boundary code is the same as `HEAD`.
- Results, with no state change in any case:
  1. Serve injects the identity header. A non-health request through Serve is refused with "Pair this device with the desktop before using it." (401). A direct loopback request reports `identityHeaderPresent: false`.
  2. The five desktop-only POST routes, called through Serve with nonexistent identifiers, each return 401. The remote caller is refused before the desktop check.
  3. Direct loopback with a client-supplied `Tailscale-User-Login` header: each route returns 401. A forged header fails closed.
  4. Direct loopback with `Host: localhost` and no identity header: each route passes the desktop check and fails identifier validation (400). This is the accepted O1 residual: a same-user local process is treated as desktop.
- Not verified: the `desktop_required` 403 for a paired remote device session. The probes stop at the device-session check first. Verifying it needs a paired device session, which this session cannot create. Host rewriting was not observed directly. The remote classification through Serve is consistent with it.
- Status: partially performed. Still a blocking pre-V1 item until the paired-device check is run.

### Residuals and non-blocking findings

- Final review, non-blocking: the `same_family` lifecycle coverage loss (see changed assertion 2). Add a dedicated lifecycle case if it is wanted.
- Final review, non-blocking: recovery calls `engine.start` directly, not `startQueuedRun`, so it skips the `isActive` check. It runs once at startup, so the risk is low.
- Final review, non-blocking: the reviewer did not verify every relocated expectation line by line. This session checked each removed `expect` line against the current files. Three did not match by text: the intentional Q1 change, a `confirmationA`/`confirmationB` status pair that is now covered by a kit helper, and the `destinationHead` check (changed assertion 3).
- Classifier static closure reaches `finalApply.ts` via a dynamic import in `goalGit.ts`. The write-scan is a heuristic.
- Duplicate-submit read-before-settle window and the reload or second-window bypass remain (GH.4 follow-ups a and b).
- API cancel gap for queued runs, and the content-discarding `merge -s ours` completion question, remain open.
- Typecheck does not cover server test files (pre-existing).
- Physical Windows, physical iPhone and live provider gates remain pending.

### Owner items that block V1

1. Live Tailscale Serve verification, the paired-device check (`desktop_required` for a paired remote session). Blocking pre-V1. Not waived.
2. X1 text for the GH.6e documentation.
3. Owner acceptance of HR-Q4, a mandatory blocker. Fixed in code, not accepted.
4. Product question: should a content-discarding `merge -s ours` count as a completion?
5. API cancel gap for queued runs.
6. The cross-attestation stuck-Goal question from the D.4E record.

V1 is not release-ready. PR #3 is not merged. The Model Opportunity Layer has not been started.

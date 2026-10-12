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

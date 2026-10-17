# GH.6a: D3-2 consumer audit, guard and assessment

Dated 2026-10-13. Branch `gh6a`, based on `5deed09` (`feature/grand-project-goal-engine`). This record is additive. It does not reconcile into the progress record, which the lead does after merge.

**Status: Option (1) implemented with guard; owner decision 2 closed as resolved by D3-2 option (1).**

This record does not claim content verification anywhere. No production path proves that a completed Goal's content is correct at V1.

## Owner decision

Owner decision (2026-10-13), binding: D3-2 interim option (1) is approved. The existing completion Booleans `unqualifiedSuccessAllowed` and `trustedForDownstream` are kept for compatibility. This is subject to a full consumer audit and to a guard that stops `contentPreservation: 'not_proven'` being read as verified content correctness. Historical user-accepted completion is not content verification. Names, types and API fields are unchanged.

## What the Booleans mean

`unqualifiedSuccessAllowed` and `trustedForDownstream` mean an uncontested recorded decision on a proof that does not prove content. They are equal by construction at the single producer, and they are true only for a version-2 completion whose standing is `uncontested`. They never mean content correctness. The field that says what is not proven is `contentPreservation`. It is `not_proven` on every version-2 proof, and `not_applicable` on every other kind.

The doc comments on both fields (`src/shared/goalApi.ts`, `src/server/goals/completionStanding.ts`) now say this. Only comments changed; no type changed.

Historical proofs and events are untouched. GH.6a has no migration, no stored-row change, and no change to what the Booleans evaluate to.

## Producer table

The single producer is `classifyCompletionStanding` in `src/server/goals/completionStanding.ts`. The table below is the producer's exact rule, as asserted by the invariant tests in `src/server/goals/completionStanding.test.ts`.

| Facts (kind / standing)                                       | Booleans | qualifier              | contentPreservation |
| ------------------------------------------------------------- | -------- | ---------------------- | ------------------- |
| v2 / uncontested                                              | true     | none                   | not_proven          |
| v2 / disputed, withdrawn, superseded, reconciliation_required | false    | per standing           | not_proven          |
| legacy / historical_legacy (v1)                               | false    | legacy_not_v2_attested | not_applicable      |
| invalid / invalid_unverified                                  | false    | proof_unverified       | not_applicable      |
| not_completed                                                 | false    | not_completed          | not_applicable      |
| cast only: legacy / uncontested                               | false    | proof_unverified       | not_applicable      |
| cast only: invalid / uncontested                              | false    | proof_unverified       | not_applicable      |

The two cast rows are impossible pairings reachable only through a type cast. They are covered so that the invariant holds over the whole input space.

## Consumer list (grep at 5deed09, re-run after GH.6a)

Command: `grep -rn "unqualifiedSuccessAllowed\|trustedForDownstream\|contentPreservation" src docs`, then the same two names outside `src` and `docs`.

Outside `src` and `docs`: no hit for either Boolean name. The word `contentPreservation` does appear in `src/server/migrations/027_goal_external_completion_proofs.sql` (lines 33, 152, 226), as a SQL check on the stored proof. No file outside `src` reads either Boolean.

### Production reads of the Booleans (src, not test files)

| File                                         | Lines (after GH.6a)                            | What it does                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/goalApi.ts`                      | 276 (comment), 434, 436                        | Type declaration of `GoalCompletionStandingClaim`; doc comment on the list brief.                                                                                                          |
| `src/server/goals/completionStanding.ts`     | 57, 59, 93, 99-100, 107-108, 116, 121, 142-143 | Type; producer; the two accessor predicates; the GH.6a helper `completionStandingHasProofBoundDecision`.                                                                                   |
| `src/server/goals/goalRoutes.ts`             | 512                                            | List brief copies `trustedForDownstream` as `trusted`, beside `contentPreservation` (513). Pass-through.                                                                                   |
| `src/client/goals/completionStandingCopy.ts` | 201-202                                        | The one trusted classifier. Requires both Booleans, `qualifier === 'none'` and `contentPreservation === 'not_proven'`; any disagreement is unrecognised.                                   |
| `src/client/goals/completionStandingCopy.ts` | 249 (reads `brief.trusted`)                    | List label. Requires `brief.trusted`, `standing === 'uncontested'`, `qualifier === 'none'` and `contentPreservation === 'not_proven'`. The field is named `trusted`, not the Boolean name. |
| `src/client/goals/qualificationKit.ts`       | 219-233, 315                                   | Test fixture. It is not a `*.test` file, and it is imported only by `completionCorrectionQualification.test.tsx` and `goalWriteRemount.test.tsx`.                                          |

### Production reads of contentPreservation only (no Boolean)

These read or emit `contentPreservation` and never read a Boolean. They are display, copy, proof literals or fixtures.

- `src/shared/goalApi.ts` 190, 199, 210, 292, 446, 883 (type and fixture shapes).
- `src/server/goals/externalCompletion.ts` 321, `externalCompletionPreflight.ts` 156, 529, 793, `externalCompletionProof.ts` 52, 609, `externalIntegration.ts` 1200, 1218: the fixed `not_proven` limitation on proof, preflight and attestation shapes. Each is a literal `not_proven`.
- `src/server/goals/goalRoutes.ts` 513 (list brief copy), 822, 852 (fixed `not_proven` literals in another route).
- `src/client/goals/completionModel.ts` 90-263: copy for the desktop panel. It reads the value and maps it to text.
- `src/client/goals/GoalCompletion.tsx` 503-532: presentation of the value.
- `src/client/goals/GoalMobileCockpit.tsx` 105-106: presentation of the value.
- `src/client/goals/completionStandingCopy.ts` 34-190: copy and the classifier's own shapes.
- `src/client/goals/qualificationKit.ts` 219, 233, 315: fixture.

### Accessor predicates

`completionStandingAllowsUnqualifiedSuccess` and `completionStandingTrustedForDownstream` have zero production callers. They are called only by `src/server/goals/completionStanding.test.ts` and `src/server/goals/completionStandingService.test.ts`.

### Test files

Fourteen test files mention a Boolean name (a count of files mentioning either Boolean; other test files mention only `contentPreservation`). They are excluded from the production guard by the file-name rule, as in the existing consumer guard.

### Docs

`docs/` mentions the two Booleans or `contentPreservation` in `GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md` (4), `GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md` (6), `GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md` (3), `V1_READINESS.md` (3), `GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md` (2), and one each in `GOAL_FINAL_APPLY_AUTHORITY.md`, `GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md` and `GOAL_CROSS_ATTESTATION_RECOVERY_DESIGN.md`. These are design and progress notes. They are not consumers.

## Verdicts

- `goalRoutes.ts` 512: passes the Boolean through beside `contentPreservation`. The list route test `L1` asserts that the one producible trusted brief carries `contentPreservation: 'not_proven'`, and `L2` asserts that a corrected Goal is not trusted. No behaviour change.
- `completionStandingCopy.ts` 201-204: fails closed. A trusted classification needs every signal, including `not_proven`.
- `completionStandingCopy.ts` 249: fails closed. A trusted brief with `not_applicable` or a missing value is shown as not recognised. This is now tested by `L-5b`.
- `GoalCompletion.tsx`, `GoalMobileCockpit.tsx`, `completionModel.ts`: read `contentPreservation` for display only. No Boolean.
- `qualificationKit.ts`: a fixture. It constructs claims for tests and is imported by no production file.

No consumer outside the allow-list reads a Boolean without `contentPreservation`. No STOP condition was reached.

## Merge -s ours observation

The feasibility spike found that a `merge -s ours` on sha256 is accepted by verification and completion. The merge discards content, and `main` lacks `src/add.js`. The completion reads as `uncontested`, `unqualifiedSuccessAllowed: true`, `trustedForDownstream: true`, and `contentPreservation: 'not_proven'`. This is recorded as an observed value in `docs/GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md`, around the `ours` completion entry.

So the Booleans say that an uncontested recorded decision exists while the content gap is open. That is why the guard requires `contentPreservation` beside every Boolean read, and why no Boolean alone implies content correctness. GH.6a does not change the `ours` completion. It remains trusted in the sense the Booleans define. The guard prevents a consumer from reading that as verified content. Whether a not-proven-content completion should be trusted at all is a product question that GH.6a does not decide.

## Guard design (as implemented)

The guard is `src/server/goals/completionStandingBooleanGuard.test.ts`. Its detector is `findViolations(path, text)`, and the production scan and the seeded tests all call it.

1. Allow-list by path relative to `src`. Five files: `shared/goalApi.ts`, `server/goals/completionStanding.ts`, `server/goals/goalRoutes.ts`, `client/goals/completionStandingCopy.ts`, `client/goals/qualificationKit.ts` (test fixture). A file outside the list that mentions either Boolean name, as a bare word in any form, is an `unlisted_consumer`.
2. Paired consumers, `goalRoutes.ts` and `completionStandingCopy.ts`. Every Boolean read (identifier or string key) must sit in an enclosing function, or in the whole file for a top-level read, that names `contentPreservation`. For `completionStandingCopy.ts` the same scope must also name the literal `'not_proven'`. An unpaired read is an `unpaired_read`.
3. Deviation from the brief: `goalRoutes.ts` is paired on `contentPreservation` only, not on the literal `'not_proven'`. The route copies the value into the brief and does not decide from it. Adding a literal to that function would be a behaviour-neutral edit made only to satisfy the guard, so the route's list test asserts the value instead.
4. The guard runs on production files under `src` only. Files named `*.test.ts`, `*.test.tsx` and `*.d.ts` are excluded.
5. Non-vacuity: every allow-listed file must still exist and mention a Boolean. Every paired file must still contain at least one Boolean read. The qualificationKit fixture must be imported by no production file.

## Limits

- The guard cannot see consumers outside `src`. A script, a separate package or a runnable doc example is not scanned. A new consumer outside `src` needs a manual review. The audit grep above is the only check for those.
- Pairing checks that the scope names the field, not that the field is used in the same expression. A change that keeps the name in the enclosing scope but stops using it would pass the guard. The behaviour tests are the check for that. The GH.6a RED runs show both cases: a client mutation that removes the literal is caught by the guard and by behaviour tests, and a list-label mutation is caught only by behaviour test `L-5b`.
- The list label reads a brief field named `trusted`. The name scan does not follow that field. It is covered by the behaviour tests `L-5b` and `L-5`.
- No content-verification path exists at V1. `completionStandingIsContentVerified` returns `false` for every input.
- Historical completion proofs and events are not touched. A correction, a withdrawal or a replacement never rewrites them.

## Helpers added (GH.6a)

- `completionStandingIsContentVerified(model)`: returns `false` for every input. It exists so that the content question has one answer, and so a future content-verification path has one place to change.
- `completionStandingHasProofBoundDecision(model)`: true only when both Booleans are true, `qualifier` is `none`, and `contentPreservation` is `not_proven`. This is the rule `completionStandingCopy.ts` applies. It is not content verification. It has no production caller. The `qualifier` condition is added so that the helper matches the client rule, which requires all four signals.

No production behaviour changed. The helpers are additive.

## Tests added or changed

- `src/server/goals/completionStanding.test.ts`: a new `describe` block with six tests over the producer's whole input space (ten inputs: eight typed facts plus two casts). No existing assertion changed.
- `src/server/goals/completionStandingBooleanGuard.test.ts`: new file, nine tests, including the production scan and the seeded violations.
- `src/client/goals/goalListStanding.test.tsx`: new `L-5b` (`it.each`, two rows: `not_applicable` and `null`). Exact label `Standing not recognised`.
- `src/client/goals/mobileStanding.test.tsx`: one new row in the existing `M-R6` `it.each` table (`contentPreservation null`). No existing row changed.

No assertion was weakened. No test was skipped, made `only`, given a sleep, a timer, a timeout increase or a retry.

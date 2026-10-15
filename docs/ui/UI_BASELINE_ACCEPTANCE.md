# UI-development baseline: limited acceptance and overhaul scope

Dated 2026-10-15. This records an owner decision. It supplements, and does not replace, [V1_READINESS.md](../V1_READINESS.md), which stays the canonical release tracker.

## Owner decision (quoted in substance)

The owner accepts `67af34f2f633aa2c8570a74990c6097f6aafbf4d` (tip of `feature/grand-project-goal-engine`) **as the baseline for UI development only**. This does **not**:

- accept HR-Q4 (it stays a mandatory V1 blocker, fixed in code, not owner-accepted);
- declare the Goal Engine, PR #3 or V1 release-ready;
- waive live Tailscale verification (the paired-device `desktop_required` check is still pending);
- waive physical Windows, physical iPhone, live-provider or other platform acceptance;
- decide any outstanding owner question (X1 text, `merge -s ours` completion semantics, queued-run API cancel gap, cross-attestation stuck-Goal question).

All existing release gates are preserved. Nothing in the UI overhaul changes a gate's status.

## Owner-approved UI overhaul scope

A programme to reconcile the supplied UI packet and supplement with the product: design tokens (dark-only), shell, read-only run workspace, Goal cockpit reskin, settings/pairing/administration, mobile PWA, mascot and motion, then qualification. Governing document: [UI0_SPEC.md](UI0_SPEC.md). Decisions recorded there: D-2, D-5, D-6, D-7, D-8, D-9, D-10 decided; D-3 (UnifrakturCook) and D-4 (clean skull and wipes) **still pending the owner's visual acceptance**; D-1 as stated here.

The overhaul is an owner-approved exception to the readiness document's plan of a strict feature freeze after the Goal Engine and Model Opportunity Layer. It does not start the Model Opportunity Layer.

Preserved without change: the Goal Engine security model, real Goal-state read models, approvals and mobile restrictions (R-1, R-2, R-3), token rules, billing safeguards (`evaluateBillingLane`), Git boundaries, database contracts, and the deferred-feature boundaries (no editor, terminal, sidebar file tree, account menu, draft persistence or Reviews destination).

## Evidence for the selected baseline

| Item                                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate branch SHA                      | `67af34f2f633aa2c8570a74990c6097f6aafbf4d` (`feature/grand-project-goal-engine`)                                                                                                                                                                                                                                                                                                                                                 |
| Hosted CI                                 | [run 38729022874](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/38729022874), event `pull_request`, conclusion success, about 21 minutes (11:40:37Z to 12:01:19Z on 2026-10-15), single job `gate`                                                                                                                                                                                                     |
| What CI checked out                       | **PR merge commit** `b3b2a0b3dcdc321fc53fcafa38b8c9bd6ddecb4d` ("Merge 67af34f… into 2ae9dfc…"), not the branch tip itself                                                                                                                                                                                                                                                                                                       |
| PR base SHA                               | `2ae9dfcde9d140dc453f6e423823d0ae9632b240` (`master`)                                                                                                                                                                                                                                                                                                                                                                            |
| Merge commit parents                      | `2ae9dfc…` (base) and `67af34f…` (candidate)                                                                                                                                                                                                                                                                                                                                                                                     |
| Tree identity                             | The merge commit's tree and the candidate's tree are the same object, `36a2397964e173571e2ad80f2cca8dd56da03fbf` (verified by `git rev-parse <sha>^{tree}`), because the base is an ancestor of the candidate. The CI result therefore describes the candidate's exact file contents, but its commit identity is the merge SHA.                                                                                                  |
| CI gate steps                             | `npm ci`, `format:check`, `lint`, `typecheck`, `npm test`, `build`, `npm audit --omit=dev` (`.github/workflows/ci.yml`, 30-minute timeout)                                                                                                                                                                                                                                                                                       |
| Direct branch-tree checks                 | The repository's CI runs only on pushes to `master` and on pull requests, so there is **no push-triggered run on the branch itself**. Direct checks of the branch tree are the Goal Engine programme's local gate on `c775a6b`, recorded in [GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md](../GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md) (167 files, 3,365 tests). This UI programme did not re-run that local gate on `67af34f`. |
| Separately recorded evidence on `c775a6b` | Local gate green; PR-event [CI run 38477357295](https://github.com/abharrison1995-droid/turing-terminal-v1/actions/runs/38477357295) success (26 min 20 s); GH.6f final independent review over `1cbe58a..c775a6b` APPROVE, no blocking findings; focused HR-Q4 re-reviews APPROVE on `3e77b60` and `c775a6b`.                                                                                                                   |
| Verified difference `c775a6b..67af34f`    | Two documentation files only: `docs/GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md` and `docs/V1_READINESS.md` (`git diff --stat`). All code is identical to `c775a6b`.                                                                                                                                                                                                                                                              |

## Consequences for the UI programme

- `ui/overhaul` is created from exactly `67af34f2f633aa2c8570a74990c6097f6aafbf4d` in a separate worktree. Any later rebase onto other Goal Engine commits requires fresh local checks and fresh hosted CI evidence recorded for the new source identity (merge SHA, base SHA, run URL, tree SHA).
- Stage prerequisites in UI0_SPEC.md §8 stand: UI.1b onward needs the owner's visual acceptance of D-3 and D-4.
- The overhaul's final PR to `master` is not merged without explicit owner instruction, and V1 is not declared release-ready by this programme.

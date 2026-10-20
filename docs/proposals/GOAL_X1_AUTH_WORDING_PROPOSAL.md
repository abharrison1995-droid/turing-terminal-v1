# X1: authentication-boundary wording proposal

Status: **Proposal. Awaiting owner acceptance.** This document changes no product behaviour and no existing statement. It lists where the boundary is stated, where the statements disagree, and a proposed default wording for the owner to accept, amend or reject.

Note, 2026-10-20: the `V1_READINESS.md` lines cited below are now in the frozen log `docs/history/V1_READINESS_LOG.md` (same line numbers). The rewritten [V1_READINESS.md](../V1_READINESS.md) records O1 as approved and no longer contains the disputed statements, so recommendation 1 now applies to `SECURITY.md:49` only and recommendation 2 needs no change. The rest of this proposal is unchanged.

## 1. Purpose

Users and reviewers read the docs to learn what the server can and cannot tell apart. The X1 concern is that one statement says the authentication model "does not distinguish a desktop UI from a paired mobile client". That is accurate only for routes that do not use the Goal desktop guard. It must not be read as covering the five user-only Goal completion and correction routes, which now refuse remote requests (GH.1, S1a).

## 2. Where the boundary is stated

| Location                                                                       | Current wording (summary)                                                                                                      | Status                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `docs/history/V1_READINESS_LOG.md:167`                                         | Preparation route inherits the global model. Says S1b "owner decision pending".                                                | Scope correct. **Conflicts with line 382.**                     |
| `docs/history/V1_READINESS_LOG.md:205`                                         | "a paired mobile client can call the same API"                                                                                 | Broader. Should say "on routes without the Goal desktop guard". |
| `docs/history/V1_READINESS_LOG.md:348`                                         | Phone enforcement. Says S1b "owner pending".                                                                                   | **Conflicts with line 382.**                                    |
| `docs/history/V1_READINESS_LOG.md:353`                                         | Says S1b "remains an owner decision pending".                                                                                  | **Conflicts with lines 369 and 382.**                           |
| `docs/history/V1_READINESS_LOG.md:369`                                         | "O1 approved for V1, conditionally. Residual trust model accepted and documented."                                             | Matches the progress doc.                                       |
| `docs/history/V1_READINESS_LOG.md:382`                                         | S1b "is no longer 'owner pending'. O1 is approved for V1, conditionally."                                                      | Matches line 369 and the progress doc.                          |
| `docs/history/goals/GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md:892` and `:941` | O1 approved for V1, conditionally, on 2026-10-13. Condition: live Tailscale verification is not waived.                        | Records the decision.                                           |
| `docs/SECURITY.md:49`                                                          | Same-user local process "not distinguished from the desktop UI (S1b, owner decision pending)".                                 | **Conflicts with the progress doc and line 382.**               |
| `docs/goals/GOAL_TRUSTED_CALLER_BOUNDARY.md:19–32`                             | Lists what the server can and cannot distinguish, including the process that sent a local request and whether a human clicked. | Accurate. Does not state the decision status.                   |
| `docs/history/goals/GOAL_E2E_ACCEPTANCE_MATRIX.md:190`                         | "There is no desktop-only principal." Loopback trust is process-agnostic.                                                      | Accurate.                                                       |
| `docs/history/goals/GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md:293`       | Current auth does not distinguish a desktop human from a paired mobile client or trusted local process.                        | Accurate, but predates GH.1. Should note GH.1.                  |

The closure report earlier cited `:196` for the matrix. The correct location is `GOAL_E2E_ACCEPTANCE_MATRIX.md:190`. `docs/history/V1_READINESS_LOG.md:196` is blank.

## 3. The inconsistency to resolve

Four records say O1 was approved for V1 on 2026-10-13, conditionally: `docs/history/V1_READINESS_LOG.md:369`, `:382`, and the progress doc at `:892` and `:941`. Four others still say S1b is pending: `docs/history/V1_READINESS_LOG.md:167`, `:348` and `:353`, and `SECURITY.md:49`.

The condition named in the progress doc is that live Tailscale verification is not waived. The live check of `desktop_required` was performed from a disposable paired browser on 2026-10-17. Live verification of identity-header handling (whether `Tailscale-User-Login` can be stripped or injected, and how Host is rewritten) is still pending physical acceptance (`docs/SECURITY.md:50`).

**Owner question:** is O1 accepted now, with the live identity-header check still pending as its condition? Or is S1b still open? Whichever answer is correct, the four pending statements should be brought into line with lines 369 and 382, or the approval withdrawn.

## 4. Proposed default wording (for owner acceptance)

> Remote requests, meaning requests that carry a Tailscale identity, are refused with `403 desktop_required` on the five user-only Goal completion and correction routes. The guard keys on the remote-request check alone; it does not look at pairing. Other routes use the existing authentication model: remote requests need a Tailscale identity and a paired device session, with a few exemptions (the pairing claim routes and `/api/health`). Loopback requests are trusted without distinguishing the process or whether a human acted. A same-user local process on the desktop is therefore not distinguished from the desktop UI. The owner accepted this residual for V1 under decision O1, conditional on live Tailscale identity-header verification, which remains pending. This is not a desktop-only principal.

**Must not claim:** that loopback proves a human clicked; that the five guarded routes are protected from a same-user local process (they are not, under the current model); or that identity-header handling is verified live (it is pending).

## 5. Changes to make on acceptance

1. Align `docs/history/V1_READINESS_LOG.md:167`, `:348`, `:353` and `SECURITY.md:49` with the decision recorded at lines 369 and 382.
2. Change `docs/history/V1_READINESS_LOG.md:205` to say "on routes without the Goal desktop guard".
3. Add a GH.1 note to `GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md:293`.
4. Replace the proposed wording in the closure report (section 8), which currently says the residual is "accepted under S1b decision O1 for V1". That is not yet confirmed as the owner's current position.

No change is made to any of these files by this proposal.

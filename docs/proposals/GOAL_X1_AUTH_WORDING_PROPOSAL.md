# X1: authentication-boundary wording proposal

Status: **Wording proposal; the underlying O1 decision is recorded.** The owner conditionally accepted the same-user local-process residual for V1 on 2026-10-13 (O1), with live Tailscale identity-header/Host behaviour verification as its condition; O2 may be post-V1. The exact proposed prose below was not separately approved. This document changes no product behaviour.

Note, 2026-10-21: the active [SECURITY.md](../SECURITY.md), [GOAL_TRUSTED_CALLER_BOUNDARY.md](../goals/GOAL_TRUSTED_CALLER_BOUNDARY.md) and [V1_READINESS.md](../V1_READINESS.md) now record the conditional O1 decision and keep the live verification gate. The historical log cited below is unchanged and is not current state. The exact wording in section 4 remains a proposal, not an approved artefact.

## 1. Purpose

Users and reviewers read the docs to learn what the server can and cannot tell apart. The X1 concern is that one statement says the authentication model "does not distinguish a desktop UI from a paired mobile client". That is accurate only for routes that do not use the Goal desktop guard. It must not be read as covering the five user-only Goal completion and correction routes, which now refuse remote requests (GH.1, S1a).

## 2. Where the boundary is stated

- `docs/history/V1_READINESS_LOG.md:167`: preparation route inherits the global model; says S1b "owner decision pending". Scope correct; conflicts with line 382.
- `docs/history/V1_READINESS_LOG.md:205`: "a paired mobile client can call the same API". Broader; should say "on routes without the Goal desktop guard".
- `docs/history/V1_READINESS_LOG.md:348`: phone enforcement; says S1b "owner pending". Conflicts with line 382.
- `docs/history/V1_READINESS_LOG.md:353`: says S1b "remains an owner decision pending". Conflicts with lines 369 and 382.
- `docs/history/V1_READINESS_LOG.md:369`: "O1 approved for V1, conditionally. Residual trust model accepted and documented." Matches the progress doc.
- `docs/history/V1_READINESS_LOG.md:382`: S1b "is no longer 'owner pending'. O1 is approved for V1, conditionally." Matches line 369 and the progress doc.
- `docs/history/goals/GOAL_AUTONOMOUS_IMPLEMENTATION_PROGRESS.md:892` and `:941`: O1 approved for V1, conditionally, on 2026-10-13. Condition: live Tailscale verification is not waived.
- `docs/SECURITY.md`: same-user local process not distinguished from the desktop UI; O1 conditionally accepted for V1, with live Tailscale verification as the condition. Active doc updated to the recorded decision.
- `docs/goals/GOAL_TRUSTED_CALLER_BOUNDARY.md:19–33`: lists what the server can and cannot distinguish, including the process that sent a local request and whether a human clicked. Accurate; does not state the decision status.
- `docs/history/goals/GOAL_E2E_ACCEPTANCE_MATRIX.md:190`: "There is no desktop-only principal." Loopback trust is process-agnostic. Accurate.
- `docs/history/goals/GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md:293`: current auth does not distinguish a desktop human from a paired mobile client or trusted local process. Accurate, but predates GH.1; should note GH.1.

The closure report earlier cited `:196` for the matrix. The correct location is `GOAL_E2E_ACCEPTANCE_MATRIX.md:190`. `docs/history/V1_READINESS_LOG.md:196` is blank.

## 3. The recorded decision

The O1 decision is recorded: the same-user local-process residual was conditionally accepted for V1 on 2026-10-13, with live Tailscale identity-header/Host behaviour verification as its condition. O2 may be post-V1. O1 and O2 are not open owner choices.

The condition is that live Tailscale identity-header and Host handling is not waived. The live check of `desktop_required` was performed from a disposable paired browser on 2026-10-17. Live verification of identity-header handling (whether `Tailscale-User-Login` can be stripped or injected, and how Host is rewritten) remains pending physical acceptance. A remote request misclassified as local that reaches a desktop-only Goal route is a blocking defect.

The active docs have been aligned to that decision. Frozen historical statements are left as written and are not current state. This proposal does not claim that the exact prose in section 4 was separately approved.

## 4. Proposed default wording (not separately approved)

> Remote requests, meaning requests that carry a Tailscale identity, are refused with `403 desktop_required` on the five user-only Goal completion and correction routes. The guard keys on the remote-request check alone; it does not look at pairing. Other routes use the existing authentication model: remote requests need a Tailscale identity and a paired device session, with a few exemptions (the pairing claim routes and `/api/health`). Loopback requests are trusted without distinguishing the process or whether a human acted. A same-user local process on the desktop is therefore not distinguished from the desktop UI. The owner accepted this residual for V1 under decision O1, conditional on live Tailscale identity-header verification, which remains pending. This is not a desktop-only principal.

**Must not claim:** that loopback proves a human clicked; that the five guarded routes are protected from a same-user local process (they are not, under the current model); or that identity-header handling is verified live (it is pending).

## 5. Alignment status

1. `docs/SECURITY.md` now records the conditional O1 decision and keeps the live Tailscale identity-header/Host verification gate and the blocking misclassification condition.
2. `docs/goals/GOAL_TRUSTED_CALLER_BOUNDARY.md` now records the same decision and the post-V1 O2 direction.
3. `docs/V1_READINESS.md` now records O1 as a conditional decision, not a pending owner choice.
4. The frozen `docs/history/V1_READINESS_LOG.md` statements cited above are left unchanged as historical records and are not current state.

No product or code change is made, and the exact proposed prose in section 4 is not claimed as separately approved.

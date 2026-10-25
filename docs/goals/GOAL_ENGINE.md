# Goal Engine (Grand Projects)

An overview of the Goal Engine as implemented on the current development branch, checked on 2026-10-24. The contracts listed at the end define each boundary in detail. Release state is in [V1_READINESS.md](../V1_READINESS.md).

## What it is

A Goal is a long-running piece of work with a versioned, user-approved definition: objectives, milestones, scope, bounds, a route blueprint (pinned routes and explicitly authorised pools) and a completion policy. The Goal supervisor advances a Goal one persisted step at a time (`tickGoal` in `src/server/goals/supervisor.ts`), so every step is individually recoverable after a restart.

The Goal Engine sits above `RunEngine`. All model work runs as ordinary bounded runs through the run launcher and `RunEngine`; the Goal Engine never rewrites them. The UI labels Goals "Grand Projects".

## Production status

Production calls `createProductionGoalComposition` (`src/server/index.ts:28`). That composition wires `createGoalSupervisor` to `TuringGoalExecutor` with `ResolvedGoalRunPlanProvider` and `requireResolvedRoutes: true` (`src/server/goals/productionComposition.ts`). The supervisor decides every state transition and starts at most one ordinary queued run at a time through the same `RunEngine`; the exact backend, provider, model and billing lane come from the cycle's write-once persisted role resolution, never from a fallback or a fresh selection. A plan without a matching resolved route is refused.

The Goal composition has deterministic acceptance coverage for the exact persisted route, isolated execution, manual handoff and the user's base staying untouched until the user acts. The provider process boundary is faked: this is not live-provider, physical-device or release qualification. Current full-gate and platform status is in [V1_READINESS.md](../V1_READINESS.md).

Creating Goals and definition drafts, approving and amending definitions, persistence and restart recovery, and **authoring runs** also work. An authoring run (`POST /api/goals/authoring`, consumed by `AuthoringReconciler`) uses the user's exact pinned route.

Delivery remains manual-handoff only. Turing never writes the user's base branch; the checked-out-worktree writer `applyApprovedGoalToBase` is quarantined and unreachable because it can overwrite ignored files. New completions bind to immutable evidence from the read-only `content-verified-v1` verifier; old ancestry-only completion proofs remain historical and immutable. The verifier compares Goal-changed paths at the first destination-history commit containing the source, refuses LFS-filtered paths, fails closed above 10,000 paths, and does not turn a mismatch into success through Policy B.

## Lifecycle

Statuses (`GoalStatus` in `src/shared/goals.ts`): `draft`, `ready`, `running`, `reviewing`, `needs_user`, `blocked`, `paused`, `completed`, `abandoned`. Transitions come from `GOAL_TRANSITIONS` and are enforced by `src/server/goals/stateMachine.ts`. `completed` and `abandoned` are terminal; a terminal Goal never reopens. A project holds at most one active Goal (the project lease, migration 015).

Work happens in cycles (authoring, execution, remediation, review, verification) on the Goal's own ref, `refs/heads/turing/goal/<goal-id>`, which is never checked out. Evidence comes from run results and verification commands. Reviews must come from an independent model family. The user decides findings. Hard bounds (`bounds.ts`) stop a Goal that exceeds its execution-cycle, remediation-attempt, active-time, wall-clock or metered-spend limits.

## Delivery and completion

1. **Final review and acceptance.** An independent final review, then explicit user acceptance. Completion evaluation then reports `final_apply_required` until delivery is recorded.
2. **Manual handoff** (`manualHandoff.ts`). An immutable record binds the exact source and base commits and trees, the evidence, the review, a bounded diff and read-only inspection commands. Turing never writes the user's base branch. The old checked-out-worktree writer, `applyApprovedGoalToBase` in `finalApply.ts`, is quarantined and unreachable because it can overwrite ignored files.
3. **The user integrates** the result with their own Git operation.
4. **External-integration attestation** (`externalIntegration.ts`). The user confirms the integration, and Turing observes that the source and the expected base are ancestors of the exact destination commit. The separately versioned content verifier checks changed paths for new completion evidence; ancestry-only records remain `not_proven`, and a `git merge -s ours` cannot pass the content check.
5. **Completion** (`externalCompletionDecision.ts`, `externalCompletion.ts`). For a definition with the version-2 policy (`external_user_attested_v2`), a read-only preflight, then a recorded user decision, then a terminal transition that writes an immutable proof. Definitions with the legacy version-1 policy keep their original rules.
6. **Corrections** (migration 028). An attestation can later be disputed, withdrawn or superseded through an append-only ledger. A correction changes the completed Goal's standing (`uncontested`, `disputed`, `withdrawn`, `superseded`, `reconciliation_required`), never its completion, proof or `completed_at`.

## Authority boundaries

- **Desktop-only routes.** These five routes refuse paired remote callers with 403 `desktop_required`:
  - `POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attest`
  - `POST /api/goals/:goalId/completion-decision`
  - `POST /api/goals/:goalId/completion`
  - `POST /api/goals/:goalId/attestation-corrections/:approvalId/decision`
  - `POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections`
- **Final-acceptance decision.** `POST /api/goal-approvals/:approvalId/decision` has one conditional exception. The handler reads the stored `goal_approvals` row (a mutable row) before app-level body validation and writes, and refuses a paired remote caller only when `row.gate === 'final_acceptance' && row.status === 'pending'` with 403 `desktop_required`. Local callers stay allowed, an unknown remote id stays the ordinary 404, and every other gate stays allowed; an already-decided row keeps its ordinary idempotent 200 or 409 `already_decided`. `final_apply` is deliberately not guarded: `applyApprovedGoalToBase` stays quarantined and unreachable, no Turing API writes the user's base, and the external-integration attestation itself remains desktop-only.
- **Caller-aware projection.** Both `/api/approvals/unified` and `/api/dashboard` thread the same request identity predicate through the approval projection. A remote caller still receives a pending `final_acceptance` row in the pending list, but with `decidable: false` and `desktopOnly: true`; a local caller sees it as decidable. The row is never dropped from the pending list.
- **Local trust.** Loopback callers are trusted. A same-user local process is not distinguished from the desktop UI; the owner conditionally accepted this residual for V1 on 2026-10-13 (O1), with live Tailscale identity-header/Host behaviour verification as its condition. O2, a verified process boundary, may be post-V1. See [GOAL_TRUSTED_CALLER_BOUNDARY.md](GOAL_TRUSTED_CALLER_BOUNDARY.md).
- **Phone.** It shows Goal state and completion standing read-only. A pending final-acceptance approval stays visible in its pending list with an explanatory desktop note and no decision buttons. It has no completion, correction or handoff control.
- **Approvals.** All Goal approvals use the one approval system (`goal_approvals`). Model output never decides a Goal transition.

## Where the code is

| Area                         | Files (under `src/server/goals/` unless noted)                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Domain types and transitions | `src/shared/goals.ts`, `src/shared/goalApi.ts`, `stateMachine.ts`                                                                   |
| Supervisor and executor      | `supervisor.ts`, `preflight.ts`, `executor.ts`, `turingExecutor.ts`, `runPlan.ts`, `routePlan.ts`                                   |
| Definitions and authoring    | `definitions.ts`, `definitionValidation.ts`, `definitionHash.ts`, `amendmentAuthority.ts`, `authoring.ts`                           |
| Evidence, reviews, findings  | `evidence.ts`, `runEvidence.ts`, `verification.ts`, `reviews.ts`, `reviewIndependence.ts`, `findings.ts`                            |
| Handoff and integration      | `manualHandoff.ts`, `externalIntegration.ts`, `externalIntegrationApproval.ts`, `src/server/goalGit.ts`                             |
| Completion and corrections   | `completionEvaluation.ts`, `completionPolicy.ts`, `externalCompletion*.ts`, `completionStanding.ts`, `completionAuthorityPolicy.ts` |
| HTTP routes                  | `goalRoutes.ts`; authoring routes are in `src/server/routes/goalAuthoringRoutes.ts`                                                 |
| Desktop and phone UI         | `src/client/goals/`                                                                                                                 |

## Contracts

- [GOAL_MANUAL_HANDOFF_CONTRACT.md](GOAL_MANUAL_HANDOFF_CONTRACT.md)
- [GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md](GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md)
- [GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md](GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md)
- [GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md](GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md)
- [GOAL_FINAL_APPLY_AUTHORITY.md](GOAL_FINAL_APPLY_AUTHORITY.md): the quarantined writer's approval contract, kept for the records it defines.
- [GOAL_TRUSTED_CALLER_BOUNDARY.md](GOAL_TRUSTED_CALLER_BOUNDARY.md)

These were written stage by stage. Their opening status lines describe the stage they were written in, not today; this page and the code are current.

The original design, stage progress record, acceptance matrix and closure report are in [../history/goals/](../history/goals/).

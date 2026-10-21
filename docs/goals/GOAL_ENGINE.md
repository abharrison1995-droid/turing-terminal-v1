# Goal Engine (Grand Projects)

An overview of the Goal Engine as the code stands, checked on 2026-10-20. The contracts listed at the end define each boundary in detail. Release state is in [V1_READINESS.md](../V1_READINESS.md).

## What it is

A Goal is a long-running piece of work with a versioned, user-approved definition: objectives, milestones, scope, bounds, a route blueprint (pinned routes and explicitly authorised pools) and a completion policy. The Goal supervisor advances a Goal one persisted step at a time (`tickGoal` in `src/server/goals/supervisor.ts`), so every step is individually recoverable after a restart.

The Goal Engine sits above `RunEngine`. All model work runs as ordinary bounded runs through the run launcher and `RunEngine`; the Goal Engine never rewrites them. The UI labels Goals "Grand Projects".

## Production status

Production constructs `DisabledGoalExecutor` (`src/server/index.ts`). Its route check always reports `route_unavailable`, so starting a Goal fails preflight and no proposal, execution, review, remediation or verification run is ever queued. The real executor, `TuringGoalExecutor`, is used only by tests.

What does work in production: creating Goals and definition drafts, approving and amending definitions, persistence and restart recovery, and **authoring runs**. An authoring run (`POST /api/goals/authoring`, consumed by `AuthoringReconciler`) is the only Goal path that starts a model run, and it uses the user's exact pinned route.

Because no Goal can execute, no production Goal can reach handoff. Everything under "Delivery and completion" below is exercised by fake-provider end-to-end tests (`src/server/goals/goalE2E.test.ts`) only.

## Lifecycle

Statuses (`GoalStatus` in `src/shared/goals.ts`): `draft`, `ready`, `running`, `reviewing`, `needs_user`, `blocked`, `paused`, `completed`, `abandoned`. Transitions come from `GOAL_TRANSITIONS` and are enforced by `src/server/goals/stateMachine.ts`. `completed` and `abandoned` are terminal; a terminal Goal never reopens. A project holds at most one active Goal (the project lease, migration 015).

Work happens in cycles (authoring, execution, remediation, review, verification) on the Goal's own ref, `refs/heads/turing/goal/<goal-id>`, which is never checked out. Evidence comes from run results and verification commands. Reviews must come from an independent model family. The user decides findings. Hard bounds (`bounds.ts`) stop a Goal that exceeds its execution-cycle, remediation-attempt, active-time, wall-clock or metered-spend limits.

## Delivery and completion

1. **Final review and acceptance.** An independent final review, then explicit user acceptance. Completion evaluation then reports `final_apply_required` until delivery is recorded.
2. **Manual handoff** (`manualHandoff.ts`). An immutable record binds the exact source and base commits and trees, the evidence, the review, a bounded diff and read-only inspection commands. Turing never writes the user's base branch. The old checked-out-worktree writer, `applyApprovedGoalToBase` in `finalApply.ts`, is quarantined and unreachable because it can overwrite ignored files.
3. **The user integrates** the result with their own Git operation.
4. **External-integration attestation** (`externalIntegration.ts`). The user confirms the integration, and Turing observes that the source and the expected base are ancestors of the exact destination commit. This proves ancestry at an observed time only. Content preservation is not proven (`contentPreservation: not_proven`): a `git merge -s ours` passes the ancestry check while discarding the work.
5. **Completion** (`externalCompletionDecision.ts`, `externalCompletion.ts`). For a definition with the version-2 policy (`external_user_attested_v2`), a read-only preflight, then a recorded user decision, then a terminal transition that writes an immutable proof. Definitions with the legacy version-1 policy keep their original rules.
6. **Corrections** (migration 028). An attestation can later be disputed, withdrawn or superseded through an append-only ledger. A correction changes the completed Goal's standing (`uncontested`, `disputed`, `withdrawn`, `superseded`, `reconciliation_required`), never its completion, proof or `completed_at`.

## Authority boundaries

- **Desktop-only routes.** These five routes refuse paired remote callers with 403 `desktop_required`:
  - `POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attest`
  - `POST /api/goals/:goalId/completion-decision`
  - `POST /api/goals/:goalId/completion`
  - `POST /api/goals/:goalId/attestation-corrections/:approvalId/decision`
  - `POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections`
- **Local trust.** Loopback callers are trusted. A same-user local process is not distinguished from the desktop UI; the owner accepted this for V1 (O1). See [GOAL_TRUSTED_CALLER_BOUNDARY.md](GOAL_TRUSTED_CALLER_BOUNDARY.md).
- **Phone.** It shows Goal state and completion standing read-only. It has no completion, correction or handoff control.
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

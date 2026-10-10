# Goal Manual Integration Handoff Contract

Status: Stage 7C.2B.4 implementation candidate, pending independent review. This contract prepares a reviewed Goal result for user-controlled Git integration. It does not apply the result, attest that integration occurred, or satisfy the existing `applyToBase: "required"` completion policy.

## Services and mutation boundary

`src/server/goals/manualHandoff.ts` exposes four distinct operations:

- `buildManualHandoffSnapshot(db, goalId)` reads Goal authority and Git objects, then returns a candidate with no database or Git writes.
- `prepareManualHandoff(db, goalId)` builds and rechecks the candidate, then inserts one immutable SQLite record. A transaction rechecks the database fingerprint and returns an existing record for the same Goal/digest.
- `validateManualHandoff(db, goalId, handoffId)` reads the immutable record and reconstructs the current candidate. It never refreshes or edits the stored payload.
- `getManualHandoffProjection(db, goalId, handoffId)` returns the bounded stored projection with a fresh `current`, `stale`, `unavailable`, or `invalid` state.

Stage 7C.2B.4 exposes three Goal-scoped HTTP operations and a desktop-only cockpit review surface:

- `GET /api/goals/:goalId/handoffs?limit=25&offset=0` returns newest-first metadata only. `limit` is 1–50 (default 25), `offset` is bounded to 100,000, and the response includes a next offset when more rows exist. It selects indexed identity columns and does not parse full history payloads or scan Git.
- `GET /api/goals/:goalId/handoffs/:handoffId` first checks that the record belongs to the exact Goal, then calls `getManualHandoffProjection()`. It reconstructs and validates the selected record against current authority and Git identities. Currentness describes that read moment only.
- `POST /api/goals/:goalId/handoffs` accepts an empty JSON object only and calls `prepareManualHandoff(db, goalId)`. All source/base identities and authority remain server-owned. It returns 201 for a new immutable record or 200 when an identical digest is reused. The UI follows with the selected GET; the POST response is not treated as a lasting currentness assertion.

No GET calls the preparation service. Opening the tab, refresh, SSE, history selection, and failed GETs do not prepare a handoff. The explicit confirmation is the only UI path that sends the POST. Preparation errors are returned as bounded domain codes/messages; unexpected server failures do not expose exception traces.

The routes inherit `createApp()`'s existing `/api` authentication. Loopback/local requests use the existing local-trust policy. Remote requests require Tailscale Serve identity and a live paired `__Host-turing-device` session (HttpOnly, Secure, SameSite=Strict). The same authenticated API is available to desktop and mobile clients; there is no server-verifiable desktop-browser principal. Hiding preparation controls from the PWA is a UX boundary, not an authorization guarantee. The UI makes preparation an explicit user action, and no agent, supervisor, scheduler, or provider code path calls these routes. The local-trust policy is process-agnostic: a local process that can reach the API is not distinguished from the desktop UI, so this endpoint does not prove that a human clicked the control. That is an existing principal-boundary limitation, not a desktop-only security guarantee.

The desktop cockpit mounts its Handoff tab only when selected. Mobile has no preparation control and describes the manual integration workflow. The existing tab keyboard model and unsaved-definition navigation guard remain in force. Full SHA IDs, stored evidence/review identities, at most 100 changed paths, a bounded diff stat/preview, explicit truncation, and fixed read-only inspection commands are displayed as inert React text. Copying uses a direct user click and the clipboard fallback is selectable text. Stale, unavailable, and invalid records never show a current-ready state; commands are disabled unless selected validation is current. Historical rows are not eagerly validated; selecting one triggers the full validation.

Git access uses `execFile` argument arrays and `gitTry()` with a 60-second timeout, a 64 MiB output cap, and `GIT_OPTIONAL_LOCKS=0`. The complete content scan is capped at 256 MiB and 60 seconds. The handoff uses only ref/object reads, ancestry checks, commit-to-commit diffs, and the existing full path/content checks. Diff generation disables external diff and text conversion. No command accepts a client-supplied ref, path, or commit. The service does not check out a branch or read the live index/worktree as its result source.

## Record v1

Migration `025_goal_result_handoffs.sql` adds `goal_result_handoffs`. Its strict payload has:

- `schemaVersion: 1`, `kind: "turing_goal_manual_integration_handoff"`, UUID handoff and Goal IDs;
- current approved definition version/hash and the exact user definition-approval identity digest;
- exact final-acceptance approval ID and identity digest;
- registered project ID, server-computed repository identity, object format, and project scope;
- Goal source ref, full source commit and tree;
- recorded base branch/ref and the observed base commit and tree;
- completion/finding identity digests;
- exact passing final-review ID/identity digest;
- deterministic identities for the evidence rows selected by `evaluateCompletion()`, plus their IDs, criterion keys, verifier digests, kinds, and verdicts;
- full changed-path digest and count, bounded path summary, bounded stat/diff preview, their digests and truncation flags;
- fixed read-only inspection commands, a creation time, and a content digest.

The canonical digest is SHA-256 over `"turing-goal-manual-integration-handoff-v1\n"` plus the existing recursively key-sorted `canonicalJson()` representation of the identity payload. The identity includes source/base, approval, definition, review/evidence, completion/finding, repository, full changed-path, and displayed-preview identities. `handoffId` and `createdAt` are excluded, so equal prepared content has the same digest. The selected preview limit is included because changing the visible excerpt changes the material presented for review.

The table constrains version/kind, JSON validity and size, full lowercase-hex object IDs for SHA-1/SHA-256, indexed payload fields, same-Goal definition/acceptance/review references, the current user-approved definition and its actual user decision, current user acceptance, and a passing final review bound to the exact source. `(goal_id, handoff_digest)` is unique. Update and delete triggers make rows immutable. A changed snapshot creates a new row; no old row is edited or deleted.

## Eligibility and authority binding

Preparation first uses the real `evaluateCompletion()` and proceeds only when the sole failure is `final_apply_required`, `finalApply` is still required and `not_applied`, final acceptance is required and valid, and a passing independent final review is required and valid. The current definition must be approved by the user and pass its stored hash check. The actual approval and review rows are reread and bound; approval or review JSON supplied by a caller is never accepted as authority.

### Amended-definition approval compatibility

Stage 7C.2B.3a corrected an authority mismatch found in review: the initial implementation required the current definition approval gate to be `definition`, while `approveDefinition()` uses `amendment` after a current definition exists. The handoff service now derives the expected gate from the persisted parent-version lineage: version 1 must be the root (`parentVersion: null`) and use `definition`; each child must link to an earlier version and use `amendment`. The Goal's current-definition pointer must name the candidate, each parent must be superseded, and the complete chain must terminate at version 1. For the current version and every ancestor, the stored definition hash must verify and its persisted approval must match the Goal, expected gate, version, hash, approved status, and user decision. A version number by itself is not treated as proof of amendment lineage.

This agrees with `approveDefinition()`, which requires a proposal's parent to equal the current approved definition before selecting its gate, and with migration 018's `CASE WHEN parent_version IS NULL THEN 'definition' ELSE 'amendment' END` approval trigger. Migration 025 permits both legitimate gate values while referencing the already-approved immutable definition. No migration 026 is needed. The service independently revalidates the full lineage, including pre-existing rows that migration 018 did not retroactively validate.

The version 2 regression uses the real amendment, definition approval, evidence, review, and final-acceptance services. It keeps the Git source commit unchanged, changes a verifier so version 1 evidence cannot satisfy version 2, and proves that the old immutable handoff becomes stale from its changed definition authority while a distinct version 2 handoff becomes current. Negative cases cover cross-Goal, wrong-version/hash, pending, denied, system-decided, wrong-gate, and broken-lineage approvals, plus version 1 review, acceptance, or evidence reused after amendment. These refusals do not relax acceptance, review, evidence, repository, source, or completion checks.

For each verifier that the evaluator says is satisfied, the handoff uses its `decidingEvidenceId` and confirms that immutable row belongs to the same Goal/current definition/criterion/verifier and has a satisfying verdict. Its digest includes the persisted evidence identity fields and canonicalized `ref_json`. User-skipped milestones bind the actual user skip approval. The completion/finding digests bind current evaluator states and open-finding identities. No second verifier-selection algorithm chooses substitute evidence.

Preparation refuses terminal Goals, manual-reconciliation states, active cycles/runs, pending reviews, unresolved integration operations, and historical failed/applied v1 `apply_to_base` operations that could leave the repository state uncertain. It also refuses missing or invalid authority and Goals whose policy does not require base integration. Existing planned historical v1 apply operations are never replayed. If completion already sees verified application or an external attestation, the single-`final_apply_required` precondition fails.

## Repository observation and consistency

Repository identity reuses the existing project ID + canonical repository root + Git common directory + project scope hash. Source ref is derived only from the server-created Goal UUID. The runtime head must equal the source ref's full commit and the evaluator's source tree. The recorded local base branch must pass `git check-ref-format`; its current ref must still equal the runtime's recorded base commit. The service reads both trees and requires base-to-source ancestry. It refuses missing/diverged bases and does not retarget, merge, rebase, or adapt the source.

The full changed-path set is derived from exact base/source commit IDs. Every old and new path is checked against project scope, sensitive/protected paths, and unsupported symlink/submodule modes. The complete diff is scanned for suspected secrets under size/time bounds; incomplete scans fail closed. Only afterward does the service build redacted, bounded display text. The preview is not the complete safety scan.

Git observations are not an atomic repository snapshot and do not reserve refs. The builder records a database fingerprint, reads source/base, evaluates completion, computes evidence/path/diff identities, re-evaluates completion, then rereads the material database and Git identities. If they differ, preparation refuses. SQLite `BEGIN IMMEDIATE` rechecks database bindings before inserting. This does not lock out external Git processes between the final ref read and the database commit. The immutable record preserves exactly what was observed; every display/retrieval recomputes currentness. It can become stale immediately after preparation.

## Currentness and projection

Validation reports:

- `current`: rebuilt canonical digest matches the persisted handoff;
- `stale`: a material identity changed or a completion prerequisite ceased to hold;
- `unavailable`: required repository/Git state cannot be read;
- `invalid`: no such Goal-scoped handoff exists, or its stored payload, digest, discriminator, or indexed identity is malformed.

Known reasons include definition change, completion/evidence/review change, source ref/head change, base ref missing/diverged, repository unavailable, unsafe changes, and snapshot movement. The original record is returned as historical data for stale/unavailable results but is never rewritten. It is never presented with a current/ready label unless fresh validation matches.

The projection label for a current record is **Ready for manual integration**. It explicitly records `actualApplication: "not_performed_by_turing"` and `goalCompletion: "not_completed_by_handoff"`. Inspection commands use only validated full object IDs. They display `git show --stat <source>`, `git diff --stat <base> <source>`, and `git diff <base> <source>`; none checks out or changes refs. A warning tells the user to recheck both identities and their worktree before later manual integration.

## Completion and historical compatibility

`evaluateCompletion()` and completion policy are unchanged. A prepared/current handoff leaves:

```text
finalApply.ok = false
finalApply.reason = not_applied
failure = final_apply_required
```

It creates no `goal_integration_ops` row, final-apply approval, external-application attestation, completion proof, Goal status transition, or provider call. Existing v1 `apply_to_base_intent` approvals and operation/recovery records keep their original meaning; no migration derives or converts authority from them. Migration 025 adds no Git-write authority.

## Evidence and limits

Temporary-repository tests cover all 30 original negative-case categories plus amended-definition approval compatibility, service-recorded acceptance/review/evidence, SHA-1 and SHA-256, identical concurrent preparation, source/base movement during preparation, stale base/definition/review/acceptance/evidence, unsafe paths/content, active work, pending operations, unreadable repositories, malformed/tampered handoffs, and a before/after Git-state comparison over refs, HEAD, index bytes/entries, tracked/ignored/untracked files, worktree registrations, config, exclude, and reflogs. Source/base races use a test-local Git executable shim with a locked invocation counter to inject movement before the final ref read; the production service exposes no callback hook. The existing real fake-provider Goal E2E traverses the actual definition, run, evidence, independent review, and user-acceptance path before creating a handoff, then confirms staleness and unchanged completion semantics. The amendment regression retains the same Git source commit and proves that definition authority alone makes the version 1 handoff stale.

Linux characterization is available on the local test host. Windows was not available and is unverified. No test used a real project for Git mutation. The later user integration step remains outside the service: the user reviews the exact source/base and chooses a safe Git workflow. If a Goal is to complete under the existing required-apply policy afterward, a separate explicit external-attestation design is still needed. This stage does not implement it and does not qualify final apply for production.

## Stage 7C.2B.4a — desktop UI state remediation candidate

Independent review identified two UI state defects in the first desktop handoff candidate:

1. `Refresh currentness` cleared the unknown-POST lock before its replacement GET succeeded. If both the preparation request and recovery read failed, a later failed refresh enabled another preparation.
2. The history-selection effect replaced any selected ID missing from the currently held page with that page's first row. Because `useLoad()` intentionally holds old page data while refreshing, a successful version 2 POST could select version 1 until the new list arrived, and its version 2 projection could be hidden.

Deterministic regressions use rejected requests, deferred list responses, and a version 1 → version 2 preparation. Both tests fail against the original candidate. The corrected component records preparation as idle, pending, confirmed, refused, uncertain, reconciling, reconciliation-failed, or reconciled. An ambiguous POST locks the action. Refresh, ordinary history reload, SSE, and cached `useLoad()` data do not clear that lock.

Recovery makes fresh, sequential, Goal-scoped metadata GETs through every page until `nextOffset` is null. It is bounded to 100 pages of 50 rows and rejects malformed, non-advancing, out-of-range, failed, or over-bound pagination. An incomplete scan keeps preparation locked. A successful full scan is reported as a point-in-time history read; it does not claim whether the original POST persisted. It permits the user to review the refreshed list and make a new explicit, confirmed request. The service's immutable digest/idempotency remains the duplicate-record protection. No POST is retried automatically.

The unresolved flag, selected handoff ID, and history offset are kept in per-Goal `sessionStorage` UI memory. This preserves the lock and the user's selection when the Handoff tab or Goal cockpit unmounts; another Goal uses a separate key. A late response from an unmounted component cannot update visible state. A selected ID is never replaced merely because it is absent from a cached or older history page. After preparation, the exact returned ID remains selected until the corresponding Goal-and-handoff-scoped projection arrives. Projection errors retain that ID and offer a user-triggered retry; only an identity-matching projection is displayed. A stale response remains stale, and the version 2 regression verifies it stays selected while version 1 history is cached and after updated history arrives. Users can then explicitly choose version 1 again.

These changes are frontend navigation/recovery safeguards. They add no backend authority, endpoint, migration, Git writer, external-application attestation, or completion behavior. Handoff preparation remains a durable manual-integration record. Git refs, checkout, index, worktree, reflogs, and Goal lifecycle remain untouched; completion remains `final_apply_required` with `finalApply.ok = false` and `reason = not_applied`. `applyApprovedGoalToBase()` stays quarantined and production remains `DisabledGoalExecutor`. No live provider/model calls or subscription usage were introduced.

The remediation candidate awaits independent review. Its exact commit, focused/full gate counts, and hosted CI result are recorded in the checkpoint report. Windows behavior remains unverified.

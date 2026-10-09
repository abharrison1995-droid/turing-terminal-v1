# Goal Manual Integration Handoff Contract

Status: Stage 7C.2B.3 implementation candidate, pending independent review. This contract prepares a reviewed Goal result for user-controlled Git integration. It does not apply the result, attest that integration occurred, or satisfy the existing `applyToBase: "required"` completion policy.

## Services and mutation boundary

`src/server/goals/manualHandoff.ts` exposes four distinct operations:

- `buildManualHandoffSnapshot(db, goalId)` reads Goal authority and Git objects, then returns a candidate with no database or Git writes.
- `prepareManualHandoff(db, goalId)` builds and rechecks the candidate, then inserts one immutable SQLite record. A transaction rechecks the database fingerprint and returns an existing record for the same Goal/digest.
- `validateManualHandoff(db, goalId, handoffId)` reads the immutable record and reconstructs the current candidate. It never refreshes or edits the stored payload.
- `getManualHandoffProjection(db, goalId, handoffId)` returns the bounded stored projection with a fresh `current`, `stale`, `unavailable`, or `invalid` state.

There is no new HTTP route or supervisor hook in this stage. Preparing a handoff is an explicit trusted service call. A future user-facing preparation interaction needs a separate reviewed route. A GET must never call the preparation service.

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

Temporary-repository tests cover all 30 requested negative-case categories, service-recorded acceptance/review/evidence, SHA-1 and SHA-256, identical concurrent preparation, source/base movement during preparation, stale base/definition/review/acceptance/evidence, unsafe paths/content, active work, pending operations, unreadable repositories, malformed/tampered handoffs, and a before/after Git-state comparison over refs, HEAD, index bytes/entries, tracked/ignored/untracked files, worktree registrations, config, exclude, and reflogs. Source/base races use a test-local Git executable shim with a locked invocation counter to inject movement before the final ref read; the production service exposes no callback hook. The existing real fake-provider Goal E2E traverses the actual definition, run, evidence, independent review, and user-acceptance path before creating a handoff, then confirms staleness and unchanged completion semantics.

Linux characterization is available on the local test host. Windows was not available and is unverified. No test used a real project for Git mutation. The later user integration step remains outside the service: the user reviews the exact source/base and chooses a safe Git workflow. If a Goal is to complete under the existing required-apply policy afterward, a separate explicit external-attestation design is still needed. This stage does not implement it and does not qualify final apply for production.

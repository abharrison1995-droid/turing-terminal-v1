# Goal final-apply authority contract

Status: Stage 7C.2A authority contract. This document defines authorization for a future exact fast-forward; it does not authorize or implement a Git write. Stage 7C.2B remains responsible for execution and recovery.

## Existing authority

- Goal approvals are persisted in `goal_approvals`, with one existing gate vocabulary and immutable request details. `requestGoalApproval()` creates pending records and `decideGoalApproval()` permits an explicit user approval or a system denial. Decisions are terminal and idempotent when repeated identically.
- `evaluateCompletion()` is the completion authority. For a Goal whose policy requires base application, final acceptance is bound to the current definition version/hash and integration tree. Completion remains false until an `apply_to_base` operation is durably applied at the current integration head, or a separate user approval carries the exact `action: "applied_externally"` attestation.
- `preflightFinalApply()` is the existing read-only Git authority. It checks the recorded base, current branch/HEAD, clean checkout, Goal-ref identity and checkout state, fast-forward ancestry, full changed-path scope, sensitive paths, and complete content scan. Its diff and path displays are bounded/redacted separately from safety checks.
- No final-apply-specific prospective authority currently binds a user approval to one exact source, destination, repository and reviewed change summary. There is no final-apply writer or request endpoint.

## 7C.2A intent

The server constructs `FinalApplyIntent` schema version 1 with action `apply_to_base_intent`. Its authority fields are:

- Goal ID and approved definition version/hash;
- exact Goal ref, full integration commit ID, and integration tree ID;
- registered project/repository identity, full base ref, recorded base branch and expected old base commit;
- SHA-256 digests of the complete changed-path set, bounded diff-stat display, and bounded diff-preview display, plus the preview truncation flag;
- a SHA-256 `intentDigest` over a versioned canonical serialization of all those fields.

Commit/tree IDs retain their full repository-specific width (40 hexadecimal characters for SHA-1, 64 for SHA-256). The client never supplies or replaces authority fields. The stored explanation is bounded to the approval read model's 4,000-character detail limit; the complete path and content safety scans remain independent of that display. The preview digest binds the exact bounded/redacted preview the approval record presents, while the full source commit/tree and complete path-set digest bind the underlying change.

Repository identity is a server-computed SHA-256 over a versioned tuple containing the registered project ID, canonical real repository root, canonical Git common directory, and project-relative scope. This prevents replay to another registered project/repository that happens to use the same branch name. It intentionally treats moving a repository or changing the registered project root as stale authority; it is a local identity, not a portable repository UUID.

Canonical digest input is a version-tagged JSON array in fixed field order, not arbitrary object serialization. No timestamps, formatted prose, or client-provided digest participate. Each authoritative field and preview digest has a sensitivity test proving a changed value changes the digest; identical inputs produce the same lowercase SHA-256 digest.

## Eligibility and revalidation

`prepareFinalApplyIntent(db, goalId)` is read-only. It calls `evaluateCompletion()` and accepts only a non-`ok` evaluation whose sole failure is `final_apply_required`, with required criteria, milestones, findings policy, final review, and final acceptance all satisfied. It also refuses an unapproved or invalid current definition, terminal/manual-reconciliation Goal, active cycle/run, any unresolved planned integration operation, or a policy that does not require base application. It then calls the existing `preflightFinalApply()` and requires `ready_for_approved_apply`; it does not duplicate Git policy.

The persisted approval request uses the existing service with gate `final_apply`, risk `high`, requester `user`, and `action: "apply_to_base_intent"`. Both the existing service and migration insert guard reject prospective intent records with another risk or requester. The immutable detail also records the registered `repositoryProjectId` used to compute the repository identity. No new public request endpoint or UI action is introduced in 7C.2A. The existing decision endpoint routes prospective intent approvals through asynchronous read-only validation before an explicit user approval, then rechecks Goal, definition, source-head, destination and active-work database bindings inside the decision transaction. Git reads occur outside SQLite transactions. A Git ref or repository identity can still change in the interval before the approval decision commits; the approved record remains bound to the earlier snapshot and cannot authorize a different one. 7C.2B must revalidate after acquiring its Git coordination and immediately before the write.

`validateFinalApplyAuthority(db, goalId, approvalId)` is read-only and requires the exact approval to be pending or explicitly approved according to its caller. It validates strict versioned detail shape, Goal/gate/risk/requester/status/decision actor, matching typed digest metadata, canonical digest, current definition/hash, completion prerequisites, current repository identity, source commit/tree, destination branch/base commit, fresh preflight, and absence of active work or unresolved operations. A mismatch returns a specific refusal; it never refreshes or rebinds an approval. The write stage must call it for an approved decision and must use only the returned authority.

## Approval lifecycle and idempotency

- An identical current request returns the existing pending or approved approval. An approved record is never replaced.
- A denied record is returned as denied by default. A new attempt at the same digest is permitted only through a distinct explicit request (`retryDenied: true`); it creates a new approval and leaves the denied record intact. A changed snapshot naturally has a different digest.
- A SQLite `BEGIN IMMEDIATE` request transaction serializes duplicate creation across Master processes. An additive partial unique index permits at most one live pending/approved prospective approval for a Goal/digest. A denied record is excluded so an explicit retry can be recorded.
- When a new, different current intent is requested, older pending prospective intents for that Goal are system-denied with a stale note through the existing decision service. Their history remains. An approved old intent remains immutable, but revalidation refuses it while its authority differs. If a stale pending approval is decided before a replacement request, the existing decision endpoint returns a stale refusal and leaves it pending; a later request settles it. No stale approval is silently selected or rebound.
- Two requests for different snapshots may leave historical approvals for different digests; only the digest matching the current complete evaluation and preflight can validate. Two decisions on one approval retain the existing exactly-once rule: one terminal decision wins, an identical repeat is a no-op, and a conflicting decision is refused.

Final acceptance, prospective Turing apply authority, and `applied_externally` remain distinct. Prospective detail uses only `apply_to_base_intent`; it never uses `applied_externally`. Approving this intent does not create an applied operation, move a ref, complete the Goal, or start/resume it. Completion continues to report `final_apply_required` until a later operation is durably proven or a separate valid external attestation is made outside this stage.

## Stage 7C.2B recovery and concurrency contract

7C.2A does not change `recoverIntegrationOps()`; it continues to skip `apply_to_base`. Before any write, 7C.2B must persist one immutable planned `apply_to_base` operation containing the approval ID, intent digest, source commit/tree/ref, target ref, expected old commit, and the exact authority-check record. The order is: validate approved authority; persist planned operation; recheck authority and both refs; perform one guarded ref transaction; persist applied result; recover the database record after interruption.

For recovery, the observed destination equal to the expected old commit means no write occurred and may be aborted/retried only after fresh checks. Equality to the approved new Goal commit may be reconciled as applied only when the immutable planned record, approval, digest, source ref, and transaction identity all match. A different or missing/unreadable destination fails closed without a Git write. Mere commit equality without a pre-existing Turing planned record is not proof of a Turing operation; external application remains a separate user attestation.

An ordinary `git merge --ff-only` after a prior read is not an atomic expected-old check. 7C.2B must coordinate at the common Git ref store and use a Git compare-and-swap transaction that verifies the Goal ref is still the approved source and updates the base ref only if it is still the approved expected-old commit. `git update-ref --stdin` supports a transaction containing expected-old `verify` and `update` commands; a failed compare-and-swap performs no base-ref update ([Git documentation](https://git-scm.com/docs/git-update-ref)). The transaction must not create a merge commit, reset, rebase, cherry-pick, or force-update. Any worktree/index refresh is a separate non-destructive concern: it must never overwrite edits made after preflight and must fail safely if it cannot synchronize.

Concurrency expectations:

- Identical request races serialize at SQLite and converge on one live approval. Different snapshots have different digests and only the current one validates.
- Approval-decision races are serialized by the existing terminal decision transaction. A Goal advance, definition amendment, stale review/acceptance, base movement, checkout change, dirty worktree, Goal-ref movement, or safety failure makes the old intent fail revalidation.
- A crash after persisting `planned` but before the Git transaction observes the old ref and aborts/retries only after fresh checks. A crash after the ref transaction but before database reconciliation observes the approved new ref and reconciles only with matching operation provenance. Third-party movement or an unreadable ref is never guessed over.
- The CAS transaction protects the expected-old base ref and approved Goal ref at the write boundary. A process-local mutex or `merge --ff-only` alone is insufficient. SQLite and Git cannot form one atomic transaction; durable planned-operation recovery is required.

## Schema decision and boundary

Add only a nullable `goal_approvals.intent_digest` authority-metadata column, an immutable insert/update guard, and a partial unique index for live prospective approvals. The JSON detail remains the single approval record and contains the strict versioned intent. The typed column/index makes duplicate prevention durable across concurrent processes without a second approval table. Historical approvals retain `NULL`; no approved definition is changed. No schema change authorizes or performs a Git write.

No final-apply execution endpoint, request endpoint, `apply_to_base` writer, external-attestation mutation, UI control, phone control, provider call, or production executor change belongs to 7C.2A. Production remains on `DisabledGoalExecutor`; Stage 7C.2B must independently review this contract before implementation.

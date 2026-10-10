# Goal external integration attestation authority contract

## Stage 7C.2B.5B implementation candidate

This is an internal backend authority contract. It adds no user action. The external-integration endpoint, desktop/mobile control, version-2 completion evaluation and Goal completion transition remain unimplemented. The Stage 7C.2B.5B checkpoint is pending independent review; it is not release qualification.

The three records remain separate:

1. A **manual handoff** is Turing's immutable prepared result and acceptance evidence.
2. A **Git observation** is a bounded, read-only observation of exact refs, commits, trees and ancestry in the server-registered repository.
3. An **external integration attestation** is immutable evidence that a separate, exact user-decided approval confirmed one Git observation.

None of these records by itself completes a Goal. The attestation says only that the accepted source commit and recorded base commit were observed as ancestors of the exact recorded destination commit at `observedAt`. It does not prove accepted files survived, that conflict resolution was correct, that the working tree/index matches the ref, or that the ref remains there.

## Internal service boundary

`src/server/goals/externalIntegration.ts` provides:

- `buildExternalIntegrationObservation()` — read-only authority and Git observation. It does not create approvals, attestations or Git state.
- `validateExternalIntegrationObservation()` — rebuilds the observation and compares its canonical action digest.
- `createExternalIntegrationApprovalDetail()` — constructs the separate version-2 `confirm_external_integration` approval detail.
- `persistExternalIntegrationAttestation()` — requires a matching approved user decision, revalidates the observation, then inserts or reuses an immutable record in a short SQLite `BEGIN IMMEDIATE` transaction.
- `validateExternalIntegrationAttestation()` and `getExternalIntegrationProjection()` — validate historical record integrity and compare it with a fresh read-only observation.

The caller must create and decide the approval through the established approval service. The attestation persistence function never requests or approves one. No route, supervisor, provider, model, scheduler or UI invokes these functions in production.

The verifier derives its repository from the Goal's registered project. It verifies canonical root and Git common directory, project/scope and repository identity, SHA-1/SHA-256 format, exact Goal source ref, exact handoff destination ref, full object-ID widths, source/base trees, and both ancestry relations. It uses fixed `execFile` argument arrays, a 10-second timeout, a 4 MiB output bound, `GIT_OPTIONAL_LOCKS=0`, disabled system Git config and replacement objects, and removes inherited `GIT_*` environment overrides. It does not run a diff, hook, merge driver, shell command, or user-provided command.

The repository identity is the existing logical registration identity: project ID, canonical root, Git common-directory path, and project scope. This rejects a project rebind, changed path/common-dir, or a replacement with different refs/objects. Git has no portable permanent repository UUID, and older immutable handoffs do not carry a physical filesystem-instance marker. A byte-for-byte same-history replacement at the same canonical paths is therefore indistinguishable from the registered instance; the attestation binds the exact current logical registration and Git identities, not an inode-level repository identity. Windows filesystem identity behavior is also unverified.

The source ref must still name the exact accepted commit. The destination is never client-selected. Verification samples source/destination refs, resolves exact commit/tree identities, checks ancestry, then samples refs, repository identity and Goal/handoff authority again. A detected change refuses the observation. These reads are not atomic with an external Git process; a change after the last sample remains possible and is represented only as a point-in-time historical observation.

## Approval and digest identity

The new approval uses `gate: final_apply`, `risk: high`, `requestedBy: user`, schema version 2, action `confirm_external_integration`, and a separate typed `external_integration_action_digest`. It cannot carry `intent_digest`. Migration 026 makes both typed digest fields immutable and keeps the old prospective-apply index and guard unchanged. A legacy `applied_externally` row or `apply_to_base_intent` approval cannot authorize this record.

Action identity uses domain-separated SHA-256 over canonical serialization. It binds Goal, handoff ID/digest, contract version, definition and approval, final review/acceptance/evidence identities, repository/project/scope/object format, exact source and recorded destination refs/commits/trees, observed destination commit/tree, proof mode/version and the explicit decision discriminator. It excludes volatile attestation/approval row IDs and timestamps so the same evidence has one action identity.

The record digest uses a separate domain and covers the full versioned record identity, including attestation ID, approval ID, action digest, decision actor/value, observation time and decision time. Reads recompute both digests, compare canonical JSON with the typed SQLite columns, and verify same-Goal authority references. A digest mismatch is invalid, not repairable metadata.

## Migration 026

`migrations/026_goal_external_integration_attestations.sql` adds the distinct approval digest and `goal_external_integration_attestations`. The table has exact handoff, approval, definition, review, acceptance and Goal references; typed source/destination/repository/proof identities; SHA-1/SHA-256 width checks; payload-to-column checks; a unique `(goal_id, action_digest)` identity; insert-time authority checks; and immutable/no-delete triggers. The trigger verifies that the approved action detail agrees with the complete stored observation identity. SQLite does not perform Git ancestry; the service proves ancestry before persistence.

Migration 026 does not rewrite migrations 023–025, old approvals, handoffs, operations, recovery proofs or completion records. It does not create authority from historical records. A 025-to-026 upgrade and historical v1 operation/handoff preservation are covered by schema tests.

## Persistence, idempotency and recovery

Git verification occurs before the SQLite write transaction. Inside the short immediate transaction, the service rechecks the handoff's canonical payload, digest and typed identity, the Goal authority fingerprint, and the exact approved user decision. It inserts the typed immutable record. Identical action retries return the persisted record; a new observed destination commit has a different action digest and needs a separate user decision. The unique index serializes identical concurrent inserts. No retry replays Git or fabricates a decision.

Before commit, recovery observes no attestation; a user would need a fresh observation and explicit decision. If the database commit succeeds but a future caller loses the response, lookup by the persisted record/history and an identical retry recover the same immutable ID. Currentness changes never rewrite a record. `current` means a fresh observation has the same action identity; `historical` means the destination has since advanced while the recorded authority remains the same; `not_integrated`, `stale`, `unavailable` and `invalid` remain distinct refusal states. The projection always says `contentPreservation: not_proven` and `goalCompletion: not_completed_by_attestation`.

## Completion and future activation blockers

`evaluateCompletion()`, `checkCompletionProof()`, `completeGoal()`, the definition schema/hash, and completion outcome are unchanged. `finalApply.ok` remains false for this flow and the existing Goal remains at `final_apply_required`. The new table is not a completion proof.

Future 7C.2B.5D must explicitly design and hash-cover a backward-compatible version-2 completion contract, bind the exact attestation and destination observation, and re-observe ancestry close to the Goal transition. Missing definition version remains legacy v1, historical definition bytes/hashes are not rewritten, and unsupported policy versions must fail closed. Completion activation also remains blocked on a separately reviewed append-only correction/withdrawal policy; immutable original evidence cannot silently reverse a terminal Goal.

The current local authentication model does not prove that a human clicked or distinguish desktop from paired mobile/local API callers. A future user-facing route must use the existing authorization boundary and describe that limitation accurately; this stage adds no route or claim of desktop-only authority.

## Evidence and limitations

Deterministic tests use disposable registered repositories. They cover real fast-forward and `git merge -s ours --no-ff` histories, SHA-1/SHA-256, ancestry refusal, repeated-read ref movement, source/repository identity changes, immutable persistence, idempotent/concurrent retry, stale history and tamper refusal. The `ours` case proves both ancestry checks can pass while the accepted file is absent; the proof is therefore named `source_history_observed` and content preservation is explicitly not proven.

Linux behavior is exercised on the available Linux/Git host. Windows and Git for Windows path/ref/common-directory behavior remain unverified. No user repository, live provider/model, subscription allowance, Git writer, public endpoint, UI action or Goal completion transition is used by this implementation.

## Stage 7C.2B.5B.1 — timestamp and projection remediation candidate

`observedAt` is server-owned evidence. `validateExternalIntegrationObservation()` now returns the freshly rebuilt server observation after the caller's Goal, handoff, Git identities, ancestry and authority have been matched. It does not return the caller's parsed timestamp. The action digest intentionally remains timestamp-independent so identical Git evidence retains one approval identity; the immutable record digest covers the actual authoritative observation timestamp.

Persistence stores the timestamp from that fresh validation. A retry performs fresh Git verification, then returns the existing immutable record for the same action digest without rewriting its original `observedAt` or record digest. If the destination identity changes, the action digest changes and the prior approval cannot authorize the new observation.

A parsed record alone is insufficient for a positive projection. Only a validated record with valid linked user approval and state `current` or `historical` carries `source_history_observed_at_recorded_time`. `invalid`, `stale`, `unavailable`, and `not_integrated` project `claim: not_verified`; invalid approval does not erase the parseable row or valid historical evidence from the database. No schema, migration, Git-write, approval-authority, or completion-policy change is made by this remediation.

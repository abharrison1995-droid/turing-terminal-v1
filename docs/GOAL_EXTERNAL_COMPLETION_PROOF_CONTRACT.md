# Goal external-completion proof contract

## Status

Stage 7C.2B.5D.1 adds versioned policy and immutable proof infrastructure. It does **not** activate version-2 Goal completion. No production service can create the version-2 completion approval or proof, no endpoint or desktop action exists, and no Goal can become completed through this contract. The document describes the implemented boundary plus the records reserved for a later stage.

## Definition policy

The discriminator lives in the existing `contract.completionPolicy` object:

```ts
completionContractVersion?: 2;
integrationMode?: 'external_user_attested';
```

Both fields must be absent for legacy v1 or present with those exact v2 values. V2 additionally requires `applyToBase: 'required'`, final review and user acceptance. Partial, explicit-v1, unsupported, malformed, or weakened policies fail validation. Loading a v1 definition does not add defaults. A golden v1 fixture retains its existing canonical hash.

V2 takes effect only when a user approves the exact definition version and hash through the existing definition/amendment workflow. The read-only lineage validator checks every approved ancestor, matching approval, definition hash, and parent link. Once any version opts into v2, descendants cannot downgrade to legacy v1. The full root-to-current authority chain has a domain-separated digest.

## Legacy authority isolation

For v1, completion keeps the existing behavior. For v2, the evaluator reports `finalApply.ok: false` with `external_completion_not_activated`; it does not accept a legacy `applied_externally` approval or a historical Turing apply operation. A migration-026 attestation whose payload says `completionContractVersion: 2` is not a definition opt-in and cannot be reused after a v2 definition is approved. New definition-bound review, acceptance, handoff, and attestation evidence would be required by a future activation stage.

`completeGoal()` cannot complete a v2 Goal. `checkCompletionProof()` refuses an earlier proof against a current v2 policy. A supervisor tick with all ordinary evidence and legacy external-apply authority remains `completion_pending`. No v2 completion event, proof row, or terminal transition is created.

## Future action identity

The reserved action discriminator is `complete_goal_external_integration_v2`, with `schemaVersion: 1`, `completionContractVersion: 2`, and `integrationMode: 'external_user_attested'`. Its strict schema binds:

- Goal and approved definition version/hash/approval/lineage digest;
- exact handoff and attestation IDs/digests/approval IDs;
- final review, final acceptance, verification-evidence, milestone, and finding identities;
- repository project/identity/scope/object format;
- source ref/commit/tree and recorded plus observed destination ref/commit/tree;
- ancestry-only Git proof identity and explicit `contentPreservation: 'not_proven'` limitation;
- exact user-reviewed preflight digest and same-attestation correction-chain identity.

Its SHA-256 digest is computed over canonical JSON under `turing-goal-external-completion-action-v2`, followed by a NUL separator. This identity is distinct from the existing prospective apply intent, `applied_externally`, and `confirm_external_integration` action. No current approval request service can issue it.

## Future proof identity

The reserved immutable record has `kind: 'turing_goal_external_completion_proof'`, `schemaVersion: 1`, and `contractVersion: 2`. Its proof body binds the action decision, evaluation identities, all Git/repository identities, observation timestamp, proof limitations, and correction-chain identity. `proofDigest` covers the complete canonical body, including both observation and decision timestamps, under `turing-goal-external-completion-proof-v2` plus a NUL separator. Action and proof digests are separate identities.

The correction-chain member records a sequence, digest, and `active_uncontested` standing at the eventual proof point. D.1 does not implement a correction ledger or prove this standing. The member is not an irrevocable assertion that no later correction can exist. A future correction stage must validate the chain and current standing; until then no proof can be issued.

## Migration 027

`migrations/027_goal_external_completion_proofs.sql` adds a distinct nullable `external_completion_action_digest` to the existing approval ledger and an immutable `goal_external_completion_proofs` table. It does not rewrite migrations 018–026 or historical records. Existing rows keep a null new digest. There is no migration backfill and no proof is created during upgrade.

The schema adds same-Goal foreign keys, definition/handoff/attestation/review/approval identity columns, payload-to-column checks, SHA-1/SHA-256 object-ID width checks, authority-bound insert guards, a unique action digest per Goal, and at most one terminal proof per Goal. Updates and deletes are rejected. Server parsing remains authoritative and rechecks the canonical proof digest and linked records; SQL checks are complementary.

Controlled migration tests exercise a synthetic row only with the proof-authority trigger and foreign keys deliberately disabled, to isolate JSON binding, hash-width, uniqueness, and immutability constraints. Separate tests verify that an ordinary unauthorized insert is rejected by the live authority trigger. This is test scaffolding, not an application insert path.

## Current completion and recovery boundary

The policy projection can report `external_user_attested_v2`, but always reports `v2CompletionActivated: false` and blockers for inactive completion and missing correction authority. `readExternalCompletionProof()` is read-only: it returns not-found, valid, or invalid; it never repairs or inserts data. No production row can currently be validly created through Turing.

The selected future completion stage must freshly verify repository/ref ancestry, correction standing and current Goal authority, then commit the completion approval, immutable proof, event, and terminal transition atomically in SQLite. Recovery must inspect persisted authority and remain observation-only; it must never infer completion from a proof row without the matching committed terminal event/state. External Git observation and SQLite cannot form one transaction, so the proof will remain point-in-time evidence and cannot prove content preservation or prevent later ref movement.

## Not implemented in D.1

- Live v2 completion decision or approval creation.
- Proof issuance or a qualifying proof insert service.
- Correction/withdrawal ledger or verified correction standing.
- Fresh completion-time Git verification orchestration.
- Atomic proof/event/terminal transition.
- Completion API, desktop completion control, or automatic supervisor completion.
- Windows production qualification.

The rejected checked-out-worktree writer remains quarantined, production uses `DisabledGoalExecutor`, and V1 is not release-ready. Stage 7C.2B.5D.2 and later stages remain separate implementation and review gates.

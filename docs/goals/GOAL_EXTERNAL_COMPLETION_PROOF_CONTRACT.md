# Goal external-completion proof contract

## Status

**Current status (2026-10-25):** Version-2 external completion is active on master after PR #15. New completion preflight performs a read-only content observation and requires a verified `content-verified-v1` evidence digest; the atomic completion transaction persists that evidence with the proof and terminal transition. Migration 033 adds the binding without rewriting migration-027 proof rows. Existing ancestry-only records remain `not_proven`, immutable and historical. The proof's `contentPreservation: not_proven` field describes the legacy ancestry subproof; the separately surfaced completion standing reports verified content only when its evidence digest validates. The stage notes below preserve their original chronology and are superseded where they describe pre-activation behavior. See [V1_READINESS.md](../V1_READINESS.md) for release qualification.

Stage 7C.2B.5D.1 adds versioned policy and immutable proof infrastructure. Stage 7C.2B.5D.1a adds fail-closed validation of approved definition content and approval lineage before completion evaluation and terminal proof acceptance. Neither stage activates version-2 Goal completion. No production service can create the version-2 completion approval or proof, no endpoint or desktop action exists, and no Goal can become completed through this contract. The document describes the implemented boundary plus the records reserved for a later stage.

The D.3.0B reconciliation (CCv2r1) records the version-2 completion decisions D1-D5 in the section below. It is a documentation change only: version-2 completion remains inactive and this document makes no activation or release claim. The identifiers named as reserved in this section are specified here and are not yet implemented. Stage 7C.2B.5D.3E adds the internal version-2 completion service described in the D.3E section below; the statements in this Status section describe the state before D.3E.

## Definition policy

The discriminator lives in the existing `contract.completionPolicy` object:

```ts
completionContractVersion?: 2;
integrationMode?: 'external_user_attested';
```

Both fields must be absent for legacy v1 or present with those exact v2 values. V2 additionally requires `applyToBase: 'required'`, final review and user acceptance. Partial, explicit-v1, unsupported, malformed, or weakened policies fail validation. Loading a v1 definition does not add defaults. A golden v1 fixture retains its existing canonical hash.

V2 takes effect only when a user approves the exact definition version and hash through the existing definition/amendment workflow. The read-only lineage validator checks every approved ancestor, matching approval, definition hash, and parent link. Once any version opts into v2, descendants cannot downgrade to legacy v1. The full root-to-current authority chain has a domain-separated digest.

## Legacy authority isolation

For a valid, hash- and approval-bound v1 definition, completion keeps the existing behavior, including legacy `applied_externally` and verified historical Turing apply semantics. Before evaluating completion, the application recomputes the approved definition hash and verifies the user approval and full approved ancestor chain. Corrupt, malformed, unsupported, or unapproved definition authority fails closed, even if the changed JSON parses as legacy v1. This prevents a v2 policy whose discriminator was removed from selecting legacy final-apply authority without changing legitimate v1 semantics.

For v2, the evaluator reports `finalApply.ok: false` with `external_completion_not_activated`; it does not accept a legacy `applied_externally` approval or a historical Turing apply operation. A migration-026 attestation whose payload says `completionContractVersion: 2` is not a definition opt-in and cannot be reused after a v2 definition is approved. New definition-bound review, acceptance, handoff, and attestation evidence would be required by a future activation stage.

`completeGoal()` cannot complete a v2 Goal. `checkCompletionProof()` refuses an earlier proof against a current v2 policy. A supervisor tick with all ordinary evidence and legacy external-apply authority remains `completion_pending`. No v2 completion event, proof row, or terminal transition is created.

## Approved-definition integrity revalidation (Stage 7C.2B.5D.1a)

Independent review found that `evaluateCompletion()` previously selected the legacy path from the parsed current policy without first checking that the stored JSON still matched the approved hash. Removing both v2 discriminator fields from otherwise intact v2 policy JSON made it parse as legacy v1; with matching legacy-shaped final-apply approval, the evaluator returned `ok: true`.

The evaluator now validates the full current definition approval lineage before using any completion policy, then independently verifies the loaded definition hash and mode. The lineage check binds each definition version to its user approval, hash, and parent; it also rejects a v2 ancestor followed by a legacy-looking descendant. Malformed JSON is converted to a bounded refusal rather than escaping as an exception. `checkCompletionProof()` repeats the lineage, hash, and policy checks immediately before accepting a terminal transition. A successful older in-memory proof therefore cannot bypass definition or approval corruption that occurs after evaluation.

The regression fixture drops the immutability trigger only in its disposable test database, removes both v2 discriminator fields, and leaves the approved hash, version, approval, and integration head unchanged. It proves the modified JSON parses as legacy and hashes differently from the stored approved digest. The corrected path rejects evaluation, proof validation, `completeGoal()`, direct `transitionGoal(..., 'completed')`, and supervisor-driven completion. Additional tests cover a single missing discriminator, unsupported version, a corrupted v2 ancestor, legacy v1 content/hash mismatch, approval/hash mismatch, malformed JSON, and stale proof after successful legacy evaluation. Existing valid legacy completion remains covered.

Historical Stage 7C.2B.5D.1a remediation did not change migration 027 or activate completion. Later work added migration 033 and activated the content-verified completion path; the earlier stage statement is not current status.

## Future action identity

The reserved action discriminator is `complete_goal_external_integration_v2`, with `schemaVersion: 1`, `completionContractVersion: 2`, and `integrationMode: 'external_user_attested'`. Its strict schema binds:

- Goal and approved definition version/hash/approval/lineage digest;
- exact handoff and attestation IDs/digests/approval IDs;
- final review, final acceptance, verification-evidence, milestone, and finding identities;
- repository project/identity/scope/object format;
- source ref/commit/tree and recorded plus observed destination ref/commit/tree;
- ancestry-only Git proof identity and explicit `contentPreservation: 'not_proven'` limitation;
- exact user-reviewed preflight digest and same-attestation correction-chain identity.

The preflight digest is domain-separated under `turing-goal-external-completion-preflight-v1` (reserved; the D.1 schema carries the field but does not yet name this domain). The correction-chain identity for an attestation with no correction (the empty chain) is the SHA-256 of `turing-goal-attestation-correction-chain-v1`, a NUL separator, and the canonical JSON `{schemaVersion:1, kind, attestationId, attestationRecordDigest, sequence:0, tipCorrectionDigest:null}`. No placeholder correction row is fabricated for the empty chain (decision D3 below). This domain is reserved and not yet implemented.

Its SHA-256 digest is computed over canonical JSON under `turing-goal-external-completion-action-v2`, followed by a NUL separator. This identity is distinct from the existing prospective apply intent, `applied_externally`, and `confirm_external_integration` action. No current approval request service can issue it.

## Future proof identity

The reserved immutable record has `kind: 'turing_goal_external_completion_proof'`, `schemaVersion: 1`, and `contractVersion: 2`. Its proof body binds the action decision, evaluation identities, all Git/repository identities, observation timestamp, proof limitations, and correction-chain identity. `proofDigest` covers the complete canonical body, including both observation and decision timestamps, under `turing-goal-external-completion-proof-v2` plus a NUL separator. Action and proof digests are separate identities.

Destination policy `exact_attested_tip` (decision D1 below): the proof's observed destination commit and tree must equal the selected attestation's observed commit and tree. Migration 027 enforces this with its attestation-linkage trigger. Ancestry alone is not accepted for version 2. The action digest excludes `observedAt`, but the proof digest covers the complete canonical body, including `gitProof.observedAt` and the decision timestamp. `contentPreservation` remains `not_proven`.

The correction-chain member records a sequence, digest, and `active_uncontested` standing at the eventual proof point. D.1 did not implement a correction ledger. Stage 7C.2B.5D.2 implements the append-only per-attestation ledger and a read-only standing read (see [GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md](GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md)). No proof row binds that standing yet: proof issuance remains absent until D.3 validates the chain inside the completion transaction. The member is not an irrevocable assertion that no later correction can exist.

## Migration 027

`migrations/027_goal_external_completion_proofs.sql` adds a distinct nullable `external_completion_action_digest` to the existing approval ledger and an immutable `goal_external_completion_proofs` table. It does not rewrite migrations 018–026 or historical records. Existing rows keep a null new digest. There is no migration backfill and no proof is created during upgrade.

The schema adds same-Goal foreign keys, definition/handoff/attestation/review/approval identity columns, payload-to-column checks, SHA-1/SHA-256 object-ID width checks, authority-bound insert guards, a unique action digest per Goal, and at most one terminal proof per Goal. Updates and deletes are rejected. Server parsing remains authoritative and rechecks the canonical proof digest and linked records; SQL checks are complementary.

Controlled migration tests exercise a synthetic row only with the proof-authority trigger and foreign keys deliberately disabled, to isolate JSON binding, hash-width, uniqueness, and immutability constraints. Separate tests verify that an ordinary unauthorized insert is rejected by the live authority trigger. This is test scaffolding, not an application insert path.

## Current completion and recovery boundary

The policy projection reports version-2 completion capability from production composition. `readExternalCompletionProof()` remains read-only: it returns not-found, valid, or invalid; it never repairs or inserts data. The completion decision path performs fresh content observation, binds its digest to the user decision, and persists evidence, proof, event and terminal state atomically.

The completion path freshly verifies repository/ref ancestry, content preservation, correction standing and current Goal authority, then commits the user decision, immutable content evidence and proof, event, and terminal transition atomically in SQLite. Recovery inspects persisted authority and never infers completion from a proof row without the matching committed terminal event/state. External Git observation and SQLite cannot form one transaction, so evidence remains point-in-time and does not prevent later ref movement.

## CCv2r1 decisions D1-D5 (D.3.0B)

These decisions reconcile the version-2 completion contract (CCv2r1) before D.3 implementation. Each is a design decision; none activates completion.

- **D1 exact attested tip.** Version-2 completion requires the destination to equal the attested tip exactly. A destination that has advanced past the attested observation is refused, not accepted by ancestry. The trade-off is explicit: destination advancement is not permitted for V1 completion, although the original design allowed it. A later change is handled by a new read-only verification and a new user `confirm_external_integration` attestation at the new tip. No attestation or completion action is rewritten.
- **D2 version-aware handoff.** Handoff preparation selects the completion path from the validated approved policy mode (`approvedCompletionPolicyMode`). This is already implemented at `manualHandoff.ts:626`. The legacy v1 branch is unchanged.
- **D3 empty correction chain.** An attestation with no correction uses the empty-chain identity defined above. No fabricated row is written.
- **D4 user completion authority.** Completion uses a dedicated, proof-bound user reason (reserved name `external_completion_user_confirmed`). It is a narrowly guarded, user-initiated version-2 `running → completed` transition with its own authority. It is not a generic `user` actor edge. No supervisor or model path can complete a version-2 Goal. Version-2 completion never derives from `applied_externally` or apply-operation evidence. Legacy v1 behaviour is unchanged.
- **D5 read-only preflight.** A Goal-scoped completion preflight is read-only. It creates no approval, proof, or terminal authority.

## Not implemented in D.1 / D.1a

- Read-only completion preflight (D5) and the user completion transition (D4); both are reserved by the decisions above.

- Live v2 completion decision or approval creation.
- Proof issuance or a qualifying proof insert service.
- Completion-time binding of correction standing into a v2 proof. The append-only ledger and read-only standing are implemented in D.2; the proof-time binding is D.3.
- Fresh completion-time Git verification orchestration.
- Atomic proof/event/terminal transition.
- Completion API, desktop completion control, or automatic supervisor completion.
- Windows production qualification.

The rejected checked-out-worktree writer remains quarantined, production uses the enabled deterministic Goal composition, and V1 release qualification remains open. The statement above describes the earlier stage checkpoint.

## D.3D user completion decision

A decision creates one approved `user_confirmation` approval with a completion action digest. It is not a proof. `goal_external_completion_proofs` stays empty, and a static test confirms that no production code inserts a proof.

`readExternalCompletionDecision` returns `valid` only when the stored detail parses, its digest matches the column, and the row is approved by the user with the required gate, risk and requester. External-integration approvals, correction approvals and legacy `applied_externally` final-apply approvals are never completion decisions.

## D.3E version-2 completion

Stage 7C.2B.5D.3E adds `completeGoalFromExternalDecision` in `src/server/goals/externalCompletion.ts`. It is an internal service with no route and no UI. For a Goal whose `completionContractVersion` is 2, it is the only completion route. Its ordering and its limitations are in [GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md](../history/goals/GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md).

- **`external_completion_not_activated`.** The legacy evaluator still reports this code for every version-2 Goal, and the legacy transition path refuses version-2 completion with the same code. It means that the Goal cannot be completed through the legacy path. It does not mean that version-2 completion is unavailable through the service.
- **Legacy v1 is unchanged.** The evaluator and the legacy completion path have no D.3E change. `transitionGoal` now notifies observers through `notifyGoalTransition` with the same behaviour.
- **No v2 downgrade.** A Goal whose approved policy is version 2 cannot complete through the legacy v1 path. Its completion rests on the decided version-2 action and the immutable proof, not on legacy `applied_externally` or apply-operation evidence.
- **Legacy ancestry limitation.** Migration-027 version-2 proofs record `contentPreservation: 'not_proven'` and remain unchanged. New completions also bind a separate content-verification digest; a `git merge -s ours` cannot satisfy that verifier when accepted files are absent.
- **Authenticated `user`.** `user` means authenticated application control (loopback or Tailscale login plus paired device), not a verified person. The completed Goal records the user decision and the content-verification evidence identity.
- **Release qualification.** HTTP routes and desktop UI are implemented. Windows, live-provider and full release qualification remain open as recorded in [V1_READINESS.md](../V1_READINESS.md).

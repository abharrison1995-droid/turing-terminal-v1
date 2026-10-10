# Goal external-integration attestation correction and withdrawal design

Status: Stage 7C.2B.5D.2 correction authority is implemented in the service layer (migration 028, append-only ledger, read-only history route). It is not yet a completion input: the completion-standing projection is Stage D.3, and the correction write route and desktop UI are Stage D.4. See "Stage 7C.2B.5D.2 implementation status" at the end of this document.

**Implementation status (Stage 7C.2B.5D.2, reviewed candidate).** Stage 7C.2B.5D.2 implements append-only per-attestation correction authority (migration 028, service, read-only history route, correction events) as a reviewed candidate. It does not implement a correction write route, desktop correction UI, completion-standing projection, or any completion consumer; those are D.3/D.4 work. The sections below describe the contract; the implementation section at the end lists what exists and what is deferred.

## 1. Purpose and governing rules

Migration-026 external-integration attestations are immutable evidence that an authenticated app user confirmed one exact observation. The observation proves only that the accepted Goal source commit and the handoff's recorded base commit were ancestors of a specific destination commit at a recorded time. It does not prove that accepted content survived or that the branch remains unchanged.

A user who discovers an error needs a way to correct their claim without rewriting history. Use an append-only, per-attestation correction ledger and derive current standing from the immutable attestation plus its correction chain. Never update/delete the original attestation, approval, completion proof, event, or terminal Goal row.

The projection distinguishes **integrity** (whether an immutable record validates) from **eligibility** (whether it may support a new completion) and **historical standing** (what later user decisions say about it). Avoid a single `valid` boolean.

## 2. Correction action contract

Use a new action discriminator, such as `correct_external_integration_attestation_v1`. It has its own canonical action-digest domain and binds:

- Goal ID, exact handoff ID/digest, and exact original attestation ID/action digest/record digest/approval ID;
- current correction-chain sequence and previous correction digest, or explicit “no correction yet”;
- correction kind (`dispute`, `withdraw`, or `supersede`);
- a bounded enumerated reason code and optional bounded plain-text explanation;
- for `supersede`, one exact replacement attestation ID and record/action digest;
- repository/source/destination identity from the subject and replacement where relevant;
- authenticated user decision and server time.

A user confirmation is an explicit high-risk command. Extend the existing `goal_approvals` authority rather than creating another approval system: use the generic `user_confirmation` gate with `risk: high`, `requested_by: user`, a strict action detail schema, and a distinct typed `attestation_correction_action_digest` column plus immutable trigger/unique index. Do not put a correction under `final_apply` or reuse `applied_externally`, `confirm_external_integration`, or `apply_to_base_intent`.

The existing app boundary records an authenticated user-control decision; it does not prove a specific physical human or distinguish desktop from paired mobile/local callers. Correction UI can be desktop-only, but the server must rely on existing authentication and same-Goal checks, not a claimed desktop header.

## 3. Append-only schema and correction ordering

A future additive migration may create `goal_external_integration_attestation_corrections` with typed columns for:

- immutable correction ID, Goal ID, handoff ID, subject attestation ID;
- `schema_version`, `kind`, monotonically increasing per-attestation sequence;
- previous correction digest (nullable only at sequence 1);
- action digest, correction digest, approval ID, reason code, bounded explanation, created/decided timestamps;
- optional exact replacement attestation ID/digest;
- canonical bounded `payload_json`.

Use composite same-Goal FKs to the handoff, original attestation, correction approval, and optional replacement attestation. Unique keys should include `(goal_id, id)`, `(goal_id, attestation_id, sequence)`, and `(goal_id, attestation_id, action_digest)`. Validate payload-to-column identity, exact approval detail, and correction sequence/previous digest on insert. Reject UPDATE and DELETE. Do not create a mutable “current status” column as authority; current standing is a projection of the append-only chain.

Appending requires compare-and-swap against the exact prior correction digest supplied in `If-Match`. The service re-reads the chain and approval inside a short immediate SQLite transaction. Concurrent corrections from the same previous digest cannot both win; the unique sequence/previous-digest guard lets one commit, and the other receives a stale/conflict result. An identical action digest returns the original immutable correction. A different action against the old chain must be freshly reviewed and cannot silently supersede the winner.

This is not “latest record wins”: each next correction explicitly names the previous digest and an allowed transition. Sequence is meaningful only after validating the whole chain from the original attestation.

## 4. Correction state machine

The derived per-attestation states are:

| State                     | Meaning                                                                                                                                     | May support a new completion?                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `active_uncontested`      | Attestation integrity and approval pass; no correction exists.                                                                              | Yes, only with fresh completion-time Git verification and all other v2 prerequisites. |
| `disputed`                | User has explicitly questioned the claim. The original remains intact, but it is not acceptable as completion authority.                    | No.                                                                                   |
| `withdrawn`               | User explicitly withdrew the original integration claim. Terminal correction state.                                                         | No.                                                                                   |
| `superseded`              | User explicitly identified one exact replacement attestation. The old claim remains historical; the replacement is evaluated independently. | No for the old record; replacement only if independently valid and uncorrected.       |
| `historical_not_current`  | No correction exists, but fresh authority/repository/currentness checks no longer support using it now.                                     | Not without a fresh verifier result; this is not a correction.                        |
| `invalid` / `unavailable` | Stored authority fails integrity checks or current validation cannot complete.                                                              | No.                                                                                   |

Allowed correction transitions:

- `active_uncontested -> disputed`, `withdrawn`, or `superseded`.
- `disputed -> withdrawn` or `superseded` after a fresh user review.
- `withdrawn` and `superseded` are terminal for that attestation.

A dispute is deliberately fail-closed; V1 has no “clear dispute” operation that erases the concern. The user may obtain a distinct new attestation after re-reviewing a genuinely new observation, definition/handoff, or repository state, and may explicitly supersede the disputed record with that exact new attestation. If idempotency returns the same old record, it cannot be used to clear the dispute. This avoids a generic “reaffirm” action that could revive a withdrawn claim without new evidence.

`corrected` is a presentation summary, not a database authority state. It means a correction exists; the precise projection is `disputed`, `withdrawn`, or `superseded`. The original record remains inspectable. Integrity may still be `valid` while eligibility is false.

## 5. Multiple attestations and supersession

Allow multiple attestations for one Goal when they bind distinct exact observations. Do not select the newest row automatically. A completion preflight must select one exact attestation and show its handoff, action/record digest, repository, source, destination and correction standing.

A correction targets one exact attestation. Withdrawing attestation A does not invalidate independent attestation B. A `supersede` correction against A must name a persisted, valid same-Goal replacement B and bind B's exact record digest. Require compatible policy version and same accepted source/Goal lineage before presenting B as its replacement; a different definition or repository is not silently treated as equivalent. A's historical completion proof, if any, remains bound to A and is not rewritten to point at B.

If two corrections are concurrently requested, the first exact previous-digest CAS wins. A later request must refresh the chain and ask the user to confirm a new exact action; no implicit conflict resolution. A correction cannot target another Goal even when UUIDs or Git object IDs happen to match.

## 6. Before and after Goal completion

### Before completion

The completion POST performs a fresh Git observation first, then begins its immediate SQLite transaction and rechecks the full correction chain and selected-attestation identity. If a dispute/withdrawal/supersession committed before the transaction, the selected attestation fails and no approval, proof, event, or status change commits. If the correction races after the transaction acquires SQLite's writer lock, it waits; completion can commit only with the correction-chain digest it checked. The correction then becomes a post-completion event and affects standing. Git remains outside the SQLite atomic boundary.

An uncertain correction POST is reconciled by exact action digest through read-only status/history. Never replay a correction with changed content or automatically decide a pending approval. A malformed, truncated, cross-Goal, or unavailable history response remains unresolved and disables another correction action until the exact record is fetched.

### After completion

Preserve `goals.status = 'completed'`, `completed_at`, the immutable completion proof, and all old events. Append the correction and a Goal event that references correction ID/digest, subject attestation ID, and kind. Do not reopen or rewrite the Goal. Do not automatically create work or invoke an executor.

The completion projection must change immediately after a valid correction:

- `goalStatus: completed` remains the historical terminal status;
- `completionStanding` becomes `disputed`, `withdrawn`, `superseded`, or `reconciliation_required`;
- the banner must say the Goal was completed at a past time based on the named attestation and that the user later disputed/withdrew/superseded that claim;
- the old completion proof remains visible and immutable;
- an exact replacement attestation does not rewrite old proof or silently restore its standing;
- any needed work requires a separately created and approved repair/reconciliation Goal.

Do not display a green, unqualified “Completed successfully” indicator when the proof's selected attestation is disputed, withdrawn, superseded, malformed, or otherwise untrusted. A later Git ref move alone does not falsify the historical point-in-time observation; it is not a correction. The projection can separately show current ancestry verification when requested, but no background watcher is implied.

## 7. API and user experience proposal

Potential future routes:

- `GET /api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections` — bounded append-only correction history and derived standing; no write or Git scan.
- `POST` on that path — explicit user-confirmed correction with strict body, typed action digest `If-Match`, no client-chosen Goal/handoff/repository/ref/approval IDs, and exact current-chain precondition.
- The completion preflight must list bounded attestation choices and their correction standing; it does not auto-select “latest.”

The desktop correction dialog identifies the original statement and exact observation, explains that withdrawal/dispute stays in permanent history, shows any replacement attestation by exact ID/digest, and states that the Goal will remain historically completed if already terminal. Cancellation sends no POST. The user supplies a finite reason and optional bounded explanation. After POST, GET the exact correction record and refresh the Goal standing; never show success before persistence confirmation.

Mobile remains read-only in V1. It may display correction status and historical completion, but offers no correction or completion button. API security follows current user authentication; mobile presentation is not a security boundary.

## 8. Cross-component effects

`goal_events` is append-only and should gain a small typed event such as `external_integration_corrected`, carrying IDs, kind and digest only. No raw explanation, Git output or unbounded text should be copied into the event payload. The correction row holds bounded explanation under a strict schema.

`completionStanding` belongs in the Goal read model and completion API. Keep `completed_at` as the original terminal time; expose correction times separately. History shows both the original completion proof and correction chain.

The current Goal system has no general cross-Goal dependency engine. Any future workflow that consumes a completed Goal must check `completionStanding` in addition to `status`. No downstream supervisor or automated executor may treat a corrected completed status as clean authority. Production stays `DisabledGoalExecutor` unless a separate stage authorizes and qualifies execution.

Notifications should report a correction as an update to a historical completion claim, not a second state transition to “incomplete.” Audit exports should include the proof ID/digest, attestation ID/digest, correction chain, action approvals, timestamps and explicit limits. Existing manual handoff and attestation history remains immutable. Readiness docs should distinguish accepted authority implementation from disabled completion activation.

## 9. Test matrix and residual limits

Future deterministic tests must cover: no correction; dispute/withdraw/supersede; exact same-digest retry; wrong previous digest; competing concurrent corrections; invalid sequence/hash/approval; cross-Goal, cross-handoff and copied approvals; replacement attestation absent/invalid/corrected; independent B remains eligible when A is withdrawn; correction racing completion before and after SQLite lock acquisition; crash before/after commit; lost HTTP response; Goal remains terminal after post-completion correction; `completed_at` and original proof unchanged; read model loses unqualified success; downstream projection refuses untrusted standing; SHA-1/SHA-256; Windows SQLite/path behavior; migration upgrade preserving all 026 rows.

A local single-user product cannot establish legal identity. A user correction can be issued by any caller authorized by the existing local/Tailscale user-control boundary; there is no desktop-only principal. SQLite can serialize Turing writers but cannot make Git and database state atomic. A later correction records user accountability; it cannot establish what content was present at an earlier time. Windows remains unverified until exercised on Windows.

No correction, withdrawal, completion, migration, or endpoint is implemented in Stage 7C.2B.5D.0.

## Stage 7C.2B.5D.1 implementation boundary

Migration 027's future proof shape carries a same-attestation correction-chain schema version, attestation ID, sequence, digest, and point-in-time `active_uncontested` standing. This is an identity slot for a later validated chain, not evidence that D.1 has checked current standing. D.1 creates no correction row, approval, event, endpoint, UI, or completion proof, and no code interprets the placeholder standing as authority. Proof issuance remains absent until a later stage can verify the correction chain and atomically bind it to completion. Later correction records must remain append-only and must not rewrite a historical proof or terminal Goal.

## Stage 7C.2B.5D.2 implementation status

Implemented and covered by focused tests:

- Migration 028: additive `goal_attestation_corrections` table with composite same-Goal foreign keys, a typed `attestation_correction_action_digest` on approvals with immutable identity guard and unique index, and insert-authority, immutability, and no-delete triggers.
- Service (`attestationCorrection.ts`): request approval, append under one immediate SQLite transaction with sequence and previous-digest CAS, exact-retry idempotency, standing and history reads that re-verify the full chain on every call.
- Read-only route: `GET .../external-integration/attestations/:attestationId/corrections`. It performs no write and no Git observation.
- Events: `external_integration_corrected` carries IDs and digests only.
- Evidence: a correction approval cannot become user-confirmation evidence.
- Recovery: a committed correction survives a fresh connection with its exact retry returning the original. A pending or decided-but-unappended approval is not a correction. A failure at the row insert or at the later event write rolls back everything. A damaged stored row fails closed after restart.
- Migration: a 026 database with a seeded attestation, approval, handoff and review upgrades to 028 with those rows unchanged, zero correction rows, and immutable guards intact.
- Git formats: withdraw and supersede run under SHA-1 and SHA-256. The correction service makes no Git writes; a test asserts the ref table and HEAD are unchanged across a supersession.

Deliberately not implemented in D.2 (dependencies named):

- Completion-standing projection in the Goal read model, and any completion consumer: D.3. `attestationCorrectionStandingAllowsCompletion()` returns true only for `active_uncontested` and is tested, but nothing calls it yet.
- Correction write route and desktop correction UI: D.4. D.2 exposes service functions and a read-only route only.
- Cross-format replacement refusal: a replacement must share the original's repository identity, and the Goal engine binds one repository per Goal, so a different-format replacement inside one Goal cannot be constructed. Cross-Goal replacement is refused. The identity comparison is covered by the existing replacement-compatibility check.

Superseded semantics: a supersession is not re-evaluated when its replacement is later disputed or withdrawn. The original stays `superseded`, which is non-authoritative, and the replacement's own standing is evaluated independently. This is the fail-closed direction; no operation restores authority to a superseded attestation.

### D.2 limits and prerequisites for D.3 and D.4

- Terminal Goal: a correction can be appended to a completed Goal without changing its status or reopening it (tested). A user decision on a pending correction approval for a terminal Goal is refused by `decideGoalApprovalAsUser` with `goal_terminal` (tested as the current behaviour). D.4 must add a narrow, deliberate exemption for correction approvals in that command, and test it through the HTTP route.
- Note for D.3: `getAttestationCorrectionStanding` throws when the original attestation is missing or invalid, instead of returning `standing: 'invalid'`. The route maps this to 409. D.3 must handle the refusal explicitly.
- Replacement lineage: same handoff, definition version and hash, and repository identity and project. The handoff equality is checked at write time. The read path re-checks approval identity only. No test builds a replacement from a different handoff.
- Evidence refusal (`recordUserConfirmationEvidence`): defence in depth. The criterion-key check refuses the same approval first.
- "Crash" in the tests is an injected SQLite abort inside a transaction, or closing and reopening the database handle. Real multi-process CAS races and operating-system crashes are not tested.
- The 026→028 migration test uses historical-shaped fabricated digests and does not prove real chain validation of a historical attestation.

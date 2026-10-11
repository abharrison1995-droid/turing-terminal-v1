# Goal external-completion contract design

Status: Stage 7C.2B.5D.0 design checkpoint accepted. Its proposal remains a future completion contract; Stage 7C.2B.5D.1 implements only the versioned policy boundary and proof infrastructure described in the implementation note at the end. Completion activation is still pending independent review and is not production qualification.

## 1. Recommendation

Adopt **Policy B — user-accountable historical integration**, with a separate explicit user action to complete the Goal.

A version-2 completed Goal would mean:

> The user reviewed the result in the destination and accepted responsibility for the external integration. At the recorded completion time, Turing independently observed that the exact accepted source commit and the handoff's recorded base commit were ancestors of the exact registered destination ref and commit.

It would **not** mean Turing proved the accepted files or their semantics survived conflict resolution, that the destination working tree is clean, or that the branch remains at the observed commit. The completion screen must state those limits beside the final confirmation. The user must inspect the destination result and make the content-preservation judgment themselves.

This is suitable for the personal-IDE V1 trust model only if “complete” is understood as the user's decision that the Goal's work is complete, backed by a point-in-time history observation. If product language or downstream use requires Turing to guarantee that accepted content remains present and correct, this policy is insufficient and completion must stay blocked. The UI and API must not translate this proposal into a claim of content verification.

Keep two separate decisions:

1. **Confirm external integration** records the user's statement about manual Git work and one exact source-history observation.
2. **Complete Goal** records that the user reviewed the completion evidence and accepts the version-2 proof limitations.

Neither action triggers the other automatically. No current service implements the second action.

## 2. Current authority inventory and gaps

### Definitions and hashes

`GoalDefinition` contains five hashed parts: `contract`, `milestones`, `routing`, `review`, and `limits`. `contract.completionPolicy` currently has `requireFinalReview`, `requireUserAcceptance`, `applyToBase`, finding limits, and high-severity resolution. `applyToBase` is either `required` or `leave-on-goal-branch`. The validator uses strict Zod objects. `hashGoalDefinition()` canonicalizes the five parts with sorted object keys and preserves array order; the result is stored in `goal_definition_versions.definition_hash` and bound to the user approval.

Approved definitions and their approval lineage are immutable. Migration 018 and the definition service require a `definition` approval for version 1 and an `amendment` approval for child versions, each bound to the exact version and definition hash. The Goal points to one current approved version. No completion-policy version discriminator currently exists.

### Evaluator and transition

`evaluateCompletion()` is read-only and issues an in-memory proof object registered in a private `WeakSet`. It evaluates current criteria/evidence, milestones, findings, final review, final acceptance, and final-apply policy. For `applyToBase: 'required'`, it accepts either a verified historical `apply_to_base` operation or a user `final_apply` approval whose detail says `action: 'applied_externally'` and binds the current definition hash/version and Goal integration head. The latter legacy row does not bind the immutable handoff, repository identity, destination ref/commit/tree, or an ancestry proof.

The accepted migration-026 external-integration attestation is different: it binds the handoff, definition, review/acceptance, repository, source and destination identities, exact user approval, ancestry evidence, observation time, and digests. The evaluator does not read this table. Its `completionContractVersion: 2` is emitted by the attestation implementation even though the Goal definition has no corresponding v2 opt-in. It currently identifies that attestation payload's proposed contract context; it does **not** prove that the definition opted into v2 and does not authorize completion. Existing records remain valid history under their original attestation semantics.

`checkCompletionProof()` accepts only the in-memory object from `evaluateCompletion()` and rechecks Goal identity, current definition version/hash/status, and Goal integration head. It does not persist a complete immutable proof or re-evaluate every changing authority row. `completeGoal()` evaluates, checks the Goal ref, then records a bounded `completion_evaluated` event and calls `transitionGoal()` in a SQLite transaction. The terminal transition is `running -> completed`, currently supervisor-only. `GoalSupervisor` calls `completeGoal()` when its work is exhausted, so the existing path can complete eligible legacy Goals automatically.

No dedicated `goal_completion_proofs` table exists. A successful current completion leaves `goals.completed_at`, status detail, and append-only events; the event contains a compact result summary, not the exact review, attestation, destination observation, user completion decision, and proof digest.

### Terminal state, events, and approvals

The application state machine treats `completed` and `abandoned` as terminal. There is no reopening transition. `transitionGoal()` updates status and timestamps and appends `state_changed` inside one transaction. Goal events and decided approvals are append-only/immutable. `goal_approvals` already has high-risk user gates and an explicit user decision model; it also has typed identity columns for prospective final-apply intent and external-integration attestation. Migration 026 makes attestations immutable, Goal/handoff scoped, and idempotent by action digest. These structures should be extended, not replaced by a parallel approval ledger.

### Current external observation

The accepted verifier uses the registered project and repository identity, exact `refs/heads/turing/goal/<goal-id>` source ref, exact handoff destination ref, SHA-1/SHA-256-aware object IDs, and two ref samples around tree and ancestry reads. It proves `source commit` and `recorded base commit` are ancestors of the observed destination commit. It reports `current` when the attestation action identity still matches, `historical` when the same authority and destination ref now point to a later tip, and distinct stale, not-integrated, unavailable, and invalid states. It does not modify Git.

## 3. Why ancestry is not content preservation

The retained disposable-repository `git merge -s ours --no-ff` characterization includes both source and base commits in destination history while omitting the source file changes from the destination tree. Therefore both ancestry tests can pass when accepted content is absent. Ordinary merges can also have a destination tree different from the source tree for valid reasons. Git ancestry proves graph inclusion, not tree equality, semantic correctness, or intent-preserving conflict resolution.

Policy A, generic strict content preservation, is not a realistic universal V1 rule. Tree equality would accept only a narrow set of outcomes and reject useful merge results that contain later or target-side content. Tree-difference heuristics cannot identify whether a conflict resolution preserved meaning. Patch IDs, file similarity, changed-path overlap, rebase detection, squash matching, and semantic equivalence are not authority. A generic engine for those cases would add substantial complexity without proving intent.

Policy B is explicit about the weaker claim. The completion review must show the exact repository, source commit/tree, recorded base, destination ref and observed commit/tree, both ancestry results, observation time, and immutable attestation. It must display: **“Turing verified source history at this time. Turing did not verify that every accepted change remains in the destination.”** The user must review the resulting destination and affirm that the content is acceptable. `ours` merge remains ancestry-eligible under this policy, but it cannot be presented as content-safe; a user who sees missing changes must refuse completion.

Squash, rebase, cherry-pick, partial application, and any history where the exact source commit is not an ancestor remain ineligible. No patch or tree heuristic may convert them into v2 proof. Such work can be handled by a separately designed policy in a later version, or by amending/reintegrating through a supported exact-history workflow.

## 4. Versioned definition policy

Add a strict additive discriminator inside `contract.completionPolicy` in a future definition-schema stage:

```ts
// Legacy v1: both fields absent; all current fields and their meaning are preserved.
// External-integrated v2: both fields required and exact.
completionContractVersion?: 2;
integrationMode?: 'external_user_attested';
```

For v2, retain the existing policy fields and require `applyToBase: 'required'`, `requireFinalReview: true`, and `requireUserAcceptance: true`. Require the final-review and final-acceptance human gates through the existing validation rules. The explicit pair means that final-apply policy is satisfied only by a valid v2 external-integration attestation plus a separate completion action. It is not satisfied by the quarantined writer, an old `applied_externally` approval, or a prospective `apply_to_base_intent` approval.

Parsing is fail-closed and version-dispatched:

| Stored discriminator                                                                                              | Meaning                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Both fields absent                                                                                                | Existing legacy v1 policy, interpreted exactly as today.                                  |
| `completionContractVersion: 2` and `integrationMode: 'external_user_attested'` with the v2-required policy fields | Explicit v2 policy.                                                                       |
| Only one field present, another mode, version 0/1 explicitly stored, or a version greater than 2                  | Unsupported or malformed policy; completion and new external-completion authority refuse. |

Do not insert defaults while loading or hashing legacy definitions. With the optional fields absent, the canonical five-part JSON remains byte-for-byte the same logical hash input and the legacy hash is unchanged. The new fields enter a definition hash only when a user proposes and approves an explicit v2 definition version.

The policy becomes authoritative only after the existing definition/amendment approval transaction sets the current pointer to a validated, approved definition with the exact v2 hash and its matching user approval. No migration rewrites old rows or synthesizes approval. Amendments retain the existing full parent-lineage checks. Once an approved lineage first opts into v2, future descendant definitions must not drop the v2 discriminator or fall back to legacy v1 evidence; otherwise an amendment could weaken completion requirements. A new completion policy version would need its own explicit design and approval.

A v2 opt-in requires new bound completion prerequisites. Existing handoffs and attestations bind their exact definition version/hash. The current 5C implementation may have made records whose `completionContractVersion` equals 2 while the approved definition is legacy. Preserve these records as valid historical attestations, but they cannot satisfy v2 completion. After a v2 definition is approved, the Goal needs a new version-bound final review and final acceptance, a new immutable handoff, and a fresh user attestation. Nothing is converted or silently reused.

## 5. V2 completion prerequisites

Completion must require all of the following, on one exact Goal and one current approved v2 definition:

| Requirement                                                                                                                    | Existing authority or future check                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal is eligible, `running`, nonterminal, and has no active cycle/run or unsettled integration work                            | Existing state machine and cycle/run records; add a final transactional eligibility check.                                                                                                                          |
| Current definition is approved, hash-valid, explicitly v2, and lineage-valid                                                   | Existing definition version/approval service plus strict v2 parser and monotonic lineage rule.                                                                                                                      |
| Required criteria and verification evidence pass at the current Goal integration head/tree                                     | Existing deterministic evaluator; include a canonical identity digest and recheck authoritative rows before transition.                                                                                             |
| Required milestones are satisfied or explicitly user-skipped; no blocking findings exceed policy                               | Existing evaluator and finding/milestone services; recheck counts and selected row identities in the final DB transaction.                                                                                          |
| Independent final review passes for the exact current version and source tree                                                  | Existing review authority; preserve exact review ID and identity digest, and recheck status/verdict/blocking/independence.                                                                                          |
| Explicit final user acceptance matches definition version/hash and source commit/tree                                          | Existing high-risk/medium user approval ledger and exact binding.                                                                                                                                                   |
| Immutable handoff is intact and binds that same version, review, acceptance, evidence, repository, source, and recorded base   | Migration-025 service and exact handoff digest. Ordinary `projection.state === current` is not required after integration because the base ref is expected to move. Use the dedicated handoff-authority validation. |
| Immutable attestation and its linked high-risk user approval are intact and same-Goal/same-handoff/same-definition             | Migration-026 typed columns, canonical payload, digest, FK scope, and approval row with exact action discriminator/digest.                                                                                          |
| Attestation has no effective dispute, withdrawal, or superseding correction                                                    | Future append-only correction ledger; select one exact attestation, never “latest record wins.”                                                                                                                     |
| Repository registration and object format still match; exact source ref still names the accepted source commit/tree            | Existing read-only verifier, run freshly for completion.                                                                                                                                                            |
| Exact recorded destination ref currently names a commit whose graph contains both exact source and recorded base commits       | Fresh independent Git observation; no reliance on the attestation's old `observedAt` alone.                                                                                                                         |
| User explicitly requests Goal completion after seeing this exact preflight                                                     | New typed high-risk user completion action/digest, separate from `confirm_external_integration`.                                                                                                                    |
| No concurrent amendment, new blocking finding, invalidating review, correction, or competing terminal transition commits first | Re-read all database authority inside one immediate SQLite write transaction and require exact snapshot bindings.                                                                                                   |

The current `evaluateCompletion()` already evaluates criteria, milestones, finding thresholds, final review, final acceptance, and its legacy final-apply rules. It does not select or validate the migration-026 attestation, implement v2 policy parsing, prove current destination ancestry, persist a durable proof, check the explicit completion action, derive a correction standing, or make supervisor completion user-controlled. Do not duplicate the existing evaluator's valid evidence logic; build an external v2 evaluator branch that composes its deterministic findings with the existing results and adds the missing authority.

## 6. Separate user completion action and preview

Keep the already implemented `confirm_external_integration` action as historical integration confirmation. Add a distinct versioned action, for example:

```text
complete_goal_external_integration_v2
```

The action detail must bind the Goal ID, current definition version/hash/approval, exact completion preflight identity, selected handoff ID/digest, selected attestation ID/action digest/record digest/approval ID, current repository identity, source ref/commit/tree, destination ref/observed commit/tree, ancestry evidence digest, the version-2 policy discriminator, and the disclosed `contentPreservation: not_proven` statement. It must use a new canonical action digest domain. It cannot reuse `applied_externally`, `confirm_external_integration`, or `apply_to_base_intent`.

The desktop workflow is:

1. A read-only completion preflight calculates current blockers and a fresh destination observation. It never writes an approval or completes the Goal.
2. The user opens the completion review. It shows all exact identities, definition/review/acceptance/evidence/handoff/attestation IDs, current blockers, the observed destination tip and timestamp, and the ancestry-only limitation.
3. The user inspects the destination content through safe read-only review instructions and explicitly acknowledges responsibility for its contents. Cancel leaves all rows and Goal state unchanged.
4. The user selects a clearly labeled action such as **Complete Goal based on my review**. It is distinct from **Confirm external integration**.
5. The server repeats every authority check and fresh Git observation. A change from the reviewed ref/commit/tree or any database authority binding refuses the old preflight and requires the user to review a new one.
6. Only after successful revalidation does one immediate SQLite transaction record the exact high-risk user decision, immutable proof, completion event, and terminal transition.

The simplest authority integration is the existing `goal_approvals` ledger with a typed completion action digest and `risk: high`, requested by and explicitly decided by the user through the authenticated user-control route. A new `goal_completion` gate is clearer but would require changing/rebuilding the current SQLite gate CHECK. The design recommends retaining the existing `user_confirmation` gate and adding a distinct typed `completion_action_digest` column, strict detail discriminator, immutable identity trigger, and unique `(goal_id, action_digest)` index. This is a typed user command, not a new approval subsystem. Whether one user click creates and decides that exact approval in the completion transaction or the UI has a separate approval screen must be reviewed in 7C.2B.5D.1; neither design may allow a supervisor to turn an approved row into completion automatically.

The preflight may be GET `/api/goals/:goalId/completion-preflight`; explicit completion may be POST `/api/goals/:goalId/completion` with a strict decision body and `If-Match` for the reviewed preflight digest. History/standing is read-only. Exact route names remain an implementation review item. The request must contain no client-chosen repository/ref/object IDs or authority row IDs. All identities are reconstructed server-side.

Desktop shows the full completion proof and warning. Mobile stays read-only for V1 and may show the completed/standing projection, but has no completion or correction action. This is a product boundary, not a separate authenticated principal: paired mobile clients can call the same authenticated API. No server-enforced desktop-only claim is valid under the current process-agnostic local and paired-device trust model.

## 7. Fresh Git observation and transition ordering

A displayed green preflight is only a review snapshot. It cannot directly be passed into the terminal transition. A future completion request should follow:

```text
Read-only preflight for the selected Goal and attestation
  -> explicit user reviews one exact candidate
  -> POST binds the preflight digest
  -> re-read current definition, evaluation, handoff, attestation, approval and correction history
  -> obtain a new read-only repository identity/ref/tree/ancestry observation
  -> sample refs again and refuse observed movement
  -> destination commit and tree must equal the attested tip (exact_attested_tip, CCv2r1 D1)
  -> begin a short SQLite BEGIN IMMEDIATE transaction
  -> recheck Goal status, current definition/hash/approval lineage, evaluation identities,
     final review/acceptance, finding/cycle/run state, handoff, attestation/approval,
     correction chain, and exact reviewed action binding
  -> persist approved completion action + immutable proof + completion event + terminal status atomically
  -> return the stored proof; after an uncertain response, read by exact action digest
```

The second Git observation must be produced by the completion operation itself. The earlier attestation observation remains evidence that the user confirmed that event, not proof of present destination state. The completion-time observation is a fresh read that must equal the attested tip; the proof stores it with a new `observedAt`. A moved destination is refused at completion and is never accepted by ancestry. There is no rewrite of attestations or completion actions: the remedy is a new read-only verification and a new user `confirm_external_integration` attestation at the new tip. If the destination changes between preflight and POST, the request refuses and the UI requires new review. If source/destination changes between the verifier's own ref samples, the verifier refuses.

Do not hold the SQLite writer lock while Git subprocesses run. Git may stall or time out, and SQLite and Git cannot share an atomic transaction. After Git returns, start a short immediate transaction, re-read every authoritative DB row and compare a canonical database-authority fingerprint captured before Git reads. If a concurrent DB writer changed definition pointer/hash, review, acceptance, findings, cycles/runs, attestation, correction chain, or Goal status, roll back without completion. Insert proof, its action approval, terminal state, and event in that same transaction. Use an idempotent unique action identity so a retry after a lost HTTP response reads the already committed result rather than making a second completion.

There remains an unavoidable Git TOCTOU interval: an external Git process can move the destination ref after the last verifier read and before SQLite commit, or after completion. Git offers no portable lock that an external CLI/IDE must honor for this read-only workflow. No mutex or SQLite transaction can prevent that. Persist exactly the observed ref, commit, tree, ancestry result and time; describe the proof as **observed at completion time**, not a guarantee that the branch remains there. A later move does not rewrite history or automatically uncomplete the Goal. A later user correction changes the completion standing projection.

Concurrent completion POSTs serialize at the SQLite immediate transaction and unique Goal/action/proof constraints. The first valid transition wins. A second exact retry returns the already persisted proof only if all exact action/proof digests match; a different action on an already completed Goal returns the existing terminal result without minting new authority. A database rollback means no proof/action/status event is committed. If the SQLite commit succeeds but the response is lost, exact digest lookup recovers it. An unrecoverable/corrupt proof fails closed.

## 8. Immutable completion proof

Note (D.3.0B, CCv2r1): the version-2 destination policy is exact-tip. The proof's observed destination commit and tree must equal the selected attestation's (migration 027 enforces this). Ancestry alone is not sufficient for version 2.

The existing WeakSet-issued `CompletionEvaluation` is a useful in-process guard for legacy transitions, but cannot serve as durable version-2 evidence. Add an immutable v2 proof record, separate from mutable `finalApply.ok` read-model fields.

Proposed canonical payload:

```ts
{
  schemaVersion: 1,
  kind: 'turing_goal_external_completion_proof',
  contractVersion: 2,
  goalId,
  definition: { version, hash, approvalId, parentLineageDigest },
  evaluation: { integrationHead, integrationTree, evidenceIdentityDigest,
                milestoneIdentityDigest, findingIdentityDigest, finalReviewId,
                finalReviewIdentityDigest, acceptanceApprovalId },
  handoff: { id, digest },
  attestation: { id, actionDigest, recordDigest, approvalId, correctionDigestAtCompletion },
  repository: { projectId, identity, scope, objectFormat },
  source: { ref, commit, tree },
  destination: { ref, expectedBaseCommit, expectedBaseTree,
                 observedCommit, observedTree },
  historyProof: { mode: 'source_history_observed', sourceAncestor: true,
                  baseAncestor: true, verifierVersion: 1, evidenceDigest },
  observation: { observedAt },
  completionDecision: { approvalId, actionDigest, decidedBy: 'user', decidedAt },
  proofDigest
}
```

The exact serialized version may change after schema review. Use separate domain-separated SHA-256 digests:

- `completion-action-v2\n` over the exact user-reviewed decision binding (including the versioned policy and destination identity; exclude server-generated row IDs where the action must be idempotently reconstructed).
- `completion-proof-v2\n` over the canonical full immutable proof body, including proof schema, persisted authority IDs, observation timestamp, decision timestamp, and action digest.

The row should store the frequently queried typed identity columns plus canonical bounded `payload_json`; recompute canonical JSON and both digests on read. Never repair a digest mismatch. Use the proof schema version and action discriminator independently from the definition contract version and attestation schema version.

An additive future migration is required because no durable completion proof exists. A proposed `goal_external_completion_proofs` table would have a primary key, `goal_id`, proof schema/kind, definition version/hash/approval, handoff, attestation, repository/source/destination identities, completion approval/action digest, proof digest, observed/decided/created timestamps, and bounded canonical payload. Add same-Goal composite foreign keys for definition, approval, handoff, attestation, final review, and completion action approval; uniqueness for `(goal_id, id)`, `(goal_id, action_digest)`, and at most one terminal v2 completion proof per Goal. Object IDs must be length-checked against recorded SHA-1/SHA-256 format. Insert guards must verify all payload-to-column identities and exact linked v2 approvals. UPDATE and DELETE triggers must reject mutation. The terminal event/status detail should carry the proof ID/digest. Add a separate standing read model; do not make a JSON boolean the proof.

For legacy v1 terminal transitions, preserve existing status/event history and evaluator behavior. Do not backfill synthetic v2 proof rows or rewrite completed timestamps/events. A v2 Goal without a valid proof row and matching transition event is corrupt/unverified, not complete-by-inference.

## 9. Attestation correction and terminal standing

See [GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md](GOAL_ATTESTATION_CORRECTION_WITHDRAWAL_DESIGN.md). The core rule is append-only: corrections never update/delete the attestation or completion proof and never silently reopen a terminal Goal.

Before completion, a correction that disputes, withdraws, or supersedes the exact selected attestation makes that attestation ineligible. Completion must re-read the correction chain inside the final SQLite transaction, so a stale preflight cannot race past an earlier committed correction. Another uncorrected attestation remains independently eligible; no Goal-wide “latest wins” rule applies.

After completion, the Goal remains historically `completed` with its original timestamp and proof. The read model gains a derived `completionStanding` such as `uncontested`, `disputed`, `withdrawn`, `superseded`, or `unverified`, plus whether reconciliation is needed. A corrected proof is never displayed as an unqualified green success. A later attestation does not rewrite the old completion proof or automatically restore its standing. If more work is needed, the user creates and approves a separate repair/reconciliation Goal; the original terminal Goal is not reopened. There is no current cross-Goal dependency engine. Any later consumer that relies on completion must consult standing as well as terminal status.

## 10. Compatibility matrix

| Historical/current item                                                          | V1 meaning                                                                         | V2 completion treatment                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved definition with no new policy discriminator                             | Existing legacy contract; current hash unchanged                                   | Never treated as v2; user must propose/approve an explicit v2 definition.                                                                            |
| V1 `applied_externally` approval                                                 | Existing legacy evaluator meaning, bound to version/hash/Goal head                 | Cannot authorize v2, even if detail or timestamp resembles integration evidence.                                                                     |
| `apply_to_base_intent` approval                                                  | Prospective exact Turing apply authority under its original contract               | Cannot authorize external completion or a completion action.                                                                                         |
| Migration-024 integration operation/recovery proof                               | Historical Turing-operation evidence under schema 1                                | Retain unchanged; not rewritten as user attestation or v2 proof.                                                                                     |
| Migration-025 handoff                                                            | Immutable prepared result bound to its then-current definition/base                | Usable only when it exactly matches current v2 definition/acceptance/review/repository/source prerequisites. No automatic retarget.                  |
| Migration-026 attestation with `completionContractVersion: 2`, legacy definition | Valid history of explicit user integration confirmation under the existing service | Not v2 definition opt-in and not sufficient for completion. New v2-bound handoff and attestation required after opt-in.                              |
| Pending/denied/system approval                                                   | Preserve original status and audit record                                          | Never promoted or migrated. Only exact user-approved v2 action qualifies.                                                                            |
| Malformed proof/approval/handoff/event                                           | Preserve evidence for investigation; do not repair                                 | Refuse completion; projection `invalid`/`unverified`.                                                                                                |
| Existing legacy completed Goal with no proof row                                 | Preserve terminal status/timestamp/events                                          | Historical legacy completion; no synthetic v2 proof. Standing is `legacy_unverified` for external-attestation semantics, not a claim that it met v2. |
| Historical aborted/planned final-apply operation                                 | Preserve immutable operation and recovery meaning                                  | Never replayed, reinterpreted, or converted to external completion.                                                                                  |

There is no new migration in this design checkpoint. The current data remains untouched.

## 11. Completion standing and downstream consumers

Add a read-only completion projection that keeps separate:

- `goalStatus`: historical state-machine status (`completed` remains terminal).
- `completionProofState`: `legacy`, `valid`, `invalid`, or `missing`.
- `completionStanding`: `uncontested`, `disputed`, `withdrawn`, `superseded`, `reconciliation_required`, or `unverified`.
- `completionClaim`: exact bounded wording that the user accepted a result and Turing observed source history at a timestamp; never `content_preserved`.
- `trustedForDownstream`: false for disputed, withdrawn, superseded, missing, or invalid v2 proof; a future dependent workflow must explicitly require this projection.

A read does not rescan Git on every dashboard request. It validates immutable rows and correction chain. The historical proof remains a time-bounded fact. A separately requested fresh Git check can say whether source/base ancestry is still observed now, but it does not edit the original proof. Notifications and audit exports refer to proof/correction IDs and standing. Do not overwrite the original `completed_at`; expose the later correction timestamp separately.

Current supervisors do not execute Goals because production remains `DisabledGoalExecutor`. No existing mechanism should infer that an amended or unrelated Goal can rely on a completion record without its own authorized dependency rule. V1 readiness must describe terminal completion as user-accountable v2 history, not Turing-certified content correctness.

## 12. Failure, race, and recovery matrix

| Condition                                                                          | Required v2 behavior                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing attestation, wrong Goal, wrong handoff, wrong repository                   | Refuse; no completion action/proof/status transition. Scope all lookups by Goal and handoff.                                                         |
| Legacy `applied_externally` or prospective apply approval presented                | Refuse v2; preserve legacy records unchanged.                                                                                                        |
| Pending, denied, system-decided, malformed, or wrong-digest approval               | Refuse; only exact approved user decision qualifies.                                                                                                 |
| Invalid attestation/proof/correction digest or tampered payload                    | `invalid`/`unverified`; no repair or success inference.                                                                                              |
| Withdrawn, disputed, or superseded selected attestation                            | Refuse new completion. An independent uncorrected attestation may be selected only after fresh user review.                                          |
| Correction committed during preflight/POST                                         | Final transaction sees correction-chain digest change and rolls back; user reviews a new candidate.                                                  |
| Source ref movement/deletion or wrong source/tree                                  | Refuse stale/invalid. Do not retarget or use an old reachable object alone.                                                                          |
| Destination movement during ref sampling                                           | Refuse `observation_changed`; require another preflight.                                                                                             |
| Destination movement after last sample before/after SQLite commit                  | Cannot be locked portably. Store exact point-in-time commit/tree/time; later movement does not rewrite proof.                                        |
| Source/base not ancestor, including squash/rebase/cherry-pick/partial              | Refuse; no patch-ID or tree heuristic.                                                                                                               |
| Git timeout, missing ref, unreadable repo, changed identity/common dir             | Refuse unavailable/stale; no transition.                                                                                                             |
| Changed definition, review, acceptance, evidence, findings, milestone, active work | Final DB recheck refuses; no legacy fallback.                                                                                                        |
| Goal already completed/abandoned or no longer running                              | Return terminal conflict/read-only existing proof; never mint a second proof.                                                                        |
| Concurrent completions                                                             | Serialize with SQLite immediate transaction and unique proof/action constraints. Exact duplicate recovers same proof; conflicting candidate refuses. |
| Database failure before commit                                                     | Roll back action approval, proof, completion event and status together.                                                                              |
| Crash or lost response after commit                                                | Read-only lookup by exact action digest returns the persisted proof; no replay or new decision.                                                      |
| Completed proof later disputed/withdrawn                                           | Preserve terminal status and original proof; append correction and change standing projection.                                                       |
| Concurrent independent attestations                                                | Require user-selected exact attestation. No automatic latest-record selection.                                                                       |
| Cross-Goal correction or copied approval                                           | Composite Goal FKs and service equality checks refuse.                                                                                               |
| Unsupported completion/proof/correction version                                    | Fail closed; preserve raw historical row for audit, do not downgrade.                                                                                |
| SHA-1/SHA-256                                                                      | Validate the stored object format and exact OID width at every layer.                                                                                |
| Windows path/ref/common-dir semantics                                              | Require dedicated Windows Git CI/characterization before production qualification; current evidence is Linux only.                                   |

## 13. Security, platform, and scope

The actor model includes the Turing process, another Turing instance, external Git CLI/IDE, a user changing refs or files, repository replacement, application/database crash, malformed rows, paired mobile clients, and unauthenticated callers. SQLite transactions and unique constraints protect database consistency among Turing processes. They do not lock external Git. The read-only verifier uses registered repository identity and exact refs; it does not claim physical repository identity if a byte-for-byte replacement at the same registered paths/common directory is indistinguishable. Local API trust remains process-agnostic, and paired mobile clients share the current user-control API. User approval therefore means “the authenticated app user control recorded this decision,” not verified legal/physical identity.

No new Git writer is part of this design. The rejected `applyApprovedGoalToBase()` remains quarantined. Production remains `DisabledGoalExecutor`. No provider/model or subscription path is needed. Windows is not available in the evidence cited by the accepted design and remains unverified. SHA-1/SHA-256 and Linux characterization already exist for handoff/attestation; new completion-specific digest and database tests must cover both object formats.

V1 does not need semantic merge equivalence, automatic repair, worktree watchers, Goal reopening, generalized distributed transactions, or automatic Goal creation. A later user-created repair Goal is the bounded correction path. No completion activation is safe until versioned policy, exact user completion authority, durable proof, final DB rechecks, correction standing, and platform validation have each passed independent review.

## 14. Proposed implementation stages

1. **7C.2B.5D.1 — Definition policy and proof/action schema.** Add the strict legacy-v1/v2 definition parser without changing legacy hashes; enforce approved lineage/no downgrade; add typed completion action identity and immutable proof table/migration. Add read-only policy projection. No completion endpoint or state transition yet.
2. **7C.2B.5D.2 — Attestation correction and standing.** Add typed high-risk user correction action, append-only correction ledger, per-attestation CAS/ordering, same-Goal constraints, projection states, and pre/post-completion tests. No Goal reopening and no completion activation.
3. **7C.2B.5D.3 — Controlled v2 completion authority.** Compose existing evaluator, validate exact v2 prerequisites, perform fresh Git observation, final transactional DB rechecks, and atomically persist proof/event/terminal state. Make supervisor unable to auto-complete a v2 Goal. Keep legacy completion behavior unchanged. No UI activation until independent backend review.
4. **7C.2B.5D.4 — Explicit desktop completion/correction UX.** Add preflight, digest-bound completion action, detailed ancestry/content-limit disclosure, correction flow, unknown-outcome recovery, history/standing, mobile read-only projection, and full service-backed E2E. Never add Git integration execution.
5. **7C.3 — Separate production qualification** only after all above are independently reviewed and platform gaps are resolved. It is not authorized by this design.

The first implementation phase should remain narrowly reviewable; do not combine policy migration, evaluator activation, terminal transition changes, and UI in one checkpoint.

Stage 7C.2B.5D.3 is delivered in sub-phases under CCv2r1 (decisions D1-D5 in the proof contract). The sub-phases so far add version-2 handoff preparation and user-confirmed attestation records. None of them activates version-2 completion.

## 15. Verification plan and remaining blockers

No characterization test is necessary to decide the policy: the accepted disposable `ours`-merge evidence already distinguishes ancestry from content preservation. No tests or production changes are added by this design stage. Future tests must prove:

- Legacy definition hashes byte-for-byte unchanged; no defaults added on load; explicit v2 definition needs a new user-approved version/hash; incomplete/unsupported discriminators fail closed; v2 lineage cannot downgrade.
- Legacy `applied_externally`, `apply_to_base_intent`, migration-024 operations, old handoffs, old attestations, and malformed records retain history but cannot authorize v2 completion.
- Exact v2 evidence, approvals, selected attestation and proof bind same Goal/version/handoff/repository/source/destination; correction identity is same-attestation scoped.
- `ours` merge makes ancestry eligible but UI/proof still states content is unproven; source/destination ref races during reads refuse; changes after last sample are recorded only as point-in-time limitation.
- Concurrent definition/finding/review/correction/completion writes are caught by final DB rechecks or serialized; proof, approval, status and events commit/rollback together.
- Duplicate/lost-response completion is idempotently recoverable by exact digest and cannot transition twice.
- Withdrawn/disputed/superseded proof remains historically visible and changes standing without changing terminal status or `completed_at`.
- SHA-1 and SHA-256, Linux and Windows, immutable triggers, malformed digest, cross-Goal FKs, and database restart recovery are covered.

The D.3.1 closure tests in `src/server/goals/manualHandoff.test.ts` (`version-2 handoff closure (D.3.1 review)`) pin D1 by refusing a destination that advanced past the attested observation, and do not accept it by ancestry. They also pin that a pre-version-2 attestation is not version-2 evidence after amendment. They do not exercise a completion transition, which is not implemented.

Outstanding blockers are the missing v2 definition discriminator, mismatch between the attestation's hard-coded contract version and definition policy, absent durable completion proof, supervisor's automatic legacy completion caller, no final transactional recheck of the full evidence set, no correction ledger/standing model, no explicit completion action, and unverified Windows behavior. This checkpoint resolves design direction only; completion remains unimplemented and disabled.

## Stage 7C.2B.5D.1 — policy and proof infrastructure implementation

This implementation checkpoint adds strict legacy-v1 versus explicit external-integration-v2 parsing, preserves absent v1 discriminator fields and the golden legacy definition hash, and allows v2 only through normal hash-bound definition approval. The approved parent chain is checked root-to-current and v2 cannot be downgraded by an amendment. Policy projection remains read-only and always reports v2 completion disabled.

The legacy completion evaluator is retained for v1. For v2 it now fails closed with `external_completion_not_activated`; legacy `applied_externally` approval and historical Turing apply evidence cannot satisfy it. The same boundary is checked by `checkCompletionProof()`, and a supervisor regression with passing criteria, review, acceptance, and legacy external authority remains pending. Existing migration-026 attestations are not definition opt-ins and cannot be reused after v2 approval.

The implementation adds strict, domain-separated completion-action and immutable-proof schemas plus migration 027. The new approval digest is distinct from the external-integration and prospective-apply digests. The proof table binds same-Goal authorities, hashes the entire proof including timestamps, checks SHA-1/SHA-256 widths, rejects updates/deletes, and limits a Goal to one terminal proof. No production service issues the action approval or inserts a proof. The correction-chain member is a future identity field; D.1 has no correction ledger and does not establish its standing.

Focused tests prove the legacy authority bypass before and after the evaluator guard, v1 hash compatibility, v2 opt-in/lineage/downgrade refusal, prior Turing-operation and migration-026 attestation isolation, supervisor refusal, migration-027 upgrade preservation, and schema integrity. See [GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md](GOAL_EXTERNAL_COMPLETION_PROOF_CONTRACT.md) for the exact implemented boundary. Windows remains unverified. No completion route, UI action, correction service, provider call, subscription use, Git writer, or positive v2 completion path is included. This checkpoint is pending independent review and does not establish release readiness; 7C.2B.5D.2, 7C.2B.5D.3, 7C.2B.5D.4, and 7C.3 have not started.

## Stage 7C.2B.5D.2 correction authority status

Stage 7C.2B.5D.2 implements append-only per-attestation correction authority (migration 028, service, read-only history route, correction events) as a reviewed candidate. It does not implement a correction write route, desktop correction UI, completion-standing projection, or any completion consumer; those are D.3/D.4 work.

The v2 completion path remains inactive. No completion action, proof issuance, or supervisor completion was added in D.2, and the legacy evaluator is unchanged.

## Stage 7C.2B.5D.3D - user completion decision boundary

Option B is implemented. One explicit user action records the decision. `recordExternalCompletionDecision` in `src/server/goals/externalCompletionDecision.ts` is an internal service with no route. It takes the Goal, the attestation, an acknowledgement that content is `not_proven`, and the digest of the preflight the user reviewed. It recomputes the preflight with fresh Git and requires the reviewed digest to equal the fresh digest. In one transaction it requests and approves a high-risk `user_confirmation` approval whose detail is the exact completion action, bound by `external_completion_action_digest`.

The decision records no proof, changes no Goal status, and does not complete the Goal. Completion remains `external_completion_not_activated`. D.3E must consume and re-verify the decision before any completion.

Guards: the generic decision route refuses completion approvals (`completion_decision_requires_dedicated_service`). A completion request must carry a digest that matches its action (`invalid_external_completion_action_digest`). Bind, evidence and freshness paths exclude completion approvals. The preflight option `allowRecordedDecision` lets the decision read a preflight after a decision exists. The default still refuses with `completion_already_recorded`.

Stale and conflict rules: a reviewed digest that no longer matches the fresh digest is refused (`reviewed_preflight_changed`). A database change between the Git read and the commit is refused (`authority_changed_during_decision`). A stored completion row that fails validation blocks new decisions for that Goal (`decision_corrupt`). A different decision for the same attestation is refused (`decision_conflict`).

Observed limitations at this stage: a serial repeat of an exact decision returns the existing approval with `reused: true`. A concurrent duplicate is refused by the preflight's snapshot check (`preflight_refused` with detail `observation_changed`) instead of being reused. A lineage-change refusal is not covered by a test in this stage.

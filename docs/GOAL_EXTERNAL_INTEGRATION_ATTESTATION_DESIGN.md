# Goal external-integration attestation design

Status: The opening sections preserve the original Stage 7C.2B.5A design record. Later implementation and remediation checkpoints are appended below; they do not change the completion boundary or permit Turing Git writes.

## 1. Executive decision

Keep manual integration user-controlled. A future completion contract may recognize external integration only when both of these are true:

1. The user explicitly confirms that they integrated the reviewed handoff into its recorded base branch.
2. A fresh read-only observation in the registered repository proves that the exact accepted source commit and the handoff's expected base commit are ancestors of the observed destination commit.

The proof means **the accepted source commit is present in the destination branch's recorded history at the observation time**. It does not prove that conflict-resolution content is byte-for-byte equal to the Goal tree, that every change remains in the destination tree, that a working tree is clean, or that the ref will remain unchanged. The user remains responsible for the meaning and quality of conflict resolution.

Squash, rebase, cherry-pick, partial application, patch similarity, matching trees without source ancestry, an assertion without Git proof, and any ambiguous observation do not satisfy this proposed strict contract. They remain available as manual workflows, but the Goal stays in manual reconciliation until a human-approved definition explicitly chooses a different completion threshold. No weaker threshold is recommended for V1.

Do not reinterpret current definitions. Their current `applyToBase: "required"` behavior and any historical `applied_externally` approvals remain governed by the existing evaluator. A newly approved definition version must opt into a separately versioned external-integration policy before this proof can satisfy completion.

## 2. Existing implementation audited

- `manualHandoff.ts` builds an immutable v1 handoff binding the Goal, approved definition and approval lineage, final review, final acceptance, selected evidence, repository identity, exact Goal ref/commit/tree, recorded base ref/commit/tree, and change-summary digests. Its canonical digest is persisted by migration 025. Preparation does not write Git or change Goal status.
- `validateManualHandoff()` reconstructs the current handoff snapshot. It requires the Goal source ref and recorded base ref to remain at the original handoff commits. After a real integration moves the base ref, the ordinary projection becomes stale with `base_diverged`; therefore a future attestation verifier must be a separate read-only service. It must validate the immutable handoff authority while allowing only the specifically proven source/base ancestry transition. It must not weaken ordinary handoff-currentness or reuse a stale projection as success.
- `evaluateCompletion()` verifies the current approved definition, Goal integration head/tree, criteria, milestones, findings, final review and final user acceptance. For `applyToBase: "required"`, it accepts either an applied operation proven by `hasVerifiedAppliedFinalApplyOperation()` or any approved user `final_apply` record whose detail says `action: "applied_externally"` and matches definition version/hash and Goal integration head. That historical attestation carries no handoff ID/digest, repository identity, destination ref, destination commit/tree, verification mode, or Git evidence digest.
- `checkCompletionProof()` accepts only an in-memory proof object issued by `evaluateCompletion()`, then checks Goal identity, the current approved definition/hash and the Goal integration head. It does not re-read the base branch. `completeGoal()` re-verifies the Goal ref, then writes the completion event and transition. A future v2 evaluator must add the external-attestation evidence to the issued proof and revalidate its observation contract; the current evaluator is unchanged in this stage.
- The v1 `apply_to_base_intent` approval is prospective authority for its original Turing operation. Migration 023 types its digest; migration 024 binds historical writer operations and recovery proof. Neither is authority for a user attestation.
- Migrations 018–025 preserve definition approval lineage, user decisions, review identity, immutable prospective authority, immutable operations, and immutable handoffs. Migration 025's `goal_result_handoffs` is the right source record, not an application result.
- Goal approvals are immutable after decision and use the existing unified approval ledger. An approved decision is not itself a reason to skip the exact v2 identity checks.

## 3. Threat model

| Actor or condition                         | Asset / interference                                                                      | Required treatment                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turing read-only verifier                  | May read inconsistent snapshots while refs move                                           | Read exact refs/objects, repeat ref reads, fail on observed movement, persist the observation timestamp and exact identities. Never claim a lock or permanent currentness.                                                                                                     |
| Another Turing process                     | May decide an approval, amend a Goal, create another attestation or complete concurrently | SQLite uniqueness/transactions serialize database identity; re-read Goal, definition, handoff and approval inside the final persistence transaction. Duplicate identical evidence resolves to one immutable row.                                                               |
| External Git CLI / IDE                     | May move refs, create commits, change worktrees during verification                       | No Turing Git write occurs. A changed ref observed between reads refuses. A later move is outside the snapshot guarantee and is recorded as later repository state, not rewritten evidence.                                                                                    |
| User changes branches or creates commits   | May change target identity or advance it after integration                                | Destination must be the handoff's exact recorded base ref. A target that no longer descends from the handoff base or lacks the source commit refuses. Later descendant commits do not erase the historical observation.                                                        |
| User edits tracked/untracked/ignored files | Worktree may differ from committed destination tree                                       | The proof concerns committed Git ancestry only. Do not call it a worktree verification or clean-checkout proof. Uncommitted integration is not eligible.                                                                                                                       |
| Linked worktree creation/removal           | Another checkout can appear without a portable atomic occupancy lock                      | Attestation performs no checkout/ref update, so occupancy is not a write-safety precondition. Worktree `HEAD`, index and files are not claimed to match the branch ref.                                                                                                        |
| Source ref moved or deleted                | A handoff's source pointer no longer names the accepted commit                            | Treat the handoff as stale and refuse new attestation, even if the old object remains. Do not silently retarget. If the object is pruned, proof is unavailable.                                                                                                                |
| Wrong repository or project                | Identical object IDs can exist in unrelated repositories                                  | Recompute the registered project/repository/common-dir/scope identity and require exact equality with the handoff. Object ID equality alone is insufficient.                                                                                                                   |
| Wrong destination ref                      | A valid source may be integrated into another branch                                      | Strict v2 policy only recognizes the exact handoff `target.baseRef`. Other branches require a separately approved contract and must not satisfy this policy.                                                                                                                   |
| Crash before/after persistence             | Request result may be unknown to the client                                               | Read back by Goal/handoff/action digest. Reuse an identical persisted record; do not automatically repeat a changed or uncertain user decision. No Git recovery action exists.                                                                                                 |
| Database corruption or malformed history   | Stored decision or handoff may be tampered/corrupt                                        | Strict parse, recompute every digest and foreign-key identity, fail closed. Preserve malformed rows for audit; never repair authority by rewriting them.                                                                                                                       |
| Correction after completion                | User may later withdraw an assertion or repository history may move                       | Add an append-only correction/withdrawal fact. Do not erase history or silently reopen a terminal Goal. Surface that completion was based on a historical observation and that a later correction exists. This limitation needs explicit product acceptance before activation. |

The supported authority boundary is the existing authenticated user-control surface. The UI is not a security boundary: paired mobile clients can reach the same API, and local API trust does not identify a particular human or desktop process. The record may say `decidedBy: user`; it must not claim verified legal identity or prove which physical person clicked unless a future auth contract provides that fact.

## 4. Disposable-repository evidence matrix

The characterization suite is `src/server/goals/externalIntegrationCharacterization.test.ts`. It creates and removes temporary repositories; it does not call a production writer. Results below are from Linux 6.8, Git 2.43.0, Node 22.23.1. `source ancestor` means `git merge-base --is-ancestor <handoff-source> <observed-destination>` succeeds.

| Integration or interference                                 | Observed Git facts                                                                                                                                                      | Strict v2 result                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact fast-forward                                          | Expected base and exact source are ancestors of destination; destination tree equals source tree when there is no later commit                                          | Eligible with explicit user confirmation and exact repository/ref/handoff checks                                                                                                                                                                                                  |
| Ordinary merge commit                                       | Expected base and source are ancestors. Destination tree can differ from the Goal source tree because target changes are retained                                       | Eligible as source-history integration; user owns merge semantics                                                                                                                                                                                                                 |
| Squash merge                                                | Patch ID can match, but source commit is not an ancestor and destination tree may differ                                                                                | Refuse; patch identity is not authority                                                                                                                                                                                                                                           |
| Cherry-pick                                                 | New commit ID; source is not an ancestor. Stable patch ID can match                                                                                                     | Refuse under strict policy                                                                                                                                                                                                                                                        |
| Rebase then integrate                                       | Rebased source has a new ID. Original handoff source is not an ancestor; rebased commit can have the same patch ID                                                      | Refuse; the old handoff is not silently retargeted                                                                                                                                                                                                                                |
| Partial cherry-pick                                         | Source is not an ancestor; destination tree and patch ID differ; one accepted path can be absent                                                                        | Refuse                                                                                                                                                                                                                                                                            |
| Conflict resolution changes content                         | Source and base remain ancestors of merge commit, but destination tree differs and conflicted content can be changed                                                    | Eligible only as history inclusion plus an explicit user claim that resolution was intentional; never claim tree equality/content preservation                                                                                                                                    |
| Unrelated target advancement before integration             | If the target advance and source are both merged, both are ancestors of destination                                                                                     | Eligible; recorded base must still be an ancestor                                                                                                                                                                                                                                 |
| Unrelated commits after integration                         | Source and expected base remain ancestors of the later destination                                                                                                      | Historical record stays valid history (`historical`, `destination_advanced_after_observation`). It is NOT acceptable as V1 completion evidence; completion needs a new attestation at the new tip. The original design allowed recording the later tip; CCv2r1 D1 supersedes that |
| Target ref force-moved to unrelated history                 | Source/base ancestry can disappear                                                                                                                                      | Refuse when observed; no force-move recovery                                                                                                                                                                                                                                      |
| Wrong destination branch                                    | The recorded base branch does not contain the source history                                                                                                            | Refuse, even if another ref does                                                                                                                                                                                                                                                  |
| Wrong repository                                            | Fixed test identities produce the same commit OID in two independently initialized repositories, while their Git common directories differ                              | Refuse by registered repository identity; Git OIDs are not repository identity                                                                                                                                                                                                    |
| Outdated handoff/base moved for unrelated work              | Destination may descend from the old base but does not include the exact source; regular handoff is stale                                                               | Refuse; no retargeting or patch guess                                                                                                                                                                                                                                             |
| Goal source ref moved                                       | Old object may remain readable but no longer matches the handoff source ref                                                                                             | Stale; refuse. A later prune can make the object unavailable                                                                                                                                                                                                                      |
| Same changes under different commit IDs                     | Rebase/cherry-pick preserve patch IDs in tested cases but produce different commit IDs and no source ancestry                                                           | Refuse under strict policy                                                                                                                                                                                                                                                        |
| Dirty target worktree                                       | Branch history can contain source while index/files contain additional or different uncommitted material                                                                | History claim only; never claim the live worktree matches or is clean                                                                                                                                                                                                             |
| Ref moves between observation reads                         | A second Git CLI process can advance the ref at a deterministic barrier; before/after OIDs differ                                                                       | Detect and refuse that observation; no portable lock spans check and SQLite commit                                                                                                                                                                                                |
| Linked worktree checks out destination during ref operation | External low-level `git update-ref` succeeds for a checked-out linked-worktree branch; its symbolic `HEAD` resolves to new commit while index/files remain at old state | Turing must not perform that ref update. Read-only attestation does not rely on worktree synchronization                                                                                                                                                                          |
| SHA-1 / SHA-256                                             | Both object formats are available in this Linux environment; commit/tree IDs are respectively 40/64 lowercase hex                                                       | Persist object format and validate every OID against it                                                                                                                                                                                                                           |

Tests establish specific command behavior for the tested Git build. They do not establish portability to every Git release, filesystem, repository configuration, or Windows.

## 5. Exact, non-identical and user-only claims

### Verified source-history integration

At the observation time, the exact handoff source commit and exact handoff base commit are ancestors of the commit read from the exact recorded base ref in the same registered repository. This proves source-history inclusion and base lineage. It does not prove the resulting tree equals the source tree or that every line remains unchanged. The user's explicit confirmation supplies the semantic claim that this is the integration they intended.

This is the only category recommended to satisfy a new strict `applyToBase: "required"` policy. The read-only verifier must reread source and destination refs and fail if they changed during its check. A ref can still move after the last read; the evidence is historical and time-bound, not a reservation.

### Qualified but non-identical Git evidence

- **Tree equality without ancestry:** same tracked snapshot, but not proof of which history or operation produced it. It can be informative; it does not satisfy strict integration.
- **Patch ID or diff similarity:** Git patch IDs intentionally normalize some details and do not prove complete source application, original base, repository or intended semantics. They do not satisfy strict integration.
- **Squash/rebase/cherry-pick:** may be inspected and displayed as a candidate for manual reconciliation, but the original source commit is not in destination ancestry. A user assertion cannot upgrade that observation to independently verified source-history integration.
- **Partial or conflict-altered content:** ancestry may exist while the destination tree differs. The verifier cannot label the output content unchanged. Under the recommended contract, the user's high-risk confirmation accepts responsibility for the merge result; the UI must show that limitation.

### User-attested only / refused

An assertion without the exact repository/ref/source/base observation is a user statement, not Git proof. It does not satisfy the recommended v2 strict policy. Missing, stale, contradictory, wrong-repository, wrong-destination, pruned-object, failed-read or moving-ref evidence is refused. No green state is inferred from a handoff, approval, copied command or previous successful observation.

## 6. Proposed immutable record

Prefer one new immutable record table linked to the existing approval ledger. Do not put a loosely structured JSON note in the existing operation table, and do not reuse `goal_integration_ops`: a user did not ask Turing to perform that operation.

Proposed conceptual row `goal_external_integration_attestations`:

```ts
interface ExternalIntegrationAttestationV1 {
  schemaVersion: 1;
  kind: 'turing_goal_external_integration_attestation';
  attestationId: string;
  goalId: string;
  approvalId: string; // exact, approved, user-decided v2 action
  completionContractVersion: 2;
  handoff: { id: string; digest: string };
  definition: { version: number; hash: string; approvalId: string };
  review: { finalReviewId: string; acceptanceApprovalId: string };
  repository: { projectId: string; identity: string; scope: string; objectFormat: 'sha1' | 'sha256' };
  source: { ref: string; commit: string; tree: string };
  destination: {
    ref: string;
    expectedBaseCommit: string;
    expectedBaseTree: string;
    observedCommit: string;
    observedTree: string;
  };
  proof: { mode: 'source_ancestor_of_destination'; verifierVersion: 1; evidenceDigest: string };
  decision: { value: 'confirm_external_integration'; decidedBy: 'user'; decidedAt: string };
  observedAt: string;
  recordDigest: string;
}
```

The database should have typed columns for Goal, approval, handoff, contract version, definition, repository, source and destination identities, evidence/record digests, and timestamp; bounded canonical JSON can retain the complete versioned payload. Foreign keys bind the record to its Goal, exact handoff and exact approval. Insert triggers check that the approval is approved by a user, is high risk and carries the new action/version/digest, and that the handoff/definition identities agree. Update and delete are rejected. A unique index prevents duplicate records for an identical action digest while allowing a later separately reviewed observation if the destination advanced.

No row is created for a refusal that failed to establish an attestation. A bounded Goal event may record the refusal code without raw Git output. Corrections are append-only records that reference the attestation they supersede; they never mutate the original. Completion reads only the latest valid, non-withdrawn chain.

## 7. Canonical digest and idempotency

Use a domain-separated, version-tagged, fixed-order canonical tuple. Include Goal/handoff IDs and digests; completion contract version; definition/hash/approval; final review and acceptance identities; repository/project/common-directory/scope identity; object format; exact source ref/commit/tree; exact destination ref; expected base commit/tree; observed destination commit/tree; verifier mode/version; evidence digest; explicit decision and actor classification. Validate OID width against the recorded object format.

Do not include display prose, command strings, preview text, client-supplied digest, or provider output as authority. The **action digest** excludes generated row ID and timestamps so an identical retry is idempotent. The immutable **record digest** includes the action digest, server-generated record ID, decision actor classification, and timestamps. Both are recomputed on read.

An identical retry after a lost response returns the exact existing row. If any observed ref/commit, handoff, definition, repository, or evidence identity differs, it is a new decision request and requires a new user confirmation. The client must reconcile by GET after an unknown response; it must never auto-replay the attestation POST.

## 8. Approval authority and risk

Use the existing `goal_approvals` ledger. A new typed variant may use gate `final_apply`, risk `high`, `requested_by: "user"`, and an exact detail action such as:

```json
{
  "schemaVersion": 2,
  "action": "confirm_external_integration",
  "attestationActionDigest": "…",
  "goalId": "…",
  "handoffId": "…",
  "handoffDigest": "…",
  "definitionVersion": 2,
  "definitionHash": "…",
  "repositoryIdentity": "…",
  "sourceCommit": "…",
  "destinationRef": "refs/heads/main",
  "observedDestinationCommit": "…"
}
```

This is not a `FinalApplyIntent`, has a different schema version and action discriminator, and cannot create a `goal_integration_ops` row. Migration 023's prospective-intent rules and unique index must remain specific to v1 `apply_to_base_intent`; migration 024's writer guard must continue to reject any other action. A migration must explicitly type and validate this new action rather than weakening those guards.

The user's button is a decision to attest, not an apply command. It should be labelled **Confirm external integration** and carry high risk. The server computes all authority fields, performs fresh verification, records the user decision through the existing approval service, and inserts the linked immutable attestation in one SQLite transaction after the Git observation. The client supplies only the Goal/handoff path identity and the explicit decision, never refs, commits, trees, evidence, approval IDs, proof categories or digests.

The current auth boundary authenticates the existing user-control surface but does not establish a distinct desktop principal or a named human for local loopback. Do not claim stronger actor identity. No agent, supervisor, scheduler or model route may call this action.

## 9. Completion-policy versioning

Do not change `evaluateCompletion()` or existing Goal definitions in this stage. Current definitions have no external-integration evidence version. Treat a missing version field as their existing legacy contract; do not rewrite their canonical payload or hash.

For a future amended definition, add a hash-covered explicit policy discriminator, for example:

```ts
completionPolicy: {
  version: 2,
  applyToBase: 'required',
  externalIntegration: 'user_confirmation_plus_exact_source_ancestry_v1',
  // existing completion fields
}
```

The user must approve that new definition version and its changed hash. Under this strict policy, only the current exact v2 attestation described here can set `finalApply.ok = true`, with basis `applied_externally` and an explicit `proofLevel`. A legacy `applied_externally` approval, a v1 prospective intent, a handoff, tree equality, or a patch match cannot satisfy it. A current Turing-applied operation may remain valid only for the legacy contract that authorized it; this stage does not revise that behavior.

For v2, the completion proof should record the exact attestation ID, handoff digest, destination ref, observed commit/tree, repository identity, evidence digest, proof level and observed time. Completion should mean **the user-confirmed source history was observed in the required destination at that time**, not that the ref or checkout will remain unchanged forever. The destination must be re-read during completion evaluation and must equal the attested tip exactly (CCv2r1 D1); descent from both the handoff base and source is not enough. If it differs, completion fails. Git and SQLite cannot make this observation plus Goal status transition atomic; that final time-of-check interval must remain explicit.

Historical definitions retain existing meaning. To use the stricter v2 contract, the user creates and approves an amended definition. There is no automatic migration from old approvals or records into v2 authority.

## 10. Historical compatibility

| Historical record                                              | Future v2 treatment                                                                                                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version-1 `apply_to_base_intent` approval                      | Audit only for v2. Never an external-attestation approval.                                                                                                                        |
| Pending v1 prospective approval                                | Preserve history; system-deny with an explicit superseded reason when a migration/flow replaces it. Never reinterpret.                                                            |
| Approved v1 prospective approval                               | Immutable historical approval for its original operation only; v2 validator refuses it.                                                                                           |
| `turing_goal_final_apply_operation` v1 planned/applied/aborted | Parse only with its v1 schema. Recovery proof retains its old meaning; never convert to external integration. Unsafe planned records remain unresolved/refused, observation-only. |
| Existing `applied_externally` approval                         | Continue legacy v1 behavior only when the current v1 evaluator would accept it. It has no handoff/destination proof and is not eligible for v2.                                   |
| Manual handoff v1                                              | Immutable source record; usable only if its exact handoff digest and current definition/approval/review/acceptance identities validate. Never proof of integration.               |
| Amended Goal definition                                        | Each new approved version/hash needs its own current final review, acceptance and handoff. Old handoffs remain history and cannot authorize the new version.                      |
| Malformed approval, operation, proof or handoff                | Fail closed, retain the audit row, do not repair, replay or infer authority.                                                                                                      |
| Existing completion proof                                      | Historical proof only; no new evidence is synthesized from it.                                                                                                                    |

## 11. Handoff staleness and integration observation

Ordinary handoff currentness remains strict: it means the source and destination still match the exact pre-integration snapshot. Successful manual integration necessarily moves the destination, so the old handoff will be stale under `validateManualHandoff()` after that move. This is truthful for review currentness but is not by itself a refusal or success signal for external integration.

A future attestation-specific verifier must:

1. Parse the immutable v1 handoff, compare typed columns, recompute its digest, and verify its exact Goal/definition/approval/review/acceptance identities.
2. Require that the Goal still names the handoff's approved definition and source integration head/tree; require the Goal source ref still points to the exact handoff source commit. A moved source ref makes the handoff stale.
3. Recompute the registered repository identity and object format; require exact equality.
4. Require the exact handoff destination ref; read its commit/tree and prove both expected base and accepted source are ancestors.
5. Repeat source/destination ref reads and fail if any changed while verification ran.

It must not call `buildManualHandoffSnapshot()` as its sole currentness rule because that intentionally refuses any moved base. It must not treat all `base_diverged` results as successful integration. An unrelated target move, wrong destination or missing ancestry refuses. The attestation projection should say `source history observed at <commit> at <time>` and separately show that the original handoff is no longer current as a pre-integration snapshot.

## 12. Concurrency and crash recovery

- Read repository and database identity before scanning; collect exact source and destination OIDs/trees; run ancestry checks over immutable object IDs; reread refs, repository binding and database authority before persisting. Any observed difference refuses with a bounded code.
- These reads detect movement across their samples; they do not reserve refs. A concurrent move after the final read cannot be excluded. The record is a time-stamped observation, not an eternal branch-currentness guarantee.
- Do not hold a SQLite write transaction while scanning Git. Before insertion, use a short `BEGIN IMMEDIATE` transaction to recheck database fields and approval uniqueness, then persist approval and record atomically.
- Crash before persistence: no attestation exists. GET finds none; user must review and explicitly decide again.
- Crash after commit before HTTP response: GET finds the immutable record; identical retry returns it. The client never assumes failure and never automatically resends.
- Concurrent identical requests: unique action digest returns one record. Concurrent requests with different observations require separate user decisions; only a record matching current v2 contract and fresh destination ancestry can satisfy completion.
- External movement after persistence does not rewrite the historical record. A fresh completion read must fail if the required ancestry is no longer present. Ref movement after Goal completion remains a later repository event, not a retroactive mutation of the completion proof.
- User correction/withdrawal is a new user-authorized append-only record referencing the original. It invalidates prospective completion. It cannot change a terminal Goal status; a post-completion correction must be conspicuously shown as a later dispute and requires a separate human recovery policy. This is an activation blocker until the product accepts that terminal-state limitation.

There is no Git replay or write recovery. Recovery only reads approval, record, handoff, refs, objects and digests; it never creates a ref, checks out, merges, resets, or marks an unproven result successful.

## 13. Proposed API boundary

Use Goal- and handoff-scoped routes, subject to existing auth and CSRF/origin conventions:

- `GET /api/goals/:goalId/handoffs/:handoffId/external-integration` — read-only latest status/record summary; no history scan over every record.
- `GET /api/goals/:goalId/handoffs/:handoffId/external-integration/verification` — read-only verification of the selected handoff. Returns bounded proof category, exact observed IDs and refusal reason; creates no approval or attestation.
- `POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attest` — strict body containing only an explicit decision enum. Re-reads all authority and Git identity; persists a high-risk, user-decided approval and immutable record only if strict verification succeeds. No client proof fields.

The desktop first displays the read-only verification response, then requires a separate explicit confirmation request. The POST re-runs verification so the displayed snapshot itself is never treated as authority. Never add a generic `/complete` route or a route that calls the quarantined writer. GET remains non-mutating. Errors are bounded and do not include raw Git output.

The server cannot prove a person clicked from the current local process-agnostic trust model. An authenticated paired phone client can reach the same API; this design makes the action user-authorized, not desktop-exclusive.

## 14. Desktop and mobile UX proposal

Add a separate external-integration section after Handoff. Show the handoff and its verified identities, then the actual recorded base ref, the current observed destination commit/tree, the source ancestry result, the expected base ancestry result, and observation time. Use full IDs with copy controls and short IDs only as secondary labels.

Before action, say: **Turing will only read Git and record your confirmation. It will not apply, check out, merge, or change files. Confirm only after you have integrated this exact handoff into this repository's recorded base branch.**

Action: **Confirm external integration**. Do not label it “Apply” or “Complete Goal”. Show a second explicit confirmation naming repository, destination ref, source commit and observed destination commit. After persistence, label the result **User confirmed; source history observed at …** and preserve the distinction between that evidence and Goal completion. If a squash/rebase/cherry-pick or partial result is observed, say **Git cannot verify this handoff under the current completion policy; manual reconciliation is required**.

Mobile is read-only until another stage explicitly authorizes an action. Do not present an approval button as desktop-only security. Stale, unavailable, invalid, wrong-repository, wrong-destination, or moved-ref states are explicit and fail closed.

## 15. Negative-test and E2E plan

Future production tests must use the real verifier and disposable repositories, and cover:

- exact FF and merge accepted; wrong repo/ref/source/base rejected;
- squash/rebase/cherry-pick/partial content/tree-only/patch-ID-only rejected under strict v2;
- conflict-resolved merge accurately labelled as ancestry plus user assertion, never exact-tree equality;
- source ref, destination ref, handoff, repository, definition, final review, acceptance, evidence or Goal status changes during the read;
- linked worktree and dirty files do not cause a Git write or a claim about checkout content;
- duplicate confirmation, concurrent confirmation, unknown HTTP result, crash before/after DB commit, and GET recovery;
- legacy v1 approval and operation cannot satisfy v2; malformed records, bad digests, wrong Goal and cross-repository records refuse;
- correction before completion removes eligibility; correction after completion is surfaced without rewriting history/status;
- completion proof is bound to the v2 attestation and a fresh destination ancestry check; no attestation by handoff display, copy, final acceptance, model, supervisor or SSE.

An end-to-end fixture must complete the accepted fake-provider Goal flow, create a current handoff, perform the integration only inside a disposable repository, confirm it explicitly, observe the immutable record, then separately evaluate completion under a version-2 definition. It must prove base/worktree state changes only because the fixture's user-simulated Git command ran, never because an application service ran. No live provider or subscription path is involved.

## 16. Windows and object-format qualification

Linux evidence: kernel 6.8, Git 2.43.0, Node 22.23.1, SHA-1 and SHA-256 temporary repositories. SHA-1 IDs were 40 hex characters and SHA-256 IDs 64. Linux behavior is characterized, not a cross-platform guarantee.

Windows: unverified. Before production qualification, run the characterization matrix on a real supported Windows host and supported Git for Windows versions. Check process/path quoting, common-dir resolution, case-insensitive ref/path behavior, linked-worktree administration, ref reads during concurrent checkout/switch, SHA-256 availability, and object/prune behavior. The verifier must reject case-ambiguous/non-canonical destination identity rather than normalize to a different branch.

## 17. Proposed migrations and implementation phases

No migration 026 is created here. A future additive migration should:

1. Add an explicit completion-policy discriminator for newly approved definition versions; missing legacy values remain v1 and hashes are not rewritten.
2. Add a strict typed approval-detail/action variant and immutable `goal_external_integration_attestations` table, unique action digest, exact Goal/handoff/approval foreign keys, OID-format checks, insert authority trigger, and no-update/no-delete triggers.
3. Add append-only correction linkage and indexes only after the post-completion correction behavior is approved.
4. Extend read models and completion proof only after the authority service is independently reviewed.

Recommended sequence:

- **7C.2B.5B — Attestation authority and read-only verifier:** migration, canonical identity, exact ancestry service, historical rejection and recovery tests. Keep no user confirmation route and no completion change.
- **7C.2B.5C — Explicit user action and desktop review:** authenticated user decision, immutable record creation, unknown-outcome reconciliation, desktop UI; no completion transition.
- **7C.2B.5D — Versioned completion integration:** only after independent review of B and C; amended definition contract, evaluator proof and full fake-provider E2E. Preserve historical v1 meaning.

If V1 cannot accept the non-atomic observation and post-completion correction limits described above, stop after the handoff and keep Goals at `final_apply_required` / manual reconciliation. Do not manufacture completion to close the workflow.

## 18. Remaining risks and current implementation status

- A source-ancestry proof does not prove conflict-resolved content matches the accepted tree. The user must own that semantic decision.
- Repository ref state can change immediately after the read; the attestation is historical, not a lock.
- Current auth does not distinguish a desktop human from a paired mobile client or arbitrary trusted local process.
- Existing v1 `applied_externally` rows have weaker identity than the proposed v2 record and remain legacy-only.
- Existing `validateManualHandoff()` considers any base movement stale; an attestation-specific validator is required.
- Windows behavior is unverified.
- A post-completion withdrawal cannot reverse an immutable terminal transition without a new recovery design.

At the 7C.2B.5A design checkpoint there was no external-attestation endpoint, table, migration, completion-policy change, production Git writer, Goal status transition, or UI action. `applyApprovedGoalToBase()` remained quarantined and production remained on `DisabledGoalExecutor`.

## Stage 7C.2B.5B implementation candidate

The accepted 7C.2B.5A design is now represented by an internal-only backend candidate: migration 026, a distinct `confirm_external_integration` approval digest, the read-only external Git observation service, immutable attestation persistence, and bounded validation/projection. Details and exact service contracts are in [GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md](GOAL_EXTERNAL_INTEGRATION_AUTHORITY_CONTRACT.md). This checkpoint is pending independent review.

The proof remains deliberately limited to `source_history_observed`: both the exact accepted source commit and recorded base commit are ancestors of the exact destination commit observed at a timestamp. A disposable `git merge -s ours --no-ff` test shows those ancestry checks succeed while the accepted file is absent. Projection therefore says `contentPreservation: not_proven`; neither ancestry nor the user assertion is a Goal completion proof.

The verifier uses repeated source/destination reads, exact registered repository identity, full SHA-1/SHA-256 object IDs and bounded read-only Git subprocesses. A deterministic injected ref move between the relevant reads is refused. This detects sampled races but does not make Git and SQLite atomic or prevent a later external ref change. Attestation-specific validation re-parses the immutable handoff without weakening ordinary handoff staleness after base movement.

Migration 026 is additive and preserves legacy v1 approvals, operations, recovery proofs, completion records and handoffs. No old record is converted. The new action digest is separate from `intent_digest`; only exact approved user decisions can persist an attestation. No endpoint, UI action, automatic approval, Git writer, completion-evaluator change, completion proof, Goal transition, provider call or subscription usage is added. Production remains on `DisabledGoalExecutor` and the rejected checkout writer remains quarantined. Windows behavior is unverified; Stage 7C.2B.5C/D and 7C.3 have not started.

## Stage 7C.2B.5B.1 — narrow evidence-integrity remediation

Review found that a timestamp excluded from action identity could still be copied from the caller into an otherwise valid observation and persisted. Successful validation now returns the newly constructed server observation, including its server-generated timestamp. The canonical action digest remains timestamp-independent; the record digest continues to cover the authoritative stored `observedAt`. An idempotent retry revalidates Git and returns the original immutable timestamp. A changed destination still requires a new action digest and user approval.

Review also found that a structurally valid record with an invalid linked approval could produce a positive projection claim. Positive claims are now limited to validation states `current` and `historical`, both after approval and record validation. Invalid, stale, unavailable and not-integrated results say `not_verified`; valid historical evidence remains preserved and accurately qualified. These are narrow service/projection corrections only: no migration, approval schema, Git writer, endpoint, UI, Goal completion or provider/billing behavior changed. Deterministic past/future timestamp and corrupted-approval regressions are part of the remediation candidate; full gate and hosted CI status belong to its checkpoint.

## Stage 7C.2B.5C — user attestation API and desktop confirmation candidate

The accepted 5B/5B.1 authority is now connected to bounded Goal/handoff-scoped GET routes, one strict explicit POST, and the desktop Handoff review surface. `GET` reads stored metadata without Git scans or persistence; the verification GET runs the accepted read-only observation service; the POST requires the exact reviewed action digest in `If-Match`, re-observes all authority and Git identities, and only then creates or reuses the distinct high-risk user approval and persists/reuses the immutable attestation.

The UI shows exact repository, source, recorded base and observed destination identities. It visibly explains that ancestry does not prove every accepted content change survived. The explicit dialog freezes Goal/handoff/repository/ref/commit/time/digest values at open; a changed digest is refused and displayed through a fresh verification. Unknown POST results reconcile only the exact approval/attestation metadata; there is no automatic retry. A successful attestation remains separate from application and completion.

The actual trust boundary remains the existing app pre-handler: remote Tailscale requests require a Serve identity and paired device session; Tauri CORS now admits the strong `If-Match` header. Local loopback API callers are process-agnostic, and paired mobile clients can call the same endpoint. The UI is desktop-focused, but the server does not assert a desktop-only physical-human guarantee.

Focused route/component tests and the extended fake-provider E2E use only disposable repositories. They prove GET creates no approval/attestation, exact confirmation creates one user-decided approval and immutable record, duplicate exact confirmation reuses it, changed review evidence is refused, app endpoints leave Git unchanged, later destination movement yields historical projection, and completion remains `final_apply_required`. Stage 7C.2B.5D, 7C.3, Windows qualification and independent acceptance remain outstanding. This candidate is not production-ready.

## Stage 7C.2B.5C.1 — UI authority and recovery follow-up

The ordinary handoff validator answers whether the snapshot remains ready for initial integration. A moved base can make it stale after the user integrates the accepted source. The desktop may still call the distinct read-only external verifier; stale status is neither a positive result nor a reason to bypass that verifier. Only its fresh exact-authority/source-and-base-ancestry result enables the separate explicit confirmation.

Unknown-outcome recovery retains one exact pending action digest per Goal/handoff while later observations are displayed. A different digest cannot replace or bypass it. Exact saved attestations require projection validation; approved orphans require fresh same-digest verification plus another explicit confirmation; denials remain non-retryable; complete scoped absence requires a fresh Git verification before the next confirmation. Failed, malformed, truncated, mismatched or unavailable responses keep the lock. No automatic POST retry or Git write is introduced.

The pending identity is stored in per-tab `sessionStorage` with a same-page in-memory fallback when storage writes fail. This cannot guarantee recovery across a reload with unavailable browser storage or across processes; server approvals and immutable attestations remain the durable authority. The service, migration 026, approval contract and completion evaluator are unchanged. Windows remains unverified; Stage 7C.2B.5D and 7C.3 have not begun.

## Stage 7C.2B.5D.0 — completion-contract design reconciliation

This later design checkpoint resolves the provisional choice in the original 7C.2B.5A document. The original strict recommendation is retained as historical design discussion; the recommended V1 completion meaning is now **user-accountable historical integration** (Policy B), as specified in [GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md](GOAL_EXTERNAL_COMPLETION_CONTRACT_DESIGN.md). The accepted `git merge -s ours` characterization proves why this wording must remain narrow: exact source/base ancestry may be true even when accepted content is absent from the destination tree. V2 completion therefore requires an explicit separate user completion decision after content review and discloses that Turing did not prove content preservation. Squash/rebase/cherry-pick/partial history still does not qualify; no patch or semantic heuristic is introduced.

The current code has a contract mismatch the design must resolve before activation: migration-026 external attestations carry `completionContractVersion: 2`, but `GoalDefinition.contract.completionPolicy` has no version discriminator and the external confirmation service does not require a separately approved v2 definition. The attestation field is not itself a Goal policy opt-in. Those existing records remain immutable user-confirmation history, but cannot authorize future v2 completion. A newly approved v2 definition must bind a fresh review, acceptance, handoff and attestation; no migration synthesizes or converts authority.

This section is a design record only. `evaluateCompletion()`, `checkCompletionProof()`, `completeGoal()`, Goal terminal behavior, migration 026, and the attestation service remain unchanged. Completion and correction/withdrawal are not implemented. The master Stage 7C.2B.5D.0 prompt marks Stage 7C.2B.5C.1 accepted; that acceptance does not accept this new design checkpoint. Windows remains unverified.

## Design change record (D.3.0B, CCv2r1)

The original design allowed a destination that advanced after integration to be recorded at its later tip. CCv2r1 narrows this for version-2 completion: the destination must equal the attested tip exactly. The narrowing is required because the migration-027 proof trigger binds the attested destination columns. Permitting advancement would need a new migration and new action and proof schema versions. The historical attestation record is unchanged and remains valid history.

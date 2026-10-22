# Content-verified integration: approved design (not implemented)

Status: **Approved design. Not implemented.** The owner recorded decisions on 2026-10-21 and they are recorded in section 6. Approval of the design is not implementation: no source code, schema, migration, test, UI or active completion behaviour in this repository implements any policy below, and every implementation step described in this document remains pending. Nothing in this document changes the accepted v2 historical contract, existing attestations, existing completion proofs or any Git writer.

Owner rule (decision d3e4, 2026-10-17): a merge that demonstrably discards accepted Goal work must not count as successful delivery. Ancestry alone is not proof that content was preserved.

Owner decisions (2026-10-21) are recorded in section 6. They settle the questions this proposal left open; they do not implement them.

Review traceability: independent review job `ddbbb3b680d747b48f3011f19bff4783` raised non-blocking findings N1–N4; this revision addresses wording only, with no policy change.

| Finding | Resolved location                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1      | §4 records both client and server trusted classifiers; runtime fail-closed behavior for client strings; server schema/enum rejects unknown values; no compile-time exhaustiveness claim. |
| N2      | §4 records exact 026/027 JSON-key counts and all three 027 not_proven pins.                                                                                                              |
| N3      | §3 rules 4–5 describe fast-forward and first destination-history comparison point.                                                                                                       |
| N4      | §3 and later relevant passages distinguish verifier version 2 from completionContractVersion 2.                                                                                          |

## 1. Current behaviour, from code

- `src/server/goals/externalIntegration.ts` (around lines 640–660) decides "integrated" by ancestry only: `isAncestor(source, destination)` and `isAncestor(expectedBase, destination)`. Both must be true.
- The destination tree is recorded as `observedTree` (around line 683) but is **never compared with the source tree or with the content the Goal changed**.
- The proof is pinned to one literal: `proof.mode = 'source_history_observed'` and `proof.verifierVersion = 1` (schema around lines 71–76 and 126–131; constructed around lines 566–570).
- The database pins the same values. Migration `026_goal_external_integration_attestations.sql` line 65–66 has `CHECK (proof_mode = 'source_history_observed')` and `CHECK (verifier_version = 1)`. Migration `027_goal_external_completion_proofs.sql` lines 80–83 repeat them, and line 143 has a `CHECK` and line 224 a trigger, both of which compare the verifier version. SQLite cannot change a `CHECK` in place.
- `docs/history/goals/GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md` line 337 already records the accepted position: `merge -s ours` can satisfy ancestry while accepted content is absent. Under Policy B ("user-accountable historical integration") completion needs an explicit separate user decision that discloses Turing did not prove content preservation.

## 2. What the three categories mean

| Category                | Definition                                                                                 | Today                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| Known content loss      | A path the Goal changed is absent from the destination, or differs from the Goal's version | **Not detected.** No check exists.     |
| Unverified preservation | Ancestry holds, content is not compared                                                    | Accepted as Policy B, with disclosure. |
| Verified preservation   | Every path the Goal changed matches the destination                                        | **Not implemented.**                   |

Known content loss cannot be proved to be absent until the content check exists, so today every ancestry-verified integration is "unverified preservation", including ones that discarded content.

The "Today" column describes the repository as it stands. The approved policy in section 3 changes it for **new** completions only, and only once that policy is implemented. Existing records stay exactly as they are.

## 3. Approved design: a new versioned verifier, `content-verified-v1`

Add a separate verifier, leave v1 alone, and select it explicitly for new completions. This is the approved shape (owner, 2026-10-21); it is not implemented. In this document, "verifier version 2" means `proof.verifierVersion = 2` for the `content-verified-v1` verifier; it is not `completionContractVersion: 2`.

**Verification rule.**

1. Keep the ancestry checks unchanged. They are necessary.
2. Compute the set of paths changed from the expected base to the accepted source with `git diff-tree -r -z --no-renames`, so unusual names survive and a rename is a delete plus an add. Include file mode, type changes, symlink targets and submodule (gitlink) entries. Compare both trees through `ls-tree -r -z`.
   - **Directory/file conflicts:** if the source changed a file path that the destination now holds as a directory (or the reverse), that path is a mismatch.
3. For each changed path, read the destination entry at that path:
   - If the source added or modified it, the destination entry must have the same object id and mode.
   - If the source deleted it, the destination must not have it.
4. Fast-forward is a special case: the destination tree must equal the source tree, compared as the destination tree at the source commit (the first destination-history commit containing the accepted source); later tip edits do not change that comparison. The rule above covers it.
5. **Comparison point (approved 2026-10-21).** Compare the destination at the **first destination-history commit containing the accepted source** — the commit at which the accepted source entered the destination history — not at the current destination tip. A later destination commit that changes a Goal path therefore does not turn a preserved merge into a mismatch. The comparison commit is resolved from the same bounded, read-only Git reads as the rest of the observation; the tip is never the comparison point. (Fast-forward comparison point: see rule 4.)
6. Result:

   - All paths match: `verified` under `content-verified-v1`.
   - Any mismatch: `content_not_preserved`, with the count and a digest of the mismatched paths. Path names are not put in user-facing text. This is the internal `ContentTreeComparisonStatus` comparator result; it is not the attestation correction reason code of the same literal, and the attestation correction reason `content_not_preserved` keeps its own correction semantics. Any completion API or wire field that surfaces this comparison uses its content-verification namespace and is not a correction reason.
   - Bounded work: if the changed-path set exceeds **10,000** paths, fail closed as `content_observation_too_large`. **No sampling**: the verifier never verifies a subset and reports it as the whole.
   - Unreadable Git object: fail closed as `content_unreadable`.

**Conflict resolutions.** A merge where the user changed content to resolve a conflict will report `content_not_preserved` under verifier version 2, because the destination intentionally differs. That refusal applies to the verifier version 2 path only (distinct from completionContractVersion 2). **Decided 2026-10-21:** Policy B — the explicit user-accountable historical path — remains available for such a merge, and the Policy B record discloses the content mismatch. Policy B must never treat a content mismatch as successful delivery (section 6, decision 2).

**Later destination edits.** A commit that changes a Goal path after the merge would also report `content_not_preserved` if the check compares the branch tip. That is a false refusal on active repositories. Options were (a) compare at the observed comparison commit, the first destination-history commit containing the accepted source, rather than at the tip; or (b) keep the tip check and accept the refusal. **Decided 2026-10-21: option (a).** The destination is compared at the first destination-history commit containing the accepted source (see section 3, rules 4–5), never at the current tip (section 6, decision 6).

**Fail-closed reasons, beyond the cap and unreadable objects.**

- `object_format_unsupported` for any repository whose object format the verifier does not yet handle, including SHA-256 unless it is tested.
- `object_missing` for a shallow or partial clone whose required objects are absent. It must not be reported as preserved.
- `content_lfs_unsupported` when any changed source path has a Git LFS filter. The blob at such a path is an LFS pointer, not the accepted content, so the verifier refuses rather than comparing pointers (section 6, decision 3). The LFS filter is detected per changed path, not only from a repository-wide `filter.lfs` setting.
- A submodule gitlink whose commit is not in the local repository is compared by id only and is **not** a failure. Its content is outside the verified scope.
- `core.autocrlf` and filter drivers can change the bytes Git compares. The verifier must read raw object ids, never the working tree, and must refuse if a repository sets a filter for a changed path.

**Known limits, to disclose.**

- Git LFS: the blob at an LFS path is the pointer, so the large object's content would not be compared. **Decided 2026-10-21: refuse.** If any changed source path has an LFS filter, the verification refuses (`content_lfs_unsupported`); it never compares an LFS pointer and reports preservation. Disclosure alone is not sufficient for those paths.
- Binary files and symlinks are compared by object id, which is exact, so they need no special handling.
- Submodules are compared by commit id. The submodule's own content is not inspected.

## 4. Storage and migration: additive only, with two exceptions

**Exceptions to additivity, which must be stated and tested.**

- The `goal_approvals` insert guards in migration 026 (around lines 17–33) and migration 027 (around lines 20–38) pin the approval action types and digests. A verifier version 2 confirmation needs its own action type, so those guards must be extended. The change must leave v1 approval acceptance and rejection exactly as they are. A regression test is required.
- The read-side literal `contentPreservation: 'not_proven'` is a closed type in `src/shared/goalApi.ts` (around lines 190, 199, 210, 446, 883) and is required by a 027 insert trigger (around line 225). A verifier version 2 record needs a `verified` value. Consumers of the new verified result must be updated and must fail closed on any value they do not recognise: the shared types, the standing claim (`completionStanding`), the UI, and `src/server/goals/retention.ts` (around lines 221–230), which keys on ancestry. The two trusted classifiers are `src/client/goals/completionStandingCopy.ts` and `src/server/goals/completionStanding.ts`. The client classifier must fail closed at runtime on any value it does not recognise, and the server enum/schema must reject unknown values. The client classifier reads untrusted string payloads at runtime; the TypeScript compiler does not guarantee exhaustiveness for those string payloads.

Otherwise:

- Migration guards (compatibility): migration 026's approval guard requires exactly 27 keys in `detail_json` (`(SELECT COUNT(*) FROM json_each(NEW.detail_json)) <> 27`); migration 027's approval guard requires exactly 20 keys. Migration 027 pins `contentPreservation: 'not_proven'` in three places: the approval guard (`$.proofLimitations.contentPreservation IS NOT 'not_proven'`), the table CHECK (`$.proofLimitations.contentPreservation IS 'not_proven'`), and the insert trigger (`$.proofLimitations.contentPreservation = 'not_proven'`). v1 rows keep these constraints; a verifier version 2 value needs its own guards.
- **Do not alter `goal_external_integration_attestations` or `goal_external_completion_proofs`.** Migrations 026 and 027 keep their `CHECK` constraints and their triggers for v1 rows. This is unchanged by the 2026-10-21 decisions: v1 keeps its existing proof and schema constraints.
- Add new tables for v2 evidence, for example `goal_content_verifications` (identity, verifier version 2, changed-path count, mismatch digest, observed destination tree) and a verifier version 2 completion record, each with its own digest and append-only triggers.

- Existing v1 completions stay historical. They are not re-verified and not rewritten. Their completion proofs keep their current digests, and they stay `not_proven`. **Confirmed by the owner decision of 2026-10-21:** existing ancestry-only records stay immutable and historical — no rewrite, no re-verification.
- New completions can use verifier version 2 only after the migration and verifier are shipped and tested. Until then, v1 remains the only path. The 2026-10-21 decisions do not change this gate.

- The action digest for a verifier version 2 confirmation uses a new domain string, so a verifier version 2 digest can never collide with a v1 digest.

## 5. Test plan (still pending; the approved decisions fix the expected outcomes)

Fixtures in a temporary repository, each asserting the state, not just the HTTP status. No fixture below exists yet; the whole plan is pending implementation.

1. Fast-forward with the Goal's content: verified.
2. True merge where the destination kept the source's content: verified.
3. `merge -s ours`: ancestry true, `content_not_preserved`.
4. A conflict resolution that edits the Goal's content: `content_not_preserved`.
5. A destination-only change that does not touch the Goal's paths: verified.
6. Rename, deletion, mode change, symlink, submodule entry, LFS pointer, and a path name with unusual bytes.
7. Changed-path count over the cap: `content_observation_too_large`.
8. Destination moves during observation: the existing before/after check still fails closed.
9. Existing v1 records are unchanged after migration: record digests, the trigger set and the schema SQL for the v1 tables. Ancestry-only records are not rewritten and not re-verified.
10. A verifier version 2 row cannot be inserted into the v1 tables (the `CHECK` constraints still hold).
11. Directory/file replacement and file-type change (symlink to file) fixtures.
12. The cap boundary value, both at and one above the limit.
13. Shallow clone and missing-object fixtures: `object_missing`, never verified.
14. Comparison point: a destination that changes a Goal path **after** the comparison commit still verifies against the first destination-history commit containing the accepted source (see section 3, rules 4–5); the tip is never used as the comparison point.
15. An LFS-filtered changed path refuses with `content_lfs_unsupported`; a pointer comparison is never reported as preserved.
16. The changed-path cap is exactly 10,000: 10,000 changed paths verify, 10,001 fail closed as `content_observation_too_large`, and no sampling occurs at any size.
17. The Policy B path never reports a content mismatch as successful delivery: the record discloses the mismatch, the standing stays a disclosed mismatch, and no consumer may read it as delivery.
18. Turing performs no Git write in any of the above: the repository is byte-identical before and after the verification.

## 6. Owner decisions (recorded 2026-10-21)

The owner recorded the following decisions on 2026-10-21. They close every question this proposal left open. They are policy, not implementation: nothing below is in the source code, the schema, the migrations, the tests or the UI yet, and every implementation item in sections 3–5 remains pending.

1. **Approved.** New Goal completions use the new versioned content verifier (`content-verified-v1`, verifier version 2), with the additive table-based migration and the fail-closed reasons in section 3.
2. **Approved, with the constraint recorded in section 3.** Policy B — the explicit user-accountable historical path — stays available, including for conflict-resolved merges and for content mismatches. It must never treat a content mismatch as successful delivery: a mismatch stays a mismatch, is disclosed, and never becomes a delivery claim. Goals already completed under v1 stay as they are.
3. **Approved: refuse.** Git LFS paths are not accepted on pointer comparison. If any changed source path has an LFS filter, the verification refuses (`content_lfs_unsupported`).
4. **Approved: 10,000.** The changed-path cap is 10,000 paths. Overflow fails closed as `content_observation_too_large`, with no sampling.
5. **Confirmed.** Turing performs no Git write to make a merge verify. The verifier is read-only, exactly like the existing ancestry observation.
6. **Approved: compare at the comparison commit.** The destination is compared at the first destination-history commit containing the accepted source (see section 3, rules 4–5), not at the current tip.

Two further constraints come from the same decision record:

- **Existing ancestry-only records stay immutable and historical.** They are not rewritten and not re-verified; they keep their digests and their `not_proven` standing.
- **v1 keeps its existing proof and schema constraints.** Migrations 026 and 027 keep their `CHECK` constraints and triggers for v1 rows, and the v1 completion path is unchanged.

Every question this proposal raised is now decided. Implementation of the approved policy has not started and remains pending; this document records approved design only.

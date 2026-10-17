# Content-verified integration: design proposal

Status: **Proposal. Not implemented. Requires owner approval** before any code, migration or test change. Nothing in this document changes the accepted v2 historical contract, existing attestations, existing completion proofs or any Git writer.

Owner rule (decision d3e4, 2026-10-17): a merge that demonstrably discards accepted Goal work must not count as successful delivery. Ancestry alone is not proof that content was preserved.

## 1. Current behaviour, from code

- `src/server/goals/externalIntegration.ts` (around lines 640–660) decides "integrated" by ancestry only: `isAncestor(source, destination)` and `isAncestor(expectedBase, destination)`. Both must be true.
- The destination tree is recorded as `observedTree` (around line 683) but is **never compared with the source tree or with the content the Goal changed**.
- The proof is pinned to one literal: `proof.mode = 'source_history_observed'` and `proof.verifierVersion = 1` (schema around lines 71–76 and 126–131; constructed around lines 566–570).
- The database pins the same values. Migration `026_goal_external_integration_attestations.sql` line 65–66 has `CHECK (proof_mode = 'source_history_observed')` and `CHECK (verifier_version = 1)`. Migration `027_goal_external_completion_proofs.sql` lines 80–83 repeat them, and line 143 has a `CHECK` and line 224 a trigger, both of which compare the verifier version. SQLite cannot change a `CHECK` in place.
- `docs/GOAL_EXTERNAL_INTEGRATION_ATTESTATION_DESIGN.md` line 337 already records the accepted position: `merge -s ours` can satisfy ancestry while accepted content is absent. Under Policy B ("user-accountable historical integration") completion needs an explicit separate user decision that discloses Turing did not prove content preservation.

## 2. What the three categories mean

| Category                | Definition                                                                                 | Today                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| Known content loss      | A path the Goal changed is absent from the destination, or differs from the Goal's version | **Not detected.** No check exists.     |
| Unverified preservation | Ancestry holds, content is not compared                                                    | Accepted as Policy B, with disclosure. |
| Verified preservation   | Every path the Goal changed matches the destination                                        | **Not implemented.**                   |

Known content loss cannot be proved to be absent until the content check exists, so today every ancestry-verified integration is "unverified preservation", including ones that discarded content.

## 3. Proposal: a new versioned verifier, `content-verified-v1`

Add a separate verifier, leave v1 alone, and select it explicitly for new completions.

**Verification rule.**

1. Keep the ancestry checks unchanged. They are necessary.
2. Compute the set of paths changed from the expected base to the accepted source with `git diff-tree -r -z --no-renames`, so unusual names survive and a rename is a delete plus an add. Include file mode, type changes, symlink targets and submodule (gitlink) entries. Compare both trees through `ls-tree -r -z`.
   - **Directory/file conflicts:** if the source changed a file path that the destination now holds as a directory (or the reverse), that path is a mismatch.
3. For each changed path, read the destination entry at that path:
   - If the source added or modified it, the destination entry must have the same object id and mode.
   - If the source deleted it, the destination must not have it.
4. Fast-forward is a special case: the destination tree must equal the source tree. The rule above covers it.
5. Result:
   - All paths match: `verified` under `content-verified-v1`.
   - Any mismatch: `content_not_preserved`, with the count and a digest of the mismatched paths. Path names are not put in user-facing text.
   - Bounded work: if the changed-path set exceeds a fixed cap, fail closed as `content_observation_too_large`. Do not sample.
   - Unreadable Git object: fail closed as `content_unreadable`.

**Conflict resolutions.** A merge where the user changed content to resolve a conflict will report `content_not_preserved` under v2, because the destination intentionally differs. That refusal applies to the v2 path only. Whether Policy B remains available for such a merge is decision 6.2.

**Later destination edits.** A commit that changes a Goal path after the merge would also report `content_not_preserved` if the check compares the branch tip. That is a false refusal on active repositories. Options: (a) compare at the observed merge commit, the first commit that contains the source, rather than at the tip; or (b) keep the tip check and accept the refusal. This is decision 6.6.

**Fail-closed reasons, beyond the cap and unreadable objects.**

- `object_format_unsupported` for any repository whose object format the verifier does not yet handle, including SHA-256 unless it is tested.
- `object_missing` for a shallow or partial clone whose required objects are absent. It must not be reported as preserved.
- A submodule gitlink whose commit is not in the local repository is compared by id only and is **not** a failure. Its content is outside the verified scope.
- `core.autocrlf` and filter drivers can change the bytes Git compares. The verifier must read raw object ids, never the working tree, and must refuse if a repository sets a filter for a changed path.

**Known limits, to disclose.**

- Git LFS: the blob compared is the pointer. The large object's content is not compared. This must be disclosed or LFS repositories refused.
- Binary files and symlinks are compared by object id, which is exact, so they need no special handling.
- Submodules are compared by commit id. The submodule's own content is not inspected.

## 4. Storage and migration: additive only, with two exceptions

**Exceptions to additivity, which must be stated and tested.**

- The `goal_approvals` insert guards in migrations 026 (around lines 8–17) and 027 (around lines 10–20) pin the approval action types and digests. A v2 confirmation needs its own action type, so those guards must be extended. The change must leave v1 approval acceptance and rejection exactly as they are. A regression test is required.
- The read-side literal `contentPreservation: 'not_proven'` is a closed type in `src/shared/goalApi.ts` (around lines 190, 199, 210, 446, 883) and is required by a 027 insert trigger (around line 225). A v2 record needs a `verified` value. Every consumer must be updated and must fail compilation if a case is missing: the shared types, the standing claim (`completionStanding`), the UI, and `src/server/goals/retention.ts` (around lines 221–230), which keys on ancestry.

Otherwise:

- **Do not alter `goal_external_integration_attestations` or `goal_external_completion_proofs`.** Migrations 026 and 027 keep their `CHECK` constraints and their triggers for v1 rows.
- Add new tables for v2 evidence, for example `goal_content_verifications` (identity, verifier version 2, changed-path count, mismatch digest, observed destination tree) and a v2 completion record, each with its own digest and append-only triggers.
- Existing v1 completions stay historical. They are not re-verified and not rewritten. Their completion proofs keep their current digests, and they stay `not_proven`.
- New completions can use v2 only after the migration and verifier are shipped and tested. Until then, v1 remains the only path.
- The action digest for a v2 confirmation uses a new domain string, so a v2 digest can never collide with a v1 digest.

## 5. Test plan (for after approval)

Fixtures in a temporary repository, each asserting the state, not just the HTTP status:

1. Fast-forward with the Goal's content: verified.
2. True merge where the destination kept the source's content: verified.
3. `merge -s ours`: ancestry true, `content_not_preserved`.
4. A conflict resolution that edits the Goal's content: `content_not_preserved`.
5. A destination-only change that does not touch the Goal's paths: verified.
6. Rename, deletion, mode change, symlink, submodule entry, LFS pointer, and a path name with unusual bytes.
7. Changed-path count over the cap: `content_observation_too_large`.
8. Destination moves during observation: the existing before/after check still fails closed.
9. Existing v1 records are unchanged after migration: record digests, the trigger set and the schema SQL for the v1 tables.
10. A v2 row cannot be inserted into the v1 tables (the `CHECK` constraints still hold).
11. Directory/file replacement and file-type change (symlink to file) fixtures.
12. The cap boundary value, both at and one above the limit.
13. Shallow clone and missing-object fixtures: `object_missing`, never verified.

## 6. Decisions for the owner

1. Approve the new verifier, the table-based migration, and the fail-closed reasons.
2. Decide whether Policy B (the explicit historical path) stays available for conflict-resolved merges. Goals already completed under v1 stay as they are.
3. Decide how LFS repositories are handled: refuse, or accept the disclosed pointer-only limit.
4. Decide the cap on changed paths.
5. Confirm that Turing must not perform any Git write to make a merge verify.
6. Decide the later-edit rule (section 3): compare at the merge commit, or at the tip.

No implementation begins until these are decided.

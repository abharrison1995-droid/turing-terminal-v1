# Workflows

A saved workflow is an ordered list of stages. At run creation Turing copies the workflow into a snapshot, so later edits do not rewrite a run already in progress. Preview resolves the selected project, provider assignments, model IDs, permission label, branch strategy, and warnings before the user starts a run.

## Stage behavior

| Stage                      | Behavior                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planner                    | Calls the selected provider with a planning prompt.                                                                                                                                                                                |
| Prompt refinement          | Optional first enabled stage. Produces a bounded JSON specification, ambiguities, and questions; pauses for user review even when there are no questions. Later stages use the confirmed specification and optional clarification. |
| Implementer                | Calls the selected provider to edit the working copy.                                                                                                                                                                              |
| Build / Test               | Runs the matching project package script when configured; skips with a reason when absent.                                                                                                                                         |
| Reviewer / Parallel review | Sends the current diff and prior build/test results to one or more configured reviewers. Output must include a readable JSON `findings` array.                                                                                     |
| Consolidation              | Calls the selected provider to consolidate reviewer findings.                                                                                                                                                                      |
| Remediation                | Runs up to `maxRemediationRounds`; after each pass, invokes the workflow's enabled reviewer stage and stops early when no open findings remain.                                                                                    |
| Final gate                 | Requires a JSON pass/fail verdict. A malformed verdict or `pass: false` fails the run.                                                                                                                                             |
| Git checkpoint             | Saves a restorable tree snapshot under a run-scoped Git ref without creating a branch commit; asks first in Supervised mode.                                                                                                       |
| Git commit                 | Stages and commits only the registered project subtree on the isolated Turing branch; Supervised and Normal ask, YOLO/ENIGMA may proceed.                                                                                          |
| Git push                   | Pushes the run branch to the configured remote and destination without force; always asks, including in ENIGMA.                                                                                                                    |
| Git merge                  | Shows a redacted diff and waits for approval, then fast-forwards the unchanged starting branch only.                                                                                                                               |
| Git rollback / restore     | Always asks before restoring to the run start or latest earlier checkpoint in the isolated project subtree.                                                                                                                        |
| Conditional branch         | Evaluates a typed condition against prior build, test, review, or final-gate results and skips configured later stages when false.                                                                                                 |
| Shell command              | Uses the broker and permits only configured `build`, `test`, or `lint` package scripts.                                                                                                                                            |
| Human approval             | Persists an approval request and waits for a user decision in Turing. Broker operations can also pause on the same approval engine.                                                                                                |
| Notification               | Emits a notification event and reaches connected browser clients that granted notification permission.                                                                                                                             |

Review stages require machine-readable output. Malformed reviewer output fails the stage and remains in its persisted output for inspection; it is not counted as an empty review. Review findings are deduplicated by description. Each remediation pass reopens findings that still appear in the subsequent review.

Prompt refinement is off by default. Add and configure a Prompt refinement stage in the workflow editor, then enable the workflow default or turn it on for an individual run. The refinement stage must be the first enabled stage. The run remains in `waiting_for_user` until the user edits or accepts the proposed specification and continues, or cancels the run. The pause and draft are persisted across service restarts. Prompt refinement is read-only; it cannot edit project files or run commands. The original request remains in run history, while later workflow stages receive the confirmed specification and any user clarification.

## Profiles and limits

Economy, Balanced, and Maximum currently adjust parallel reviewer count. A workflow's `maxParallelAgents` and each review stage's `parallelism` are capped at eight. Remediation is bounded to zero through five passes. The profile names do not select a model, change provider, or guarantee a particular billing cost.

Provider assignments are explicit per AI stage. Turing will not silently fall back to another provider or model if an assignment is missing, the CLI disappears, or OpenCode no longer reports that model.

## Git and project commands

For a clean Git project with isolation enabled, Turing creates a `turing/<run-id>` worktree at the selected folder's Git root while keeping the stage working directory aligned to the registered subfolder. Dirty projects are blocked from worktree runs. For non-Git folders, or workflows with isolation disabled, stages use the registered project directory directly.

Only package scripts matching `npm|pnpm|yarn|bun run build|test|lint` can be configured. The commands come from project detection or an explicit profile edit. A script may still execute arbitrary code from that repository; see [Security](SECURITY.md).

Git workflow stages require a clean starting repository and isolated worktree execution. Commit and checkpoint reject out-of-project paths, sensitive filenames, symlinked changes, and content matching known credential patterns. Turing-managed commit, push, and merge operations suppress repository hooks; commit signing is disabled for these commits. Merge requires an earlier commit stage, an unchanged clean source checkout, and a fast-forward; the approval includes a redacted diff preview. Push requires an earlier commit, a clean run worktree, and approval in all modes. Rollback always requires approval. It resets only the Turing run branch and restores the registered project subtree; ignored files are preserved. Operation, approval, result, and commit/tree IDs are stored in run history.

The workflow editor supports editing, reordering, duplicating, importing, and exporting saved workflows. Exported JSON contains workflow configuration and should be reviewed before importing into another installation.

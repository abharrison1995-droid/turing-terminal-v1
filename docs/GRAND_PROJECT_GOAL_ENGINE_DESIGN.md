# Grand Project / Goal Engine design

**Status: design proposal, revision 2.2. Stage 0A (launcher extraction) is implemented; nothing else is.** Written on branch `feature/grand-project-goal-engine` from the `v1.0.0-rc2` baseline. File and symbol references were read from that source; where this document says "proposed" it describes something that does not exist yet.

Revision 2 incorporates the independent architecture review: Goal integration branches (Q1), a bounded `RunEngine` extension, atomic Goal run launch with database idempotency, repository-bound evidence, a Goal-level finding lifecycle, versioned Goal definitions with safe amendment, role-specific route validation, provenance-aware availability, stronger final-review independence, asynchronous authoring, and a split Stage 0. A change log is in section 25.

## 1. Goals and non-goals

### Goals

- A persistent, resumable **Grand Project** (a "Goal") that pursues a structured **Goal Contract** across hours, days, or weeks.
- Each unit of work is an **ordinary, finite Turing run** created through the existing run path. The Goal supervisor is a deterministic state machine that launches, observes, and judges runs.
- Completion is decided by the application from **structured, repository-state-bound evidence** against explicit success criteria, never by a model saying "done".
- Role-based routing (orchestrator, implementer, routine reviewers, milestone reviewer, final reviewer) with **pinned routes** and **explicitly authorised route pools**.
- Periodic, milestone, repeated-failure, and final reviews that can **block** progress, with a Goal-level finding lifecycle.
- Unattended multi-cycle progress on a **Turing-owned Goal integration branch**, with the user's branch changed only by an explicit approved final apply.
- Hard bounds on cycles, duration, remediation, concurrency, spend, and required human gates.
- Survives browser close, app close, Master restart, machine restart, and provider exhaustion.
- Anticipates the later Model Opportunity Layer through route pools, availability policy, and reusable route validation records.

### Non-goals

- Turning `RunEngine` into the Goal supervisor or into a long-lived autonomous loop (section 24).
- A second provider/model system, usage ledger, review engine, approval table for in-run approvals, or model catalog.
- Silent provider or model substitution, or any widening of billing rules.
- Model-generated shell, or repository access outside the execution broker.
- Implementing Model Opportunity detection, the Opportunity Board, or opportunity-sourced pools in the first Goal Engine pass.
- Automatic reconciliation of a diverged user base branch (V1 requires manual reconciliation; section 7.4).
- Multi-Goal parallel scheduling (section 12.3) and visual polish (section 16 is behaviour only).

## 2. Existing architecture reused (and the bounded extensions)

| Concern                  | Existing mechanism (verified in RC2 source)                                                                                                                                                               | Goal Engine use                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Run creation             | `makePreview()` and `createQueuedRun()` in `src/server/app.ts`; `makePreview` accepts a `workflowOverride`. `createQueuedRun` inserts the run and then calls `engine.start(id)` immediately               | Extracted into a launcher with a queue step and a separate start step (section 8). Ordinary behaviour unchanged |
| Workflow engine          | `RunEngine.start/cancel/decideApproval`, finite stage graph, retries, remediation rounds, `maxDurationMinutes`, `paused_limit_reached`                                                                    | Unchanged contract. Bounded additive changes only (section 2.1)                                                 |
| Restart reconciliation   | `RunEngine.reconcileInterruptedRuns()` pauses runs in `preparing/running/cancelling/waiting_for_approval`, denies pending approvals, interrupts git operations. **It does not touch `queued` runs**       | Goal reconcile runs afterwards and also recovers goal-linked `queued` runs (section 8)                          |
| Approvals                | `approvals` table (`run_id NOT NULL`); `RunEngine.requestApproval`                                                                                                                                        | Unchanged for anything inside a run. Goal gates use `goal_approvals` plus a common UI model (section 15)        |
| Git merge                | `mergeGitBranch` calls `requestApproval` unconditionally and fast-forwards the user's base branch only if it is clean, on the recorded branch, at the recorded starting commit                            | Not used for per-cycle integration (section 7). Its safety checks are the model for the final apply             |
| Worktrees                | `prepareWorkingCopy` creates `turing/<runid8>` from the source repo HEAD, **requires the source repo to be clean**, records `starting_commit`/`base_branch`. No worktree or branch cleanup exists in RC2  | Extended with a trusted base commit (section 2.1). Retention is an open question (Q6)                           |
| Git stages               | `gitCheckpoint/gitCommit/gitPush/gitMerge/gitRollback`, `git_operations`, path/sensitive-path checks (`assertPathsWithinProject`, `isSensitivePath`)                                                      | Child workflows commit on the run branch with existing stages; the same checks guard integration                |
| Usage ledger             | `usage_events` keyed by `run_id`, canonical and reconciled; `metered_reservations`; `usageAnalytics.ts` `UsageFilter`; `resolved_model_id`                                                                | Goal usage derived by joining runs to cycles to goals. No new ledger                                            |
| Billing                  | `evaluateBillingLane`/`resolveBillingMode`, per-run caps, daily/monthly budgets                                                                                                                           | Unchanged; Goal limits only restrict                                                                            |
| Model config and routing | `ModelConfiguration`, `ConnectionProfile`, `ModelPreset`, `stageDefaults`, `routeMatchesBillingLane`                                                                                                      | Routes are `ModelConfiguration` plus profile references                                                         |
| Model catalog            | `model_catalog_cache`, `applyCatalogCache` (Last Known semantics), `ModelOption.status`, `ProviderStatus.catalogSource`, `classifyModelIdentity` (flags `~`, `latest`, `/auto`, Claude Code aliases only) | Availability policy and validation records (section 10)                                                         |
| Context management       | `ContextPolicy`, `makeStagePrompt`, handoff artifacts                                                                                                                                                     | Goal memory is a bounded task block                                                                             |
| Review findings          | `review_findings` (per run), `normalizeFindings`                                                                                                                                                          | Goal-level lifecycle layered over them (section 11)                                                             |
| Notifications            | `noticeForMasterEvent` (**returns null when the payload has no `runId`**), `deliverPushNotice`                                                                                                            | Extended to accept `goalId` events (section 16)                                                                 |
| Run input                | `runInputSchema` is a non-strict zod object (unknown keys stripped)                                                                                                                                       | Goal origin can never arrive from an HTTP body; tested (section 20)                                             |

### 2.1 Bounded `RunEngine` extension (accepted)

The requirement is: **preserve the finite-run state-machine contract and make only the smallest additive Git/run-origin changes needed for Goal-owned integration branches.** A Goal child run is still finite, separately snapshotted, cancellable, independently recoverable, billing-checked, context-bounded, and permission-controlled. The permitted engine changes are exactly:

1. `prepareWorkingCopy`: when the run row carries a trusted `goal_base_commit`, create `turing/<runid8>` from that commit instead of the source HEAD and **skip the source-checkout-clean check** (the user's checkout is not involved). Records `starting_commit = goal_base_commit` and `base_branch = NULL`. **Goal branch ownership stays outside `RunEngine`:** the authoritative Goal branch is `goal_runtime.goal_branch` and its expected tip is `goal_runtime.integration_head`. Goal child workflows contain no `gitMerge`, `gitPush` or `gitRollback` stage, so `runs.base_branch` has no operational use for them, and the engine is not taught about Goals merely to populate a historical field. The integration module (Stage 1) advances the ref independently.
2. Capture the exact repository state a deterministic stage verified: `build`, `test`, and lint/`shellCommand` stage outputs gain `subjectTree` (tree object of the working state, computed with a temporary index so the real index is untouched) and `subjectCommit` (worktree HEAD). Additive output fields; existing consumers ignore them.
3. Read nothing else. The engine does not learn about Goals, cycles, evidence, or routes.

No other `RunEngine` behaviour changes. Everything else is supervisor-side.

## 3. Domain model and storage

### 3.1 Principles

- **Approved definitions are immutable** and versioned as a whole (section 9). Mutable runtime state (counters, accumulated time, integration head, memory) lives in a separate table and never inside approved configuration.
- **One authoritative direction of linkage** between cycles and runs: `runs.goal_cycle_id` + `runs.goal_run_purpose`. `goal_cycles` does not store run ids.
- **Machine-readable codes separate from human detail**: `status_reason_code` (enumerated) and `status_detail_json`.
- **Evidence is immutable and repository-bound**; staleness is computed, not written.
- Goals are never hard-deleted in V1 (archive via `abandoned`/`completed`); foreign keys use default `NO ACTION`, so history cannot be orphaned.

### 3.2 Entities

- **GrandProject (`goals`)**: identity, project/machine, title, status, status code and detail, pointer to the current approved definition version, active milestone.
- **GoalDefinition (`goal_definition_versions`)**: immutable full definition = contract + milestones + routing policy + review policy + limits, with deterministic hash.
- **GoalContract**, **GoalMilestone spec**, **GoalRoutingPolicy**, **GoalReviewPolicy**, **GoalLimits**: members of the definition (types in section 5).
- **GoalRuntime (`goal_runtime`)**: mutable counters, accumulated active time, integration state, bounded memory.
- **GoalCycle (`goal_cycles`)**: one bounded unit of autonomous progress; runs attach to it by purpose.
- **GoalEvidence**, **GoalReview**, **GoalFinding**, **GoalApproval**, **GoalIntegrationOp**, **RouteValidation**, **GoalEvent**.

## 4. Migrations

Two additive migrations, split by whether `runs` needs a foreign key into them (SQLite cannot add a foreign key to an existing column later without a table rebuild, so everything `runs` points at must exist when the column is added):

- **`015_goal_core.sql` (Stage 0B)**: `goals`, `goal_definition_versions`, `goal_milestones`, `goal_runtime`, `goal_cycles`, `goal_integration_ops`, the three new `runs` columns, indexes, and triggers. Ships with schema tests and **no supervisor logic**.
- **`017_goal_evidence_reviews.sql` (Stage 2)**: `goal_evidence`, `goal_reviews`, `goal_findings`, `goal_finding_observations`, `goal_approvals`, `goal_events`, `route_validations`.

Both are applied by the existing `runMigrations()` (lexical, transactional, recorded in `schema_migrations`). A database upgraded from RC2 keeps all history; no backfill. `db.test.ts` is extended for both migrations, and a dedicated test exercises every foreign key and trigger under `PRAGMA foreign_keys = ON` (which `openDatabase` sets).

### 4.1 `015_goal_core.sql` (summary; normative columns)

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('draft','ready','running','reviewing','needs_user','blocked','paused','completed','abandoned')),
  status_reason_code TEXT,             -- enumerated, section 6.3; recovery keys off this
  status_detail_json TEXT,             -- human-readable and structured detail only
  current_definition_version INTEGER,  -- approved version; NULL while the first draft is unapproved
  active_milestone_id TEXT,            -- must belong to this Goal (composite FK below)
  created_at TEXT NOT NULL, approved_at TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
  -- Both deferred: a Goal row and its first definition/milestone rows are written in one transaction in any order.
  -- Composite foreign keys are not enforced while any column is NULL, so a draft Goal (NULL pointers) is valid.
  FOREIGN KEY (id, current_definition_version) REFERENCES goal_definition_versions(goal_id, version)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, active_milestone_id) REFERENCES goal_milestones(goal_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE goal_definition_versions (       -- immutable once approved (trigger)
  goal_id TEXT NOT NULL REFERENCES goals(id),
  version INTEGER NOT NULL,
  parent_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','superseded','rejected')),
  contract_json TEXT NOT NULL,
  milestones_json TEXT NOT NULL,
  routing_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,              -- SHA-256 of canonical JSON of the five parts
  change_summary TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('user','authoring_run','amendment_assist')),
  approved_by TEXT CHECK (approved_by IS NULL OR approved_by = 'user'),
  approval_id TEXT,                           -- goal_approvals.id (017); no FK across migrations
  created_at TEXT NOT NULL, approved_at TEXT,
  PRIMARY KEY (goal_id, version)
);

CREATE TABLE goal_milestones (                -- runtime status of a milestone identified by its stable key
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  milestone_key TEXT NOT NULL,                -- stable author id inside the definitions
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','in_review','satisfied','blocked','skipped')),
  satisfied_at TEXT,
  UNIQUE (goal_id, milestone_key),
  UNIQUE (goal_id, id)                        -- target of same-owner composite foreign keys
);

CREATE TABLE goal_runtime (                   -- mutable; 1:1 with goals
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  cycles_executed INTEGER NOT NULL DEFAULT 0,
  consecutive_failed_cycles INTEGER NOT NULL DEFAULT 0,
  remediation_attempts_json TEXT NOT NULL DEFAULT '{}',   -- per milestone key
  active_ms INTEGER NOT NULL DEFAULT 0,
  base_branch TEXT, base_commit TEXT,         -- the user's branch and commit the Goal started from
  goal_branch TEXT, integration_head TEXT,    -- turing/goal/<id> and its current expected tip
  memory_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE goal_cycles (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  definition_version INTEGER,                 -- version this cycle ran under; NULL only for kind = 'authoring'
  milestone_id TEXT REFERENCES goal_milestones(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('authoring','execution','remediation','review','verification')),
  trigger_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('planned','proposing','proposed','launching','running','collecting','integrating',
     'succeeded','failed','cancelled','rejected')),
  base_integration_commit TEXT,               -- Goal HEAD when the cycle began
  result_integration_commit TEXT,             -- Goal HEAD after integration (NULL if none)
  validated_task_json TEXT,                   -- NextTask after deterministic validation
  route_resolution_json TEXT,                 -- section 10.4
  outcome_json TEXT,
  next_action_code TEXT,
  created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (goal_id, sequence),
  CHECK ((kind = 'authoring') OR (definition_version IS NOT NULL)),
  UNIQUE (goal_id, id),                       -- target of same-owner composite foreign keys (017 tables)
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions(goal_id, version),
  FOREIGN KEY (goal_id, milestone_id) REFERENCES goal_milestones(goal_id, id)   -- a cycle cannot use another Goal's milestone
);

CREATE TABLE goal_integration_ops (           -- durable record of every ref movement (section 7)
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  cycle_id TEXT,
  run_id TEXT REFERENCES runs(id),
  op TEXT NOT NULL CHECK (op IN ('init_ref','advance','apply_to_base')),
  expected_old TEXT, new_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','applied','failed','aborted')),
  checks_json TEXT NOT NULL,                  -- the invariants evaluated and their results
  error_code TEXT,
  created_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY (goal_id, cycle_id) REFERENCES goal_cycles(goal_id, id)
  -- trigger: when run_id is set, runs.goal_cycle_id must equal cycle_id (an op cannot cite another Goal's run)
);

ALTER TABLE runs ADD COLUMN goal_cycle_id TEXT REFERENCES goal_cycles(id);
ALTER TABLE runs ADD COLUMN goal_run_purpose TEXT
  CHECK (goal_run_purpose IS NULL OR goal_run_purpose IN
    ('authoring','proposal','execution','review','remediation','verification'));
ALTER TABLE runs ADD COLUMN goal_base_commit TEXT      -- trusted; set only by server code; lowercase hex of length 40 or 64
  CHECK (goal_base_commit IS NULL OR (length(goal_base_commit) IN (40, 64) AND goal_base_commit NOT GLOB '*[^0-9a-f]*'));

-- All-or-none origin metadata and per-purpose idempotency
CREATE UNIQUE INDEX idx_runs_goal_cycle_purpose ON runs(goal_cycle_id, goal_run_purpose)
  WHERE goal_cycle_id IS NOT NULL;
-- triggers (a CHECK on ADD COLUMN cannot span columns), on INSERT and UPDATE:
--   goal_cycle_id NULL     -> goal_run_purpose NULL and goal_base_commit NULL
--   goal_cycle_id NOT NULL -> goal_run_purpose NOT NULL (goal_base_commit stays nullable, e.g. initial authoring)
--   origin columns are immutable once the run row exists (set at insert or never)
-- Server code, not SQL, validates that a non-null goal_base_commit exists in the registered repository.
-- trigger: goal_definition_versions rows with status approved/superseded reject UPDATE of the five definition columns, hash and identity;
--          approved rows may only move to superseded; superseded and rejected are terminal; approved/superseded rows cannot be deleted
-- At most one approved definition per Goal:
CREATE UNIQUE INDEX idx_goal_one_approved_definition ON goal_definition_versions(goal_id) WHERE status = 'approved';
-- Amendment approval is one transaction: N approved -> superseded, N+1 proposed -> approved, goals.current_definition_version = N+1.
-- trigger: goal_integration_ops with a run_id require that runs.goal_cycle_id equals cycle_id
CREATE UNIQUE INDEX idx_goal_one_active_per_project ON goals(project_id)
  WHERE status IN ('running','reviewing','needs_user','blocked','paused');
-- Authoring cycles exist before any definition does, so definition_version may be NULL only when kind = 'authoring'.
-- Every other kind must carry a version (the CHECK above). A composite FOREIGN KEY is not enforced when any column is NULL,
-- so non-null values stay protected. No placeholder 'version 0' is created. Authoring usage is attributed through
-- run -> goal_cycle -> goal, not through a definition. Stage 0B tests: NULL accepted for authoring, rejected for every other kind,
-- and a non-null version that does not exist is rejected by the foreign key.
CREATE INDEX idx_goal_cycles_goal ON goal_cycles(goal_id, sequence);
CREATE INDEX idx_runs_goal_cycle ON runs(goal_cycle_id);
```

**Same-owner rule (applies to 017 as well).** Wherever a row carries both `goal_id` and a child key (`milestone_id`, `cycle_id`, `review_id`), the pair is a composite foreign key to `(goal_id, id)` of the child table, never a bare child id next to an independent `goal_id`. 017 tables follow this and are tested with deliberate cross-Goal inserts.

`runs.goal_id` is intentionally **not** added: the Goal of a run is `runs.goal_cycle_id → goal_cycles.goal_id`. A convenience view `goal_runs(run_id, goal_id, cycle_id, purpose)` supports queries. `goal_cycles.proposal_run_id` and `goal_cycles.run_id` from revision 1 are removed (answering the review's question: they are not necessary and would be a second source of truth).

Foreign keys that were application-only in revision 1 are now declared: `goals.active_milestone_id → goal_milestones(id)` (circular with `goal_milestones.goal_id → goals(id)`, hence `DEFERRABLE INITIALLY DEFERRED`, exercised in tests), `runs.goal_cycle_id → goal_cycles(id)`, `goal_cycles` to its definition version, `goal_integration_ops` to cycles/runs. `ALTER TABLE ADD COLUMN ... REFERENCES` with a `NULL` default is permitted by SQLite when foreign keys are on; Stage 0B proves this against a migrated RC2 database before anything depends on it (Q5).

The unique index `idx_goal_one_active_per_project` is the **project lease**. `needs_user` is in the set, so a Goal that is being amended (section 9.3) keeps its lease. `draft` and `ready` do not hold it; starting a Goal can fail on the index, which the API reports as "another Goal is active on this project".

### 4.2 `017_goal_evidence_reviews.sql` (Stage 2; summary)

```sql
CREATE TABLE goal_evidence (                  -- immutable; no superseded_by
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  definition_version INTEGER NOT NULL,
  milestone_id TEXT REFERENCES goal_milestones(id),
  criterion_key TEXT NOT NULL,
  verifier_digest TEXT NOT NULL,              -- hash of the verifier spec this evidence answers
  kind TEXT NOT NULL CHECK (kind IN
    ('test_result','build_result','lint_result','run_result','commit','review_verdict','artifact','user_confirmation')),
  verdict TEXT NOT NULL CHECK (verdict IN ('satisfies','contradicts','inconclusive')),
  cycle_id TEXT REFERENCES goal_cycles(id),
  run_id TEXT REFERENCES runs(id),
  stage_id TEXT REFERENCES stages(id),
  subject_commit TEXT,                        -- repository state proved (section 11.1)
  subject_tree TEXT,
  subject_path TEXT, subject_blob TEXT, subject_sha256 TEXT,
  reviewed_from_commit TEXT, reviewed_to_commit TEXT, reviewed_to_tree TEXT,
  ref_json TEXT NOT NULL,                     -- typed pointer: exit code, summary, review id, approval id
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER goal_evidence_immutable BEFORE UPDATE ON goal_evidence BEGIN SELECT RAISE(ABORT, 'goal_evidence is immutable'); END;

CREATE TABLE goal_reviews ( id, goal_id, cycle_id, definition_version, review_kind, verdict, blocking,
  reviewed_from_commit, reviewed_to_commit, reviewed_to_tree, report_json, independence_json, created_at, completed_at );
CREATE TABLE goal_findings ( id, goal_id, fingerprint, severity, category, description, affected_files_json,
  status, first_seen_review_id, last_seen_review_id, resolved_by_review_id, resolution_basis_json,
  created_at, updated_at );
CREATE TABLE goal_finding_observations ( id, goal_finding_id, review_id, run_finding_id, observation, basis, created_at );
CREATE TABLE goal_approvals ( id, goal_id, gate, risk, reason, requested_by, detail_json, status,
  decided_by, decision_note, created_at, responded_at );
CREATE TABLE goal_events ( id, goal_id, type, payload_json, created_at );
CREATE TABLE route_validations ( id, identity_hash, identity_json, profile, status, evidence_run_id,
  resolved_model_reported, checks_json, provenance, adapter_version, capability_fingerprint,
  tested_at, expires_at );
```

## 5. Shared types (`src/shared/goals.ts`, proposed)

Names are normative; field lists are the minimum.

```ts
export type GoalStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'reviewing'
  | 'needs_user'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'abandoned';
export type GoalRunPurpose =
  'authoring' | 'proposal' | 'execution' | 'review' | 'remediation' | 'verification';
export type GoalCycleKind = 'authoring' | 'execution' | 'remediation' | 'review' | 'verification';
export type GoalRole =
  'orchestrator' | 'implementer' | 'routine_reviewer' | 'milestone_reviewer' | 'final_reviewer';

/** Trusted server-side launch context. Never parsed from HTTP bodies or model output. */
export interface RunOrigin {
  goalCycleId: string;
  goalRunPurpose: GoalRunPurpose;
  goalBaseCommit?: string; // full 40-hex SHA resolved by deterministic server code
}

export interface GoalDefinition {
  // the unit that is versioned, hashed, and approved
  contract: GoalContract;
  milestones: GoalMilestoneSpec[];
  routing: GoalRoutingPolicy;
  review: GoalReviewPolicy;
  limits: GoalLimits;
}

export interface GoalContract {
  outcome: string;
  successCriteria: SuccessCriterion[];
  nonGoals: string[];
  constraints: string[];
  deliverables: Deliverable[];
  completionPolicy: CompletionPolicy;
}

export interface SuccessCriterion {
  key: string; // stable across definition versions
  statement: string;
  verification: VerificationSpec[];
  required: boolean;
}

export type VerificationSpec =
  | { kind: 'build'; command?: string[] }
  | { kind: 'test'; command?: string[] }
  | { kind: 'lint'; command?: string[] }
  | { kind: 'file_exists'; path: string } // content-bound artifact
  | { kind: 'review_verdict'; reviewKind: 'milestone' | 'final' }
  | { kind: 'commit_on_branch' }
  | { kind: 'user_confirmation'; prompt: string; freshness: 'any' | 'head-bound' };

export interface CompletionPolicy {
  requireFinalReview: boolean;
  requireUserAcceptance: boolean; // default true
  applyToBase: 'required' | 'leave-on-goal-branch'; // default 'required' (section 7.4)
  maxOpenFindings: { critical: 0; high: 0; medium?: number };
  highSeverityResolution: 'review-only' | 'review-plus-head-bound-verifier'; // default the latter
}

export interface GoalMilestoneSpec {
  key: string;
  title: string;
  objective: string;
  criteria: string[]; // criterion keys
  dependsOn: string[];
  allowedScope: { includeGlobs: string[]; excludeGlobs: string[] };
  requiredEvidence: Array<{ criterionKey: string; kinds: GoalEvidenceKind[] }>;
  reviewRequirements: { milestoneReview: boolean };
}

export type RouteAvailability = 'live-catalog' | 'fresh-validation' | 'live-catalog-or-fresh-validation';
export type FreshnessClass = 'stable-subscription' | 'opportunity'; // 7 days / 24 hours
export type ValidationProfile =
  'structured-readonly' | 'review-json' | 'orchestrator-json' | 'broker-read' | 'broker-edit';

export interface RouteMember {
  configuration: ModelConfiguration; // exact route; billing lane fixed here
  identityKind?: 'pinned' | 'floating' | 'unknown'; // user may declare; see 13
  freshnessClass: FreshnessClass;
}

export type GoalRoute =
  | { kind: 'pinned'; member: RouteMember; availability: RouteAvailability; requireRoleValidation: boolean }
  | { kind: 'pool'; poolId: string };

export interface RoutePool {
  id: string;
  label: string;
  members: RouteMember[]; // ordered, explicit, user-approved
  admission: 'static' | 'opportunity'; // 'opportunity' rejected by validation until that layer exists
  availability: RouteAvailability;
  requireRoleValidation: boolean; // default true for pools
  selection: 'ordered' | 'round_robin';
  laneClass: 'subscription' | 'permitted-by-billing-mode';
  autoRevalidate: false; // reserved; true is rejected in V1 (no silent allowance use)
}

export interface GoalRoutingPolicy {
  roles: Partial<Record<GoalRole, GoalRoute>>;
  pools: RoutePool[];
  workflows: { planning: string; execution: string; review: string; verification: string };
  independence: IndependencePolicy;
}

export interface IndependencePolicy {
  finalReview: 'different-family' | 'different-model' | 'none'; // default 'different-family'
  against: Array<'implementer' | 'remediation' | 'orchestrator'>; // default implementer, remediation
  allowFloatingFinalReviewer: boolean; // default false
}

export interface GoalReviewPolicy {
  periodic?: {
    everyNExecutionCycles: number;
    reviewerCount: number;
    scope: 'since_last_review' | 'full_diff';
  };
  onMilestoneComplete: boolean;
  onRepeatedFailure?: { afterConsecutiveFailures: number };
  onScopeChange?: { pathsOutsideScopeAtLeast: number; diffLinesAtLeast?: number };
  final: boolean;
  blocking: { periodic: boolean; milestone: true; final: true };
}

export interface GoalLimits {
  maxExecutionCycles: number;
  maxConsecutiveFailedCycles: number;
  maxRemediationAttempts: number; // per milestone
  maxActiveMinutes: number; // Running + Reviewing only
  maxWallClockDays: number; // from approval; pause does not stop it
  maxParallelAgents: number;
  maxMeteredUsd: number | null; // null only if the billing mode forbids metered lanes
  billingMode: BillingMode; // never more permissive than the child workflows'
  humanGates: GoalHumanGates;
}

export interface GoalHumanGates {
  eachCycle: boolean;
  beforeMilestoneComplete: boolean;
  poolRouteFirstUse: boolean; // default true
  finalAcceptance: boolean; // default true; final apply to the base branch always gated
}

export interface NextTask {
  milestoneKey: string;
  title: string;
  instructions: string; // bounded length
  targetCriteria: string[];
  expectedPaths: string[]; // inside the milestone's allowedScope
  workflowId?: string; // within the goal's permitted workflows
  rationale: string;
}

export type GoalEvidenceKind =
  | 'test_result'
  | 'build_result'
  | 'lint_result'
  | 'run_result'
  | 'commit'
  | 'review_verdict'
  | 'artifact'
  | 'user_confirmation';
```

## 6. Goal state machine

The supervisor is the only writer of `goals.status`. Every transition is one function `transitionGoal(goalId, to, reasonCode, detail)` that validates the table, writes `goal_events`, and rejects illegal moves inside one transaction. **Models produce only `NextTask`, `ReviewReport`, and draft definitions; they cannot call `transitionGoal`.**

### 6.1 Transitions

| From                              | To                       | Caused by (deterministic)                                                                                           |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `draft`                           | `ready`                  | User approves definition version 1 (`goal_approvals` gate `definition`), validation passes                          |
| `draft`, `ready`                  | `abandoned`              | User                                                                                                                |
| `ready`                           | `running`                | User Start and preflight passes (section 7.1; routes ready; billing; lease)                                         |
| `ready`                           | `draft`                  | User starts a revision of an unapproved/ready definition                                                            |
| `running`                         | `reviewing`              | A review trigger fires (section 11)                                                                                 |
| `running`                         | `needs_user`             | Human gate; run interrupted by restart; scope violation; divergence; user-confirmation criterion; amendment started |
| `running`                         | `blocked`                | Hard bound, route/provider unavailable, ref changed, evidence contradiction, invalid Git state                      |
| `running`                         | `paused`                 | User pause or clean Master shutdown                                                                                 |
| `running`                         | `completed`              | `evaluateCompletion` passes and required gates satisfied (section 6.2)                                              |
| `reviewing`                       | `running`                | Review verdict non-blocking                                                                                         |
| `reviewing`                       | `blocked` / `needs_user` | Review `block` / decision required                                                                                  |
| `needs_user`                      | `running`                | Gate resolved, run resumed, amendment approved and preflight passes, or amendment discarded                         |
| `needs_user`, `blocked`, `paused` | `abandoned`              | User                                                                                                                |
| `blocked`                         | `running`                | Blocker resolved, or a limit-raising definition version approved (section 9)                                        |
| `blocked`, `paused`               | `needs_user`             | User starts an amendment (`amendment_in_progress`)                                                                  |
| `paused`                          | `running`                | User resume; preflight and reconcile re-run                                                                         |
| `completed`, `abandoned`          | none                     | Terminal                                                                                                            |

### 6.2 Completion check (`evaluateCompletion`)

A pure function of persisted rows plus **fresh repository reads at the current Goal integration HEAD**. It runs inside the completing transition with no child run in flight (the supervisor is the sole writer of the Goal ref, so HEAD cannot move during the check). All must hold:

1. Every `required` success criterion has, for every verifier of its **current** definition, at least one evidence row that is `satisfies` and **not stale at HEAD** (section 11.1), with the latest non-stale row not `contradicts`.
2. Every milestone is `satisfied` or explicitly `skipped` by the user.
3. Goal-level findings (section 11.4) within `maxOpenFindings`.
4. If `requireFinalReview`: a `final` review with verdict `pass` whose reviewed tree equals the HEAD tree and whose route satisfies the independence policy (section 13).
5. If `requireUserAcceptance`: an approved `final_acceptance` goal approval bound to the HEAD tree.
6. If `applyToBase = required`: the final apply (section 7.4) succeeded, or the user closed the Goal as applied externally (Q3).

A model's claim of completion creates at most an `inconclusive` evidence row and a displayed recommendation.

### 6.3 Status reason codes (enumerated; recovery keys off these)

- `needs_user`: `gate_pending`, `run_interrupted`, `scope_violation`, `base_diverged`, `user_confirmation_pending`, `review_needs_decision`, `amendment_in_progress`, `verification_failed`.
- `blocked`: `bound_cycles`, `bound_failures`, `bound_remediation`, `bound_active_time`, `bound_wall_clock`, `bound_spend`, `provider_exhausted`, `provider_unavailable`, `route_unavailable`, `goal_ref_changed`, `goal_ref_missing`, `evidence_contradiction`, `git_state_invalid`, `review_blocked`.
- `paused`: `user`, `master_shutdown`.

`status_detail_json` carries the human text and structured specifics (for example the provider's reported reset time or the divergence summary).

## 7. Goal integration branch

### 7.1 Ownership

Each active Goal owns exactly one Git ref, `refs/heads/turing/goal/<goal-id>`. The branch name is generated from the goal UUID (it satisfies the engine's `isSafeGitBranch` rules and cannot collide with run branches, which are `turing/<8-hex>`). The Goal branch is **never checked out anywhere**: it is advanced only with `git update-ref` and never by a worktree, so no checkout can fall out of sync with it. Preflight (every start and resume) verifies that `git worktree list` shows no worktree on that branch and that the ref still equals `goal_runtime.integration_head`; otherwise the Goal blocks with `goal_ref_changed`/`goal_ref_missing`. A persistent Goal worktree is **not** needed: child runs, reviews, and verification all use ordinary run worktrees based on the Goal HEAD.

At Goal start:

```
user base branch ── base_commit (recorded in goal_runtime: base_branch, base_commit)
        │
        └── turing/goal/<id> created at base_commit by compare-and-swap create
```

The user's checkout may stay dirty or be worked in during a Goal. Uncommitted user changes are **not** part of the Goal's base (the base is a commit); this is stated in the Start preflight.

### 7.2 Child runs on the Goal branch

The supervisor launches a child run with trusted `goalBaseCommit = integration_head`. The engine creates `turing/<run8>` from exactly that commit (section 2.1). Goal workflows must have `isolatedWorktree: true` for **every** Goal child run, including read-only roles (RC2's default Review Only workflow uses `isolatedWorktree: false` and would otherwise read the user's checkout instead of the Goal state). Goal workflows contain no `gitMerge`/`gitPush`/`gitRollback` stages; validation rejects them.

### 7.3 Advancing the Goal ref (internal integration)

After an execution/remediation run reaches a terminal state, `integrate(cycle)`:

```
H0 = cycle.base_integration_commit            T = tip of the run's branch turing/<run8>
checks (all must hold; each result recorded in goal_integration_ops.checks_json):
  C1 goal status is 'running' (not paused, amending, or blocked)
  C2 runs.goal_base_commit == H0 == goal_runtime.integration_head == current value of the Goal ref
  C3 T is a strict descendant of H0 (`git merge-base --is-ancestor H0 T`, T != H0); T == H0 is outcome 'no_change'
  C4 the run is 'completed' AND no persisted stage is failed or cancelled or otherwise non-concluded: every stage is 'passed' or 'skipped'.
     A stage that failed under continueOnFailure can still leave the run 'completed'; that is not integration-safe
     (rejection codes run_stage_failed / run_stage_incomplete, with bounded stage detail)
  C5 the run worktree is clean (porcelain, untracked included) and its HEAD == T
  C6 every changed path in H0..T: inside the registered project subfolder; none sensitive (isSensitivePath);
     the diff passes secret detection (hasSuspectedSecret)
  C7 every changed path is inside the active milestone's allowedScope (else outcome 'scope_violation', not integrated, goal needs_user or scope_change review)
  C8 no blocking review or gate applies (no pending blocking goal_approvals; Goal findings within the thresholds for continuing)
action:
  1. INSERT goal_integration_ops(op='advance', status='planned', expected_old=H0, new_commit=T, checks_json)
  2. git update-ref -m "turing goal <id> cycle <n>" refs/heads/turing/goal/<id> T H0     # native compare-and-swap
  3. in one SQLite transaction: op -> 'applied'; goal_runtime.integration_head = T;
     cycle.result_integration_commit = T; cycle.status = 'succeeded'
failure handling:
  any check false BEFORE the planned op exists -> advanceGoalRef returns 'rejected' with the check results; no op row is written and nothing
     moves. The supervisor records the higher-level rejected cycle outcome as a goal_event and updates counters.
  once the planned op row exists, the attempt has an immutable op record (applied, aborted or failed)
  update-ref reports the ref != H0 -> op 'failed', Goal -> blocked(goal_ref_changed). Never merge, never retry blindly.
```

`update-ref <ref> <new> <old>` fails atomically if the ref's current value is not `<old>`; this is the expected-old-ref compare-and-swap. `update-ref` is run with an empty `core.hooksPath` because `reference-transaction` hooks could otherwise observe or interfere with the ref change. This is internal integration of a Turing-owned ref and does not modify the user's branch.

**Crash recovery between steps 1 and 3.** On reconcile, any op in `planned` is resolved by reading the ref: equal to `new_commit` → complete step 3 (apply); equal to `expected_old` → mark `aborted` and let the cycle be re-integrated by re-running checks; anything else → `blocked(goal_ref_changed)`.

**Verification state.** Integration does not by itself prove that the integrated tree builds or passes tests. Evidence is produced at HEAD by section 11.1 (stage `subjectTree` capture, or a deterministic `verification` run with no AI stages when evidence is missing or stale).

### 7.4 Final application to the user's branch

Applying `turing/goal/<id>` to the base branch is **high risk and explicitly user-approved**, mirroring `mergeGitBranch`'s philosophy:

```
precondition: completion checks 1-5 of 6.2 pass (the Goal is "ready to apply"), or applyToBase = leave-on-goal-branch
gate: goal_approvals(gate='final_apply', risk='high', reason = diff stat + bounded diff preview of base_commit..integration_head)
on approval, re-check immediately before acting (the user's checkout can change while pending):
  source checkout clean (porcelain, untracked included)
  current branch == goal_runtime.base_branch
  HEAD == goal_runtime.base_commit
  integration_head == the value the approval was bound to; changed paths still pass section 7.3 C6
  then: git merge --ff-only turing/goal/<id>   (hooks disabled, as the engine's gitWithHooksDisabled)
  record goal_integration_ops(op='apply_to_base'); the existing safety posture: no force, no merge commit, no conflict resolution
```

**If the base branch diverged** (HEAD != `base_commit`, wrong branch, or dirty), Turing does not rebase, merge, or resolve anything. The Goal moves to `needs_user` with `base_diverged`, presenting the divergence (the two commit ranges, ahead/behind counts, whether files overlap). **V1 limitation, documented:** divergence requires manual reconciliation outside Turing (the user merges or rebases `turing/goal/<id>` themselves). Afterwards the user may abandon the Goal or close it as applied externally (Q3). Future versions may add an assisted reconciliation Goal.

## 8. Run launch, idempotency, and recovery

### 8.1 Launcher split (Stage 0A pure extraction, Stage 0B origin support)

The launcher is extracted from `app.ts` into `src/server/runLauncher.ts` as separate operations:

```
buildPreview(db, input, workflowOverride?, context?: RunLaunchContext)   // = makePreview; context is server-internal
queueRun(db, preview, options, origin?): { runId, existed }   // one SQLite transaction
startQueuedRun(db, engine, runId): { started: true } | { started: false, reason }   // starts only a persisted 'queued' run that is not active
createRun(db, engine, preview, options) = queueRun(...) then startQueuedRun(...)   // the existing human/API path
```

**Trusted launch context.** `RunLaunchContext { origin?: RunOrigin }` is a narrow internal type that never appears in `RunInput`; `runInputSchema` remains the public boundary and keeps stripping unknown keys, so `ignoreDirty`, `allowDirty` and `goalBaseCommit` cannot be sent over HTTP. RC2 `buildPreview` blocks an isolated run when `project.gitRoot && workflow.isolatedWorktree && project.dirty !== false`, correct for an ordinary run whose worktree starts from the registered HEAD. A Goal child run starts from an explicit trusted integration commit and the user checkout may stay dirty while the Goal works. A Goal-origin preview therefore treats checkout dirtiness as **informational** (reported, but not a blocker, not a warning that sets `canStart = false`) only when all hold: the `RunOrigin` was built by trusted server code; `goalBaseCommit` is present and a full lowercase commit SHA; the workflow is isolated; the commit is verified to exist in the registered repository (`git cat-file -e <sha>^{commit}`); and the context did not come from request fields. Otherwise the ordinary rule applies. Ordinary runs keep blocking on a dirty checkout.

**Recovery-safe start.** `startQueuedRun` reads the persisted status first. `queued` and not already active in the engine returns `{ started: true }` after calling `engine.start`; any other status (`paused`, `waiting_for_approval`, running, terminal, unknown run) returns `{ started: false, reason }` and never takes the fresh-start path. `RunEngine.start` still guards concurrent in-memory execution; the launcher additionally enforces the persisted-state invariant. Resuming a paused run remains the existing `engine.start(id, true)` path, used deliberately by the user, not by reconcile calling a helper twice.

`createRun` preserves RC2's exact behaviour and events for ordinary runs. Only trusted server code can construct a `RunOrigin`; `runInputSchema` strips unknown keys, and a test asserts that goal fields in an HTTP body are ignored.

### 8.2 `queueRun` transaction (Goal-origin)

Within one transaction: if `origin` is present, first `SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = ?` and return the existing run (`existed: true`) if found; otherwise insert the run row **including** `goal_cycle_id`, `goal_run_purpose`, `goal_base_commit`, its stages, its `run_queued` event, (`goal_cycles.status` is not changed here; cycle state belongs to the supervisor/state machine). The partial unique index `(goal_cycle_id, goal_run_purpose)` makes a duplicate impossible even under a race. Commit. **Only then** `startQueuedRun`. A crash can leave a committed, goal-linked run in `queued`; a started Goal child run whose Goal/cycle cannot be discovered cannot exist because the link is part of the same transaction as the run row.

### 8.3 Recovery matrix

`goalSupervisor.reconcile()` runs after `engine.reconcileInterruptedRuns()`:

| Persisted state                                  | Action                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cycle `launching`, run `queued`                  | `startQueuedRun`. A `queued` run has not begun `RunEngine.execute`, so none of its stages (and therefore none of its provider calls) has run; starting it cannot duplicate a call. RC2's own reconcile ignores `queued` runs, an existing gap for ordinary runs (Q4) that Goal reconcile covers for Goal runs only |
| Cycle `launching`, no run row                    | Create it via `queueRun` (idempotent by unique index)                                                                                                                                                                                                                                                              |
| Run `paused` (restart)                           | Goal `needs_user(run_interrupted)`; user resume calls the existing `engine.start(id, true)`. `autoResumeAfterRestart` is off by default                                                                                                                                                                            |
| Run terminal, cycle still `running`/`collecting` | Resume at collection; evidence writes are idempotent (keyed by cycle, criterion, kind, run, stage)                                                                                                                                                                                                                 |
| Cycle `integrating` with a `planned` op          | Section 7.3 recovery                                                                                                                                                                                                                                                                                               |
| Cycle `proposing`/`proposed`                     | Observe or validate the existing proposal run; never create a second proposal run for the same cycle                                                                                                                                                                                                               |
| Any attempt to re-run a purpose                  | Requires a **new cycle** (new `sequence`); one run per (cycle, purpose) is invariant                                                                                                                                                                                                                               |

## 9. Goal definition versioning and safe amendment

### 9.1 Versioning

The full approved definition (contract, milestones, routing, review policy, limits) is stored in `goal_definition_versions`, hashed deterministically (SHA-256 of canonical JSON), and **immutable once `approved`** (enforced by trigger). `goals.current_definition_version` points to the approved version. Each non-authoring cycle stores its `definition_version` (authoring cycles store NULL, since no approved definition exists yet); each route resolution stores the version and hash (section 10.4); each evidence row stores `definition_version` and `verifier_digest`; each review stores its version. History is never rewritten: a cycle created under version 3 is explained by version 3 even after version 4 is approved. Approvals of pool first use are bound to the member identity hash, not to a definition version, so they survive amendments that do not change the member.

### 9.2 Amendment flow

Models never approve amendments; only the user, through a `goal_approvals` decision recorded with `approved_by = 'user'`.

1. Goal references approved version N and continues.
2. User chooses **Revise Goal**. The supervisor **quiesces**: launches no new run; an in-flight child run may finish (its evidence is recorded under N) or be cancelled by the user. The Goal moves to `needs_user(amendment_in_progress)`. This status is in the project-lease index set, so the lease is not lost.
3. A **proposed** version N+1 row is created (`status = 'proposed'`, editable; optionally assisted by an `authoring`-purpose run whose output only fills the proposal).
4. The user reviews a diff of N vs N+1 (including limits, routes, pools, and criteria changes) and a computed impact summary.
5. Approval makes N+1 current: in one transaction N → `superseded`, N+1 → `approved`, `goals.current_definition_version` updated, milestone runtime rows reconciled by `milestone_key` (new milestones `pending`, removed ones `skipped` with reason, changed objectives re-opened).
6. Staleness rules apply deterministically (section 11.1): evidence whose `verifier_digest` no longer matches the current criterion's verifier, or whose criterion was removed, stops counting; nothing is rewritten.
7. The supervisor re-runs preflight; the Goal returns to `running` (or `blocked` with a code).
8. "Discard amendment" marks N+1 `rejected` and returns to `running`.

Raising a bound (for example after `blocked(bound_cycles)`) is the same flow with a limits-only change (a fast path in the UI, still a full version). Runtime counters are not reset by an amendment; raising a limit simply lifts the corresponding block. Billing mode in `limits` can never become more permissive than the permitted child workflows (validated at approval).

## 10. Routing, availability, and validation

### 10.1 Route resolution

`resolveRoutes(goal, roles)` is a **pure function** of the approved routing policy (by version), the cached provider/catalog snapshot, connection profiles, the effective billing mode, validation records, and prior resolution records. No network, no generation prompt, no state mutation. It returns a concrete `ModelConfiguration` per role plus an audit record, or a reasoned refusal.

- **Pinned route.** Exactly the stored configuration. If it is not ready (profile missing, provider undetected, lane blocked, availability requirement unmet), resolution **refuses**; the Goal becomes `blocked(route_unavailable)` or `needs_user`. No substitution exists.
- **Authorised pool.** An explicit, ordered allow-list. A member is eligible only if all hold: lane permitted by the effective billing mode and `laneClass` (never a metered lane when the mode forbids it); provider readiness passes; the **availability requirement** is met (10.2); if `requireRoleValidation`, a **fresh validation record exists for the requested role** (10.3); user approval of first use exists when `poolRouteFirstUse` is on. If no member is eligible the result is a refusal, never a fallback outside the pool.
- **Selection** is derived deterministically, so no mutable cursor is stored: `ordered` picks the first eligible member in declared order; `round_robin` picks the next eligible member after the member recorded in the most recent resolution for that pool and role, cycling in declared order. The approved policy is never modified to advance selection (the revision-1 `pool_state` idea is dropped).
- **Application** by constructing a `workflowOverride` passed to `buildPreview`, so inheritance and provider-lock rules apply. Saved workflows are never mutated.

### 10.2 Provenance-aware availability

```ts
type RouteAvailability = 'live-catalog' | 'fresh-validation' | 'live-catalog-or-fresh-validation';
```

- **`live-catalog`** is satisfied only when the provider has authoritative discovery (`capabilities.modelDiscovery`), the catalog is live (`catalogSource` is `live`, not `cache`), and the model is present with status `current`. `last-known`, `unavailable`, and `deprecated` do not satisfy it; a failed refresh never raises eligibility and never deletes cached entries.
- **`fresh-validation`** is satisfied by a non-expired role-appropriate validation record for the exact route (10.3). Required for providers without reliable account-visible discovery. Per the RC2 capability matrix, Cline CLI discovery is **Unsupported** and Claude Code discovery is **Partial** (aliases and IDs only), so routes on those backends can be available only through this clause.
- **`live-catalog-or-fresh-validation`** accepts either.

Availability answers "can this route run at all" and role validation answers "is it suitable for this role"; pools may require both. The later Opportunity Layer adds "advertised" and "locally discovered" as separate, weaker states that satisfy neither requirement by themselves. Advertised does not mean executable; executable does not mean free; exhaustion of a free or promotional route never converts to a metered lane (section 18).

### 10.3 Route validation records (`route_validations`; reusable, not Goal-specific)

A validation is an explicit record about an **exact route**, not "a model once answered".

- **Identity** (`identity_hash` = SHA-256 of canonical `identity_json`): backend id; provider id; billing lane; connection profile id plus its backend/provider/lane (never credentials); exact configured model id; variant id; reasoning and `nativeSettings`; adapter version; **capability fingerprint** (hash of the model's reported capability fields: tool support, structured output, reasoning control, context length, identity kind, catalog status class). Any change in these produces a different hash, so the old record **expires early by key mismatch**; no separate invalidation is needed.
- **Profiles** (a record is per profile): `structured-readonly` (returns schema-valid JSON from a read-only task), `review-json` (produces a schema-valid `ReviewReport` for a seeded diff with a planted defect), `orchestrator-json` (produces a schema-valid `NextTask` and refuses a planted out-of-scope instruction), `broker-read` (reads only through the broker, no write attempt succeeds), `broker-edit` (performs a specified edit and commit in a fixture worktree within scope and nothing outside it).
- **Role requirements:** orchestrator ⇒ `orchestrator-json` + `broker-read`; routine/milestone/final reviewer ⇒ `review-json` + `broker-read`; implementer ⇒ `broker-edit` + `broker-read`. A reviewer validation never qualifies a route as an implementer.
- **Recorded:** profile, evidence run id (the probe is an ordinary child run in a throwaway fixture repo, so usage and billing are normal), request ids, resolved model as reported by telemetry where available, per-check results, result (`pass`/`fail`), tested time, expiry, and provenance (`turing_probe_run`).
- **Freshness:** `freshnessClass` per member: `opportunity` (temporary, free, experimental, or stealth) 24 hours; `stable-subscription` 7 days. Defaults conservative; configurable later.
- **No silent spend.** A catalog refresh is not a validation. An expired record makes the member ineligible; Turing does **not** re-run a probe to refresh it unless the user has explicitly started validation for that route (`autoRevalidate` is reserved and rejected in V1).

### 10.4 Recorded resolution

`goal_cycles.route_resolution_json` stores per role: definition version and hash, route kind, pool id, the evaluated members with eligibility reasons (including expiry times and catalog status/provenance used), the selected configuration and its identity hash, the validation record id(s) relied on, and the independence evaluation when applicable. Every child run additionally snapshots concrete routes through `workflow_snapshot_json` and `stages.model_snapshot_json`.

## 11. Evidence, findings, and reviews

### 11.1 Evidence bound to repository state

Evidence rows are immutable. Staleness is **computed** from the row plus current repository state at the Goal integration HEAD (read from Git objects, not a worktree), never by mutating older rows.

| Kind                                         | Binding written at creation                                               | Valid at HEAD when                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `build_result`, `test_result`, `lint_result` | `subject_tree` (and `subject_commit`) captured by the stage (section 2.1) | `subject_tree == tree(HEAD)`                                                                                                       |
| `artifact` (`file_exists`)                   | `subject_path`, `subject_blob`, `subject_sha256`                          | the blob at `HEAD:<path>` still has the recorded blob id/hash                                                                      |
| `commit`                                     | `subject_commit`                                                          | `subject_commit` is an ancestor of, or equal to, HEAD                                                                              |
| `review_verdict`                             | `reviewed_from_commit`, `reviewed_to_commit`, `reviewed_to_tree`          | milestone/final verifiers: `reviewed_to_tree == tree(HEAD)`. Periodic reviews inform findings but are never accepted as a verifier |
| `user_confirmation`                          | `subject_tree` when `freshness = 'head-bound'`                            | per its `freshness` (final acceptance is `head-bound`)                                                                             |
| `run_result`                                 | run id                                                                    | informational only; never satisfies a repository-behaviour criterion                                                               |

Also required for validity: `verifier_digest` equals the digest of the criterion's verifier in the **current** definition. A `contradicts` row that is itself current at HEAD makes the criterion unsatisfied regardless of older passes.

**Producing HEAD-bound evidence.** After integration the supervisor reads each deterministic stage's captured `subjectTree`. If it equals `tree(HEAD)` the evidence is recorded as valid. If the engine did not capture it, or a later cycle changed the tree, the supervisor schedules a **`verification` cycle**: an ordinary run of a built-in workflow containing only `build`/`test`/`lint` stages (no AI stage, so no provider spend) on a worktree at HEAD, which records fresh evidence. A final Goal completion therefore cannot succeed on a test result from an older implementation state; if evidence is stale, `evaluateCompletion` fails and requests verification.

### 11.2 Review runs

Reviews are ordinary child runs (`parallelReview` + `consolidate` + `finalGate` stages already exist) on the Goal HEAD, with routes resolved for the review role. Triggers (deterministic): every N execution cycles; milestone criteria all satisfied; consecutive failures reaching the configured threshold below the hard limit; scope change; final. Each review stores the reviewed commit range and tree. Reviewer count maps to workflow `parallelism`, clamped to `maxParallelAgents`.

### 11.3 `ReviewReport`

```ts
interface ReviewReport {
  verdict: 'pass' | 'pass_with_findings' | 'block';
  criterionProgress: Array<{
    criterionKey;
    assessment: 'met' | 'partial' | 'not_met' | 'unknown';
    basis: string;
  }>; // advisory
  existingFindings: Array<{
    goalFindingId: string;
    status: 'still_open' | 'resolved' | 'not_assessed';
    basis: string;
  }>;
  newFindings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    category;
    description;
    evidence;
    affectedFiles;
    remediation;
  }>;
  regressions: string[];
  scopeDrift: boolean;
  architectureDrift: boolean;
  furtherWorkJustified: boolean;
}
```

`criterionProgress` is advisory; it can create `inconclusive` evidence or recommend blocking, but only deterministic verifiers produce `satisfies`.

### 11.4 Goal-level finding lifecycle

RC2 `review_findings` are per run and deduplicated only within a run. A Goal needs identity across runs. This is the lifecycle over existing review output, **not a second review engine**: per-run findings still exist and are linked.

- `goal_findings`: stable id, Goal, fingerprint, severity, category, description, affected files, status (`open`, `resolved`, `accepted_by_user`, `dismissed_by_user`), first/last seen review, resolved-by review, timestamps.
- `goal_finding_observations`: each review's observation (`new`, `still_open`, `resolved`, `reopened`, `not_assessed`) with the linked per-run `review_findings` row.
- **Prompts** to review stages include the open Goal findings (bounded: highest severity first, at most 25) **with their stable ids**, and require the structured `existingFindings`/`newFindings` split above.
- **Matching:** a reviewer's `newFinding` whose fingerprint (category + normalised affected paths + normalised title) equals an open Goal finding is recorded as a `still_open` observation, deterministically deduplicated. Fingerprints are only used for that dedupe; they never resolve anything.
- **Resolution:** a finding is never resolved because it is absent from a later response; absence is `not_assessed` and the finding stays open. `resolved` requires an explicit `resolved` status from a review whose reviewed range includes the change. For `critical`/`high`, `highSeverityResolution` (default `review-plus-head-bound-verifier`) additionally requires current HEAD-bound passing build/test evidence. Users may accept or dismiss a finding (recorded, user-only).
- Completion thresholds and "may continue" checks (C8 in 7.3) read **Goal-level finding state**.
- Blocking findings create `remediation` cycles, bounded by `maxRemediationAttempts` per milestone.

## 12. Bounds, scheduling, and duration

### 12.1 Bounds (`enforceBounds`, checked before every launch and after every run)

| Bound                        | Meaning                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `maxExecutionCycles`         | Execution + remediation cycles (reviews and verification excluded from this count, included in time and spend)                      |
| `maxConsecutiveFailedCycles` | Failed, rejected, `no_change`, or `scope_violation` cycles in a row                                                                 |
| `maxRemediationAttempts`     | Per milestone                                                                                                                       |
| `maxActiveMinutes`           | Accumulated `active_ms` in `running` and `reviewing` only                                                                           |
| `maxWallClockDays`           | From approval, regardless of pause state                                                                                            |
| `maxParallelAgents`          | Clamp on every child workflow's `maxParallelAgents` and review parallelism                                                          |
| `maxMeteredUsd`              | Reconciled metered actuals plus open reservations for the Goal's runs, compared before each launch                                  |
| Human gates                  | Section 7.4 and the supervisor gates                                                                                                |
| Per-run limits               | Each child run keeps its own `maxDurationMinutes`, retries, remediation rounds, and metered per-run cap; the Goal never raises them |

There is no unbounded `while`: the supervisor performs at most one transition per Goal per tick, every launch is gated by `enforceBounds`, and counters are persisted transactionally with the cycle row they belong to.

### 12.2 Duration accounting

`maxActiveMinutes` counts only `running` and `reviewing` time; `paused`, `needs_user`, and `blocked` time is excluded. `maxWallClockDays` continues from approval. The supervisor measures active time with a **monotonic process clock** (`process.hrtime`), adds the delta to `goal_runtime.active_ms`, and persists at least every 15 seconds and on every transition. A crash can therefore lose at most one persist interval per restart. Restart begins a new monotonic interval from the persisted value; downtime is not counted. A crash loop could under-count active time by one interval per crash; this is bounded by the wall-clock and cycle limits and by `blocked`-on-repeated-failure behaviour.

### 12.3 Concurrency (V1)

One child run in flight per Goal; one active Goal per project (the unique index); and a **global supervisor limit of one running Goal** (`settings` key `goal_max_running`, default 1). Parallel agents inside the currently executing workflow remain supported. The scheduler selects Goals by a deterministic order and reads the limit from the setting, so raising it later needs no schema change. Multi-Goal provider scheduling is out of scope.

## 13. Final-review independence

Same backend/provider/model comparison is insufficient: the same underlying model through two providers is not independent. The policy is explicit (`IndependencePolicy`):

- **Model key.** `underlyingModelKey` is derived from (a) the **resolved model id reported by telemetry** (`usage_events.resolved_model_id`) where available, else (b) the configured model id, normalised by a code-maintained `modelFamily()` function (strip provider prefixes, `:free`-style route suffixes, and variant; map known aliases to a family and version). Unknown ids use their normalised full id as the family, which can only make independence harder to claim, never easier.
- **Authority set.** The set of keys (configured and resolved) of every route that produced implementation or remediation commits in the Goal, plus the orchestrator when `against` includes it. Resolved keys are recorded on each cycle outcome from usage telemetry.
- **Default** `finalReview: 'different-family'` against implementer and remediation: the final reviewer's family key must not appear in the authority set. `'different-model'` compares exact keys; `'none'` is allowed but recorded.
- **Floating or unknowable identity.** A route classified `floating` by `classifyModelIdentity`, or declared `floating`/`unknown` on the pool member (RC2's classifier recognises only `~`, `latest`, `/auto`, and Claude Code aliases, so a user can additionally declare anonymous/stealth routes), cannot establish independence. With the default `allowFloatingFinalReviewer: false` such a route is ineligible for the final review role; if the user allows it, the review records an explicit "independence not established" uncertainty that the UI shows.
- Routine review swarms may use several instances of one model and have no independence requirement.
- The evaluation is stored in `goal_reviews.independence_json`.

## 14. Authoring is asynchronous

`POST /api/goals/authoring` (body: project, free text, a pinned authoring route) in one transaction creates a **draft Goal**, an **authoring cycle** (`kind = 'authoring'`, sequence 0), and queues the **authoring child run** (`purpose = 'authoring'`, read-only planner workflow), then starts it after commit and **returns `202 { goalId, cycleId, runId }` immediately**. No HTTP request stays open while a model works. The client follows progress with the existing polling and SSE patterns. When the run finishes, the supervisor parses its strict structured output into a **proposed definition version 1** and emits `goal_authoring_completed`; parse failure sets `status_reason_code = authoring_failed` on the draft, leaves it editable, and permits a new authoring cycle. Authoring usage belongs to the Goal because its run is linked to the Goal's cycle. A draft is outside the project lease.

## 15. API and preview

All under `/api/goals`, same security model as other routes. Bodies use zod schemas. Status mutations go only through `transitionGoal`.

| Method and path                                                                        | Purpose                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/goals`, `GET /api/goals/:id`                                                 | List and detail (current definition, runtime counters, memory, integration head, current cycle, next action, "needs you") |
| `POST /api/goals/authoring`                                                            | Asynchronous authoring (section 14)                                                                                       |
| `POST /api/goals`, `PUT /api/goals/:id/definitions/:version`                           | Create a draft; edit a **proposed** version only; returns validation results                                              |
| `POST /api/goals/:id/definitions`                                                      | Start an amendment (proposed N+1), including limits-only                                                                  |
| `POST /api/goals/:id/definitions/:version/approve` / `/reject`                         | User approval (`goal_approvals`), never by a model                                                                        |
| `POST /api/goals/:id/start`, `/pause`, `/resume`, `/abandon`                           | State commands returning preflight results or refusal codes                                                               |
| `GET /api/goals/:id/cycles`, `/evidence`, `/reviews`, `/findings`, `/events`, `/usage` | Activity, evidence with computed staleness, review reports, Goal findings, audit, usage (shared analytics)                |
| `GET /api/goals/:id/preview`                                                           | **Read-only**; see below                                                                                                  |
| `GET /api/approvals/unified`                                                           | Run approvals and Goal approvals through one UI model                                                                     |
| `POST /api/goal-approvals/:id/decision`                                                | Decide a goal-level gate                                                                                                  |
| `POST /api/route-validations`                                                          | User-initiated route validation (explicit allowance use)                                                                  |
| `GET /api/events?goalId=`                                                              | SSE for goal events through the existing subscriber set                                                                   |

**`GET /api/goals/:id/preview` never calls a provider for generation and never mutates state.** It shows the Goal state, current definition, candidate routing (a dry-run of `resolveRoutes`, no cursor advance), provider readiness and billing evaluation, limits and remaining headroom, the active milestone, and whether a proposal is required. If a validated proposal is already persisted, it shows that `NextTask`; otherwise it states that proposal generation is required and does not fabricate a task. Proposal generation is always an explicit child run.

**Unified approvals.** The UI consumes `UnifiedApproval { source: 'run' | 'goal', id, runId?, goalId?, title, reason, risk, status, requestedBy, decidedBy, createdAt, respondedAt }`. Run approvals keep their table and endpoint; goal approvals keep theirs, with first-class `reason`, `risk`, `decided_by`, and `decision_note` columns. One Approval surface renders both. `DashboardSnapshot` gains `goals` and `goalApprovals` additively.

## 16. Client behaviour and notifications (minimum V1 surfaces)

Behavioural spec; visual design follows `DESIGN.md` later.

1. **Grand Projects list** (a `goals` page in the `Page` union): title, project, status and reason, active milestone, last cycle, next action, "needs you", usage.
2. **Create Goal**: free text → asynchronous authoring run → editable proposed definition (outcome, criteria with verifiers, non-goals, constraints, deliverables, milestones, roles/routes/pools, review policy, limits) → **explicit user approval** with validation and billing summary.
3. **Goal Overview** answers on one screen: what we are building; what success means (criteria with evidence status **including stale evidence marked stale**); active milestone and remaining criteria; the last cycle's outcome; what Turing does next; the orchestrator route; implementing/reviewing agents with resolved routes and lanes; when the next independent review is due; blockers (reason codes); whether the user is needed; the integration branch name and head; project usage with provenance.
4. **Activity**: child runs grouped under the Goal by cycle and purpose; resolved routes per cycle; event log.
5. **Reviews and findings**: reports and the Goal-level finding list with lifecycle.
6. **Evidence**: per criterion, typed rows with staleness at the current HEAD.
7. **Definitions**: version history and amendment diff.
8. **Usage**: existing analytics filtered by Goal.
9. **Phone cockpit**: status, unified approvals, pause/resume, "needs you" notifications; no definition authoring on the phone in the first pass.

`noticeForMasterEvent` currently returns `null` when a payload has no `runId`; it is extended (additively) to accept `goalId` events (needs you, blocked with reason, completed, review blocked, `final_apply` ready), de-duplicated by key.

## 17. Security implications

- **Models never gain authority.** They emit JSON parsed against strict schemas and validated; they cannot change routes, limits, billing, scope, workflows, definitions, or state.
- **Git refs are never model-visible or model-supplied.** `goalBaseCommit` is a SHA resolved by deterministic server code; `RunOrigin` is not accepted from any HTTP body (non-strict `runInputSchema` strips it; tested) or model output.
- **Prompt injection.** Memory and file content are data in a task block under the existing precedence statement; `NextTask.instructions` is length-capped and scanned (`hasSuspectedSecret`, `redactSecrets`); routes, limits, and permission mode are never read from model output.
- **No generated shell.** Verification commands come only from the approved definition and pass `isSafeProjectCommand` or are the project's registered commands; they run in child runs through the broker path.
- **Repository access** stays inside the broker. `allowedScope` can only narrow context, never widen it. Integration re-applies project-subfolder, sensitive-path, and secret checks.
- **User branch protection.** Per-cycle integration changes only a Turing-owned ref. The user's branch changes only by the approved final apply with the re-checks in 7.4; no force, no merge commit, no conflict resolution.
- **Permission mode** for child runs cannot be raised by the supervisor; `enigma` still needs deliberate per-run activation, which the Goal Engine never supplies.
- **Secrets**: definitions, memory, routes, pools, and validation records hold profile ids and labels, never credentials.
- **Audit**: `goal_events` + `goal_integration_ops` + `run_events` + `git_operations`; definition versions and evidence are immutable.
- **Unattended execution** is the new risk class; mitigations are conservative defaults, gates on first pool use and final apply, bounded everything, `blocked` as the default failure state, and no automatic allowance use for revalidation.

## 18. Billing implications

- Each child run is evaluated by the existing `evaluateBillingLane` through `buildPreview`; the Goal Engine cannot widen a mode. `GoalLimits.billingMode` is validated to be no more permissive than every workflow it can launch; the effective mode is the stricter.
- Subscriptions Only remains the default and blocks metered lanes for every cycle including pool members. A metered-lane member is rejected at validation under that mode and ineligible at resolution if the mode later changes.
- A member's lane is fixed in its configuration; **the supervisor has no code path that selects a different lane for the same member**. If a free or promotional route is exhausted, the provider call fails, the cycle fails or blocks, and the member becomes unavailable or ineligible on the next resolution. Free-to-metered conversion cannot occur silently.
- Provider-side PAYG fallback remains unverifiable and is disclosed as in Run Preview.
- Route validation probes are ordinary billed child runs under the same rules and are user-initiated only.
- `maxMeteredUsd` is an additional Goal cap over existing reservations and cannot raise per-run or desktop budgets.
- Goal usage is `usage_events u JOIN runs r ON r.id = u.run_id JOIN goal_cycles c ON c.id = r.goal_cycle_id` filtered by `c.goal_id`; `UsageFilter` gains `goalId`. No second ledger or reservation mechanism.

## 19. Context-management strategy and project memory

- Goal context is a structured, size-capped block placed in the child task; stage context policies keep governing reads. Defaults for Goal child workflows: `changed-files` with the milestone `allowedScope` as include globs for implementers and reviewers; `artifacts-only` plus the memory block for proposal runs.
- Between cycles the only carried state is bounded `GoalMemory` plus Git. No transcripts, no provider session resume.

```ts
interface GoalMemory {
  // goal_runtime.memory_json; rebuilt from persisted rows after every cycle
  schemaVersion: 1;
  definition: { version: number; hash: string };
  contractDigest: {
    outcome: string;
    criteria: Array<{ key; statement; status: 'satisfied' | 'stale' | 'unmet' | 'contradicted' }>;
  };
  activeMilestone: { key; objective; unresolvedCriteria: string[] };
  completedMilestones: Array<{ key; title; satisfiedAt }>;
  lastCycle: { sequence; kind; outcome; summary /* <= 800 chars */; changedFiles: string[] /* <= 30 */ };
  decisions: Array<{ id; text /* <= 300 chars */; cycle }>; // max 20, oldest compacted
  openFindings: Array<{ goalFindingId; severity; summary; files }>; // from goal_findings, max 25
  blockers: string[]; // max 10
  repo: { baseBranch; baseCommit; integrationHead; checkedAt }; // read from Git each cycle
  nextHint?: string; // advisory
}
```

- The serialized block is capped (target ≤ 4,000 estimated tokens, using the engine's estimator) with deterministic compaction order (oldest decisions, then completed-milestone lines, then summaries), set below the stage's `maxEstimatedTokens` so the mandatory task block never forces a stage to stop. The supervisor refuses to launch when the preview's context estimate exceeds the limit under the Ask/Stop policy.

## 20. Test strategy

Deterministic only (no live providers), using existing fixtures and fake provider adapters.

1. **Migrations**: 014 → 015 → 016 (integration-op audit) → 017 upgrade; every foreign key and trigger under `PRAGMA foreign_keys = ON`, including the circular `goals`↔`goal_milestones` deferral; immutability triggers; unique partial indexes; all-or-none origin trigger.
2. **Run origin (Stage 0B)**: goal fields are ignored when sent in an HTTP body; ordinary runs unchanged byte-for-byte in rows, events, and behaviour; `prepareWorkingCopy` starts from `goal_base_commit` and ignores a dirty user checkout; engine `subjectTree` capture matches a recomputed tree and leaves the real index untouched.
3. **Launch/idempotency**: queue-before-start; crash injection between queue, link, and start; duplicate `queueRun` yields one run (unique index); reconcile starts a `queued` Goal run exactly once; no second provider call.
4. **Integration git module** (temp repositories): CAS create and advance; stale expected-old fails without moving the ref; non-descendant, dirty worktree, out-of-scope path, sensitive path, secret-looking diff, and `no_change` cases; `planned` op recovery for each of the three ref states; Goal ref checked out elsewhere is detected; final apply happy path and diverged/dirty/wrong-branch paths performing no merge.
5. **State machine**: exhaustive legal/illegal transition table; only `transitionGoal` writes status.
6. **Contract and definition validation**: table-driven (missing non-model verifier, uncovered criterion, cyclic milestones, scope escapes, unsafe command, unbounded limits, metered cap vs mode, opportunity pool rejected, goal workflows lacking `isolatedWorktree`).
7. **Amendment**: quiesce, lease retained, diff, approval by user only, deterministic staleness, counters preserved, history immutable.
8. **Evidence freshness**: tree-bound test evidence goes stale after a later cycle; artifact content change; commit ancestry; review tree match; `contradicts` wins; verification cycle repairs staleness with no AI stage; completion fails on stale evidence.
9. **Findings lifecycle**: stable ids across reviews; absence ≠ resolved; fingerprint dedupe; high-severity resolution requires HEAD-bound evidence; thresholds read Goal-level state.
10. **Cycle loop with a fake executor**: proposal → validate → launch → evidence → integrate → next; bound violations (cycles, failures, remediation, minutes, spend, days); no unbounded loop.
11. **Restart/resume** at every cycle status; idempotent resume; interrupted run → `needs_user`; pending goal approvals persist.
12. **Routing**: pinned refusal without substitution; pool eligibility by availability clause (including Cline/Claude discovery-less paths) and role validation freshness; early expiry by identity change; derived round-robin determinism; failed catalog refresh never raises eligibility; independence by family and floating identity; recorded resolution.
13. **Billing**: Subscriptions Only blocks metered members; no free-to-metered path after exhaustion; goal mode cannot exceed workflow mode; `maxMeteredUsd` blocks the next launch; no automatic revalidation spend.
14. **Duration**: monotonic accumulation, persist interval, pause exclusion, wall clock.
15. **Context, usage, API, client, regression**: memory cap and compaction; goal-filtered analytics equal child-run sums with provenance preserved; async authoring returns 202 immediately; preview never calls a provider and never mutates; unified approvals; component tests; and the full existing suite (172 tests at RC2) green with the no-goal path unchanged.

## 21. Migration and backward compatibility

- A database with no goals behaves exactly as RC2. Existing-table changes are three nullable `runs` columns; existing run queries select `r.*` and `toRun` maps named columns, so they are unaffected (covered by regression tests). Ordinary runs have `NULL` goal columns.
- Existing workflows are untouched; Goals reference saved workflows by id and apply routes through `workflowOverride`. Goal templates in workflow export/import are deferred.
- API and `DashboardSnapshot` changes are additive; older phone PWAs ignore `goals`.
- Release notes for the next RC must state migrations 015, 016 and 017. Rollback is not supported by the migration runner; RC2 binaries ignore unknown tables and columns.

## 22. Staged implementation plan

Each stage ends with the full gate green, a coherent commit, and an update to `docs/V1_READINESS.md`. Ordinary non-Goal runs must stay behaviourally unchanged at every stage.

- **Stage 0A: launcher extraction (behaviour-preserving).** Move `makePreview` and `createQueuedRun` into `src/server/runLauncher.ts`; introduce `buildPreview`, `queueRun`, `startQueuedRun`, and `createRun` with ordinary semantics identical to RC2 (`createRun` = queue then start). No schema, no Goal metadata. Run the complete regression gate; **commit independently**.
- **Stage 0B: Goal-origin run support.** Migration `015_goal_core.sql` (schema and triggers only, no supervisor); `RunOrigin`, `goal_cycle_id`/`goal_run_purpose`/`goal_base_commit` persisted atomically in `queueRun`; unique idempotency index; trusted-only base commit; the bounded engine changes of section 2.1 (`prepareWorkingCopy` from `goal_base_commit`, `subjectTree` capture); tests for crash/idempotency, trusted-origin enforcement, dirty-checkout bypass, and unchanged ordinary runs. Commit independently.
- **Stage 1: integration git module.** `goalGit.ts`: CAS create/advance of `turing/goal/<id>`, ancestry/tree/blob reads, invariant checks, `goal_integration_ops` recovery, final-apply preconditions. Tested thoroughly against temp repositories before anything depends on it.
- **Stage 2: definitions, validation, state machine, evidence.** Migration 017; `shared/goals.ts`; definition versioning and amendment; validators; `transitionGoal`; evidence staleness; `evaluateCompletion`; Goal findings lifecycle; route validation schema.
- **Stage 3: supervisor core with a fake executor.** Tick loop, bounds, duration accounting, cycle persistence, memory builder, reconcile wired into `index.ts`.
- **Stage 4: real child runs.** Planning, execution, review, and verification workflows seeded as built-ins; evidence from real stage outputs; usage `goalId` filter; async authoring.
- **Stage 5: routing.** Pinned routes, static pools, availability, validation probes (user-initiated), independence, derived selection, first-use gate.
- **Stage 6: reviews and remediation.** Review runs, `ReviewReport` normalisation, triggers, blocking, remediation cycles, goal notifications.
- **Stage 7: API, UI, unified approvals, and end-to-end acceptance with fake providers; documentation (`WORKFLOWS`, `SECURITY`, `BILLING_SAFETY`, `ARCHITECTURE`, a new `GOALS.md`), readiness update.**

Only after stage 7 and a prove-it review does the Model Opportunity Layer begin: Goal Engine foundation → bounded execution proven → periodic review → Model Opportunity Layer → opportunity pools → RC3 → hardening and physical acceptance.

## 23. Risks and open questions

**Open questions (none block Stage 0A)**

- **Q1 — Subject-state capture. (decided, rev 2.1: keep both.)** Section 11.1 uses engine-captured `subjectTree` and, as a fallback, deterministic `verification` runs. Is the small additive engine change in 2.1(2) acceptable, or should HEAD-bound evidence come only from verification runs (no engine change, one extra deterministic run per evidence refresh)? Recommendation: keep both.
- **Q2 — Validation probe design.** Fixture repositories and seeded defects for each profile, and the UX for the user to approve the allowance a probe consumes.
- **Q3 — "Applied externally." (decided, rev 2.1: allowed.)** The user action is "Mark as applied externally". It requires explicit confirmation, records the Goal integration head and the observed base head where available, and creates `user_confirmation` evidence. History and UI distinguish **Applied by Turing** from **Applied externally / user attested**. Original question: After a diverged base requires manual reconciliation, may the user close the Goal as applied externally (a recorded user attestation that bypasses `apply_to_base`)? Recommendation: yes, recorded as `user_confirmation` evidence bound to the integration head.
- **Q4 — RC2 `queued` orphan gap. (decided: tracked for final hardening, not Stage 0A.)** RC2's `reconcileInterruptedRuns` ignores `queued` runs, so an ordinary run queued at the moment of a crash stays queued. Goal reconcile covers only Goal runs. Fixing ordinary runs is a separate hardening defect, not Goal scope.
- **Q5 — SQLite behaviours to prove in Stage 0B (against a migrated RC2 database, foreign keys on; stop and review the fallback if any fails).** `ALTER TABLE ADD COLUMN ... REFERENCES` plus triggers on the migrated RC2 database under foreign keys, and deferred circular foreign keys. If any fails, the fallback is a `runs` table rebuild, which would need its own review.
- **Q6 — Retention. (decided: must be designed and tested before Stage 4.)** A run worktree or branch may be removed automatically only when: the run is terminal; its committed result is durably integrated or deliberately rejected; required evidence is extracted and persisted; the worktree is clean; its commit is reachable from the Goal integration ref or another retained ref; and no recovery operation references the worktree. Never delete merely because a run is old. RC2 never removes run worktrees or branches; a long Goal creates one worktree and branch per run (`~/.turing-terminal/worktrees/<runId>`). A retention policy (prune integrated run worktrees after evidence is collected, keep branches) is needed before long Goals are practical.
- **Q7 — Family normalisation table (decided: small version-controlled table in source; unknown identities fail conservatively to "independence not established")** (`modelFamily()`): maintenance burden and where aliases live.
- **Q8 — Orchestrator in the authority set** for final-review independence: default off (implementers and remediation only). Confirmed in rev 2.1: default is implementers and remediation only; a stricter Goal policy may include the orchestrator.

**Risks**

- Unattended long runs magnify any engine defect; mitigated by bounds, `blocked` as the default failure state, and restart testing.
- Stage 0 touches the central run path; mitigated by splitting 0A (pure extraction) from 0B and characterisation tests.
- A bounded memory block can omit a needed fact; mitigated by structured fields and user-visible memory.
- Review-model agreement is not evidence; reviews are advisory except for blocking, deterministic verifiers decide satisfaction.
- Manual reconciliation of a diverged base is a real V1 limitation for very long Goals on actively developed branches.

## 24. Why `RunEngine` does not become an unbounded autonomous loop

- `RunEngine` keeps its contract: one `runId` in, one finite stage graph executed, hard `maxDurationMinutes`, bounded retries and remediation rounds, terminal status out. The accepted extension is two additive facts (a trusted base commit to start from, and the repository state a deterministic stage verified); neither adds a loop, a callback into the supervisor, or Goal awareness.
- Long-horizon behaviour exists only **above** the engine, as many separate runs created through the same launcher a user's request uses. Each run is independently previewed, billing-checked, snapshotted, approvable, cancellable, and recoverable by the existing reconciliation.
- The unit of autonomy is the **cycle**. The supervisor's repetition is a persisted state machine with explicit bounds, not an in-memory `while`. Between cycles no model session or transcript is alive; state is the definition, runtime row, evidence, findings, and Git.
- The orchestrator is a role in a read-only run. It may only propose a `NextTask` that the application validates; it cannot create stages, change routes, or move state.
- Integration of a cycle's work onto the Goal ref is a deterministic compare-and-swap performed by the supervisor under explicit invariants, not an AI decision and not a `RunEngine` Git stage.

## 25. Change log (revision 1 → 2)

1. **Q1:** Option A withdrawn. `mergeGitBranch` calls `requestApproval` unconditionally and waits for a human decision, so per-cycle merges into the user's branch would require approval every cycle (revision 1 wrongly suggested a permission mode could auto-approve it). Replaced with Goal integration branches and compare-and-swap ref advancement (section 7).
2. **Bounded `RunEngine` extension** accepted and enumerated (2.1); `RunOrigin` defined.
3. **Launch atomicity:** queue-with-linkage in one transaction, then start; no post-hoc `UPDATE` (8).
4. **Run purpose and DB idempotency:** `goal_run_purpose`, partial unique index, canonical `runs → cycle` direction; cycle↔run pointer columns removed (4.1, 8).
5. **Evidence bound to repository state;** staleness computed; verification cycles (11.1).
6. **Goal-level finding lifecycle** (11.4).
7. **Full Goal definition versioning** replaces contract-only versions (9, 4.1).
8. **Safe mid-Goal amendment** with lease retained (9.2).
9. **`goal_approvals` kept**, with first-class reason/risk/decision columns and a unified approval UI model (15).
10. **Separate read-only proposal run kept** (7.2 sequence, 22).
11. **Role-specific route validation** records with identity, profiles, freshness, early expiry by key mismatch, no silent revalidation (10.3).
12. **Provenance-aware availability** replaces `requireCatalogStatus: 'current'` (10.2).
13. **Final-review independence by model family** with floating-identity handling (13).
14. **Authoring is asynchronous** (14).
15. **`GET preview` is read-only** and never fabricates a proposal (15).
16. **Round-robin state derived** from resolution history; no mutable cursor (10.1).
17. **Schema hardening:** declared FKs, split reason code/detail, runtime vs approved separation (3.1, 4.1).
18. **V1 concurrency** limits and scheduler setting (12.3).
19. **Duration semantics** with monotonic accumulation (12.2).
20. **Stage 0 split into 0A and 0B;** integration git module is its own stage (22).
21. Core architecture retained (supervisor above `RunEngine`, finite child runs, strict state machine, structured `NextTask`, deterministic completion, bounded memory, reviews, existing usage/billing/routing, Opportunity Layer deferred).

### Revision 2.1

- `goal_cycles.definition_version` is nullable and a `CHECK` requires it for every kind except `authoring` (section 4.1). The foreign key still protects non-null values.
- Q1, Q3, Q4, Q6, Q7 and Q8 decided as annotated in section 23.
- Stage 0A implemented in `src/server/runLauncher.ts` (`buildPreview`, `queueRun`, `startQueuedRun`, `createRun`).

### Revision 2.2

- Goal-origin previews take a trusted server-internal `RunLaunchContext`; a dirty registered checkout is informational for a valid Goal-origin isolated run and still blocks ordinary runs (section 8.1).
- `RunEngine` does not derive the Goal branch: Goal-origin runs record `starting_commit = goal_base_commit` and `base_branch = NULL`; the Goal branch lives in `goal_runtime` (section 2.1).
- Migration 015 relational invariants: deferred composite foreign keys for `current_definition_version` and `active_milestone_id`; a unique partial index allowing one approved definition per Goal; same-owner composite keys for cycles and integration ops (and the rule for 016); run-origin all-or-none and immutability triggers; a hex/length check on `goal_base_commit` (section 4.1).
- `startQueuedRun(db, engine, runId)` inspects persisted state and returns `{ started }`; only a `queued` run that is not active is started (section 8.1).

### Stage 0B implementation notes (recorded after implementation)

- `015_goal_core.sql`, `RunOrigin`/`createRunOrigin`/`RunLaunchContext`, `queueRun(db, preview, options)` (origin travels on the verified preview as `preview.origin`, so a different origin cannot be supplied at queue time), `startQueuedRun(db, engine, runId)`, `RunEngine.isActive`, base-commit worktrees, and `captureSubjectState` are implemented. All SQLite assumptions in Q5 held; no `runs` rebuild was needed.
- `queueRun` does not update `goal_cycles.status` (section 8.2 listed `launching`). Cycle status transitions belong to the supervisor and its state machine (Stage 2); the cycle status is deliberately not set speculatively here.
- Subject-state capture is taken **before** the command runs (the state being verified), only for runs that carry a `goal_base_commit` (ordinary run rows stay byte-identical), and the tree is HEAD with the **project scope** replaced by the working state. Files outside the project scope stay as HEAD has them, which matches what a scoped commit stage would commit; out-of-scope edits are scope violations handled at integration. Capture failure omits the fields and never fails a stage.
- An origin problem (untrusted object, malformed or missing base commit, non-isolated workflow, cycle of another project) throws `RunOriginError` rather than producing a non-startable preview, so a supervisor that ignores a preview cannot silently create an ordinary run.

### Revision 2.3 (Stage 0B.1 hardening)

- `createRunOrigin` returns a frozen object, so a verified origin cannot be mutated between preview and queueing.
- Migration `015_goal_core.sql` is never edited once applied. `016_goal_integration_op_audit.sql` is additive: it adds `recovery_json`, makes the op identity (`id`, `goal_id`, `cycle_id`, `run_id`, `op`, `expected_old`, `new_commit`, `created_at`) and `checks_json` immutable, allows only `planned -> applied | aborted | failed` (all three terminal and fully immutable), requires inserts to be `planned`, forbids deletes, and allows at most one `planned` op per Goal. Recovery observations are written to `recovery_json`, never over the authorised checks. The planned evidence/review migration is therefore `017_goal_evidence_reviews.sql`.

## Stage 1 implementation notes (`src/server/goalGit.ts`)

Deterministic Goal integration Git mechanics only; no supervisor, AI, routing, evidence or review logic.

- **Hooks.** `update-ref` runs with `-c core.hooksPath=<empty dir>`, because Git's `reference-transaction` hook can fire on ref updates. This corrects §7.3's claim that no hooks run.
- **Rejected attempts are not recorded as ops.** A check failure returns `{outcome:'rejected', code, checks}` and writes nothing; only an attempt that reaches the planned op is audited (applied, failed or aborted). §7.3's "record an aborted op" is deferred to the supervisor, which owns cycle outcomes.
- **Concurrent ref move.** A lost CAS records the op as `failed` with `goal_ref_conflict` and the observed ref in `recovery_json`.
- **Cycle status** is never touched here; only `cycle.result_integration_commit` and `goal_runtime.integration_head` are written, with the op, in one transaction.
- **Goal status check (C1)** is a caller policy (`allowedGoalStatuses`, default `running`).
- **Path scope** uses `git diff --raw -z -M -C --find-copies-harder`, checking old and new paths. Symlink and gitlink destinations are rejected. Milestone scope is an explicit `allowedPaths` policy input.
- **Secret scan** streams the complete `-U0 --text --no-renames` diff and fails closed on a byte cap or any git error; the display preview is separate and bounded.
- **Recovery** only reads the ref. An `advance` op with ref == new_commit completes; ref == expected_old aborts; any other value leaves the op `planned` and returns `goal_ref_changed`.
- **Final apply** is preflight only (`preflightFinalApply`); no function here moves the user's branch. A safe-looking checkout whose Goal diff fails the path/secret scan reports `unsafe_changes`, an addition to the specified result codes.

### Stage 1.1 integration boundary hardening

- C4 now inspects persisted stages: any `failed`/`cancelled` stage gives `run_stage_failed`; any other non-`passed`, non-`skipped` stage (`pending`, `running`, `waiting_*`, unknown) gives `run_stage_incomplete`. `continueOnFailure` is never authority to integrate a failed stage.
- `completeOp` asserts that the `goal_runtime` update and (for an advance with a cycle) the `goal_cycles` update each change exactly one row. Otherwise it throws `bookkeeping_invariant`, the transaction rolls back and the op stays `planned`; nothing is reconstructed silently.

## Stage 2A implementation notes (domain, definition validation, state machine)

Stage 2A is deterministic and has no supervisor, model, route-discovery or evidence-evaluation behaviour. Where it differs from or refines the design above:

- **Migration 017** adds `goal_evidence`, `goal_reviews`, `goal_findings`, `goal_finding_observations`, `goal_approvals`, `goal_events` and `route_validations`. Every child row carries `goal_id` and references its parents through same-owner composite foreign keys onto `UNIQUE(goal_id, id)`. Evidence, observations, events and route validations are immutable; completed reviews keep identity, reviewed commit/tree and report fixed; approvals are `pending` then terminal, and `approved` requires `decided_by = 'user'`. Nothing in the tables is deletable.
- **Goal approvals are separate from run approvals.** The `approvals` table is untouched. The gate list is closed (`GOAL_APPROVAL_GATES`) and there is no model or automatic approval path; the system may only deny.
- **Definition hash:** SHA-256 over canonical JSON (recursively sorted keys, array order significant, non-finite numbers rejected) of exactly `{contract, milestones, routing, review, limits}`.
- **Amendment of an executing Goal** (running, blocked or paused) moves it to `needs_user` with `amendment_in_progress`. Approving the amendment leaves it in `needs_user`; preflight and the return to `running` belong to the Stage 3 supervisor. Discarding a proposal also leaves the Goal in `needs_user`, and a new amendment may be started from there. A `ready` Goal being revised goes to `draft` (`user_revision`) and returns to `ready` on approval, or on discard via the additional `amendment_discarded` reason.
- **State machine preconditions:** every edge into `running` except from `reviewing` requires `preflight`; every edge into `completed` requires `completion_evaluated`. Both are asserted by the caller (the evaluator and supervisor arrive in Stage 2B/3). Edges into `ready` and `running` require an approved current definition. A second Goal taking the project lease raises `project_lease_conflict`.
- **`goal_runtime` is created with the Goal** (at `createGoalDraft`), not at first run, so counters exist before any approval and are never reset by approval.
- **Milestone reconciliation by key:** new keys are inserted pending; a satisfied milestone whose objective or criteria changed is re-opened; a returning skipped key is pending again; removed unfinished keys become `skipped`. Removed keys are ordered after live ones so ordinals stay unique.
- **Validation** is a pure function returning structured `{code, path, severity}` issues, with a separate contextual pass for workflow comparison. Verification commands go through `isSafeProjectCommand`.
- Not in 2A (Stage 2B): `evaluateCompletion`, evidence staleness, evidence collection, verification-cycle scheduling, finding lifecycle, review normalization, final-review independence evaluation, route-validation probing.

## Stage 2A.1 authority and ownership hardening

- **A definition approval means "this exact content".** A Goal approval for a definition or amendment carries `detail = {version, definitionHash}`. `approveDefinition` refuses a supplied approval unless the Goal, the gate (`definition` for a first version, `amendment` otherwise), `detail.version` and `detail.definitionHash` all match the proposal (`approval_mismatch`, or `approval_definition_changed` when only the hash differs). Because a proposal stays editable, an approval requested before an edit is stale and is never reinterpreted.
- **Migration 018 enforces the same binding in SQL**, on `INSERT` of an approved definition and on `proposed -> approved`: the referenced approval must exist, belong to the same Goal, be `approved` with `decided_by = 'user'`, use the gate implied by `parent_version`, and match version and hash. Rows that predate 018 are not re-validated.
- **Run-finding ownership:** `goal_finding_observations.run_finding_id` must belong to the same run as the observation's Goal review (`goal_reviews.run_id = review_findings.run_id`), and a review with no run cannot cite a run finding. Since a review's run is already checked against its Goal, the chain observation -> Goal review -> review run -> run finding is single-owner.

## Stage 2B implementation notes (evidence, reviews, findings, completion evaluation)

Modules under `src/server/goals/`: `verifierDigest`, `repository`, `freshness`, `evidence`, `reviews`, `findings`,
`milestones`, `completionEvaluation` (evaluator + sealed proof registry; formerly `completionProof`), `completion`. Nothing here schedules work or calls a provider.

- **Verifier digest.** SHA-256 over canonical JSON of `{criterionKey, verifier}` (sorted keys, array order significant).
  Evidence carries the digest of the verifier it was recorded for; an amendment keeps old evidence only for verifiers
  whose digest is unchanged. Evidence rows are never mutated.
- **Repository state** is read from Git objects at the verified Goal ref (`integration_head`, `head^{tree}`), never the
  user's checkout. Freshness: build/test/lint need `subject_tree` equal to the current tree; review verdicts need
  `reviewed_to_tree` equal to it; artifacts persist path, blob and sha256 and go stale if the path is missing, the blob
  changes or the path leaves scope; commits must be ancestors of head; user confirmation is current when `any`, and tied
  to the tree when `head-bound`.
- **Criterion evaluation.** Per verifier the latest non-stale evidence (by `recorded_at`, then insertion order) decides:
  satisfied, contradicted, inconclusive, stale or missing. A criterion needs all of its verifiers satisfied; the worst
  state is reported with the evidence ids.
- **Completion** is `evaluateCompletion` (structured, deep-frozen, registered in a module-private WeakSet; see 2B.1). The `completed`
  transition accepts only such an object and re-reads the definition version, its hash and the integration head; `completeGoal`
  also re-verifies the ref. There is no boolean precondition.

Differences from the design text, chosen deliberately:

1. Only **required** criteria gate milestones and completion; `requiredEvidence` kinds are all-of.
2. Reviews and proofs are strict on **definition version**: a review made under an older version does not count.
3. Final acceptance is required when `requireUserAcceptance` **or** `humanGates.finalAcceptance`.
4. Criteria owned only by user-skipped milestones are exempt from completion; automatic skips from removal are not user skips.
5. Final apply is satisfied by a Turing `apply_to_base` op at head or a user `final_apply` attestation bound to head.
6. Independence `none` needs no recorded payload; otherwise `independence_json` must say `established` with the same policy.
7. High/critical resolution under the default policy requires fresh build/test evidence; with no build/test verifier a
   high finding cannot be resolved by review (`no_deterministic_verifier`).
8. `run_result` evidence is refused at record time and ignored if present; it never backs a verifier.
9. ~~User accept/dismiss of findings is enforced in the service only.~~ Superseded by Stage 2B.1 / migration 019 (below).
10. Added `completeGoal` and `syncMilestoneRuntime` (runtime status is a cache, never consulted for completion).

## Stage 2B.1 hardening notes

- **Proof issuance is module-private.** The proof registry and `issueCompletionProof` live inside
  `completionEvaluation.ts` and are not exported. The module exports exactly `evaluateCompletion` and
  `checkCompletionProof`; `completion.ts` keeps `recordCompletionEvaluation` and `completeGoal`. No importable function
  accepts a caller-supplied `CompletionEvaluation` and registers it. Tests obtain proof only by running the real
  evaluator against a real fixture repository; a test asserts the export surface so a minting function cannot reappear.
- **Stale reviews cannot mutate current findings.** `applyReviewFindings` requires
  `review.definitionVersion == goals.current_definition_version` and `review.reviewedToTree == current integration tree`
  before any lifecycle write; otherwise `review_not_current` and nothing changes (no finding, reopen, resolve,
  observation, `last_seen_review_id` or event). The version is re-checked with the head inside the write transaction.
  A completed review stays immutable, visible history and is lifecycle-inert once stale. (The earlier per-finding
  `review_not_current` resolution refusal is gone: the whole application is refused instead.)
- **Reviews start only under current approved authority.** `createReview` requires the definition version to be the
  Goal's `current_definition_version` with status `approved`; otherwise `definition_not_current` (a nonexistent version
  stays `definition_not_found`). A review already in flight when an amendment lands may still complete as history.
  **Stage 2B.2:** the same synchronous assertion runs again inside the insert transaction (with the head re-check), so
  an amendment approved while the asynchronous Git reads were in flight yields `definition_not_current` and no row is
  written. `reviewsRace.test.ts` forces that interleaving deterministically (a mocked repository-read boundary runs the
  amendment after the real read resolves; no timers).
- **Migration 019 — finding decision authority.** `goal_findings.decision_approval_id` (nullable FK to `goal_approvals`).
  `open -> accepted_by_user | dismissed_by_user` requires that pointer to name an approval of the same Goal, gate
  `finding_decision`, `approved` by the `user`, whose detail has `findingId == finding.id`, `decision == new status`, and
  `definitionVersion`/`definitionHash` equal to the Goal's current approved definition. User decisions are sticky (no
  return to open, resolved or the opposite decision) and the pointer is immutable once set; a finding cannot be created
  already decided or carry a pointer without a user decision. `decideFinding` persists status, pointer and event in one
  transaction; the event carries the same `approvalId`. Rows decided before 019 keep a NULL pointer and are sticky.
- **Test fixtures.** Goal fixtures close their database and remove their temporary repository after each test
  (`afterEach`); suites that deliberately share a database (`stateMachine.test.ts`) clean up once. Turing-owned temp
  prefixes created by tests: `turing-goalrepo-`, `turing-goals-`, `turing-goal-schema-`, `turing-goal-git-`,
  `turing-subject-`, `turing-goal-origin-` (plus the older `turing-db-`, `turing-git-`, `turing-api-`, etc.); an
  interrupted run can leave these behind and they are safe to delete by prefix. `turing-goal-git-no-hooks` is a single
  reused production directory, not a leak. `npm ci` is part of the mandatory gate.

## Stage 3 implementation notes (Goal supervisor core)

Implemented in `src/server/goals/`: `cycles.ts` (sole cycle-status writer, idempotent creation, counter reconcile), `nextTask.ts`
(strict NextTask validation), `scope.ts`, `preflight.ts`, `bounds.ts`, `activeTime.ts`, `memory.ts`, `executor.ts`
(injected boundary plus the non-launching `DisabledGoalExecutor`), `supervisor.ts` (persistent ticks, reconcile, shutdown)
and migration `020_goal_supervisor_invariants.sql`. `fakeExecutor.ts` and `supervisorKit.ts` are test-only and excluded
from the server build; a static test proves no production file imports them.

Deliberate differences from the design above:

- Clean shutdown persists active-time deltas and launches nothing, but leaves a running Goal `running` (not
  `paused(master_shutdown)`), so the next start continues without a user action. Child runs are never cancelled.
- The production executor is disabled: preflight fails with `route_unavailable` until Stage 5 supplies routing.
- (Scope-violation handling superseded by Stage 3.1 below.)
- A denied `eachCycle` gate cancels that cycle; the Goal stays `needs_user(gate_pending)` until the user resumes it.
- `reconcile()` performs at most one tick per running Goal.
- Milestone refresh is a derived-cache update performed inside a tick.
- Migration 020 has no delete trigger on `goal_cycles` (an existing Stage 1 test deletes a cycle row).
- (Counting rules superseded by Stage 3.1 below.)
- Spend is read from the canonical `metered_reservations` ledger; `maxMeteredUsd` is only an extra ceiling and a
  subscriptions-only Goal has a ceiling of zero.
- Authoring, review and verification matrices exist but are not orchestrated; remediation cycles are not created by the
  supervisor yet (Stage 6).

## Stage 3.1 implementation notes (persisted proposal runs and fail-closed corrections)

- **Proposals are runs.** The executor no longer has any "call a model now" method. `queueProposalRun` persists (or
  returns) the `(cycle, 'proposal')` run, never starts it and never waits; `readProposal(runId)` reads the structured
  output a completed proposal run already persisted (Stage 4: the planner stage's `stages.output_json.text`) and does no
  provider work. The `proposing` cycle status is unchanged; the proposal run supplies the sub-state: absent ->
  `proposal_queued`; queued -> `proposal_run_started` (no validation in that tick); active -> `waiting_for_proposal`;
  paused -> `needs_user(run_interrupted)`; failed -> cycle `failed(proposal_run_failed)`; cancelled -> cycle `cancelled`
  (no replacement run); completed -> `readProposal`, strict NextTask validation, `proposed` or `rejected`.
  A restart observes the existing run and can never issue a second proposal request.
- **Run lookup by purpose.** `runForPurpose(cycleId, purpose)` distinguishes `proposal`, `execution` and `remediation`;
  the unique index on `(goal_cycle_id, goal_run_purpose)` stays authoritative. No pointer columns were added.
- **Structured start results.** `startRun` returns `startQueuedRun`'s result and the supervisor classifies it: `started`
  and `already-active` are in flight; `not-found` fails the cycle (`run_not_found`); `not-queued` re-reads the persisted
  run (active = in flight, paused = `run_interrupted`, terminal = observed without restarting, anything else =
  `run_state_invalid`).
- **Resume ordering.** `resumeGoal(..., 'run_resumed')` identifies the paused run first (refusing with `no_paused_run`),
  runs preflight, commits the Goal to `running`, and only then resumes that exact run. A resume that throws puts the Goal
  back to `needs_user(run_interrupted)` with bounded detail (`resume_failed`).
- **Startup ref verification.** `reconcile()` verifies the Goal ref after planned-op recovery and before any tick that
  could queue or start work; missing/moved/invalid Git state blocks the Goal with no queue or start call.
- **Counters.** Execution and remediation cycles ending `succeeded`, `failed` or `rejected` count toward
  `maxExecutionCycles` and (for remediation) `maxRemediationAttempts`; `cancelled` counts for nothing. Consecutive
  failures are unchanged (`failed`/`rejected` extend, `succeeded` resets).
- **Scope violation.** An actual work-run diff outside the milestone scope is never integrated; the cycle finishes
  `failed(scope_violation)` and, in the same transaction, the Goal goes to `needs_user(scope_violation)`, so no further
  autonomous cycle starts. The exits are the existing amendment reasons. An invalid proposal naming an out-of-scope path
  is still just a rejected proposal.
- No migration was added. Production remains wired to `DisabledGoalExecutor`.

## Stage 3.2 implementation notes (amendment authority, superseded cycles, retention)

- **Amendment from `needs_user(scope_violation)`.** `beginAmendment` is permitted for that one reason only. The Goal
  status and reason are not changed; the proposal needs the normal exact-hash user approval; `amendment_started` is
  written. The reason is cleared only by a later resume.
- **Factual amendment resume.** `resumeGoal` with `amendment_approved` / `amendment_discarded` verifies persisted
  `goal_events` order (`amendmentAuthority.ts`): approved needs a `definition_approved` event after the quiescent episode
  began, a current definition with a parent version, and a valid user amendment approval; discarded needs a later
  `definition_rejected` for a proposal based on the current version. Otherwise `amendment_not_resolved`; nothing starts.
- **Superseded cycles.** A cycle whose `definition_version` differs from the Goal's current version never executes.
  In-flight child work gives `superseded_cycle_in_flight` (no auto-cancel); terminal or absent child work retires the
  cycle `cancelled(definition_superseded)` with no integration and no ref movement (`superseded_cycle_retired`), and a
  following resume proceeds. A discarded amendment keeps the versions equal, so the cycle continues. The same guard
  runs first in every tick.
- **Normal-tick ref guard.** `verifyGoalRef` runs immediately before queueing and starting proposal runs and before
  queueing and starting work runs. A missing/moved/invalid ref blocks with `goal_ref_missing` / `goal_ref_changed` /
  `git_state_invalid`; nothing is queued or started and the ref is never repaired.
- **Retention (`retention.ts`).** `inspectRunRetention` is read-only; `pruneRunWorktree` runs
  `git worktree remove <path>` (never `--force`), verifies the worktree is gone, then sets `runs.worktree_path = NULL`.
  Branches, `starting_commit`, `goal_base_commit` and all history are retained; repeating a prune is a no-op. Execution,
  remediation, verification and review runs need the persisted `run_evidence_collected` marker, written only by
  `recordRunEvidenceCollected` (validated against stored evidence; never by retention). Proposal runs are eligible once
  the validated task is persisted or the cycle terminally recorded the outcome; the supervisor prunes only those,
  opportunistically, and a cleanup failure never changes the Goal outcome. No directory sweep, no `git worktree prune`;
  historical runs without the marker stay in place.
- No migration was added (`goal_events.type` has no CHECK). Production remains wired to `DisabledGoalExecutor`.

## Stage 4A implementation notes (run-backed executor, built-in workflows)

- **Built-in workflows** (`src/shared/goalWorkflows.ts`): reserved ids `goal-planning-v1`, `goal-execution-v1`,
  `goal-review-v1`, `goal-verification-v1`, `goal-authoring-v1`; all isolated, subscriptions-only, no merge/push/rollback.
  Planning is one read-only `goal-propose` planner stage. Execution is `goal-implement` → `goal-build` → `goal-test` →
  `goal-commit` (`allowNoChanges`). Review (parallelReview/consolidate/finalGate), verification (build/test only, no AI)
  and authoring are seeded but not yet driven. `openDatabase` seeds each absent built-in (not only into an empty table);
  a differing row is never overwritten: it is listed under the `goal_builtin_conflicts` setting, warned, refused by the
  executor (`reserved_workflow_conflict`), and `PUT /api/workflows/:id` returns 403 for reserved ids.
- **Permission mode**: only the execution workflow uses `yolo`, as a static, visible property (the `gitCommit` stage is
  otherwise approval-gated). `enigma` is refused by `validateGoalDefinitionContext` and by plan verification. The
  supervisor never changes a mode and `classifyBrokerOperation` has no Goal branch.
- **`allowNoChanges`** is valid only on a `gitCommit` stage; a clean worktree completes without an empty commit.
  Scope/secret/index checks still run when changes exist. Integration then reports `no_change` and the existing bounded
  failure applies.
- **Seam**: `GoalRunPlanProvider` (`runPlan.ts`) returns a concrete workflow or `ready:false`; Stage 5 will supply route
  logic. `TuringGoalExecutor` receives the database and a plan provider, never the engine, and never starts a run. A plan
  must equal the registered workflow apart from route fields, be isolated, free of forbidden stages, keep the registered
  permission mode and not exceed the Goal's billing mode; parallelism is clamped. No billing field is passed to
  `buildPreview`, so the preview billing evaluator decides. Test-only plan providers are excluded from the build.
- **`readProposal`** reads only a completed proposal run's persisted `goal-propose` stage text (size-bounded before
  parsing); it makes no provider call and no transition.
- **Prompts and scope**: bounded deterministic prompts with a fixed precedence statement; context policies are narrowed to
  the milestone `allowedScope`; `expectedPaths` is advisory.
- **Usage**: `UsageFilter.goalId` filters through the `goal_runs` view for events and decisions; an unusable `goalId`
  query returns 400 rather than widening. Verification-command materialisation (`verificationCommands.ts`) is available
  for Stage 4B. No evidence is recorded, execution worktrees stay retained, and production remains `DisabledGoalExecutor`.

## Stage 4A.1 implementation notes (run-plan authority)

- A run plan is the registered workflow plus exact route fields on model-backed stages. `canonicalNonRouteWorkflow`
  compares everything except `createdAt`/`updatedAt` and `backendId, providerId, billingLane, modelId, reasoning,
connectionProfileId, modelDisplayName, variantId, nativeSettings` on stages in the shared `MODEL_BACKED_STAGE_KINDS`
  set (also used by the launcher and engine). `modelSnapshot` is not plan authority. Deterministic stages are compared
  whole. Specific codes (isolation, forbidden stage, permission mode, billing above the Goal) are checked first; any other
  difference is `plan_workflow_mismatch`.
- Parallelism: the plan must equal the registered value; Turing then clamps to `min(registered, Goal)` after verification.
- Context: the registered workflow and stage policies are untouched. Turing mints `WorkflowDefinition.goalScope`
  (milestone include/exclude) after verification and the engine enforces it conjunctively on every `read_file`; an empty
  include list denies. No API schema accepts `goalScope`, and a plan carrying one is refused. `list_files` is unchanged
  and is not read authority.
- The idempotent `(cycle, purpose)` fast path re-proves Goal ownership, current definition, base commit and (child runs)
  the validated task before returning the existing run, still without a plan request. No migration.

## Stage 4B.1 implementation notes (real-run evidence and deterministic verification)

- **Failed deterministic stages** (`runEngine.ts`): a failed or cancelled build/test/shellCommand stage keeps `{error, command, subjectTree, subjectCommit}` (subject only for Goal runs) plus `failureKind` (`command_exit` for a real non-zero exit, otherwise `infrastructure`) and `exitCode`. Stage, run and `continueOnFailure` semantics are unchanged.
- **Collector** (`goals/runEvidence.ts`, `collectRunEvidence(db, runId)`): persisted state and Git only. Eligible: terminal run of purpose execution/remediation/verification, terminal owning cycle, non-null approved/superseded definition version. The command in the stage's `output_json` is authoritative: the verifier is found from the stored definition (`gv-<digest>` stage ids, or `goal-build`/`goal-test` matched by exact command) and its command is re-materialised with `materializeVerifierStage`; any difference (command, digest, or native-vs-shell stage kind) records nothing. Passed stage → `satisfies`; non-zero exit → `contradicts`; cancelled, skipped, timeout and runner failures → no evidence. A verification run must have verified exactly its cycle's base commit.
- **Commit/artifact evidence**: `commit_on_branch` only from a succeeded execution/remediation cycle with an applied integration op for that run and exactly its result commit. `file_exists` only while `integration_head` equals the cycle result (execution/remediation) or the cycle base (verification); otherwise nothing is fabricated. No review or user-confirmation evidence is created.
- **Idempotence**: each row is reused by its logical identity (goal, definition version, criterion, digest, kind, run, stage, and commit for commit evidence). The `run_evidence_collected` marker is written last (zero rows are valid); a crash before it leaves retention refusing and a rerun resumes without duplicates.
- **Supervisor**: `evidence_collected` is one action per terminal run, taken before the next cycle decision (cycle N terminal → evidence N → milestone refresh → N+1) and, via `maintainEvidence()` (scheduler pass and startup reconcile) and the non-running tick path, for needs_user/blocked/paused Goals without resuming them. After the marker the worktree is pruned best-effort; the run branch is kept. A run that fails to collect three times is skipped (fail closed).
- **Verification cycles**: `createCycle(kind='verification', triggerCode='evidence_refresh')` captures the definition version, active milestone and current head, is outside the execution/remediation counters and bounds (still bounded by active time and wall clock), and keeps one active cycle per Goal. Path planned → launching → running → collecting → succeeded|failed|cancelled; `tickCycle` chooses the path by kind. Scheduling happens after fresh criterion/milestone evaluation: required build/test/lint verifiers of the active milestone that are stale or inconclusive (or missing once the Goal has integrated something) trigger one cycle; a fresh `contradicted` verifier never does, and a head that already had a terminal verification cycle is not verified again. An unmaterialisable verifier launches nothing and sends the Goal to `needs_user(verification_failed)` with the verifier named. Scheduling requires an executor that implements the optional `queueVerificationRun` (the disabled production executor does not).
- **Workflow** (`goals/verification.ts`, `TuringGoalExecutor.queueVerificationRun`): the registered `goal-verification-v1` with its stages replaced by `materializeVerifierStage` output named `gv-<digest>` (each `continueOnFailure`), queued through `buildPreview` → `queueRun` with `RunOrigin(cycleId, 'verification', base)`. No model stage, plan provider, route or usage spend.

## Stage 4B.2 implementation notes (asynchronous Goal authoring)

- **API**: `POST /api/goals/authoring` takes `{projectId, title ≤ 200, prompt ≤ 8000, route}` (strict; `route` is the
  existing `modelConfiguration` shape, strict, no secrets) and answers `202 {goalId, cycleId, runId}` without waiting for
  the model. `POST /api/goals/:goalId/authoring/retry` (`{prompt, route}`) and `GET /api/goals/:goalId/authoring`
  (bounded status) are the only other routes. Goal origin fields, `modelSnapshot`, permission, billing and context
  fields are rejected (400).
- **Route authority** (`goals/authoring.ts`): starts from the registered `goal-authoring-v1` (reserved built-in verified
  as in the executor, now the shared `registeredGoalWorkflow`), applies the exact route (`PLAN_ROUTE_FIELDS`, with
  backendId/providerId/modelId/billingLane required) to the single `goal-author` stage only, and proves the rest
  identical via `canonicalNonRouteWorkflow`. `buildPreview` stays the readiness and billing authority (the workflow is
  subscriptions-only); a metered, incompatible or disconnected route is refused, the preview must keep the pinned route,
  and no other route is ever chosen.
- **Empty draft**: `createGoalDraft` is split into `createGoalShell` (Goal, `goal_runtime`, `goal_created`; no version
  row, `current_definition_version` NULL) and `createGoalDraft`. No placeholder or version zero exists.
- **Atomic order**: validate, build the preview (origin `createRunOrigin(cycleId, 'authoring')`, no base commit, so the
  conservative dirty-checkout block applies), then one transaction: Goal shell, authoring cycle (`kind=authoring`,
  definition/milestone/base NULL, sequence 0, or max+1 on retry), `cycle_created`, nested `queueRun`, cycle → `proposing`.
  Any failure rolls everything back; a refused preview creates nothing. `startQueuedRun` runs once after commit.
- **Consumption**: reads only a completed `authoring` run's `goal-author` planner `output_json.text`, bounded before
  parsing, parsed with the existing definition schema (a structural mismatch fails; semantic issues still produce an
  editable proposed v1). One transaction proves the Goal is still a draft with no version, creates proposed v1
  (`created_by=authoring_run`), emits `definition_proposed`, moves the cycle proposing → proposed → succeeded and emits
  `goal_authoring_completed`. It never approves and never sets `current_definition_version`.
- **Failure**: the cycle ends failed/cancelled, `goal_authoring_failed {cycleId, runId, code}` is written (no model
  output) and the draft carries `status_reason_code = authoring_failed` through `setDraftStatusReason` (a typed,
  draft-only helper that never writes `goals.status`). Retry is allowed after a failed or cancelled cycle and refused once
  any definition version exists or while a cycle is open.
- **Reconciliation** (`AuthoringReconciler`, run at startup and every 15 s, independent of the HTTP request, no project
  lease for drafts): queued → start once; active → observe; paused → expose, never auto-resume; completed → consume once;
  failed/cancelled → finalize once; consumed → nothing. It then prunes consumed authoring worktrees.
- **Retention**: `authoring` is a supported purpose. A worktree is pruned only when the cycle is terminal and the
  consumption record exists (completed event for this run and cycle plus v1 authored by an authoring run, or the failure
  event). Otherwise `authoring_not_consumed`. The branch is retained; no `run_evidence_collected` is needed.
- **Usage**: the existing `goalId` filter already reaches authoring runs through `goal_runs` (run → cycle → Goal); a
  regression covers it. No migration. Production autonomous Goals still use `DisabledGoalExecutor`.

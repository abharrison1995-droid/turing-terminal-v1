# Grand Project / Goal Engine design

**Status: design proposal for architecture review. No implementation exists.** Written on branch `feature/grand-project-goal-engine` from the `v1.0.0-rc2` baseline. File and symbol references below were read from that source; where this document says "proposed" it describes something that does not exist yet.

## 1. Goals and non-goals

### Goals

- A persistent, resumable **Grand Project** (a "Goal") that pursues a structured **Goal Contract** across hours, days, or weeks.
- Each unit of work is an **ordinary, bounded Turing run** created through the existing run path. The Goal supervisor is a deterministic state machine that launches, observes, and judges runs.
- Completion is decided by the application from **structured evidence against explicit success criteria**, never by a model saying "done".
- Role-based routing (orchestrator, implementer, routine reviewers, milestone reviewer, final reviewer) with **pinned routes** and **explicitly authorised route pools**.
- Periodic, milestone, repeated-failure, and final reviews that can **block** progress.
- Hard bounds on cycles, duration, remediation, concurrency, spend, and required human gates.
- Survives browser close, app close, Master restart, machine restart, and provider exhaustion.
- Anticipates the later Model Opportunity Layer by making route pools a first-class, policy-gated concept.

### Non-goals

- Rewriting or extending `RunEngine` into a long-lived autonomous loop (see section 24).
- A second provider/model system, usage ledger, approval system, or model catalog.
- Silent provider or model substitution, or any widening of the billing rules.
- Model-generated shell, or any repository access outside the existing execution broker.
- Implementing Model Opportunity detection, the Opportunity Board, or opportunity-sourced pools in the first Goal Engine pass (the pool _mechanism_ is designed now; the _source_ of candidates is static in the first pass).
- Visual polish. Section 16 gives behaviour and minimum surfaces only.

## 2. Existing architecture reused

| Concern                  | Existing mechanism (verified in source)                                                                                                                                                                                                                                   | How the Goal Engine uses it                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run creation             | `makePreview()` and `createQueuedRun()` in `src/server/app.ts`; `makePreview` already accepts a `workflowOverride`                                                                                                                                                        | Every child run is created through the same preview + create path, so billing evaluation, provider readiness, lock rules, rule snapshot, and stage routes are identical to a human-started run. Requires extraction into a shared module (section 22, stage 0) |
| Workflow engine          | `RunEngine.start/cancel/decideApproval`, stage graph, retries, remediation limits, `maxDurationMinutes`, `paused_limit_reached`                                                                                                                                           | Untouched. Child runs execute exactly as today                                                                                                                                                                                                                 |
| Restart reconciliation   | `RunEngine.reconcileInterruptedRuns()` pauses runs in `preparing/running/cancelling/waiting_for_approval`, denies pending approvals, interrupts git operations                                                                                                            | The Goal supervisor reconciles _after_ this and maps paused child runs to goal state                                                                                                                                                                           |
| Approvals                | `approvals` table, `RunEngine.decideApproval`, `approval_requested` push notice                                                                                                                                                                                           | Goal-level human gates are implemented as **ordinary `humanApproval` stages inside child workflows** or as approval rows created through the same table (section 9)                                                                                            |
| Interventions            | `interventions` table, `RunEngine.intervene`                                                                                                                                                                                                                              | Unchanged; operate on child runs                                                                                                                                                                                                                               |
| Usage ledger             | `usage_events` (canonical, reconciled), keyed by `run_id`; `metered_reservations`; `usageAnalytics.ts` `UsageFilter`                                                                                                                                                      | Goal usage is **derived by joining `usage_events.run_id` to `runs.goal_id`**. No new ledger                                                                                                                                                                    |
| Billing                  | `evaluateBillingLane` / `resolveBillingMode` in `src/shared/billing.ts`, per-run caps, daily/monthly budgets in `meteredBudget.ts`                                                                                                                                        | Child runs carry the same billing mode. Goal limits can only be _stricter_ (section 18)                                                                                                                                                                        |
| Model config and routing | `ModelConfiguration`, `ConnectionProfile`, `ModelPreset`, `stageDefaults`, `inheritStageConfiguration`, `routeMatchesBillingLane`                                                                                                                                         | A route is a `ModelConfiguration` + profile reference. Pinned routes and pool members are stored as these                                                                                                                                                      |
| Model catalog            | `model_catalog_cache`, `applyCatalogCache` (Last Known semantics), `ModelOption.status`                                                                                                                                                                                   | Pool eligibility is checked against the current catalog snapshot; a failed refresh never changes eligibility upward (section 10)                                                                                                                               |
| Context management       | `ContextPolicy`, `resolveContextPolicy`, stage prompt budgeting in `makeStagePrompt`, handoff artifacts (`PlanArtifact`, `ImplementationResult`, `ReviewFinding[]`, `FinalGateResult`, `OrchestrationDecision`)                                                           | Goal memory is injected as a **bounded task block** that counts against the child stage's context budget                                                                                                                                                       |
| Git safety               | Per-run worktree `turing/<runid8>` created from the project HEAD; `gitCheckpoint/gitCommit/gitMerge/gitPush/gitRollback` stages; merge requires the source repo to be on the recorded base branch at the recorded starting commit and clean; `git_operations` audit table | Cycles chain through these stages (section 7 and open question Q1)                                                                                                                                                                                             |
| Review findings          | `review_findings` table, `normalizeFindings`, `parseGateVerdict`                                                                                                                                                                                                          | Review output reuses finding severities and statuses                                                                                                                                                                                                           |
| Notifications            | `noticeForMasterEvent`, `deliverPushNotice`, de-duplicated by key                                                                                                                                                                                                         | New goal events map to notices through the same function                                                                                                                                                                                                       |
| Run snapshots            | `runs.workflow_snapshot_json`, `rules_snapshot_json`, `stages.model_snapshot_json`                                                                                                                                                                                        | Every concrete route in every child run is already snapshotted; the cycle additionally stores the **route resolution record**                                                                                                                                  |
| Events/SSE               | `run_events`; `/api/events?runId=` in `src/server/index.ts`                                                                                                                                                                                                               | Add a goal-scoped event stream using the same subscriber set                                                                                                                                                                                                   |
| Client                   | `App.tsx` `Page` union and left-nav task list; `api.ts`; `phase36.tsx`                                                                                                                                                                                                    | New `goals` page and goal-scoped panels                                                                                                                                                                                                                        |

## 3. Proposed schema (migration 015)

All additive. No existing table is dropped or rewritten; existing columns keep their meaning. SQLite `CHECK` constraints mirror the state machines. All timestamps are ISO-8601 UTC text, as elsewhere.

```sql
-- 015_grand_projects.sql

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('draft','ready','running','reviewing','needs_user','blocked','paused','completed','abandoned')),
  status_reason TEXT,                   -- machine-readable code + human text, see section 6
  contract_json TEXT NOT NULL,          -- current approved GoalContract
  contract_version INTEGER NOT NULL DEFAULT 1,
  routing_json TEXT NOT NULL,           -- GoalRoutingPolicy
  review_json TEXT NOT NULL,            -- GoalReviewPolicy
  limits_json TEXT NOT NULL,            -- GoalLimits
  memory_json TEXT NOT NULL DEFAULT '{}', -- bounded GoalMemory (section 10)
  active_milestone_id TEXT,
  cycles_executed INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  remediation_attempts INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0, -- accumulated Running+Reviewing time; excludes Paused/NeedsUser
  base_branch TEXT,
  goal_branch TEXT,                     -- only if integration-branch mode is chosen (Q1)
  created_at TEXT NOT NULL,
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE goal_contract_versions (   -- immutable history of the contract
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  contract_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,            -- 'user' only; models cannot approve a contract
  created_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, version)
);

CREATE TABLE goal_milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  spec_json TEXT NOT NULL,              -- criteria, dependencies, allowed scope, required evidence, review requirements
  status TEXT NOT NULL CHECK (status IN
    ('pending','active','in_review','satisfied','blocked','skipped')),
  satisfied_at TEXT,
  UNIQUE (goal_id, ordinal)
);

CREATE TABLE goal_cycles (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES goal_milestones(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('authoring','execution','review','remediation')),
  trigger TEXT NOT NULL,                -- why this cycle exists (section 7)
  status TEXT NOT NULL CHECK (status IN
    ('proposing','proposed','launching','running','collecting','succeeded','failed','cancelled','rejected')),
  proposal_run_id TEXT REFERENCES runs(id),  -- read-only planner run that proposed the task (nullable)
  run_id TEXT REFERENCES runs(id),           -- the ordinary child run
  proposed_task_json TEXT,              -- structured NextTask as proposed
  validated_task_json TEXT,             -- NextTask after deterministic validation/clamping
  route_resolution_json TEXT,           -- concrete routes chosen per role and why (section 10)
  outcome_json TEXT,                    -- structured result summary used for memory
  next_action TEXT,                     -- 'continue','review','milestone_review','final_review','user','block'
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (goal_id, sequence)
);

CREATE TABLE goal_evidence (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES goal_milestones(id),
  criterion_id TEXT NOT NULL,           -- id inside contract_json / milestone spec
  kind TEXT NOT NULL CHECK (kind IN
    ('test_result','build_result','lint_result','run_result','commit','review_verdict','artifact','user_confirmation')),
  cycle_id TEXT REFERENCES goal_cycles(id),
  run_id TEXT REFERENCES runs(id),
  stage_id TEXT REFERENCES stages(id),
  ref_json TEXT NOT NULL,               -- typed pointer (section 9); never freeform-only
  verdict TEXT NOT NULL CHECK (verdict IN ('satisfies','contradicts','inconclusive')),
  superseded_by TEXT REFERENCES goal_evidence(id),
  recorded_at TEXT NOT NULL
);

CREATE TABLE goal_reviews (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES goal_cycles(id),
  review_kind TEXT NOT NULL CHECK (review_kind IN ('periodic','milestone','repeated_failure','scope_change','final')),
  run_id TEXT REFERENCES runs(id),
  verdict TEXT CHECK (verdict IN ('pass','pass_with_findings','block')),
  blocking INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,                     -- structured ReviewReport (section 11)
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE goal_events (              -- append-only audit, mirrors run_events
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE goal_approvals (           -- goal-level gates; resolved through the same decision UI
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,                   -- 'contract','milestone_complete','cycle_start','route_pool_use','final_acceptance','continue_after_block'
  detail_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  created_at TEXT NOT NULL,
  responded_at TEXT
);

ALTER TABLE runs ADD COLUMN goal_id TEXT REFERENCES goals(id);
ALTER TABLE runs ADD COLUMN goal_cycle_id TEXT;
CREATE INDEX idx_runs_goal ON runs(goal_id, created_at);
CREATE INDEX idx_goal_cycles_goal ON goal_cycles(goal_id, sequence);
CREATE INDEX idx_goal_evidence_goal ON goal_evidence(goal_id, criterion_id);
CREATE INDEX idx_goal_events_goal ON goal_events(goal_id, created_at);
CREATE UNIQUE INDEX idx_goal_one_active_per_project
  ON goals(project_id) WHERE status IN ('running','reviewing','needs_user','blocked','paused');
```

Notes:

- `runs.goal_id` / `goal_cycle_id` are the **only** change to an existing table. They are nullable; every existing run keeps `NULL`. A run with `goal_id` is still a normal run, listed in History like any other.
- `goal_approvals` is a deliberate small exception to "do not create a second approval system": goal gates have no `run_id` or `stage_id`, which `approvals` requires (`run_id NOT NULL`). They are decided through the **same Approvals UI component and notification path**, and anything that must happen _inside_ a run still uses the existing `approvals` table. If review prefers a single table, the alternative is to relax `approvals.run_id` to nullable (a table rebuild in SQLite). See Q2.
- `idx_goal_one_active_per_project` enforces that only one non-terminal goal owns a project at a time (the project lease; Q1).

## 4. Migration

- File `migrations/015_grand_projects.sql`, applied by the existing `runMigrations()` (lexical order, transactional, recorded in `schema_migrations`).
- Strictly additive: new tables plus two nullable columns and indexes. No data backfill. A database from RC2 upgrades in place and existing history is untouched.
- Rollback is not supported by the runner; the safeguard is test coverage (section 20) and that RC2 binaries ignore unknown tables/columns.
- `db.test.ts` is extended to assert migration 015 and the new tables exist and that a database created at migration 014 upgrades.

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

export interface GoalContract {
  outcome: string; // desired outcome
  successCriteria: SuccessCriterion[]; // >= 1, each verifiable (below)
  nonGoals: string[];
  constraints: string[]; // technical/process constraints given to every cycle
  deliverables: Deliverable[]; // named, with a verifiable form (file path, command, artifact)
  completionPolicy: CompletionPolicy;
}

export interface SuccessCriterion {
  id: string; // stable; evidence references it
  statement: string;
  verification: VerificationSpec[]; // at least one non-model verifier unless userConfirmationOnly
  required: boolean; // required criteria gate completion
}

export type VerificationSpec =
  | { kind: 'build'; command?: string[] } // uses project build command or an allow-listed one
  | { kind: 'test'; command?: string[]; mustPass: true }
  | { kind: 'lint'; command?: string[] }
  | { kind: 'file_exists'; path: string } // project-relative
  | { kind: 'review_verdict'; reviewKind: 'milestone' | 'final'; minVerdict: 'pass' }
  | { kind: 'commit_on_branch'; pathsTouched?: string[] }
  | { kind: 'user_confirmation'; prompt: string };

export interface CompletionPolicy {
  requireAllRequiredCriteria: true; // not configurable off
  requireFinalReview: boolean;
  requireUserAcceptance: boolean; // default true
  maxOpenFindings: { critical: 0; high: 0; medium?: number };
}

export interface GoalMilestoneSpec {
  criteria: string[]; // ids of success criteria this milestone must satisfy
  dependsOn: string[]; // milestone ids
  allowedScope: { includeGlobs: string[]; excludeGlobs: string[] };
  requiredEvidence: Array<{ criterionId: string; kinds: GoalEvidenceKind[] }>;
  reviewRequirements: { milestoneReview: boolean; reviewerRole: GoalRole };
}

export type GoalRole =
  'orchestrator' | 'implementer' | 'routine_reviewer' | 'milestone_reviewer' | 'final_reviewer';

export type GoalRoute =
  | { kind: 'pinned'; configuration: ModelConfiguration } // exact route
  | { kind: 'pool'; poolId: string; selection: 'ordered' | 'round_robin'; count?: number };

export interface RoutePool {
  id: string;
  label: string;
  members: ModelConfiguration[]; // explicit, user-approved members (concrete backend/provider/profile/lane/model[/variant])
  admission: 'static' | 'opportunity'; // 'opportunity' reserved for the later layer; rejected by validation until it exists
  requireCatalogStatus: 'current'; // a member is only eligible while its catalog status is 'current'
  requireLaneClass: 'subscription' | 'any-permitted-by-billing-mode';
  requireValidated: boolean; // Turing-validated per section 10
}

export interface GoalRoutingPolicy {
  roles: Partial<Record<GoalRole, GoalRoute>>;
  pools: RoutePool[];
  workflows: { execution: string; planning: string; review: string }; // saved workflow ids
}

export interface GoalReviewPolicy {
  periodic?: {
    everyNExecutionCycles: number;
    reviewerCount: number;
    scope: 'since_last_review' | 'full_diff';
  };
  onMilestoneComplete: boolean;
  onRepeatedFailure?: { afterConsecutiveFailures: number };
  onScopeChange?: { changedFilesOutsideAllowedScopeAtLeast: number; diffLinesAtLeast?: number };
  final: boolean;
  blocking: { periodic: boolean; milestone: true; final: true }; // milestone/final always block
}

export interface GoalLimits {
  maxExecutionCycles: number; // hard; required
  maxConsecutiveFailedCycles: number; // required
  maxRemediationAttempts: number; // per milestone
  maxActiveMinutes: number; // accumulated, not wall clock
  maxWallClockDays: number; // absolute cap since approval
  maxParallelAgents: number; // clamps child workflows' maxParallelAgents
  maxMeteredUsd: number | null; // null only valid when billing mode forbids metered lanes
  billingMode: BillingMode; // can only be <= permissiveness of the child workflows' mode
  humanGates: GoalHumanGates;
}

export interface GoalHumanGates {
  contractApproval: true; // not optional
  eachCycle: boolean;
  beforeMilestoneComplete: boolean;
  poolRouteFirstUse: boolean; // default true
  finalAcceptance: boolean; // default true
  gitMerge: 'per-run-policy'; // governed by existing permission mode + gitMerge stage
}

export interface NextTask {
  // what the orchestrator may propose
  milestoneId: string;
  title: string;
  instructions: string; // bounded length
  targetCriteria: string[];
  expectedPaths: string[]; // must fall inside the milestone's allowedScope
  workflowId?: string; // must be in the goal's permitted workflows
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

The supervisor is the only writer of `goals.status`. Every transition is a single function `transitionGoal(goalId, to, cause)` that checks the table below inside one transaction, writes `goal_events`, and rejects illegal moves. **Models can only produce `NextTask` and `ReviewReport` payloads; they cannot call `transitionGoal`.**

| From                     | To                     | Caused by (deterministic)                                                                                                                                                                        |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `draft`                  | `ready`                | User approves the contract (a `goal_approvals` row with gate `contract`), validation (section 8) passes                                                                                          |
| `draft`                  | `abandoned`            | User                                                                                                                                                                                             |
| `ready`                  | `running`              | User presses Start and the start preflight passes (provider/model readiness, billing, project lease, clean repo)                                                                                 |
| `ready`                  | `draft`                | User edits the contract (creates a new version on re-approval)                                                                                                                                   |
| `running`                | `reviewing`            | A review trigger fires (section 11)                                                                                                                                                              |
| `running`                | `needs_user`           | A human gate is required; child run waits on approval/clarification; user-confirmation criterion pending; paused child run after restart                                                         |
| `running`                | `blocked`              | A hard bound is hit (cycles, consecutive failures, remediation, duration, spend); provider exhausted/unavailable with no authorised alternative; contradictory evidence; unrecoverable git state |
| `running`                | `paused`               | User pauses, or the machine/master shut down cleanly with a goal in flight (see section 13)                                                                                                      |
| `running`                | `completed`            | Completion check passes (below) **and** required gates are satisfied                                                                                                                             |
| `reviewing`              | `running`              | Review verdict `pass` / `pass_with_findings` and not blocking                                                                                                                                    |
| `reviewing`              | `blocked`              | Review `block`, or blocking findings exceed the completion policy                                                                                                                                |
| `reviewing`              | `needs_user`           | Review requires user decision                                                                                                                                                                    |
| `needs_user`             | `running`              | User resolves the gate / resumes                                                                                                                                                                 |
| `needs_user`             | `paused` / `abandoned` | User                                                                                                                                                                                             |
| `blocked`                | `running`              | User raises a limit, edits the contract, or resolves the blocker; supervisor re-validates                                                                                                        |
| `blocked`                | `abandoned`            | User                                                                                                                                                                                             |
| `paused`                 | `running`              | User resumes; supervisor re-runs preflight and reconciles the child run                                                                                                                          |
| `paused`                 | `abandoned`            | User                                                                                                                                                                                             |
| `completed`, `abandoned` | none                   | Terminal                                                                                                                                                                                         |

**Completion check (`evaluateCompletion`)** is a pure function over stored data, no model call:

1. Every `required` success criterion has at least one non-superseded `satisfies` evidence row of an allowed kind, and none whose latest evidence is `contradicts`.
2. Every milestone is `satisfied` or `skipped` by an explicit user action.
3. No open finding at or above the thresholds in `completionPolicy.maxOpenFindings`.
4. If `requireFinalReview`: a `final` review with verdict `pass`, completed _after_ the last execution cycle.
5. If `requireUserAcceptance`: a `final_acceptance` goal approval is `approved`.

A model's statement that the work is complete creates, at most, a `review_verdict` evidence row (`inconclusive` unless a verifier backs it) and a recommendation the supervisor may display. It never satisfies a criterion by itself.

## 7. Execution cycle algorithm

The supervisor is a single-goal state machine driven by events and a durable tick. Pseudocode (every step persists before acting; "act" means creating or observing an ordinary run):

```
tick(goal):
  if goal.status != 'running': return
  enforceBounds(goal)                       -> blocked on violation (section 12)
  m = activeMilestone(goal)
  if m is none:                             -> finalReviewOrComplete(goal)
  if reviewDue(goal): return startReview(goal, reason)         # section 11

  cycle = latestCycle(goal)
  switch cycle.status (resume point after any restart):
    none | succeeded | failed | rejected:   -> createCycle(goal, m)   # evaluate state, may produce user gate
    proposing:                              -> observe proposal_run
    proposed:                               -> validateAndLaunch(cycle)
    running | launching:                    -> observe run
    collecting:                             -> collectEvidence(cycle)

createCycle(goal, m):
  state = buildGoalState(goal)              # section 10, bounded
  trigger = whyNow(goal)                    # first | continue | remediation | repeated_failure | resumed
  if gate(eachCycle) -> goal_approvals(cycle_start), status needs_user, return
  cycle = insert goal_cycles(kind='execution', status='proposing', trigger)
  proposalRun = launchRun(planningWorkflow, role=orchestrator, task=PROPOSE_NEXT(state), readOnly)

observe proposal_run completes:
  proposed = parse NextTask (strict schema; failure => cycle rejected, consecutive_failures++)
  validated = validateNextTask(proposed, goal, m)   # deterministic: scope, criteria ids, workflow allow-list,
                                                    # length caps, non-goals, no instructions touching routes/limits
  if invalid: reject cycle (recorded), do not execute; counts toward consecutive failures
  routes = resolveRoutes(goal, roles needed)  # section 10; failure => blocked(provider_unavailable) or needs_user
  record route_resolution_json
  if gate(poolRouteFirstUse) and routes use a pool member not yet approved: needs_user
  run = launchRun(executionWorkflow with routes applied, task = taskPrompt(validated, state))
  cycle.status = 'running'

observe execution run terminal:
  collectEvidence(cycle):    # from the run's own stage outputs, git_operations, review_findings
  outcome = deriveOutcome(...)   # succeeded / failed / paused / cancelled
  update memory (section 10), counters, cycles_executed
  decide next_action deterministically (reviewDue? milestoneCriteriaMet? limits?)
  milestoneCriteriaMet(m) -> milestone 'in_review' (if required) else 'satisfied'; advance activeMilestone
```

**Launching a run** means: build a `RunInput` (project, workflow id or `workflowOverride`, task, `permissionMode`, billing), call the extracted `makePreview` + `createQueuedRun`, then `UPDATE runs SET goal_id=?, goal_cycle_id=?`. If preview reports `canStart=false` or billing blocks, the cycle fails with the preview's warnings; the supervisor never edits routes to make a preview pass.

**Sequencing and Git.** Child runs are sequential per project in the first pass (`maxParallelAgents` applies within a run; there is one in-flight child run per goal). Each execution workflow ends with the existing `gitCheckpoint` and, per policy, `gitMerge` into the recorded base branch, so the next cycle's worktree starts from the integrated HEAD. See Q1 for the integration-branch alternative.

**Where a human may be required** (all configurable except the first):

1. Contract approval (always).
2. First use of a route-pool member (default on).
3. Each cycle start (default off).
4. Any approval a child run raises (existing permission-mode rules, including `gitMerge` approval).
5. Milestone completion (default off for `routine`, on if milestone review is blocking).
6. User-confirmation success criteria.
7. Final acceptance (default on).
8. Continuing after `blocked`.

## 8. Goal Contract validation

Performed on create, edit, and at start; failures block `draft -> ready`. All checks are deterministic.

- Required fields present; `outcome` and each criterion statement non-empty and length-bounded.
- At least one `required` success criterion. Every required criterion has at least one **non-model verifier** (`build`, `test`, `lint`, `file_exists`, `commit_on_branch`) or is explicitly `user_confirmation`-only. A criterion verified solely by `review_verdict` is rejected unless it also has a deterministic verifier or user confirmation. This is the "not just an LLM saying done" rule.
- Criterion ids are unique and stable across contract versions.
- Every milestone references existing criteria; every required criterion is covered by at least one milestone; milestone `dependsOn` is acyclic.
- `allowedScope` globs are project-relative, contain no `..`, and are checked against the project's registered root. Verification commands must pass `isSafeProjectCommand` (`src/server/commandPolicy.ts`) or be the project's registered build/test/lint command.
- Limits: all required limits set and within hard maxima defined by the app (no unlimited values). `maxMeteredUsd` must be `null` unless the goal's billing mode permits metered lanes, and the existing run caps still apply.
- Routing validation: each referenced route passes `routeMatchesBillingLane`; each role the policy needs has a route; a pool has at least one member; pool admission `opportunity` is rejected in the first pass.
- Contract edits after approval create a new `goal_contract_versions` row and require user re-approval. Editing success criteria while `running` moves the goal to `needs_user` and invalidates evidence only for criteria whose statement or verifier changed.

**Natural-language authoring.** The user's text is sent through an ordinary read-only **authoring run** (a `planner`-kind stage in a built-in "Goal Authoring" workflow, analogous to the existing prompt-refinement flow that parks a run in `waiting_for_user`). Its structured output is parsed with a strict schema into a _draft_ contract and milestones. The user edits and approves; the draft has no authority. This reuses providers, billing evaluation, the broker, and usage accounting, and creates no new model-calling path.

## 9. Milestone and evidence model

A **milestone** is satisfied when, for each criterion in its spec, the required evidence kinds exist and are `satisfies`, its review requirements are met, and no blocking finding is open within its scope.

**Evidence** is a typed pointer, never freeform text alone. `ref_json` by kind:

| Kind                | `ref_json`                                            | Producer (deterministic)                                          | Verifies                                      |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| `build_result`      | `{runId, stageId, exitCode, summary}`                 | `build` stage output of a child run                               | `build` verifier                              |
| `test_result`       | `{runId, stageId, exitCode, summary, failed?:n}`      | `test` stage output                                               | `test` verifier                               |
| `lint_result`       | same                                                  | `shellCommand`/lint stage                                         | `lint` verifier                               |
| `run_result`        | `{runId, status}`                                     | terminal run row                                                  | run completed without failing required stages |
| `commit`            | `{runId, gitOperationId, afterCommit, branch, paths}` | `git_operations` completed row                                    | `commit_on_branch`                            |
| `review_verdict`    | `{reviewId, verdict, blockingFindingIds}`             | `goal_reviews`                                                    | `review_verdict` verifier                     |
| `artifact`          | `{path, sha256, runId}`                               | supervisor hashes a project-relative file inside the run worktree | `file_exists`                                 |
| `user_confirmation` | `{approvalId}`                                        | `goal_approvals` decision                                         | `user_confirmation`                           |

Evidence is written by the **supervisor from persisted run data**, never by a model. When a later cycle changes the underlying subject (for example new commit after a passing test), earlier evidence of that kind for that criterion is marked `superseded_by` the new row; completion looks only at the latest non-superseded evidence per criterion and kind. A criterion with latest evidence `contradicts` is unsatisfied regardless of earlier passes.

## 10. Routing model and project memory

### Route resolution

`resolveRoutes(goal, roles)` is a **pure function** of: the goal routing policy, the current provider/catalog snapshot, the connection profiles, the effective billing mode, and the pool usage state. It returns, per role, a concrete `ModelConfiguration` plus an audit record, or a reasoned refusal. It never reads the network and never sends a generation prompt.

- **Pinned route.** Exactly the stored configuration. If it is not ready (catalog `unavailable`/`deprecated`, provider not detected, lane blocked), resolution **refuses**; the goal goes to `blocked(provider_unavailable)` or `needs_user`. There is no substitution. This matches the Phase 3.6 rule that failed stages stop under the normal failure policy.
- **Authorised pool.** The pool's members are an explicit allow-list set by the user. Selection is `ordered` (first eligible member) or `round_robin` among eligible members, with a deterministic tie-break stored with the pool state. A member is eligible only if _all_ hold: catalog status `current` (not `last-known`, `unavailable`, `deprecated`); its lane is permitted by the effective billing mode and `requireLaneClass`; provider readiness passes; if `requireValidated`, the member carries a Turing-validation record (section 22, stage 6); and any per-member usage cap is not exhausted. A pool never contains a metered lane unless the goal's billing mode already permits that lane. If no member is eligible the result is a refusal, not a fallback outside the pool. This is **deliberate authorised policy, not silent fallback**: the set of possible routes is user-approved in advance and every selection is recorded.
- **What is recorded.** `goal_cycles.route_resolution_json` stores for each role: policy route kind, pool id, the eligible set at decision time with reasons for excluded members, the selected configuration, the catalog status and discovery time it was judged on, and the policy version. Every child run additionally snapshots the concrete route per stage through the existing `workflow_snapshot_json` and `stages.model_snapshot_json`.
- **Application.** Selected routes are applied by constructing a `workflowOverride` (stage-kind defaults for `stageDefaults`, plus explicit stage routes for review swarms) and passing it through `makePreview`, so the usual inheritance (`inheritStageConfiguration`) and provider-lock rules apply. The supervisor never mutates a saved workflow.
- **Catalog failure.** Eligibility uses the cached catalog with its status. A failed refresh leaves cached models `last-known`, which makes them **ineligible for pools requiring `current`** but does not delete anything. A pinned route with `last-known` status is allowed only if the existing run preview already allows `last-known` (today it does, with a warning); the goal's policy can require `current` for stricter behaviour. No refresh failure ever raises eligibility.
- **Retries inside a run** keep their route (existing behaviour). A new cycle may select a different pool member only through a fresh recorded resolution.
- **Model Opportunity integration point.** `RoutePool.admission: 'opportunity'` is typed but rejected by validation in the first pass. The later layer adds a second source of _candidates_ that a user must still explicitly admit to a pool (or approve a rule such as "any Turing-validated currently-free OpenCode/Cline model in this pool"); resolution logic does not change.

### Bounded project memory (`goals.memory_json`)

Memory is structured and size-capped; it is rebuilt after every cycle from persisted rows, not accumulated from transcripts.

```ts
interface GoalMemory {
  schemaVersion: 1;
  contractDigest: { outcome: string; criteria: Array<{ id; statement; status }> }; // status computed from evidence
  activeMilestone: { id; objective; unresolvedCriteria: string[] };
  completedMilestones: Array<{ id; title; satisfiedAt }>; // one line each
  lastCycle: { sequence; kind; outcome; summary /* <= 800 chars */; changedFiles: string[] /* <= 30 */ };
  decisions: Array<{ id; text /* <= 300 chars */; cycle }>; // architecture decisions, max 20, oldest compacted
  openFindings: Array<{ id; severity; summary; files }>; // max 25, highest severity first
  evidenceSummary: Array<{ criterionId; latest: 'satisfies' | 'contradicts' | 'inconclusive' | 'none' }>;
  blockers: string[]; // max 10
  repo: { baseBranch; head; dirty: boolean; checkedAt }; // read from git each cycle
  nextHint?: string; // orchestrator suggestion; advisory only
}
```

- **Hard cap:** the serialized memory block injected into a child task is capped (target ≤ 4,000 estimated tokens, enforced by the supervisor with the same estimator `estimateTokens` the engine uses). Overflow compaction order is deterministic: drop oldest decisions, shorten completed-milestone lines, truncate summaries. The cap is set below the child stage's `maxEstimatedTokens` so the mandatory task block never forces a stage to stop.
- The memory block is placed in the **task specification** of the child run (the engine already treats the task as mandatory context), alongside the bounded cycle instructions. Prior AI responses are not replayed; `includePreviousTranscript` stays false.
- Git/repo state is read live each cycle (`git rev-parse`, status, diff stat through existing helpers), not trusted from memory.

## 11. Periodic review model

A review is an **ordinary child run** of a review workflow (e.g. `parallelReview` + `consolidate` + `finalGate` stages, which already exist) using routes resolved for the review role. Reviews are triggered deterministically by `reviewDue(goal)`:

- `periodic`: `execution cycles since last periodic review >= everyNExecutionCycles`.
- `milestone`: all of a milestone's criteria have latest evidence `satisfies`.
- `repeated_failure`: `consecutive_failures >= afterConsecutiveFailures` (below the hard limit, so a review can advise before the goal blocks).
- `scope_change`: changed files outside `allowedScope`, or diff size, over configured thresholds.
- `final`: all milestones satisfied and policy requires it.

**Independence.** The final reviewer route must differ from the route(s) that implemented the work in the reviewed cycles (compared by backend + provider + model; same model with a different variant is not independent). If policy cannot satisfy this, the goal needs the user. Reviewer count for a swarm maps to the workflow's `parallelism`, clamped to `maxParallelAgents`.

**Output.** The review stages' structured output is normalised into a `ReviewReport`:

```ts
interface ReviewReport {
  verdict: 'pass' | 'pass_with_findings' | 'block';
  criterionProgress: Array<{
    criterionId;
    assessment: 'met' | 'partial' | 'not_met' | 'unknown';
    basis: string;
  }>;
  findings: Array<{
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

Findings are persisted in the existing `review_findings` table (linked via the child run), so existing finding UI and remediation reuse apply. A model's `criterionProgress` is **advisory**: it can create `inconclusive` evidence or recommend blocking, but only deterministic verifiers produce `satisfies`. Blocking rules: milestone and final reviews always block on `block` or on open findings beyond the completion policy; periodic reviews block only if `blocking.periodic` is set. Blocking findings route into a `remediation` cycle (kind `remediation`) subject to `maxRemediationAttempts`.

## 12. Project bounds

Checked by `enforceBounds(goal)` at the start of every tick, before launching any run, and again when a run finishes. Violation transitions to `blocked` with a coded reason; nothing launches.

| Bound                        | Meaning                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxExecutionCycles`         | Total execution + remediation cycles per goal (reviews excluded, but review runs count against time/spend)                                        |
| `maxConsecutiveFailedCycles` | Failed/rejected cycles in a row                                                                                                                   |
| `maxRemediationAttempts`     | Per milestone                                                                                                                                     |
| `maxActiveMinutes`           | Accumulated `active_ms` over Running+Reviewing; excludes Paused/NeedsUser/Blocked time                                                            |
| `maxWallClockDays`           | Elapsed since approval; guards forgotten goals                                                                                                    |
| `maxParallelAgents`          | Clamp applied to every child workflow's `maxParallelAgents` and review parallelism; one child run in flight per goal                              |
| `maxMeteredUsd`              | Sum of reconciled metered actuals for the goal's runs (join `usage_events` on `runs.goal_id`) plus open reservations; compared before each launch |
| Required human gates         | See section 7                                                                                                                                     |
| Per-run limits               | Each child run keeps its own `maxDurationMinutes`, `maxRemediationRounds`, retry policy, and metered per-run cap; the Goal never raises them      |

There is no unbounded `while` loop: the supervisor does at most one transition per goal per tick, every launch is gated by `enforceBounds`, and counters are persisted transactionally with the cycle row they belong to. Defaults are conservative (for example 20 cycles, 3 consecutive failures, 3 remediation attempts, 8 active hours, 14 days, 1 agent) and the UI requires an explicit limits review at approval.

## 13. Restart and recovery

The supervisor holds **no state that is not in SQLite**. On Master start, after `engine.reconcileInterruptedRuns()`, `goalSupervisor.reconcile()` runs and then the tick loop starts.

| Interrupted situation                                                                                  | Reconciliation (deterministic)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser or app window closed                                                                           | No effect. The Master, not the client, owns the supervisor, as with runs today                                                                                                                                                                                                                                                                                                                                                                  |
| Master restart, goal `running`, child run was active                                                   | `reconcileInterruptedRuns` has already paused the run and denied pending approvals. The supervisor sets the goal to `needs_user` with reason `run_interrupted` (consistent with the engine's rule that the working tree must be inspected before resuming). One-click resume calls the existing resume path (`engine.start(id, true)`), then the goal returns to `running`. An optional per-goal `autoResumeAfterRestart` is **off by default** |
| Restart between cycle steps (proposal done, run not launched; or run finished, evidence not collected) | Cycle `status` is the resume point; steps are idempotent (evidence rows keyed by `(cycle, criterion, kind, run, stage)`; launching is guarded by `run_id IS NULL`)                                                                                                                                                                                                                                                                              |
| Machine restart / app update                                                                           | Same as Master restart                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Clean shutdown with goal `running`                                                                     | Goal set to `paused` with reason `master_shutdown`; the existing `shutdown()` path in `index.ts` would call it. Resumes through the user action above                                                                                                                                                                                                                                                                                           |
| Provider exhausted/unavailable (HTTP 429, auth expired, binary missing)                                | Existing classification (`classifyProviderFailure`) marks the child run failed or paused. The supervisor does not retry on another route; a pinned role goes `blocked(provider_exhausted)` with the provider's reported reset time if known; a pool role may select another **eligible pool member** on the _next_ cycle only                                                                                                                   |
| Pending `goal_approvals` at restart                                                                    | Remain pending (they carry no live process, unlike run approvals)                                                                                                                                                                                                                                                                                                                                                                               |
| Worktree missing or branch mismatch                                                                    | Surfaced by `prepareWorkingCopy`; the cycle fails with that error and the goal goes `needs_user`                                                                                                                                                                                                                                                                                                                                                |
| Clock jumps                                                                                            | Bounds use persisted `active_ms` increments computed from monotonic ticks, not `now - started_at`                                                                                                                                                                                                                                                                                                                                               |

## 14. Usage integration

- Goal usage is `SELECT … FROM usage_events u JOIN runs r ON r.id = u.run_id WHERE r.goal_id = ?`. A `goalId` field is added to `UsageFilter`, and `loadUsageEvents` gains the join; `aggregateUsage`, breakdowns, and CSV/JSON export work unchanged.
- Breakdowns by role already exist (`u.role`); goal-role mapping (orchestrator, routine review, milestone review) is available through `goal_cycles` and the stage role recorded on each run.
- Per-cycle cost = usage of the cycle's `proposal_run_id` and `run_id`, derived the same way. Provenance (`provider_measured`, `locally_measured`, `estimated`, `unavailable`) is preserved and surfaced; unknown cost stays unknown and is never summed as zero (existing rule in `USAGE_ACCOUNTING.md`).
- The `maxMeteredUsd` bound reads reconciled actual spend and open reservations from `metered_reservations`/`usage_events`; the Goal Engine adds **no second reservation mechanism**. The existing per-run, daily, and monthly caps remain authoritative and independent.

## 15. API additions

All under `/api/goals`, same security model as other routes (loopback or paired device, existing `onRequest` checks). Request bodies use zod schemas like existing routes. Mutations that change status go through the single `transitionGoal` function.

| Method and path                                                           | Purpose                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/goals`, `GET /api/goals/:id`                                    | List and detail (contract, milestones, memory, current cycle, limits and counters, route policy, next scheduled action)  |
| `POST /api/goals/authoring`                                               | Start an authoring run from natural language; returns the draft once the run completes                                   |
| `POST /api/goals` / `PUT /api/goals/:id`                                  | Create/update a **draft** contract, routing, review, and limits; returns validation results                              |
| `POST /api/goals/:id/approve`                                             | Approve contract version (writes `goal_contract_versions`, `goal_approvals`)                                             |
| `POST /api/goals/:id/start`, `/pause`, `/resume`, `/abandon`              | State commands; each returns the preflight/validation result or the reason it was refused                                |
| `POST /api/goals/:id/limits`                                              | Raise/lower limits (raising requires explicit confirmation field; recorded in `goal_events`)                             |
| `GET /api/goals/:id/cycles`, `/evidence`, `/reviews`, `/events`, `/usage` | Activity, evidence ledger, review reports, audit, and usage (uses the shared analytics)                                  |
| `POST /api/goal-approvals/:id/decision`                                   | Decide a goal-level gate                                                                                                 |
| `POST /api/goals/:id/milestones/:mid/confirm`                             | User confirmation evidence                                                                                               |
| `GET /api/goals/:id/preview`                                              | Dry-run: the routes that would be resolved, billing evaluation, and the next bounded task description, without launching |
| `GET /api/events?goalId=`                                                 | SSE for goal events (shares the existing subscriber set; payload carries `goalId`)                                       |

`DashboardSnapshot` gains `goals: GoalSummary[]` so existing polling and the phone cockpit see goals without a new transport.

## 16. Client/UI additions (minimum V1 surfaces)

Behavioural spec; visual design follows `DESIGN.md` later.

1. **Grand Projects list** (`goals` page in the existing `Page` union): title, project, status, active milestone, last cycle, next action, "needs you" indicator, usage so far.
2. **Create Goal**: free-text box → authoring run → editable structured contract (outcome, criteria with verifiers, non-goals, constraints, deliverables, milestones) → routing roles → review policy → limits → **explicit Approve**. Shows validation errors inline and the billing/preview summary reusing the existing Run Preview components.
3. **Goal Overview** answers, on one screen: what we are building; what success means (criteria checklist with evidence status); active milestone and its remaining criteria; the last cycle's outcome; what Turing does next; orchestrator route; agents implementing and reviewing (resolved routes with lane); when the next independent review is due (cycles remaining); blockers; whether the user is needed (gate list with Approve/Deny); and project usage with provenance.
4. **Activity**: child runs grouped under the goal (links open the existing run thread), cycle kind and trigger, resolved routes per cycle, and the goal event log.
5. **Reviews and findings**: report per review, findings with status, blocking marker.
6. **Evidence**: per criterion, the typed evidence rows with links to runs/commits/files, `superseded` marked.
7. **Usage**: the existing usage analytics filtered by goal.
8. **Phone cockpit**: status, gate approvals, pause/resume, and "needs you" notifications only; no contract authoring on the phone in the first pass (consistent with the phone being a remote control).

Notifications reuse `noticeForMasterEvent`: goal needs user, goal blocked (with reason), goal completed, review blocked; de-duplicated by key.

## 17. Security implications

- **Models never get new authority.** They produce JSON that is parsed against strict schemas and validated; they cannot change routes, limits, billing, scope, workflows outside the allow-list, contract text, or state.
- **Prompt injection.** Goal memory and file content are data in a task block; the existing precedence statement (security rules, mandatory rules, role instructions, advisory rules, then task) applies. `NextTask.instructions` is length-capped and scanned with the existing secret detection (`hasSuspectedSecret`, `redactSecrets`) before launch. Expected paths and criterion ids are validated, and any instruction text that attempts to alter routes, limits, or permission mode is irrelevant because those are not read from model output.
- **No generated shell.** Verification commands come only from the approved contract and must pass `isSafeProjectCommand`; they run through the existing `runLocalCommand`/broker path in child runs, not from the supervisor.
- **Repository access** stays inside the broker (`assertProjectPath`, sensitive path blocking, symlink checks). `allowedScope` can only narrow `contextPolicy` include/exclude globs, never widen past the registered project.
- **Permission mode** for child runs is set by the goal workflow selection and cannot be raised by the supervisor; `enigma` requires the existing deliberate activation, which the Goal Engine does not auto-supply. Goals created from a phone cannot enable a more permissive mode than the Master's current settings allow.
- **Secrets**: contracts, memory, routes, and pools contain no credentials, only profile ids and labels (same rule as profiles and presets).
- **Audit:** `goal_events` plus `run_events` plus `git_operations` give a complete trail; contract versions are immutable.
- **Unattended execution** is the new risk class. Mitigations: conservative defaults, human gates on contract/first pool use/final acceptance, bounded everything, and `blocked` as the default failure state.

## 18. Billing implications

- Each child run is evaluated by the existing `evaluateBillingLane` through `makePreview`; the Goal Engine does not call a different evaluator and cannot widen a mode. `GoalLimits.billingMode` is validated to be **no more permissive** than the mode of every workflow the goal can launch; the effective mode is the stricter of the two.
- Subscriptions Only remains the default and blocks metered lanes for every cycle, including pool members. A pool containing a metered-lane member is rejected at validation when the mode forbids it, and that member is ineligible at resolution if the mode changes later.
- A pool or route never falls from a subscription/free lane into a metered lane: lane class is part of eligibility (`requireLaneClass`) and the member's own `billingLane` is fixed in its configuration. If a promotional or free route is exhausted, the provider call fails; the cycle fails/blocks and the next resolution simply finds that member ineligible or unavailable. The supervisor has no code path that picks a different lane for the same member.
- Provider-side PAYG fallback remains **unverifiable** and the Goal Overview carries the same disclosure as Run Preview.
- `maxMeteredUsd` is an additional Goal-level cap over existing reservations; it cannot raise per-run or desktop budgets.

## 19. Context-management strategy

- The Goal context is a **structured, size-capped block** (section 10) in the child task; stage context policies (`strategy`, `maxFiles`, `maxEstimatedTokens`, `maxFileBytes`, globs) continue to govern file/tool reads. Default for goal child workflows is `changed-files` for implementers/reviewers with the milestone's `allowedScope` as include globs; `artifacts-only` for the proposal run plus the memory block.
- Handoffs between stages inside a run use the existing bounded artifacts. Between cycles, the only carried state is `GoalMemory` plus Git. No transcripts, no provider session resume.
- Run Preview's context estimate already covers the memory block (it is part of the task); the supervisor additionally refuses to launch if the preview estimate exceeds the limit under the `Ask/Stop` policy, rather than letting the stage stop mid-run.

## 20. Test strategy

Deterministic only (no live providers), using the existing fixtures in `runEngine.test.ts`, `app.test.ts`, `phase36.acceptance.test.ts`, and fake provider adapters.

1. **Migration**: 014 → 015 upgrade keeps existing rows; constraints reject illegal statuses; unique active-goal-per-project index.
2. **Contract validation**: table-driven (missing verifier, uncovered criterion, cyclic milestones, scope escapes, unsafe command, unlimited limits, metered cap vs mode, opportunity pool rejected).
3. **State machine**: exhaustive transition table test (every legal and illegal pair), plus property test that only `transitionGoal` writes status.
4. **Completion**: evidence matrix; superseding; `contradicts` wins; a model "done" message alone never completes; final review must postdate the last cycle; user acceptance required.
5. **Cycle loop with a fake child-run executor**: proposal → validate → launch → evidence → next; rejected/invalid proposals; bound violations stop launching (cycles, failures, remediation, minutes, spend, days).
6. **Restart/resume** (crash simulation at every cycle status; use the existing pattern in `db.test.ts`/`runEngine.test.ts`): idempotent resume, no duplicate child runs, goal lands in `needs_user` after interrupted run, pending goal approvals persist.
7. **Route resolution**: pinned refusal when unavailable (no substitution); pool eligibility by catalog status/lane/validation; round-robin determinism; failed catalog refresh never raises eligibility; recorded resolution record; independence rule for the final reviewer.
8. **Billing**: Subscriptions Only blocks pool metered members; no free→metered path; goal billing mode cannot exceed the child workflow mode; `maxMeteredUsd` blocks the next launch.
9. **Context**: memory block cap and compaction order; launch refusal when preview estimate exceeds limits.
10. **Usage**: goal-filtered analytics equals the sum over child runs; provenance preserved; unknown cost not summed as zero.
11. **API**: authorization (remote device vs loopback), validation errors, gate decisions, idempotent commands.
12. **Client**: component tests for list/create/overview states (needs-you, blocked, completed) mirroring `App.test.tsx`.
13. **Regression**: the full existing suite (172 tests at RC2) must stay green; a no-goal run must behave byte-for-byte as before (`goal_id` NULL path).

## 21. Migration and backward compatibility

- A database with no goals behaves exactly as RC2. The only existing-table change is two nullable columns on `runs`; no existing query selects `*` into a strict type that would break (`getRunRow`/`toRun` ignore unknown columns; verified by reading `serialize.ts` usage, and covered by regression tests).
- Existing workflows are not modified. Goals reference saved workflows by id and apply routes via `workflowOverride`, so editing or exporting workflows is unaffected. Workflow export/import is unchanged in the first pass; exporting a goal contract/policy template (without local profile ids, following the existing `sanitizeWorkflowExport` approach) is deferred.
- The API and `DashboardSnapshot` additions are additive; older phone PWAs ignore `goals`.
- `RELEASE_NOTES` for the next RC must state the new migration (015).

## 22. Staged implementation plan

Each stage ends with the full gate green, a coherent commit, and an update to `docs/V1_READINESS.md`.

0. **Prerequisite refactor (no behaviour change):** move `makePreview` and `createQueuedRun` out of `app.ts` into `src/server/runLauncher.ts` (exported, same signatures, `app.ts` imports them). Characterised by existing `app.test.ts` and `phase36.acceptance.test.ts`. This is the only change to existing run code and exists because those functions are currently file-private.
1. **Schema, types, validation:** migration 015, `shared/goals.ts`, contract/limit/routing validators, state-machine module with the transition table, `evaluateCompletion`, and their unit tests. No supervisor yet.
2. **Supervisor core with fake executor:** tick loop, bounds, cycle persistence, memory builder, evidence collection from run rows; restart reconciliation wired into `index.ts`; tests for restart and bounds.
3. **Real child runs:** `launchRun` through the extracted launcher; planning, execution workflows seeded as built-ins; evidence from real stage outputs; Git sequencing per Q1; usage join and `goalId` analytics filter.
4. **Routing:** pinned routes and static pools with resolution records; independence rule; eligibility vs catalog; first-use pool gate.
5. **Reviews:** review workflows, `ReviewReport` normalisation, triggers, blocking and remediation cycles; goal notifications.
6. **Authoring and UI:** authoring run, API surface, Goals list/Create/Overview/Activity/Evidence/Usage, phone cockpit controls; Turing-validation record for routes (a manual or test-run result stored per route, never inferred from a catalog).
7. **Acceptance tests** covering sections 20.5-20.10 end to end with fake providers; documentation (`WORKFLOWS.md`, `SECURITY.md`, `BILLING_SAFETY.md`, `ARCHITECTURE.md`, a new `GOALS.md`), readiness update.

Only after stage 7 and a prove-it review does the Model Opportunity Layer begin (kept strictly separate, per the agreed sequence): Goal Engine foundation → bounded execution proven → periodic review → Model Opportunity Layer → opportunity pools → RC3 → hardening.

## 23. Risks and open questions

**Open questions needing a decision before implementation**

- **Q1 — How do consecutive cycles share code?** Today every run branches a worktree from the project HEAD and `mergeGitBranch` requires the source repo to be clean, on the recorded base branch, at the recorded starting commit. Two options:
  - _A (recommended first pass; no RunEngine change):_ each execution workflow ends with `gitCheckpoint` + `gitMerge` into the base branch; the next cycle starts from the new HEAD. The project is exclusively leased by the goal (unique index above) and must stay clean; the user cannot work in that checkout meanwhile. Merge approval follows the existing permission-mode policy, so unattended progress depends on a mode that auto-approves merge, which is a deliberate user choice.
  - _B:_ a goal integration branch (`turing/goal/<id>`) with child worktrees based on its tip and merged into it, with one final merge to the base branch under approval. This keeps the user's checkout free but needs an additive `base_ref` on runs and changes in `prepareWorkingCopy`/`mergeGitBranch`, i.e. real RunEngine edits.
    Recommendation: ship A; design B as a follow-up if the exclusive-checkout limitation proves unacceptable.
- **Q2 — Goal approvals table.** Separate `goal_approvals` (proposed) vs making `approvals.run_id` nullable (table rebuild). Proposed approach keeps migrations additive and the existing approvals invariant (`run_id NOT NULL`) intact.
- **Q3 — Where do the two planner calls (authoring, per-cycle proposal) live?** Proposed: as read-only ordinary runs, costing one extra run per cycle. If that cost is unacceptable, the proposal can be folded into the execution workflow's first `planner` stage and validated by a hold-point `humanApproval`/decision gate, at the cost of weaker pre-validation.
- **Q4 — Validation records for routes.** What constitutes "Turing-validated" for pool eligibility (a passing no-op run on that exact route? a stored result with expiry?). Needed for stage 6; not for the pinned-route MVP.
- **Q5 — Concurrency.** First pass: one child run per goal and one active goal per project. Multi-goal concurrency across projects is allowed by the schema but unproven against `maxParallelAgents` and provider limits; default global limit of one running goal until tested.
- **Q6 — Duration accounting** while `needs_user`/`paused`: proposal is to exclude it from `maxActiveMinutes` but keep `maxWallClockDays`.

**Risks**

- Unattended long runs magnify any existing engine defect; mitigation is bounds, `blocked` as default failure, and heavy restart testing.
- The extraction refactor in stage 0 touches the central run path; mitigated by characterisation tests before and after.
- A bounded memory block can omit a fact the orchestrator needs; mitigation is structured fields for decisions/findings/blockers and the user-visible memory in the Overview so errors are inspectable.
- Provider outputs that do not parse into the strict schemas will fail cycles; consecutive-failure bounds prevent runaway cost, and parse failures are cheap and visible.
- Review-model agreement is not evidence. The design treats reviews as advisory except for blocking; deterministic verifiers decide satisfaction.

## 24. Why `RunEngine` does not become an unbounded autonomous loop

- `RunEngine` keeps its current contract: one `runId` in, one finite stage graph executed, hard `maxDurationMinutes`, bounded retries and remediation rounds, terminal status out. **No `RunEngine` code needs to change for the first pass** (stage 0 only relocates two functions that `RunEngine` does not call).
- Long-horizon behaviour exists only **above** the engine, as many separate runs created via the same API path a user would use. Each run is independently previewed, billed-checked, snapshotted, approvable, cancellable, and recoverable by the existing reconciliation.
- The unit of autonomy is the **cycle**, and the supervisor's repeat is a persisted state machine with explicit bounds, not an in-memory `while`. Between cycles the process holds no live model session and no transcript; state is the Goal Contract, structured memory, evidence rows, and Git.
- The orchestrator is a _role in a read-only run_, like the existing `orchestrator` stage kind that may only choose among configured branches. Here it may only propose a `NextTask` that the application validates; it cannot create stages, change routes, or move state.
- Therefore the deterministic workflow engine stays authoritative for what happens **inside** a run, and the deterministic Goal supervisor is authoritative for what happens **between** runs. Neither is delegated to a model.

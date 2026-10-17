-- Goal evidence, reviews, findings, approvals, events and route validations (Stage 2A: structure only).
-- Same-owner rule: every row that carries goal_id and a child key references the child through a composite
-- foreign key (goal_id, child), so a row can never point into another Goal's history.

-- Targets for the same-owner composite keys that 015 did not already provide.
-- (goal_cycles, goal_milestones and goal_definition_versions already expose (goal_id, id | version).)

CREATE TABLE goal_reviews (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  cycle_id TEXT,
  milestone_id TEXT,
  definition_version INTEGER NOT NULL,
  run_id TEXT REFERENCES runs (id),
  review_kind TEXT NOT NULL CHECK (review_kind IN ('periodic','milestone','repeated_failure','scope_change','final')),
  -- Lifecycle: pending -> completed | failed | cancelled. Every non-pending status is terminal.
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','cancelled')),
  -- Repository binding, fixed at creation: the reviewer judges exactly this state.
  reviewed_from_commit TEXT,
  reviewed_to_commit TEXT NOT NULL,
  reviewed_to_tree TEXT NOT NULL,
  -- Result, written once on completion.
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass','pass_with_findings','block')),
  blocking INTEGER CHECK (blocking IS NULL OR blocking IN (0, 1)),
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
  independence_json TEXT CHECK (independence_json IS NULL OR json_valid(independence_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (goal_id, id),
  CHECK (status <> 'completed' OR (verdict IS NOT NULL AND blocking IS NOT NULL AND report_json IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status = 'completed' OR (verdict IS NULL AND report_json IS NULL AND blocking IS NULL)),
  FOREIGN KEY (goal_id, cycle_id) REFERENCES goal_cycles (goal_id, id),
  FOREIGN KEY (goal_id, milestone_id) REFERENCES goal_milestones (goal_id, id),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions (goal_id, version)
);
CREATE INDEX idx_goal_reviews_goal ON goal_reviews (goal_id, created_at);

CREATE TABLE goal_evidence (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  definition_version INTEGER NOT NULL,
  milestone_id TEXT,
  criterion_key TEXT NOT NULL,
  verifier_digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('test_result','build_result','lint_result','run_result','commit','review_verdict','artifact','user_confirmation')),
  verdict TEXT NOT NULL CHECK (verdict IN ('satisfies','contradicts','inconclusive')),
  cycle_id TEXT,
  run_id TEXT REFERENCES runs (id),
  stage_id TEXT REFERENCES stages (id),
  review_id TEXT,
  subject_commit TEXT,
  subject_tree TEXT,
  subject_path TEXT,
  subject_blob TEXT,
  subject_sha256 TEXT,
  reviewed_from_commit TEXT,
  reviewed_to_commit TEXT,
  reviewed_to_tree TEXT,
  ref_json TEXT NOT NULL CHECK (json_valid(ref_json)),
  recorded_at TEXT NOT NULL,
  UNIQUE (goal_id, id),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions (goal_id, version),
  FOREIGN KEY (goal_id, milestone_id) REFERENCES goal_milestones (goal_id, id),
  FOREIGN KEY (goal_id, cycle_id) REFERENCES goal_cycles (goal_id, id),
  FOREIGN KEY (goal_id, review_id) REFERENCES goal_reviews (goal_id, id)
);
CREATE INDEX idx_goal_evidence_criterion ON goal_evidence (goal_id, criterion_key, recorded_at);

CREATE TABLE goal_findings (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_files_json)),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','accepted_by_user','dismissed_by_user')),
  first_seen_review_id TEXT NOT NULL,
  last_seen_review_id TEXT NOT NULL,
  resolved_by_review_id TEXT,
  resolution_basis_json TEXT CHECK (resolution_basis_json IS NULL OR json_valid(resolution_basis_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (goal_id, id),
  CHECK (status <> 'resolved' OR resolved_by_review_id IS NOT NULL),
  FOREIGN KEY (goal_id, first_seen_review_id) REFERENCES goal_reviews (goal_id, id),
  FOREIGN KEY (goal_id, last_seen_review_id) REFERENCES goal_reviews (goal_id, id),
  FOREIGN KEY (goal_id, resolved_by_review_id) REFERENCES goal_reviews (goal_id, id)
);
-- A fingerprint identifies at most one open finding per Goal (deterministic dedupe, section 11.4).
CREATE UNIQUE INDEX idx_goal_findings_open_fingerprint ON goal_findings (goal_id, fingerprint) WHERE status = 'open';

CREATE TABLE goal_finding_observations (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  goal_finding_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  run_finding_id TEXT REFERENCES review_findings (id),
  observation TEXT NOT NULL CHECK (observation IN ('new','still_open','resolved','reopened','not_assessed')),
  basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (goal_finding_id, review_id),
  FOREIGN KEY (goal_id, goal_finding_id) REFERENCES goal_findings (goal_id, id),
  FOREIGN KEY (goal_id, review_id) REFERENCES goal_reviews (goal_id, id)
);

CREATE TABLE goal_approvals (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  gate TEXT NOT NULL CHECK (gate IN
    ('definition','amendment','start','each_cycle','milestone_complete','pool_route_first_use','scope_change',
     'review_decision','finding_decision','user_confirmation','final_acceptance','final_apply')),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('user','supervisor','system')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
  decided_by TEXT CHECK (decided_by IS NULL OR decided_by IN ('user','system')),
  decision_note TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  UNIQUE (goal_id, id),
  CHECK ((status = 'pending' AND decided_by IS NULL AND responded_at IS NULL)
      OR (status <> 'pending' AND decided_by IS NOT NULL AND responded_at IS NOT NULL)),
  -- Only an explicit user action approves a gate; the system may only deny (for example when a restart interrupts it).
  CHECK (status <> 'approved' OR decided_by = 'user')
);
CREATE INDEX idx_goal_approvals_goal ON goal_approvals (goal_id, status);

CREATE TABLE goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_goal_events_goal ON goal_events (goal_id, created_at);

CREATE TABLE route_validations (
  id TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  profile TEXT NOT NULL CHECK (profile IN
    ('structured-readonly','review-json','orchestrator-json','broker-read','broker-edit')),
  status TEXT NOT NULL CHECK (status IN ('pass','fail')),
  evidence_run_id TEXT REFERENCES runs (id),
  resolved_model_reported TEXT,
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  provenance TEXT NOT NULL CHECK (provenance IN ('turing_probe_run')),
  adapter_version TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  tested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > tested_at)
);
CREATE INDEX idx_route_validations_identity ON route_validations (identity_hash, profile, tested_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Evidence: immutable and append-only. Staleness is computed later, never written.
CREATE TRIGGER trg_goal_evidence_immutable BEFORE UPDATE ON goal_evidence
BEGIN SELECT RAISE(ABORT, 'goal_evidence is immutable'); END;
CREATE TRIGGER trg_goal_evidence_no_delete BEFORE DELETE ON goal_evidence
BEGIN SELECT RAISE(ABORT, 'goal_evidence cannot be deleted'); END;

-- A run or stage cited as evidence must belong to the same Goal (and cycle, when both are given).
CREATE TRIGGER trg_goal_evidence_run BEFORE INSERT ON goal_evidence
WHEN NEW.run_id IS NOT NULL
  AND ((SELECT goal_id FROM goal_runs WHERE run_id = NEW.run_id) IS NOT NEW.goal_id
    OR (NEW.cycle_id IS NOT NULL AND (SELECT cycle_id FROM goal_runs WHERE run_id = NEW.run_id) IS NOT NEW.cycle_id))
BEGIN SELECT RAISE(ABORT, 'evidence run does not belong to the Goal or cycle'); END;
CREATE TRIGGER trg_goal_evidence_stage BEFORE INSERT ON goal_evidence
WHEN NEW.stage_id IS NOT NULL
  AND (NEW.run_id IS NULL OR (SELECT run_id FROM stages WHERE id = NEW.stage_id) IS NOT NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'evidence stage does not belong to the evidence run'); END;

-- Reviews: identity and repository binding never change; a pending review completes at most once;
-- completed, failed and cancelled reviews are fully immutable.
CREATE TRIGGER trg_goal_review_insert BEFORE INSERT ON goal_reviews
WHEN NEW.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'a review is created pending'); END;
CREATE TRIGGER trg_goal_review_run BEFORE INSERT ON goal_reviews
WHEN NEW.run_id IS NOT NULL
  AND ((SELECT goal_id FROM goal_runs WHERE run_id = NEW.run_id) IS NOT NEW.goal_id
    OR (NEW.cycle_id IS NOT NULL AND (SELECT cycle_id FROM goal_runs WHERE run_id = NEW.run_id) IS NOT NEW.cycle_id))
BEGIN SELECT RAISE(ABORT, 'review run does not belong to the Goal or cycle'); END;
CREATE TRIGGER trg_goal_review_identity BEFORE UPDATE ON goal_reviews
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.cycle_id IS NOT OLD.cycle_id
  OR NEW.milestone_id IS NOT OLD.milestone_id OR NEW.definition_version IS NOT OLD.definition_version
  OR NEW.run_id IS NOT OLD.run_id OR NEW.review_kind IS NOT OLD.review_kind
  OR NEW.reviewed_from_commit IS NOT OLD.reviewed_from_commit OR NEW.reviewed_to_commit IS NOT OLD.reviewed_to_commit
  OR NEW.reviewed_to_tree IS NOT OLD.reviewed_to_tree OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'review identity and repository binding are immutable'); END;
CREATE TRIGGER trg_goal_review_terminal BEFORE UPDATE ON goal_reviews
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'a decided review is immutable'); END;
CREATE TRIGGER trg_goal_review_no_delete BEFORE DELETE ON goal_reviews
BEGIN SELECT RAISE(ABORT, 'reviews cannot be deleted'); END;

-- Findings: identity is fixed; observations are append-only.
CREATE TRIGGER trg_goal_finding_identity BEFORE UPDATE ON goal_findings
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.first_seen_review_id IS NOT OLD.first_seen_review_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'finding identity is immutable'); END;
CREATE TRIGGER trg_goal_finding_no_delete BEFORE DELETE ON goal_findings
BEGIN SELECT RAISE(ABORT, 'findings cannot be deleted'); END;
CREATE TRIGGER trg_goal_observation_immutable BEFORE UPDATE ON goal_finding_observations
BEGIN SELECT RAISE(ABORT, 'finding observations are append-only'); END;
CREATE TRIGGER trg_goal_observation_no_delete BEFORE DELETE ON goal_finding_observations
BEGIN SELECT RAISE(ABORT, 'finding observations are append-only'); END;

-- Goal approvals: created pending, decided once (pending -> approved | denied), then immutable.
CREATE TRIGGER trg_goal_approval_insert BEFORE INSERT ON goal_approvals
WHEN NEW.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'a goal approval is created pending'); END;
CREATE TRIGGER trg_goal_approval_identity BEFORE UPDATE ON goal_approvals
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.gate IS NOT OLD.gate OR NEW.risk IS NOT OLD.risk
  OR NEW.reason IS NOT OLD.reason OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.detail_json IS NOT OLD.detail_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'goal approval identity is immutable'); END;
CREATE TRIGGER trg_goal_approval_terminal BEFORE UPDATE ON goal_approvals
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'a decided goal approval is immutable'); END;
CREATE TRIGGER trg_goal_approval_no_delete BEFORE DELETE ON goal_approvals
BEGIN SELECT RAISE(ABORT, 'goal approvals cannot be deleted'); END;

-- Events are an append-only log.
CREATE TRIGGER trg_goal_event_immutable BEFORE UPDATE ON goal_events
BEGIN SELECT RAISE(ABORT, 'goal events are append-only'); END;
CREATE TRIGGER trg_goal_event_no_delete BEFORE DELETE ON goal_events
BEGIN SELECT RAISE(ABORT, 'goal events are append-only'); END;

-- Route validations are records of a test that happened; they are never edited or removed.
CREATE TRIGGER trg_route_validation_immutable BEFORE UPDATE ON route_validations
BEGIN SELECT RAISE(ABORT, 'route validations are immutable'); END;
CREATE TRIGGER trg_route_validation_no_delete BEFORE DELETE ON route_validations
BEGIN SELECT RAISE(ABORT, 'route validations cannot be deleted'); END;

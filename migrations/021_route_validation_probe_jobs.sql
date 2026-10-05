-- Stage 5B: durable route-validation probe jobs. A probe job binds ONE ordinary run to the exact route identity that was
-- captured server-side BEFORE the run was queued, the finite profile set that was requested and a finite lifecycle.
-- It carries no credential, provider text, transcript or model output. Validation records produced from the run stay
-- in the immutable `route_validations` table; this table only says what the run was for and whether it was consumed.
-- Additive: migrations 001-020 are untouched.
CREATE TABLE route_validation_probes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  freshness_class TEXT NOT NULL CHECK (freshness_class IN ('stable-subscription','opportunity')),
  profiles_json TEXT NOT NULL CHECK (json_valid(profiles_json) AND json_type(profiles_json) = 'array'
    AND json_array_length(profiles_json) BETWEEN 1 AND 5),
  fixture_commit TEXT NOT NULL CHECK (length(fixture_commit) IN (40, 64)),
  status TEXT NOT NULL CHECK (status IN ('pending','consumed','failed')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN
    ('run_missing','run_failed','run_cancelled','fixture_unavailable','profiles_untested')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  worktree_released_at TEXT,
  CHECK (
    (status = 'pending' AND failure_code IS NULL AND completed_at IS NULL)
    OR (status = 'consumed' AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX idx_route_validation_probes_open ON route_validation_probes (status, created_at);
CREATE INDEX idx_route_validation_probes_identity ON route_validation_probes (identity_hash, status);

-- Identity, profiles and binding never change. A pending probe ends exactly once, as consumed or failed. A finished probe
-- is immutable except that its worktree may be released once, after which nothing changes.
CREATE TRIGGER trg_route_probe_binding_immutable BEFORE UPDATE ON route_validation_probes
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.identity_hash IS NOT OLD.identity_hash
  OR NEW.identity_json IS NOT OLD.identity_json OR NEW.freshness_class IS NOT OLD.freshness_class
  OR NEW.profiles_json IS NOT OLD.profiles_json OR NEW.fixture_commit IS NOT OLD.fixture_commit
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'a route validation probe binding is immutable'); END;
CREATE TRIGGER trg_route_probe_transition BEFORE UPDATE ON route_validation_probes
WHEN OLD.status <> 'pending'
  AND (NEW.status IS NOT OLD.status OR NEW.failure_code IS NOT OLD.failure_code
    OR NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT, 'a finished route validation probe is immutable'); END;
CREATE TRIGGER trg_route_probe_pending_release BEFORE UPDATE ON route_validation_probes
WHEN OLD.status = 'pending' AND NEW.worktree_released_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a pending probe cannot release its worktree'); END;
CREATE TRIGGER trg_route_probe_release_once BEFORE UPDATE ON route_validation_probes
WHEN OLD.worktree_released_at IS NOT NULL AND NEW.worktree_released_at IS NOT OLD.worktree_released_at
BEGIN SELECT RAISE(ABORT, 'a probe worktree is released at most once'); END;
CREATE TRIGGER trg_route_probe_no_delete BEFORE DELETE ON route_validation_probes
BEGIN SELECT RAISE(ABORT, 'route validation probes cannot be deleted'); END;
-- A probe is created pending; nothing else is a valid start.
CREATE TRIGGER trg_route_probe_insert BEFORE INSERT ON route_validation_probes
WHEN NEW.status <> 'pending' OR NEW.worktree_released_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a route validation probe is created pending'); END;

-- Idempotent record production: at most one validation record per probe run and profile.
CREATE UNIQUE INDEX uq_route_validations_run_profile ON route_validations (evidence_run_id, profile)
  WHERE evidence_run_id IS NOT NULL;

-- A record whose evidence run is a probe run must describe exactly that probe's route and one of its profiles, and may
-- only be written while the probe is still pending (the reconciler writes records and then finalizes the probe).
CREATE TRIGGER trg_route_validation_probe_binding BEFORE INSERT ON route_validations
WHEN NEW.evidence_run_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM route_validation_probes p WHERE p.run_id = NEW.evidence_run_id)
  AND NOT EXISTS (
    SELECT 1 FROM route_validation_probes p
    WHERE p.run_id = NEW.evidence_run_id AND p.status = 'pending'
      AND p.identity_hash = NEW.identity_hash AND p.identity_json = NEW.identity_json
      AND EXISTS (SELECT 1 FROM json_each(p.profiles_json) j WHERE j.value = NEW.profile))
BEGIN SELECT RAISE(ABORT, 'a probe validation record must match its pending probe'); END;

-- Model Opportunity Layer: append-only provider/model observations with explicit, auditable retention.
CREATE TABLE model_observation_refreshes (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  backend_id TEXT NOT NULL CHECK (length(backend_id) BETWEEN 1 AND 80),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 80),
  source_class TEXT NOT NULL CHECK (source_class IN ('live', 'cache', 'adapter', 'none')),
  refresh_outcome TEXT NOT NULL CHECK (refresh_outcome IN ('success', 'empty', 'failed')),
  started_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  error_code TEXT,
  cache_observed_at TEXT,
  UNIQUE (id, backend_id, provider_id)
);

CREATE INDEX idx_model_observation_refreshes_checked
  ON model_observation_refreshes(backend_id, checked_at DESC);

CREATE TABLE model_observations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  refresh_id TEXT NOT NULL,
  backend_id TEXT NOT NULL CHECK (length(backend_id) BETWEEN 1 AND 80),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 80),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 180),
  claim_kind TEXT NOT NULL CHECK (claim_kind IN ('provider-advertised', 'locally-discovered')),
  source_class TEXT NOT NULL CHECK (source_class IN ('live', 'cache', 'adapter')),
  refresh_outcome TEXT NOT NULL CHECK (refresh_outcome IN ('success', 'empty', 'failed')),
  payload_json TEXT NOT NULL CHECK (length(CAST(payload_json AS BLOB)) <= 16384),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (refresh_id, backend_id, provider_id, model_id),
  FOREIGN KEY (refresh_id, backend_id, provider_id)
    REFERENCES model_observation_refreshes(id, backend_id, provider_id) ON DELETE RESTRICT
);

CREATE INDEX idx_model_observations_identity
  ON model_observations(backend_id, provider_id, model_id, observed_at DESC);
CREATE INDEX idx_model_observations_expiry ON model_observations(observed_at);

CREATE TABLE model_observation_admission_refs (
  admission_id TEXT NOT NULL REFERENCES goal_approvals(id) ON DELETE RESTRICT,
  goal_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  pool_id TEXT NOT NULL CHECK (length(pool_id) BETWEEN 1 AND 64),
  member_index INTEGER NOT NULL CHECK (member_index BETWEEN 0 AND 15),
  observation_id TEXT NOT NULL REFERENCES model_observations(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (admission_id, observation_id),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions(goal_id, version) ON DELETE RESTRICT
);
CREATE INDEX idx_model_observation_admission_refs_expiry
  ON model_observation_admission_refs(expires_at);

-- Admission authority is a durable proof for one exact exam definition. Raw observations and their temporary
-- references may expire after 90 days; this record stays until the definition is superseded.
CREATE TABLE model_opportunity_admission_proofs (
  approval_id TEXT PRIMARY KEY REFERENCES goal_approvals(id) ON DELETE RESTRICT,
  goal_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  pool_id TEXT NOT NULL CHECK (length(pool_id) BETWEEN 1 AND 64),
  member_index INTEGER NOT NULL CHECK (member_index BETWEEN 0 AND 15),
  member_identity_hash TEXT NOT NULL CHECK (length(member_identity_hash) = 64 AND member_identity_hash NOT GLOB '*[^0-9a-f]*'),
  opportunity_digest TEXT NOT NULL CHECK (length(opportunity_digest) = 64 AND opportunity_digest NOT GLOB '*[^0-9a-f]*'),
  observation_ids_json TEXT NOT NULL CHECK (json_valid(observation_ids_json) AND length(observation_ids_json) <= 400),
  proof_digest TEXT NOT NULL CHECK (length(proof_digest) = 64 AND proof_digest NOT GLOB '*[^0-9a-f]*'),
  accepted_at TEXT NOT NULL,
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions(goal_id, version) ON DELETE RESTRICT
);
CREATE INDEX idx_model_opportunity_admission_proofs_binding
  ON model_opportunity_admission_proofs(goal_id, definition_version, pool_id, member_index);
CREATE UNIQUE INDEX idx_model_opportunity_admission_proofs_exact
  ON model_opportunity_admission_proofs(
    goal_id, definition_version, pool_id, member_index, member_identity_hash, opportunity_digest, observation_ids_json
  );

CREATE TABLE model_observation_retention_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  cutoff_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  deleted_observations INTEGER NOT NULL DEFAULT 0 CHECK (deleted_observations >= 0),
  deleted_refreshes INTEGER NOT NULL DEFAULT 0 CHECK (deleted_refreshes >= 0),
  deleted_admission_refs INTEGER NOT NULL DEFAULT 0 CHECK (deleted_admission_refs >= 0),
  deleted_admission_proofs INTEGER NOT NULL DEFAULT 0 CHECK (deleted_admission_proofs >= 0)
);

CREATE TRIGGER trg_model_observations_no_update
BEFORE UPDATE ON model_observations
BEGIN SELECT RAISE(ABORT, 'model observations are immutable'); END;
CREATE TRIGGER trg_model_observations_no_delete
BEFORE DELETE ON model_observations
WHEN NOT EXISTS (
  SELECT 1 FROM model_observation_retention_jobs job
  WHERE job.finished_at IS NULL
    AND OLD.observed_at < job.cutoff_at
    AND NOT EXISTS (SELECT 1 FROM model_observation_admission_refs ref WHERE ref.observation_id = OLD.id)
)
BEGIN SELECT RAISE(ABORT, 'model observations may only be deleted by an eligible retention job'); END;

CREATE TRIGGER trg_model_refreshes_no_update
BEFORE UPDATE ON model_observation_refreshes
BEGIN SELECT RAISE(ABORT, 'model observation refreshes are immutable'); END;
CREATE TRIGGER trg_model_refreshes_no_delete
BEFORE DELETE ON model_observation_refreshes
WHEN NOT EXISTS (
  SELECT 1 FROM model_observation_retention_jobs job
  WHERE job.finished_at IS NULL
    AND OLD.finished_at < job.cutoff_at
    AND NOT EXISTS (SELECT 1 FROM model_observations obs WHERE obs.refresh_id = OLD.id)
)
BEGIN SELECT RAISE(ABORT, 'model observation refreshes may only be deleted by an eligible retention job'); END;

CREATE TRIGGER trg_model_admission_refs_no_update
BEFORE UPDATE ON model_observation_admission_refs
BEGIN SELECT RAISE(ABORT, 'model observation admission references are immutable'); END;
CREATE TRIGGER trg_model_admission_refs_no_delete
BEFORE DELETE ON model_observation_admission_refs
WHEN NOT EXISTS (
  SELECT 1 FROM model_observation_retention_jobs job
  WHERE job.finished_at IS NULL
    AND (OLD.expires_at <= job.started_at OR EXISTS (
      SELECT 1 FROM goal_definition_versions definition
      WHERE definition.goal_id = OLD.goal_id AND definition.version = OLD.definition_version
        AND definition.status = 'superseded'
    ))
)
BEGIN SELECT RAISE(ABORT, 'active model observation references cannot be deleted'); END;

CREATE TRIGGER trg_model_opportunity_admission_proof_insert_guard
BEFORE INSERT ON model_opportunity_admission_proofs
WHEN NOT EXISTS (
  SELECT 1 FROM goal_approvals approval
  JOIN goal_definition_versions definition
    ON definition.goal_id = NEW.goal_id AND definition.version = NEW.definition_version
  WHERE approval.id = NEW.approval_id AND approval.goal_id = NEW.goal_id
    AND approval.gate = 'pool_route_first_use' AND approval.status = 'approved'
    AND approval.risk = 'medium' AND approval.requested_by = 'user' AND approval.decided_by = 'user'
    AND definition.status IN ('proposed', 'approved')
    AND json_valid(approval.detail_json)
    AND json_type(approval.detail_json, '$.admissionKind') = 'text'
    AND json_extract(approval.detail_json, '$.admissionKind') = 'opportunity'
    AND json_extract(approval.detail_json, '$.poolId') = NEW.pool_id
    AND json_extract(approval.detail_json, '$.memberIndex') = NEW.member_index
    AND json_extract(approval.detail_json, '$.memberIdentityHash') = NEW.member_identity_hash
    AND json_extract(approval.detail_json, '$.opportunityDigest') = NEW.opportunity_digest
    AND json(json_extract(approval.detail_json, '$.observationIds')) = json(NEW.observation_ids_json)
    AND EXISTS (
      SELECT 1 FROM goal_definition_versions d,
        json_each(d.routing_json, '$.pools') pools,
        json_each(pools.value, '$.members') members
      WHERE d.goal_id = NEW.goal_id AND d.version = NEW.definition_version
        AND json_extract(pools.value, '$.id') = NEW.pool_id
        AND json_extract(pools.value, '$.admission') = 'opportunity'
        AND CAST(members.key AS INTEGER) = NEW.member_index
        AND json_extract(members.value, '$.opportunity.opportunityDigest') = NEW.opportunity_digest
        AND json(json_extract(members.value, '$.opportunity.observationIds')) = json(NEW.observation_ids_json)
    )
)
BEGIN SELECT RAISE(ABORT, 'opportunity admission proof does not match its approved definition'); END;
CREATE TRIGGER trg_model_opportunity_admission_proofs_no_update
BEFORE UPDATE ON model_opportunity_admission_proofs
BEGIN SELECT RAISE(ABORT, 'opportunity admission proofs are immutable'); END;
CREATE TRIGGER trg_model_opportunity_admission_proofs_no_delete
BEFORE DELETE ON model_opportunity_admission_proofs
WHEN NOT EXISTS (
  SELECT 1 FROM model_observation_retention_jobs job
  JOIN goal_definition_versions definition
    ON definition.goal_id = OLD.goal_id AND definition.version = OLD.definition_version
  WHERE job.finished_at IS NULL AND definition.status = 'superseded'
)
BEGIN SELECT RAISE(ABORT, 'active opportunity admission proofs cannot be deleted'); END;

CREATE TRIGGER trg_goal_approval_opportunity_insert_guard
BEFORE INSERT ON goal_approvals
WHEN json_valid(NEW.detail_json) = 0
  OR (json_type(NEW.detail_json, '$.admissionKind') IS NOT NULL
      AND (json_type(NEW.detail_json, '$.admissionKind') <> 'text'
        OR json_extract(NEW.detail_json, '$.admissionKind') NOT IN ('static', 'opportunity')))
  OR (json_extract(NEW.detail_json, '$.admissionKind') = 'opportunity' AND (
       NEW.gate <> 'pool_route_first_use' OR NEW.risk <> 'medium' OR NEW.requested_by <> 'user'
    OR json_type(NEW.detail_json, '$.schemaVersion') IS NOT 'integer'
    OR json_extract(NEW.detail_json, '$.schemaVersion') <> 1
    OR json_type(NEW.detail_json, '$.poolId') IS NOT 'text'
    OR length(json_extract(NEW.detail_json, '$.poolId')) NOT BETWEEN 1 AND 64
    OR json_type(NEW.detail_json, '$.memberIndex') IS NOT 'integer'
    OR json_extract(NEW.detail_json, '$.memberIndex') NOT BETWEEN 0 AND 15
    OR json_type(NEW.detail_json, '$.memberIdentityHash') IS NOT 'text'
    OR length(json_extract(NEW.detail_json, '$.memberIdentityHash')) <> 64
    OR json_extract(NEW.detail_json, '$.memberIdentityHash') GLOB '*[^0-9a-f]*'
    OR json_type(NEW.detail_json, '$.opportunityDigest') IS NOT 'text'
    OR length(json_extract(NEW.detail_json, '$.opportunityDigest')) <> 64
    OR json_extract(NEW.detail_json, '$.opportunityDigest') GLOB '*[^0-9a-f]*'
    OR json_type(NEW.detail_json, '$.observationIds') IS NOT 'array'
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json, '$.observationIds')) NOT BETWEEN 1 AND 8
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json, '$.observationIds')
        WHERE type <> 'text' OR length(value) <> 36 OR value GLOB '*[^0-9a-f-]*') > 0
    OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.detail_json, '$.observationIds')) <>
       (SELECT COUNT(*) FROM json_each(NEW.detail_json, '$.observationIds'))
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json)) <> 7
    OR length(NEW.detail_json) > 4000
  ))
BEGIN SELECT RAISE(ABORT, 'opportunity admission approval detail is invalid'); END;

CREATE TRIGGER trg_model_observation_admission_ref_insert_guard
BEFORE INSERT ON model_observation_admission_refs
WHEN NOT EXISTS (
  SELECT 1 FROM goal_approvals approval
  JOIN goal_definition_versions definition
    ON definition.goal_id = NEW.goal_id AND definition.version = NEW.definition_version
  WHERE approval.id = NEW.admission_id AND approval.goal_id = NEW.goal_id
    AND approval.gate = 'pool_route_first_use' AND approval.status = 'pending'
    AND approval.risk = 'medium' AND approval.requested_by = 'user'
    AND definition.status = 'proposed'
    AND json_extract(approval.detail_json, '$.admissionKind') = 'opportunity'
    AND json_extract(approval.detail_json, '$.poolId') = NEW.pool_id
    AND json_extract(approval.detail_json, '$.memberIndex') = NEW.member_index
    AND EXISTS (SELECT 1 FROM json_each(approval.detail_json, '$.observationIds') WHERE value = NEW.observation_id)
)
BEGIN SELECT RAISE(ABORT, 'observation admission reference does not match its pending approval'); END;

CREATE TRIGGER trg_model_observation_refreshes_insert_guard
BEFORE INSERT ON model_observation_refreshes
WHEN EXISTS (SELECT 1 FROM model_observation_refreshes WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'model observation refresh identity already exists'); END;
CREATE TRIGGER trg_model_observations_insert_guard
BEFORE INSERT ON model_observations
WHEN EXISTS (
  SELECT 1 FROM model_observations
  WHERE id = NEW.id
     OR (refresh_id = NEW.refresh_id AND backend_id = NEW.backend_id
         AND provider_id = NEW.provider_id AND model_id = NEW.model_id)
)
BEGIN SELECT RAISE(ABORT, 'model observation identity already exists'); END;

-- Stage 6A: the persisted review-run identity.
--
-- A Goal review is bound to exactly one review cycle and exactly one run, and a review's verdict evidence is recorded at
-- most once per verifier. These are partial unique indexes only: no existing row is rewritten, and rows that predate the
-- review-run path (cycle_id / run_id NULL, or any other evidence kind) are unaffected.
CREATE UNIQUE INDEX idx_goal_reviews_cycle_unique ON goal_reviews (cycle_id) WHERE cycle_id IS NOT NULL;
CREATE UNIQUE INDEX idx_goal_reviews_run_unique ON goal_reviews (run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_goal_evidence_review_verdict_once
  ON goal_evidence (review_id, verifier_digest) WHERE kind = 'review_verdict';

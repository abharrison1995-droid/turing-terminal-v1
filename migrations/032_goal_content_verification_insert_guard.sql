-- Additive defence for append-only content-verification evidence.
--
-- Migration 029's UPDATE and DELETE triggers do not protect against REPLACE conflict resolution while recursive
-- triggers are OFF: the implicit delete does not fire the DELETE trigger, and the UPDATE trigger does not run. This
-- BEFORE INSERT guard rejects the insert before REPLACE can remove a row, at either stored identity: the primary key
-- `id` and the `(goal_id, verification_digest)` unique key. It also rejects an ordinary duplicate INSERT.

CREATE TRIGGER trg_goal_content_verification_insert_guard
BEFORE INSERT ON goal_content_verifications
WHEN EXISTS (
  SELECT 1
  FROM goal_content_verifications
  WHERE id = NEW.id
     OR (goal_id = NEW.goal_id AND verification_digest = NEW.verification_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'content verification identity already exists');
END;

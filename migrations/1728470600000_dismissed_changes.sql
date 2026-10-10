-- Up Migration

-- "Keep my version": the user decided to keep their own row against what a statement says.
-- The signature is of the bank's values, so the question only comes back if the bank's side changes.
CREATE TABLE dismissed_changes (
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id uuid        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  signature      text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, transaction_id)
);

-- Down Migration

DROP TABLE IF EXISTS dismissed_changes;

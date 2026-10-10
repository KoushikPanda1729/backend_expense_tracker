-- Up Migration

-- The user's own comment and tag on a single transaction.
ALTER TABLE transactions
  ADD COLUMN note  text,
  ADD COLUMN label text;

-- Down Migration

ALTER TABLE transactions DROP COLUMN label, DROP COLUMN note;

-- Up Migration

ALTER TABLE users
  ADD COLUMN username        text,
  ADD COLUMN photo_key       text,                                 -- profile photo inside the storage driver
  ADD COLUMN opening_balance numeric(14,2) NOT NULL DEFAULT 0;     -- balance before the first transaction

-- Balance printed on the statement before its first row and after its last row.
ALTER TABLE statements
  ADD COLUMN opening_balance numeric(14,2),
  ADD COLUMN closing_balance numeric(14,2);

-- Down Migration

ALTER TABLE statements DROP COLUMN closing_balance, DROP COLUMN opening_balance;
ALTER TABLE users DROP COLUMN opening_balance, DROP COLUMN photo_key, DROP COLUMN username;

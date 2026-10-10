-- Up Migration

-- What the bank printed, so a payment can be traced later (UPI id / phone number, bank, full description).
ALTER TABLE transactions
  ADD COLUMN description text,
  ADD COLUMN upi_id      text,
  ADD COLUMN bank        text;

-- "I know this payee": the user's own category (and name) for a payee. Applied to old rows and to every later import.
CREATE TABLE payee_rules (
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key text        NOT NULL,           -- lower(merchant)
  merchant     text        NOT NULL,           -- as shown
  category     text        NOT NULL,
  label        text,                           -- e.g. "Friend", "Rent", "Grocery shop"
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, merchant_key)
);

-- Down Migration

DROP TABLE IF EXISTS payee_rules;
ALTER TABLE transactions DROP COLUMN bank, DROP COLUMN upi_id, DROP COLUMN description;

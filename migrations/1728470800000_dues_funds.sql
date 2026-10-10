-- Up Migration

-- "Lend & borrow": who owes the user money, and who the user owes. Separate from transactions on purpose.
CREATE TABLE dues (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person     text          NOT NULL,
  direction  text          NOT NULL CHECK (direction IN ('get', 'give')),  -- get = they owe me, give = I owe them
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  settled    numeric(14,2) NOT NULL DEFAULT 0 CHECK (settled >= 0),       -- paid back so far
  note       text,
  due_date   date,
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX dues_user_idx ON dues (user_id, created_at DESC);

-- Mutual funds the user holds, and every amount put in or taken out.
CREATE TABLE funds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text          NOT NULL,
  current_value numeric(14,2),                 -- entered by hand (the statement does not know it)
  value_as_of   date,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE fund_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_id    uuid          NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  entry_date date          NOT NULL,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  kind       text          NOT NULL DEFAULT 'invest' CHECK (kind IN ('invest', 'withdraw')),
  note       text,
  txn_id     uuid UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,  -- set when it came from a bank statement row
  created_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX fund_entries_fund_idx ON fund_entries (fund_id, entry_date DESC);

-- Down Migration

DROP TABLE IF EXISTS fund_entries;
DROP TABLE IF EXISTS funds;
DROP TABLE IF EXISTS dues;

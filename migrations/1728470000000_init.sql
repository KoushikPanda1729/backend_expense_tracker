-- Up Migration

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  country_code  text        NOT NULL,           -- e.g. +91
  phone         text        NOT NULL,           -- national digits only
  phone_e164    text        NOT NULL UNIQUE,    -- country_code || phone
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens are random strings; only their SHA-256 is stored.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TYPE statement_status AS ENUM ('uploaded', 'parsed', 'failed');

CREATE TABLE statements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name text             NOT NULL,
  storage_key   text             NOT NULL,       -- key inside the storage driver (local folder now, S3 later)
  mime          text             NOT NULL DEFAULT 'application/pdf',
  size_bytes    bigint           NOT NULL,
  sha256        text             NOT NULL,
  bank          text             NOT NULL DEFAULT 'SBI',
  status        statement_status NOT NULL DEFAULT 'uploaded',
  period_start  date,
  period_end    date,
  txn_count     integer          NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)                       -- the same file cannot be uploaded twice
);
CREATE INDEX statements_user_idx ON statements (user_id, created_at DESC);

CREATE TABLE transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement_id uuid          REFERENCES statements(id) ON DELETE CASCADE,  -- null for manual entries
  txn_date     date          NOT NULL,
  merchant     text          NOT NULL,
  mode         text          NOT NULL DEFAULT 'Manual',   -- UPI / IMPS / NEFT / Manual
  category     text          NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  is_income    boolean       NOT NULL,
  ref          text,                                      -- bank reference number
  dedupe_key   text          NOT NULL,                    -- same key = same transaction
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX transactions_user_date_idx ON transactions (user_id, txn_date DESC, id DESC);
CREATE INDEX transactions_user_category_idx ON transactions (user_id, category);
CREATE INDEX transactions_statement_idx ON transactions (statement_id);

CREATE TABLE budgets (
  user_id      uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category     text          NOT NULL,
  limit_amount numeric(14,2) NOT NULL CHECK (limit_amount > 0),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

-- Down Migration

DROP TABLE IF EXISTS budgets;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS statements;
DROP TYPE  IF EXISTS statement_status;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;

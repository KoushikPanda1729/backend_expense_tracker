-- Up Migration

-- PDF passwords the user saved. The secret is AES-256-GCM encrypted (not hashed: it has to be reused).
CREATE TABLE pdf_passwords (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text        NOT NULL,
  secret_enc   text        NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, label)
);

-- Stored statements are the unlocked PDF, encrypted at rest.
ALTER TABLE statements
  ADD COLUMN file_encrypted boolean NOT NULL DEFAULT false,
  ADD COLUMN was_locked     boolean NOT NULL DEFAULT false;   -- the bank's file had a password

-- Down Migration

ALTER TABLE statements DROP COLUMN was_locked, DROP COLUMN file_encrypted;
DROP TABLE IF EXISTS pdf_passwords;

-- Up Migration

-- Uploaded files (statement PDFs, profile photos) kept in the database when STORAGE_DRIVER=db.
-- Statements are already encrypted with ENCRYPTION_KEY before they are stored here.
CREATE TABLE files (
  key        text        PRIMARY KEY,     -- same keys the other storage drivers use, e.g. statements/<user>/<uuid>.pdf.enc
  data       bytea       NOT NULL,
  mime       text        NOT NULL,
  size_bytes integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS files;

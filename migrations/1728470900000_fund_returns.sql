-- Up Migration

-- Returns exactly as the user's fund app shows them. Stored on its own, not worked out from the other numbers,
-- because the app may count older SIPs that are not in the bank statements.
ALTER TABLE funds ADD COLUMN returns_value numeric(14,2);

-- Down Migration

ALTER TABLE funds DROP COLUMN returns_value;

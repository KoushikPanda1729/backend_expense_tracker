-- Up Migration

-- What the fund app says the user has invested in total (typed by the user). The bank statements only show the
-- payments they cover (often just the monthly SIP), so this is a separate number.
ALTER TABLE funds ADD COLUMN invested_total numeric(14,2);

-- The old "current value" field was used by the user as the total invested: carry it over.
UPDATE funds SET invested_total = current_value WHERE current_value IS NOT NULL;
ALTER TABLE funds DROP COLUMN current_value;

-- Down Migration

ALTER TABLE funds ADD COLUMN current_value numeric(14,2);
UPDATE funds SET current_value = invested_total;
ALTER TABLE funds DROP COLUMN invested_total;

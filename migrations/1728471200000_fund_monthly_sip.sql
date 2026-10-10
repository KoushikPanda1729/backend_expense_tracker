-- Up Migration
ALTER TABLE funds ADD COLUMN monthly_sip numeric(14,2);

-- Down Migration
ALTER TABLE funds DROP COLUMN monthly_sip;

-- Up Migration

-- SBI prints "Balance as on <date> : <amount>" in the statement header: the real account balance on the day it was downloaded.
ALTER TABLE statements
  ADD COLUMN balance_asof_date date,
  ADD COLUMN balance_asof      numeric(14,2);

-- Down Migration

ALTER TABLE statements DROP COLUMN balance_asof, DROP COLUMN balance_asof_date;

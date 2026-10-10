-- Up Migration

-- The user types two numbers from the fund app: the total invested and the CURRENT VALUE. The returns and the
-- percentage are worked out from those two, not typed.
ALTER TABLE funds ADD COLUMN current_value numeric(14,2);

-- Carry over what was typed as returns: current value = invested + returns.
UPDATE funds SET current_value = invested_total + returns_value
 WHERE invested_total IS NOT NULL AND returns_value IS NOT NULL;
ALTER TABLE funds DROP COLUMN returns_value;

-- Down Migration

ALTER TABLE funds ADD COLUMN returns_value numeric(14,2);
UPDATE funds SET returns_value = current_value - invested_total WHERE current_value IS NOT NULL AND invested_total IS NOT NULL;
ALTER TABLE funds DROP COLUMN current_value;

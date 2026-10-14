-- ============================================================
-- فصل «الكفالة» عن «الإعانة» الشهرية لكل أسرة
-- ============================================================
ALTER TABLE families ADD COLUMN IF NOT EXISTS aid_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (aid_amount >= 0);
ALTER TABLE families ADD COLUMN IF NOT EXISTS aid_note TEXT;

ALTER TABLE monthly_entitlements ADD COLUMN IF NOT EXISTS kafala_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (kafala_amount >= 0);
ALTER TABLE monthly_entitlements ADD COLUMN IF NOT EXISTS aid_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (aid_amount >= 0);
-- السجلات السابقة: كامل المستحق كان كفالة
UPDATE monthly_entitlements SET kafala_amount = amount_due WHERE kafala_amount = 0 AND aid_amount = 0;
ALTER TABLE monthly_entitlements ADD CONSTRAINT ent_parts_sum CHECK (kafala_amount + aid_amount = amount_due) NOT VALID;
ALTER TABLE monthly_entitlements VALIDATE CONSTRAINT ent_parts_sum;

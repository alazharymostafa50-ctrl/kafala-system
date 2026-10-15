-- 1) بند الصرف للأسرة: كفالة / إعانة / كفالة وإعانة
ALTER TABLE families ADD COLUMN support_type TEXT NOT NULL DEFAULT 'kafala'
  CHECK (support_type IN ('kafala','aid','both'));
UPDATE families SET support_type = CASE WHEN aid_amount > 0 AND (monthly_amount > 0 OR calc_method <> 'family_fixed') THEN 'both'
                                        WHEN aid_amount > 0 THEN 'aid' ELSE 'kafala' END;

-- البلد الافتراضي
UPDATE system_settings SET value = value || '{"default_city": "طنط الجزيرة"}'::jsonb WHERE key = 'org' AND NOT (value ? 'default_city');

-- 2) سلة المحذوفات (حذف قابل للاسترجاع)
ALTER TABLE families ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by INT REFERENCES users(id), ADD COLUMN status_before_delete TEXT;
ALTER TABLE sponsors ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by INT REFERENCES users(id);
ALTER TABLE family_members ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by INT REFERENCES users(id);
-- الأفراد المحذوفون يختفون من كل الاستعلامات تلقائيًا عبر عرض بنفس الاسم القديم
ALTER TABLE family_members RENAME TO family_members_all;
CREATE VIEW family_members AS SELECT * FROM family_members_all WHERE deleted_at IS NULL;

-- 3) البيانات التجريبية: علامة على السجلات الأساسية لحذفها بالكامل لاحقًا
ALTER TABLE families ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sponsors ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE donations ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE expenses ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE financial_adjustments ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- السماح بحذف السجلات المحمية فقط أثناء «حذف البيانات التجريبية» (متغير جلسة داخل معاملة واحدة)
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('kafala.demo_purge', true), '') = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'السجل % غير قابل للتعديل أو الحذف؛ استخدم عملية عكس أو تسوية موثقة', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('kafala.demo_purge', true), '') = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'لا يمكن حذف سجل من % حذفًا نهائيًا', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION protect_report_files() RETURNS trigger AS $$
BEGIN
  IF OLD.key LIKE 'reports/%' AND NOT (TG_OP = 'DELETE' AND coalesce(current_setting('kafala.demo_purge', true), '') = 'on') THEN
    RAISE EXCEPTION 'ملف التقرير المحفوظ غير قابل للتعديل أو الحذف';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;

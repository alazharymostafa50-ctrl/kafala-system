-- ============================================================
-- تخزين الملفات داخل قاعدة البيانات (المستندات، التقارير المعتمدة، الشعار)
-- يناسب الاستضافة السحابية التي لا تحتفظ بالملفات على القرص (مثل Vercel)
-- ويجعل النسخة الاحتياطية لقاعدة البيانات تشمل الملفات تلقائيًا.
-- ============================================================
CREATE TABLE stored_files (
  key         TEXT PRIMARY KEY,
  mime_type   TEXT NOT NULL,
  size_bytes  INT NOT NULL,
  sha256      TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ملفات التقارير المحفوظة لا تُعدَّل ولا تُحذف
CREATE FUNCTION protect_report_files() RETURNS trigger AS $$
BEGIN
  IF OLD.key LIKE 'reports/%' THEN
    RAISE EXCEPTION 'ملف التقرير المحفوظ غير قابل للتعديل أو الحذف';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER stored_files_protect BEFORE UPDATE OR DELETE ON stored_files FOR EACH ROW EXECUTE FUNCTION protect_report_files();

-- أسرار التطبيق المولدة تلقائيًا (مثل مفتاح الجلسات) بعيدًا عن جدول الإعدادات المعروض
CREATE TABLE app_secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- حالة التشغيل (آخر تشغيل لمحرك الاستحقاق...)
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- حد رفع الملفات المتوافق مع الاستضافة السحابية (4 ميجابايت)
UPDATE system_settings SET value = jsonb_set(value, '{max_size_mb}', '4')
 WHERE key = 'documents' AND COALESCE((value->>'max_size_mb')::int, 8) > 4;

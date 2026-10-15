-- كشف مستقل لكل بند: الكفالة وحدها، الإعانة وحدها، أو الاتنين معًا — لكل كشف إجماليه ونسخه المحفوظة
ALTER TABLE monthly_statements ADD COLUMN kind TEXT NOT NULL DEFAULT 'all' CHECK (kind IN ('all','kafala','aid'));
ALTER TABLE monthly_statements DROP CONSTRAINT monthly_statements_period_version_key;
ALTER TABLE monthly_statements ADD CONSTRAINT monthly_statements_period_kind_version_key UNIQUE (period, kind, version);
-- إنشاء كشف الشهر تلقائيًا
UPDATE system_settings SET value = value || '{"auto_generate": true}'::jsonb WHERE key = 'finance' AND NOT (value ? 'auto_generate');

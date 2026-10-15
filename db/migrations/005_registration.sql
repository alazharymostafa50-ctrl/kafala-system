-- رقم إشهار الجمعية (يظهر بجوار اسمها في الواجهة وكل المطبوعات، وقابل للتعديل من الإعدادات)
UPDATE system_settings
   SET value = value || '{"registration": "المشهرة برقم 1248 لسنة 2008 م"}'::jsonb
 WHERE key = 'org' AND NOT (value ? 'registration');

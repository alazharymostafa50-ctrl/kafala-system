-- استيراد حالات الفقراء والمساكين من Excel
ALTER TABLE import_batches DROP CONSTRAINT import_batches_import_type_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_import_type_check CHECK (import_type IN ('families','members','sponsors','poor_cases'));

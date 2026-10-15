-- كشوف الاستلام الشهرية المحفوظة: نسخة ثابتة لكل شهر، وكل تغيير في المستحقات يحفظ نسخة جديدة دون حذف القديمة
CREATE TABLE monthly_statements (
  id            SERIAL PRIMARY KEY,
  period        TEXT NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  version       INTEGER NOT NULL,
  data          JSONB NOT NULL,
  data_hash     TEXT NOT NULL,
  family_count  INTEGER NOT NULL,
  total_due     NUMERIC(14,2) NOT NULL,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period, version)
);
CREATE INDEX idx_statements_period ON monthly_statements (period DESC, version DESC);
CREATE TRIGGER statements_immutable BEFORE UPDATE OR DELETE ON monthly_statements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ============================================================
-- نظام إدارة كفالة الأيتام — الجمعية الشرعية
-- المخطط الأساسي لقاعدة البيانات (PostgreSQL 14+)
-- ============================================================

-- ---------- المستخدمون والصلاحيات ----------
CREATE TABLE roles (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  is_system     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  grp           TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id         INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  phone           TEXT,
  password_hash   TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  totp_secret     TEXT,
  totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username ~ '^[a-zA-Z0-9_.-]{3,40}$')
);

CREATE TABLE user_roles (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- جلسات الدخول (connect-pg-simple)
CREATE TABLE user_sessions (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_user_sessions_expire ON user_sessions (expire);

-- ---------- الإعدادات ----------
CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- الأسر ----------
CREATE SEQUENCE family_file_seq START 1001;
CREATE TABLE families (
  id                 SERIAL PRIMARY KEY,
  file_no            TEXT NOT NULL UNIQUE DEFAULT ('F-' || nextval('family_file_seq')),
  family_name        TEXT NOT NULL,
  opened_on          DATE NOT NULL DEFAULT CURRENT_DATE,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','under_review','suspended','closed','archived')),
  address            TEXT,
  city               TEXT,
  district           TEXT,
  calc_method        TEXT NOT NULL DEFAULT 'family_fixed'
                     CHECK (calc_method IN ('family_fixed','per_member','mixed')),
  monthly_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_amount >= 0),
  last_review_on     DATE,
  responsible_user_id INT REFERENCES users(id),
  confidential_notes TEXT,
  created_by         INT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_families_name ON families (family_name);
CREATE INDEX idx_families_status ON families (status);

CREATE TABLE guardians (
  id              SERIAL PRIMARY KEY,
  family_id       INT NOT NULL UNIQUE REFERENCES families(id) ON DELETE RESTRICT,
  full_name       TEXT NOT NULL,
  relation        TEXT,
  national_id     TEXT,
  phone           TEXT NOT NULL,
  phone_alt       TEXT,
  payout_method   TEXT CHECK (payout_method IN ('cash','bank_transfer','wallet','cheque','other')),
  bank_name       TEXT,
  iban            TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_guardians_phone ON guardians (phone);
CREATE INDEX idx_guardians_phone_alt ON guardians (phone_alt);
CREATE INDEX idx_guardians_name ON guardians (full_name);

CREATE SEQUENCE member_no_seq START 5001;
CREATE TABLE family_members (
  id                  SERIAL PRIMARY KEY,
  member_no           TEXT NOT NULL UNIQUE DEFAULT ('B-' || nextval('member_no_seq')),
  family_id           INT NOT NULL REFERENCES families(id) ON DELETE RESTRICT,
  full_name           TEXT NOT NULL,
  birth_date          DATE NOT NULL,
  gender              TEXT NOT NULL CHECK (gender IN ('male','female')),
  relation            TEXT NOT NULL,
  is_orphan           BOOLEAN NOT NULL DEFAULT TRUE,
  national_id         TEXT,
  study_status        TEXT,
  school_name         TEXT,
  study_level         TEXT,
  marital_status      TEXT NOT NULL DEFAULT 'single'
                      CHECK (marital_status IN ('single','married','divorced','widowed')),
  marriage_date       DATE,
  sponsorship_start   DATE,
  eligibility_status  TEXT NOT NULL DEFAULT 'under_review'
                      CHECK (eligibility_status IN ('eligible','eligible_university','reached_review_age',
                        'awaiting_study_proof','missing_documents','suspended','ineligible','ended','under_review')),
  monthly_amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_amount >= 0),
  notes               TEXT,
  created_by          INT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_members_family ON family_members (family_id);
CREATE INDEX idx_members_birth ON family_members (birth_date);
CREATE INDEX idx_members_status ON family_members (eligibility_status);

-- سجل قرارات الاستحقاق (تاريخي، لا يُعدَّل)
CREATE TABLE eligibility_decisions (
  id              SERIAL PRIMARY KEY,
  member_id       INT NOT NULL REFERENCES family_members(id),
  old_status      TEXT,
  new_status      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','automatic','initial')),
  age_at_decision INT,
  document_id     INT,
  decided_by      INT REFERENCES users(id),
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE INDEX idx_elig_dec_member ON eligibility_decisions (member_id, decided_at);

-- طلبات المراجعة (مثل تسجيل زواج بانتظار اعتماد)
CREATE TABLE eligibility_reviews (
  id            SERIAL PRIMARY KEY,
  member_id     INT NOT NULL REFERENCES family_members(id),
  review_type   TEXT NOT NULL CHECK (review_type IN ('marriage','age','university_proof','other')),
  details       TEXT,
  document_id   INT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  requested_by  INT REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by   INT REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  decision_id   INT REFERENCES eligibility_decisions(id)
);

-- ---------- المستندات ----------
CREATE TABLE documents (
  id             SERIAL PRIMARY KEY,
  family_id      INT REFERENCES families(id),
  member_id      INT REFERENCES family_members(id),
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('guardian_id','member_id','birth_certificate','orphan_proof',
                   'guardianship','university_proof','marriage_proof','bank_document','other_social','other_financial',
                   'expense_receipt','disbursement_receipt')),
  original_name  TEXT NOT NULL,
  stored_name    TEXT NOT NULL UNIQUE,
  mime_type      TEXT NOT NULL,
  size_bytes     INT NOT NULL,
  sha256         TEXT NOT NULL,
  issue_date     DATE,
  expiry_date    DATE,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','replaced')),
  replaces_id    INT REFERENCES documents(id),
  notes          TEXT,
  uploaded_by    INT REFERENCES users(id),
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by    INT REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  CHECK (family_id IS NOT NULL OR doc_type = 'expense_receipt')
);
CREATE INDEX idx_documents_family ON documents (family_id);
CREATE INDEX idx_documents_member ON documents (member_id);
CREATE INDEX idx_documents_expiry ON documents (expiry_date) WHERE status = 'approved';

-- ---------- الكفلاء ----------
CREATE SEQUENCE sponsor_no_seq START 301;
CREATE TABLE sponsors (
  id              SERIAL PRIMARY KEY,
  sponsor_no      TEXT NOT NULL UNIQUE DEFAULT ('K-' || nextval('sponsor_no_seq')),
  full_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  phone_alt       TEXT,
  sponsorship_type TEXT NOT NULL DEFAULT 'monthly' CHECK (sponsorship_type IN ('monthly','quarterly','annual','one_time')),
  monthly_pledge  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_pledge >= 0),
  start_date      DATE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','follow_up')),
  payment_method  TEXT,
  notes           TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sponsors_phone ON sponsors (phone);
CREATE INDEX idx_sponsors_name ON sponsors (full_name);

CREATE TABLE family_sponsorships (
  id              SERIAL PRIMARY KEY,
  sponsor_id      INT NOT NULL REFERENCES sponsors(id),
  family_id       INT NOT NULL REFERENCES families(id),
  sponsorship_type TEXT NOT NULL DEFAULT 'monthly',
  monthly_amount  NUMERIC(14,2) NOT NULL CHECK (monthly_amount >= 0),
  start_date      DATE NOT NULL,
  end_date        DATE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','suspended')),
  notes           TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
-- علاقة نشطة واحدة فقط بين الكفيل والأسرة نفسها
CREATE UNIQUE INDEX uq_active_sponsorship ON family_sponsorships (sponsor_id, family_id) WHERE status = 'active';

-- التعهد الشهري للكفيل (ليس مالًا محصلًا)
CREATE TABLE sponsor_contributions (
  id              SERIAL PRIMARY KEY,
  sponsor_id      INT NOT NULL REFERENCES sponsors(id),
  period          CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  pledged_amount  NUMERIC(14,2) NOT NULL CHECK (pledged_amount >= 0),
  needs_review    BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sponsor_id, period)
);

-- ---------- الصناديق والسجل المالي ----------
CREATE TABLE funds (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  restricted  BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT
);

CREATE TABLE donation_types (
  code                    TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  fund_code               TEXT NOT NULL REFERENCES funds(code),
  is_sponsor_contribution BOOLEAN NOT NULL DEFAULT FALSE,
  is_family_designated    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  is_system               BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE SEQUENCE receipt_no_seq START 10001;
CREATE TABLE donations (
  id               SERIAL PRIMARY KEY,
  receipt_no       TEXT NOT NULL UNIQUE DEFAULT ('R-' || nextval('receipt_no_seq')),
  donation_date    DATE NOT NULL,
  donor_name       TEXT NOT NULL,
  type_code        TEXT NOT NULL REFERENCES donation_types(code),
  fund_code        TEXT NOT NULL REFERENCES funds(code),
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('cash','bank_transfer','wallet','cheque','card','other')),
  reference        TEXT,
  period           CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  purpose          TEXT,
  family_id        INT REFERENCES families(id),
  sponsor_id       INT REFERENCES sponsors(id),
  contribution_id  INT REFERENCES sponsor_contributions(id),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','collected','needs_settlement','reversed','cancelled')),
  collected_at     TIMESTAMPTZ,
  collected_by     INT REFERENCES users(id),
  reversal_reason  TEXT,
  reversed_by      INT REFERENCES users(id),
  reversed_at      TIMESTAMPTZ,
  notes            TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (contribution_id IS NULL OR sponsor_id IS NOT NULL)
);
CREATE INDEX idx_donations_period ON donations (period);
CREATE INDEX idx_donations_status ON donations (status);
-- منع تسجيل نفس مرجع التحويل مرتين بنفس طريقة الدفع
CREATE UNIQUE INDEX uq_donation_reference ON donations (payment_method, reference)
  WHERE reference IS NOT NULL AND reference <> '' AND status NOT IN ('cancelled','reversed');

CREATE TABLE expense_categories (
  code             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  allowed_funds    TEXT[] NOT NULL DEFAULT ARRAY['general'],
  is_active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE SEQUENCE expense_no_seq START 7001;
CREATE TABLE expenses (
  id              SERIAL PRIMARY KEY,
  expense_no      TEXT NOT NULL UNIQUE DEFAULT ('E-' || nextval('expense_no_seq')),
  expense_date    DATE NOT NULL,
  category_code   TEXT NOT NULL REFERENCES expense_categories(code),
  fund_code       TEXT NOT NULL REFERENCES funds(code),
  description     TEXT NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payee           TEXT,
  payment_method  TEXT,
  invoice_no      TEXT,
  document_id     INT REFERENCES documents(id),
  period          CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','pending_approval','approved','paid','rejected','reversed')),
  notes           TEXT,
  created_by      INT REFERENCES users(id),
  approved_by     INT REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  paid_by         INT REFERENCES users(id),
  paid_at         TIMESTAMPTZ,
  reversal_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expenses_period ON expenses (period);

CREATE TABLE expense_approvals (
  id          SERIAL PRIMARY KEY,
  expense_id  INT NOT NULL REFERENCES expenses(id),
  action      TEXT NOT NULL CHECK (action IN ('submit','approve','reject','pay','reverse')),
  user_id     INT REFERENCES users(id),
  comment     TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- الاستحقاقات والصرف ----------
CREATE TABLE monthly_runs (
  id          SERIAL PRIMARY KEY,
  period      CHAR(7) NOT NULL UNIQUE CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes       TEXT
);

CREATE TABLE monthly_entitlements (
  id              SERIAL PRIMARY KEY,
  run_id          INT NOT NULL REFERENCES monthly_runs(id),
  family_id       INT NOT NULL REFERENCES families(id),
  period          CHAR(7) NOT NULL,
  calc_method     TEXT NOT NULL,
  eligible_count  INT NOT NULL DEFAULT 0,
  amount_due      NUMERIC(14,2) NOT NULL CHECK (amount_due >= 0),
  amount_paid     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  calc_detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'not_paid'
                  CHECK (status IN ('not_paid','preparing','pending_approval','partial','paid','failed','postponed','cancelled')),
  needs_review    BOOLEAN NOT NULL DEFAULT FALSE,
  status_reason   TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, period),
  CHECK (amount_paid <= amount_due)
);
CREATE INDEX idx_ent_period ON monthly_entitlements (period);

CREATE SEQUENCE disb_no_seq START 20001;
CREATE TABLE disbursements (
  id               SERIAL PRIMARY KEY,
  disb_no          TEXT NOT NULL UNIQUE DEFAULT ('D-' || nextval('disb_no_seq')),
  entitlement_id   INT NOT NULL REFERENCES monthly_entitlements(id),
  family_id        INT NOT NULL REFERENCES families(id),
  period           CHAR(7) NOT NULL,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  fund_code        TEXT NOT NULL REFERENCES funds(code),
  disb_date        DATE NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','wallet','cheque','other')),
  reference        TEXT,
  document_id      INT REFERENCES documents(id),
  status           TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending_approval','paid','rejected','reversed')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  notes            TEXT,
  created_by       INT REFERENCES users(id),
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_reason  TEXT,
  reversed_by      INT REFERENCES users(id),
  reversed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_disb_ent ON disbursements (entitlement_id);
CREATE INDEX idx_disb_period ON disbursements (period);

-- السجل المالي الموحد (دفتر الأستاذ) — لا يُعدَّل ولا يُحذف
CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  entry_date    DATE NOT NULL,
  period        CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  fund_code     TEXT NOT NULL REFERENCES funds(code),
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  source_type   TEXT NOT NULL CHECK (source_type IN ('donation','donation_reversal','expense','expense_reversal',
                   'disbursement','disbursement_reversal','adjustment','opening')),
  source_id     INT,
  family_id     INT REFERENCES families(id),
  description   TEXT NOT NULL,
  reverses_id   BIGINT REFERENCES ledger_entries(id),
  created_by    INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_period ON ledger_entries (period);
CREATE INDEX idx_ledger_fund ON ledger_entries (fund_code);
CREATE INDEX idx_ledger_source ON ledger_entries (source_type, source_id);
-- حركة واحدة فقط لكل مصدر أصلي (منع الازدواج)
CREATE UNIQUE INDEX uq_ledger_source ON ledger_entries (source_type, source_id)
  WHERE source_type IN ('donation','donation_reversal','expense','expense_reversal','disbursement','disbursement_reversal');

CREATE TABLE financial_adjustments (
  id           SERIAL PRIMARY KEY,
  adj_date     DATE NOT NULL,
  period       CHAR(7) NOT NULL,
  fund_code    TEXT NOT NULL REFERENCES funds(code),
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  kind         TEXT NOT NULL CHECK (kind IN ('opening','correction','bank_fee','other')),
  reason       TEXT NOT NULL,
  ledger_id    BIGINT REFERENCES ledger_entries(id),
  created_by   INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE financial_periods (
  period      CHAR(7) PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by   INT REFERENCES users(id),
  closed_at   TIMESTAMPTZ
);

-- ---------- التقارير المعتمدة ----------
CREATE TABLE monthly_reports (
  id            SERIAL PRIMARY KEY,
  period        CHAR(7) NOT NULL,
  report_type   TEXT NOT NULL,
  version       INT NOT NULL,
  report_level  TEXT NOT NULL DEFAULT 'detailed' CHECK (report_level IN ('summary','detailed')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','superseded','rejected')),
  summary       JSONB NOT NULL,
  source_refs   JSONB NOT NULL,
  pdf_file      TEXT,
  pdf_sha256    TEXT,
  approved_pdf_file TEXT,
  approved_pdf_sha256 TEXT,
  accountant_notes TEXT,
  prepared_by   INT REFERENCES users(id),
  prepared_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   INT REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  supersede_reason TEXT,
  reject_reason TEXT,
  UNIQUE (period, report_type, version)
);
-- تقرير معتمد واحد فقط لكل شهر ونوع في أي وقت
CREATE UNIQUE INDEX uq_report_approved ON monthly_reports (period, report_type) WHERE status = 'approved';
CREATE VIEW report_versions AS
  SELECT period, report_type, count(*) AS versions, max(version) AS latest_version,
         max(version) FILTER (WHERE status='approved') AS approved_version
  FROM monthly_reports GROUP BY period, report_type;

-- ---------- التدقيق والتنبيهات والاستيراد ----------
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INT REFERENCES users(id),
  username    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_data JSONB,
  after_data  JSONB,
  reason      TEXT,
  ip          TEXT
);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX idx_audit_at ON audit_logs (at);

CREATE TABLE notifications (
  id          SERIAL PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','danger')),
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  family_id   INT REFERENCES families(id),
  member_id   INT REFERENCES family_members(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INT REFERENCES users(id)
);

CREATE TABLE import_batches (
  id           SERIAL PRIMARY KEY,
  import_type  TEXT NOT NULL CHECK (import_type IN ('families','members','sponsors')),
  file_name    TEXT NOT NULL,
  headers      JSONB NOT NULL,
  rows         JSONB NOT NULL,
  mapping      JSONB,
  status       TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','completed','cancelled')),
  result       JSONB,
  created_by   INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ---------- حماية السجلات غير القابلة للتعديل ----------
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'السجل % غير قابل للتعديل أو الحذف؛ استخدم عملية عكس أو تسوية موثقة', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE ON eligibility_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- منع حذف العمليات المالية
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'لا يمكن حذف سجل من % حذفًا نهائيًا', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER donations_nodelete BEFORE DELETE ON donations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER expenses_nodelete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER disb_nodelete BEFORE DELETE ON disbursements FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER ent_nodelete BEFORE DELETE ON monthly_entitlements FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER reports_nodelete BEFORE DELETE ON monthly_reports FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- منع تعديل التقرير المعتمد بصمت (يسمح فقط بتحويله إلى "مستبدل")
CREATE FUNCTION protect_report() RETURNS trigger AS $$
BEGIN
  IF NEW.summary IS DISTINCT FROM OLD.summary OR NEW.pdf_file IS DISTINCT FROM OLD.pdf_file
     OR NEW.version <> OLD.version OR NEW.period <> OLD.period OR NEW.source_refs IS DISTINCT FROM OLD.source_refs
     OR (OLD.approved_pdf_file IS NOT NULL AND NEW.approved_pdf_file IS DISTINCT FROM OLD.approved_pdf_file)
     OR (OLD.status IN ('superseded','rejected') AND NEW.status <> OLD.status)
     OR (OLD.status = 'approved' AND NEW.status NOT IN ('approved','superseded')) THEN
    RAISE EXCEPTION 'التقرير المعتمد لا يُعدَّل؛ أنشئ إصدارًا جديدًا';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER report_protect BEFORE UPDATE ON monthly_reports FOR EACH ROW EXECUTE FUNCTION protect_report();

-- ============================================================
-- بيانات مرجعية أساسية (ليست بيانات وهمية)
-- ============================================================
INSERT INTO funds (code, name, restricted, description) VALUES
 ('general', 'الصندوق العام', FALSE, 'تبرعات عامة غير مقيدة'),
 ('orphans', 'صندوق كفالة الأيتام (مقيد)', TRUE, 'أموال مقيدة لا تُصرف إلا على كفالة الأيتام والمساعدات المرتبطة بهم');

INSERT INTO donation_types (code, name, fund_code, is_sponsor_contribution, is_family_designated, is_system) VALUES
 ('general',   'تبرع عام',                    'general', FALSE, FALSE, TRUE),
 ('orphans',   'تبرع مخصص لكفالة الأيتام',    'orphans', FALSE, FALSE, TRUE),
 ('sponsor',   'مساهمة كفيل',                  'orphans', TRUE,  FALSE, TRUE),
 ('family',    'تبرع مخصص لأسرة معينة',        'orphans', FALSE, TRUE,  TRUE);

INSERT INTO expense_categories (code, name, allowed_funds) VALUES
 ('family_kafala', 'كفالات الأسر',       ARRAY['orphans','general']),
 ('emergency',     'مساعدات طارئة',      ARRAY['orphans','general']),
 ('operational',   'مصروفات تشغيلية',    ARRAY['general']),
 ('administrative','مصروفات إدارية',     ARRAY['general']),
 ('other',         'مصروفات أخرى',       ARRAY['general']);

INSERT INTO permissions (code, name, grp) VALUES
 ('dashboard.view','عرض لوحة التحكم','عام'),
 ('families.view','عرض الأسر','الأسر'),
 ('families.edit','إضافة وتعديل الأسر والأفراد','الأسر'),
 ('families.sensitive','عرض البيانات الحساسة (الهويات، الحسابات البنكية، الملاحظات السرية)','الأسر'),
 ('families.archive','إغلاق وأرشفة ملفات الأسر','الأسر'),
 ('documents.view','عرض وتنزيل المستندات','المستندات'),
 ('documents.upload','رفع المستندات','المستندات'),
 ('documents.approve','اعتماد ورفض المستندات','المستندات'),
 ('eligibility.view','عرض مراجعة الاستحقاقات','الاستحقاق'),
 ('eligibility.decide','اتخاذ قرارات الاستحقاق','الاستحقاق'),
 ('sponsors.view','عرض الكفلاء','الكفلاء'),
 ('sponsors.edit','إضافة وتعديل الكفلاء وربطهم','الكفلاء'),
 ('donations.view','عرض التبرعات','المالية'),
 ('donations.edit','تسجيل التبرعات','المالية'),
 ('donations.collect','تأكيد تحصيل وعكس التبرعات','المالية'),
 ('expenses.view','عرض المصروفات','المالية'),
 ('expenses.edit','تسجيل المصروفات','المالية'),
 ('expenses.approve','اعتماد ورفض المصروفات','المالية'),
 ('expenses.pay','تسجيل دفع المصروفات وعكسها','المالية'),
 ('entitlements.view','عرض كشوف الاستحقاق','الصرف'),
 ('entitlements.generate','إنشاء كشوف الاستحقاق وتغيير حالاتها','الصرف'),
 ('disbursements.create','تسجيل عمليات الصرف','الصرف'),
 ('disbursements.approve','اعتماد وعكس عمليات الصرف','الصرف'),
 ('finance.view','عرض الأرصدة والسجل المالي','المالية'),
 ('finance.adjust','تسجيل التسويات والأرصدة الافتتاحية','المالية'),
 ('reports.view','عرض التقارير','التقارير'),
 ('reports.export','طباعة وتصدير التقارير','التقارير'),
 ('reports.approve','اعتماد وحفظ التقارير الشهرية','التقارير'),
 ('import.run','استيراد البيانات','النظام'),
 ('users.manage','إدارة المستخدمين والأدوار','النظام'),
 ('settings.manage','تعديل إعدادات النظام','النظام'),
 ('audit.view','عرض سجل التدقيق','النظام');

INSERT INTO roles (code, name, description, is_system) VALUES
 ('admin','مدير النظام','إدارة المستخدمين والصلاحيات والإعدادات',TRUE),
 ('manager','مدير الجمعية / مسؤول الكفالات','إدارة الأسر ومراجعة الاستحقاقات واعتماد القرارات وكشوف الصرف',TRUE),
 ('social_worker','مسؤول البحث الاجتماعي','إضافة الأسر والأفراد وتحديث البيانات ورفع المستندات',TRUE),
 ('accountant','المحاسب','تسجيل التبرعات والمصروفات ومراجعة المستحقات وإعداد التقارير المالية',TRUE),
 ('cashier','أمين الصندوق / مسؤول الصرف','تسجيل عمليات الصرف الفعلية وإرفاق الإيصالات',TRUE),
 ('auditor','المراجع','مراجعة السجلات والتقارير دون تعديل',TRUE);

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p WHERE r.code = 'admin';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x FROM roles r, unnest(ARRAY[
 'dashboard.view','families.view','families.edit','families.sensitive','families.archive','documents.view','documents.upload','documents.approve',
 'eligibility.view','eligibility.decide','sponsors.view','sponsors.edit','donations.view','expenses.view','expenses.approve',
 'entitlements.view','entitlements.generate','disbursements.approve','finance.view','reports.view','reports.export','reports.approve','audit.view'
]) x WHERE r.code = 'manager';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x FROM roles r, unnest(ARRAY[
 'dashboard.view','families.view','families.edit','families.sensitive','documents.view','documents.upload','eligibility.view','sponsors.view','import.run'
]) x WHERE r.code = 'social_worker';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x FROM roles r, unnest(ARRAY[
 'dashboard.view','families.view','sponsors.view','sponsors.edit','donations.view','donations.edit','donations.collect',
 'expenses.view','expenses.edit','expenses.pay','entitlements.view','entitlements.generate','finance.view','finance.adjust',
 'reports.view','reports.export','eligibility.view'
]) x WHERE r.code = 'accountant';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x FROM roles r, unnest(ARRAY[
 'dashboard.view','families.view','entitlements.view','disbursements.create','documents.upload','reports.view','reports.export'
]) x WHERE r.code = 'cashier';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x FROM roles r, unnest(ARRAY[
 'dashboard.view','families.view','sponsors.view','donations.view','expenses.view','entitlements.view','finance.view',
 'reports.view','reports.export','eligibility.view','audit.view'
]) x WHERE r.code = 'auditor';

INSERT INTO system_settings (key, value) VALUES
 ('org', '{"name":"الجمعية الشرعية","subtitle":"لتعاون العاملين بالكتاب والسنة المحمدية — فرع طنط الجزيرة","system_name":"نظام إدارة كفالة الأيتام","program_name":"كفالة الطفل اليتيم","phone":"","address":"","logo":null,"currency":"ج.م"}'),
 ('eligibility', '{"male_review_age":18,"alert_months_before":[3,1],"proof_expiry_alert_days":30,"paying_statuses":["eligible","eligible_university"],"female_marriage_new_status":"ended","document_expiry_alert_days":30}'),
 ('finance', '{"separation_of_duties":true,"disbursement_requires_approval":false,"allow_partial_disbursement":true,"allow_general_fund_for_kafala":true}'),
 ('documents', '{"max_size_mb":8,"required_family":["guardian_id","orphan_proof"],"required_member":["birth_certificate"]}');

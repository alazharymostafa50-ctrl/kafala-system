-- ============================================================
-- قسم الفقراء والمساكين: منفصل تمامًا عن كفالة الأيتام (جداوله وصندوقه وكشوفه)
-- ============================================================
CREATE SEQUENCE poor_case_seq START 1001;
CREATE TABLE poor_cases (
  id             SERIAL PRIMARY KEY,
  case_no        TEXT NOT NULL UNIQUE DEFAULT ('P-' || nextval('poor_case_seq')),
  full_name      TEXT NOT NULL,
  national_id    TEXT CHECK (national_id IS NULL OR national_id ~ '^[0-9]{14}$'),
  phone          TEXT,
  reason         TEXT NOT NULL,
  reason_note    TEXT,
  area           TEXT NOT NULL CHECK (area IN ('east','west','north','south')),
  give_type      TEXT NOT NULL CHECK (give_type IN ('cash','in_kind','both')),
  monthly_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_amount >= 0),
  family_size    INT CHECK (family_size IS NULL OR family_size BETWEEN 1 AND 30),
  address        TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
  deleted_at     TIMESTAMPTZ,
  deleted_by     INT REFERENCES users(id),
  is_demo        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_poor_national_id ON poor_cases (national_id) WHERE national_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_poor_phone ON poor_cases (phone);

-- صندوق القسم: تبرعات واردة
CREATE SEQUENCE poor_receipt_seq START 501;
CREATE TABLE poor_donations (
  id             SERIAL PRIMARY KEY,
  receipt_no     TEXT NOT NULL UNIQUE DEFAULT ('PR-' || nextval('poor_receipt_seq')),
  donor_name     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'sadaqa' CHECK (kind IN ('zakat','sadaqa','other')),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  donation_date  DATE NOT NULL,
  method         TEXT NOT NULL DEFAULT 'cash',
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'collected' CHECK (status IN ('collected','cancelled')),
  cancel_reason  TEXT,
  is_demo        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- الصرف النقدي الشهري لكل حالة (مرة واحدة لكل شهر)
CREATE TABLE poor_payments (
  id             SERIAL PRIMARY KEY,
  case_id        INT NOT NULL REFERENCES poor_cases(id),
  period         CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  pay_date       DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','reversed')),
  reverse_reason TEXT,
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_poor_payment ON poor_payments (case_id, period) WHERE status = 'paid';

-- العطاء العيني (شنطة رمضان، لحوم، بطاطين...)
CREATE SEQUENCE poor_dist_seq START 101;
CREATE TABLE poor_distributions (
  id             SERIAL PRIMARY KEY,
  dist_no        TEXT NOT NULL UNIQUE DEFAULT ('G-' || nextval('poor_dist_seq')),
  title          TEXT NOT NULL,
  items          TEXT,
  dist_date      DATE NOT NULL,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE poor_distribution_items (
  id              SERIAL PRIMARY KEY,
  distribution_id INT NOT NULL REFERENCES poor_distributions(id) ON DELETE CASCADE,
  case_id         INT NOT NULL REFERENCES poor_cases(id),
  quantity        TEXT,
  received_at     TIMESTAMPTZ,
  UNIQUE (distribution_id, case_id)
);

-- صلاحيات القسم
INSERT INTO permissions (code, name, grp) VALUES
 ('poor.view', 'عرض قسم الفقراء والمساكين', 'الفقراء والمساكين'),
 ('poor.edit', 'إضافة وتعديل حالات الفقراء والعطاء العيني', 'الفقراء والمساكين'),
 ('poor.finance', 'صندوق الفقراء: التبرعات والصرف النقدي', 'الفقراء والمساكين')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x.p FROM roles r JOIN (VALUES
  ('admin','poor.view'),('admin','poor.edit'),('admin','poor.finance'),
  ('manager','poor.view'),('manager','poor.edit'),('manager','poor.finance'),
  ('social_worker','poor.view'),('social_worker','poor.edit'),
  ('accountant','poor.view'),('accountant','poor.finance'),
  ('cashier','poor.view'),('cashier','poor.finance'),
  ('auditor','poor.view')
) AS x(role, p) ON x.role = r.code
ON CONFLICT DO NOTHING;

-- سجل تشخيصي مؤقت للطلبات (بدون بيانات حساسة) لتتبع مشاكل إعادة التوجيه
CREATE TABLE IF NOT EXISTS request_debug (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  method     TEXT,
  path       TEXT,
  status     INT,
  location   TEXT,
  has_cookie BOOLEAN,
  session    TEXT,
  ms         INT
);

-- أكواد استرجاع كلمة المرور: 8 أكواد تُستخدم مرة واحدة، تُحفظ مجزّأة فقط
CREATE TABLE user_recovery_codes (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recovery_user ON user_recovery_codes (user_id) WHERE used_at IS NULL;

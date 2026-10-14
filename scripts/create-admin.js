'use strict';
/**
 * إنشاء حساب مدير النظام الأول بأمان.
 * الاستخدام التفاعلي:   npm run create-admin
 * أو عبر المتغيرات:      ADMIN_USERNAME=... ADMIN_FULLNAME=... ADMIN_PASSWORD=... npm run create-admin
 * لا توجد أي كلمة مرور افتراضية في النظام.
 */
require('dotenv').config({ quiet: true });
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { migrate } = require('./migrate');
const { passwordPolicy } = require('../src/routes/auth');

function ask(rl, q, hidden = false) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(q, resolve);
    const out = rl.output; const orig = out.write.bind(out);
    rl.question(q, (a) => { out.write = orig; out.write('\n'); resolve(a); });
    out.write = (s) => { if (s.includes(q)) orig(s); };
  });
}

(async () => {
  await migrate({ quiet: true });
  let { ADMIN_USERNAME: username, ADMIN_FULLNAME: fullName, ADMIN_PASSWORD: password } = process.env;
  if (!username || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    username = username || (await ask(rl, 'اسم المستخدم (أحرف لاتينية وأرقام): '));
    fullName = fullName || (await ask(rl, 'الاسم الكامل: '));
    password = await ask(rl, 'كلمة المرور (10 أحرف على الأقل، حروف وأرقام): ', true);
    const confirm = await ask(rl, 'تأكيد كلمة المرور: ', true);
    rl.close();
    if (password !== confirm) throw new Error('كلمتا المرور غير متطابقتين');
  }
  username = String(username).trim().toLowerCase();
  passwordPolicy(password);
  const exists = await pool.query('SELECT 1 FROM users WHERE lower(username)=$1', [username]);
  if (exists.rowCount) throw new Error('اسم المستخدم موجود مسبقًا');
  const hash = await bcrypt.hash(password, 12);
  const u = await pool.query('INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [username, fullName || username, hash]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code='admin'`, [u.rows[0].id]);
  await pool.query(`INSERT INTO audit_logs (username, action, entity, entity_id) VALUES ('cli','create_admin','user',$1)`, [String(u.rows[0].id)]);
  console.log(`✓ تم إنشاء مدير النظام «${username}». سجّل الدخول وفعّل المصادقة الثنائية من صفحة الأمان.`);
  await pool.end();
})().catch(async (e) => { console.error('✗', e.message); await pool.end(); process.exit(1); });

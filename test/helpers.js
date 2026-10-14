'use strict';
// أدوات الاختبار: قاعدة بيانات اختبار معزولة، مستخدمون لكل دور، وعميل HTTP مع حماية CSRF
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/kafala_test';
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kafala-test-'));
process.env.BACKUP_KEY = 'test-backup-key-0123456789';
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true, override: false });

const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { migrate } = require('../scripts/migrate');
const settings = require('../src/lib/settings');

let app;
const PW = 'Test12345pass';

async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ quiet: true });
  settings.invalidate();
  const hash = await bcrypt.hash(PW, 4);
  for (const [u, role] of [['admin', 'admin'], ['manager', 'manager'], ['social', 'social_worker'], ['accountant', 'accountant'], ['accountant2', 'accountant'], ['cashier', 'cashier'], ['auditor', 'auditor']]) {
    const r = await db.one('INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [u, 'مستخدم ' + u, hash]);
    await db.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [r.id, role]);
  }
  // مدير تجريبي يجمع صلاحيات المحاسب أيضًا لتبسيط السيناريوهات المالية
  await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username='manager' AND r.code='accountant'`);
}

function getApp() {
  if (!app) app = require('../src/app').createApp();
  return app;
}

/** عميل مسجل الدخول */
async function login(username, password = PW) {
  const agent = request.agent(getApp());
  const token = async () => {
    const r = await agent.get('/login');
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    return m ? m[1] : null;
  };
  let csrf = await token();
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, username, password });
  // بعد الدخول تُنشأ جلسة جديدة؛ نجلب رمز CSRF الجديد
  const page = await agent.get('/account/password');
  const m = page.text.match(/name="_csrf" value="([^"]+)"/);
  csrf = m ? m[1] : csrf;
  const c = {
    agent, res, csrf,
    get: (u) => agent.get(u),
    post: (u, data = {}) => agent.post(u).type('form').send({ _csrf: csrf, ...data }),
    upload: (u, fields, file) => {
      let r = agent.post(u + (u.includes('?') ? '&' : '?') + '_csrf=' + csrf);
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      if (file) r = r.attach('file', file.buffer, file.name);
      return r;
    },
    /** رسالة التنبيه بعد إعادة التوجيه */
    flash: async () => { const r = await agent.get('/notifications'); const m = r.text.match(/class="alert (\w+)" role="status">([^<]*)/); return m ? { type: m[1], msg: m[2] } : null; },
  };
  return c;
}

const idFrom = (res) => Number((res.headers.location || '').match(/(\d+)(?:[#?].*)?$/)?.[1]);

module.exports = { resetDb, login, getApp, db, idFrom, PW };

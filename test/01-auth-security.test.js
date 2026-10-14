'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { resetDb, login, getApp, db } = require('./helpers');

before(resetDb);
after(() => db.pool.end());

test('الصفحات المحمية تعيد التوجيه لتسجيل الدخول', async () => {
  for (const u of ['/', '/families', '/donations', '/reports', '/admin/users', '/documents/1/file']) {
    const r = await request(getApp()).get(u);
    assert.equal(r.status, 302, u);
    assert.match(r.headers.location, /\/login/);
  }
});

test('تسجيل الدخول والخروج', async () => {
  const c = await login('admin');
  assert.equal(c.res.status, 302);
  assert.equal(c.res.headers.location, '/');
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /لوحة التحكم/);
  const out = await c.post('/logout');
  assert.equal(out.status, 302);
  const after = await c.get('/');
  assert.equal(after.status, 302);
});

test('كلمة مرور خاطئة تُرفض ويُقفل الحساب بعد 5 محاولات', async () => {
  for (let i = 0; i < 5; i++) {
    const c = await login('auditor', 'wrong-password-1');
    assert.equal(c.res.headers.location, '/login');
  }
  const u = await db.one(`SELECT locked_until FROM users WHERE username='auditor'`);
  assert.ok(u.locked_until && new Date(u.locked_until) > new Date(), 'يجب قفل الحساب');
  const c = await login('auditor'); // كلمة صحيحة لكن الحساب مقفل
  assert.equal(c.res.headers.location, '/login');
  await db.query(`UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE username='auditor'`);
  const ok = await login('auditor');
  assert.equal(ok.res.headers.location, '/');
});

test('رفض الطلبات بدون رمز CSRF', async () => {
  const c = await login('admin');
  const r = await c.agent.post('/families').type('form').send({ family_name: 'x' });
  assert.equal(r.status, 403);
});

test('الصلاحيات مطبقة في الخادم وليس فقط بإخفاء الأزرار', async () => {
  const social = await login('social');
  assert.equal((await social.get('/donations')).status, 403);
  assert.equal((await social.get('/finance')).status, 403);
  assert.equal((await social.get('/admin/users')).status, 403);
  assert.equal((await social.post('/expenses', { description: 'x' })).status, 403);
  const auditor = await login('auditor');
  assert.equal((await auditor.get('/families')).status, 200);
  const r = await auditor.post('/families', { family_name: 'محاولة', g_full_name: 'x', g_phone: '0100000000', calc_method: 'family_fixed' });
  assert.equal(r.status, 403, 'المراجع لا يعدّل البيانات');
  const cashier = await login('cashier');
  assert.equal((await cashier.get('/admin/settings')).status, 403);
  assert.equal((await cashier.post('/entitlements/generate', { period: '2026-01' })).status, 403);
});

test('سحب الصلاحية يسري فورًا على الجلسة القائمة', async () => {
  const c = await login('accountant');
  assert.equal((await c.get('/donations')).status, 200);
  await db.query(`DELETE FROM role_permissions WHERE permission_code='donations.view' AND role_id=(SELECT id FROM roles WHERE code='accountant')`);
  assert.equal((await c.get('/donations')).status, 403);
  await db.query(`INSERT INTO role_permissions (role_id, permission_code) SELECT id, 'donations.view' FROM roles WHERE code='accountant'`);
});

test('لا يمكن إزالة آخر مدير نظام', async () => {
  const c = await login('admin');
  const admin = await db.one(`SELECT id FROM users WHERE username='admin'`);
  const r = await c.post(`/admin/users/${admin.id}`, { full_name: 'مدير', is_active: '' });
  assert.equal(r.status, 302);
  const u = await db.one('SELECT is_active FROM users WHERE id=$1', [admin.id]);
  assert.equal(u.is_active, true);
});

test('إنشاء موظف بكلمة مؤقتة يجبره على تغييرها', async () => {
  const c = await login('admin');
  const r = await c.post('/admin/users', { username: 'newstaff', full_name: 'موظف جديد', password: 'Temp12345pass', roles: String((await db.one(`SELECT id FROM roles WHERE code='cashier'`)).id) });
  assert.equal(r.status, 302);
  const s = await login('newstaff', 'Temp12345pass');
  const home = await s.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/account/password');
  const ch = await s.post('/account/password', { current_password: 'Temp12345pass', new_password: 'NewPass12345', confirm_password: 'NewPass12345' });
  assert.equal(ch.headers.location, '/');
  assert.equal((await s.get('/')).status, 200);
});

test('كلمات المرور مخزنة بتجزئة ولا تظهر في سجل التدقيق', async () => {
  const u = await db.one(`SELECT password_hash FROM users WHERE username='newstaff'`);
  assert.match(u.password_hash, /^\$2[aby]\$/);
  const leak = await db.one(`SELECT count(*)::int AS n FROM audit_logs WHERE before_data::text ~ 'Pass12345|password_hash' OR after_data::text ~ 'Pass12345|password_hash'`);
  assert.equal(leak.n, 0);
});

test('سجل التدقيق غير قابل للتعديل أو الحذف', async () => {
  await assert.rejects(db.query('UPDATE audit_logs SET action=$1', ['x']), /غير قابل للتعديل/);
  await assert.rejects(db.query('DELETE FROM audit_logs'), /غير قابل للتعديل/);
});

test('ترويسات الأمان وملف الكوكي', async () => {
  const r = await request(getApp()).get('/login');
  assert.ok(r.headers['content-security-policy']);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const c = await request(getApp()).post('/login').type('form').send({ username: 'x', password: 'y' });
  assert.equal(c.status, 403); // بدون CSRF
});

test('التفعيل الأول: يتطلب مفتاح التفعيل ويتعطل بعد وجود مستخدمين', async () => {
  const anon = request.agent(getApp());
  const r = await anon.get('/setup');
  assert.equal(r.status, 302, 'يوجد مستخدمون بالفعل');
  await db.query('TRUNCATE user_roles, users RESTART IDENTITY CASCADE');
  process.env.OWNER_SETUP_KEY = 'setup-key-123456';
  const l = await anon.get('/login');
  assert.equal(l.headers.location, '/setup');
  const page = await anon.get('/setup');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const bad = await anon.post('/setup').type('form').send({ _csrf: csrf, setup_key: 'wrong-key-0000', username: 'boss', full_name: 'مدير', password: 'Boss12345pass', confirm_password: 'Boss12345pass' });
  assert.equal(bad.headers.location, '/setup');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM users')).n, 0);
  await anon.post('/setup').type('form').send({ _csrf: csrf, setup_key: 'setup-key-123456', username: 'boss', full_name: 'مدير', password: 'Boss12345pass', confirm_password: 'Boss12345pass' });
  const u = await db.one(`SELECT u.username, r.code FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id`);
  assert.deepEqual(u, { username: 'boss', code: 'admin' });
  const again = await anon.post('/setup').type('form').send({ _csrf: csrf, setup_key: 'setup-key-123456', username: 'evil', full_name: 'x', password: 'Evil12345pass', confirm_password: 'Evil12345pass' });
  assert.equal(again.headers.location, '/login');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM users')).n, 1);
  const c = await login('boss', 'Boss12345pass');
  assert.equal(c.res.headers.location, '/');
});

test('«تذكرني» يمد الجلسة 30 يومًا، وبدونه تبقى الجلسة قصيرة', async () => {
  const anon = request.agent(getApp());
  const page = await anon.get('/login');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.match(page.text, /name="remember"/);
  const r = await anon.post('/login').type('form').send({ _csrf: csrf, username: 'boss', password: 'Boss12345pass', remember: '1' });
  const exp = new Date(r.headers['set-cookie'].join(';').match(/Expires=([^;]+)/)[1]);
  assert.ok(exp - Date.now() > 29 * 24 * 3600 * 1000, 'مدة الجلسة 30 يومًا');
  const anon2 = request.agent(getApp());
  const p2 = await anon2.get('/login');
  const c2 = p2.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const r2 = await anon2.post('/login').type('form').send({ _csrf: c2, username: 'boss', password: 'Boss12345pass' });
  const exp2 = new Date(r2.headers['set-cookie'].join(';').match(/Expires=([^;]+)/)[1]);
  assert.ok(exp2 - Date.now() < 3 * 3600 * 1000, 'الجلسة العادية قصيرة');
});

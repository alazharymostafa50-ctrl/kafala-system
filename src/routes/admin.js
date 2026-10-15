'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const U = require('../lib/util');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const elig = require('../lib/eligibility');
const { memoryUpload, replaceFile } = require('../lib/uploads');
const { paged, Where } = require('../lib/paging');
const { passwordPolicy } = require('./auth');
const { h, can, flash } = require('../middleware');

// ---------- المستخدمون ----------
router.get('/admin/users', can('users.manage'), h(async (req, res) => {
  const users = await db.many(`SELECT u.*, COALESCE(string_agg(r.name, '، '), '') AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id
    LEFT JOIN roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.is_active DESC, u.full_name`);
  const roles = await db.many(`SELECT r.*, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id=r.id)::int AS perms,
    (SELECT count(*) FROM user_roles ur WHERE ur.role_id=r.id)::int AS users FROM roles r ORDER BY r.id`);
  res.render('admin/users', { title: 'المستخدمون والأدوار', users, roles });
}));

router.get('/admin/users/new', can('users.manage'), h(async (req, res) => {
  res.render('admin/user-form', { title: 'إضافة موظف', u: { is_active: true }, roles: await db.many('SELECT * FROM roles ORDER BY id'), mine: [], isNew: true });
}));

router.get('/admin/users/:id(\\d+)', can('users.manage'), h(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id=$1', [U.intId(req.params.id)]);
  if (!u) throw new U.UserError('المستخدم غير موجود', 404);
  const mine = (await db.many('SELECT role_id FROM user_roles WHERE user_id=$1', [u.id])).map((r) => r.role_id);
  res.render('admin/user-form', { title: 'تعديل مستخدم', u, roles: await db.many('SELECT * FROM roles ORDER BY id'), mine, isNew: false });
}));

async function adminsLeft(c, exceptUser) {
  const r = await c.one(`SELECT count(DISTINCT u.id)::int AS n FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
    WHERE rp.permission_code='users.manage' AND u.is_active AND u.id <> $1`, [exceptUser]);
  return r.n;
}

function tempPassword() { return 'T' + crypto.randomBytes(6).toString('base64url') + Math.floor(10 + Math.random() * 89); }

router.post('/admin/users', can('users.manage'), h(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw new U.UserError('اسم المستخدم يجب أن يكون 3-40 حرفًا لاتينيًا أو أرقامًا');
  const fullName = U.str(req.body.full_name, { required: true, label: 'الاسم' });
  const roleIds = [].concat(req.body.roles || []).map(U.intId);
  const pw = req.body.password ? String(req.body.password) : tempPassword();
  passwordPolicy(pw);
  const id = await db.tx(async (c) => {
    if (await c.one('SELECT 1 FROM users WHERE lower(username)=$1', [username])) throw new U.UserError('اسم المستخدم مستخدم مسبقًا');
    const u = await c.one(`INSERT INTO users (username, full_name, phone, password_hash, must_change_password) VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
      [username, fullName, U.phone(req.body.phone), await bcrypt.hash(pw, 12)]);
    for (const r of roleIds) await c.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [u.id, r]);
    await audit.log(req, 'create', 'user', u.id, { after: { username, full_name: fullName, roles: roleIds } }, c);
    return u.id;
  });
  flash(req, 'success', req.body.password ? 'تم إنشاء الحساب. سيُطلب من الموظف تغيير كلمة المرور عند أول دخول.'
    : `تم إنشاء الحساب. كلمة المرور المؤقتة (تظهر مرة واحدة فقط): ${pw} — سلّمها للموظف بشكل آمن، وسيُطلب منه تغييرها.`);
  res.redirect(`/admin/users/${id}`);
}));

router.post('/admin/users/:id(\\d+)', can('users.manage'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const roleIds = [].concat(req.body.roles || []).map(U.intId);
  const active = req.body.is_active === '1';
  let msg = 'تم حفظ التعديلات';
  await db.tx(async (c) => {
    const b = await c.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]);
    if (!b) throw new U.UserError('المستخدم غير موجود', 404);
    const oldRoles = (await c.many('SELECT role_id FROM user_roles WHERE user_id=$1', [id])).map((r) => r.role_id);
    await c.query('UPDATE users SET full_name=$2, phone=$3, is_active=$4, updated_at=now() WHERE id=$1', [id, U.str(req.body.full_name, { required: true }), U.phone(req.body.phone), active]);
    await c.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
    for (const r of roleIds) await c.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [id, r]);
    // ضمان بقاء مدير نظام نشط واحد على الأقل
    const stillAdmin = await c.one(`SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1 AND rp.permission_code='users.manage'`, [id]);
    if ((!active || !stillAdmin) && (await adminsLeft(c, id)) === 0) throw new U.UserError('لا يمكن إزالة صلاحية آخر مدير نظام نشط');
    if (req.body.reset_password === '1') {
      const pw = tempPassword();
      await c.query('UPDATE users SET password_hash=$2, must_change_password=TRUE, failed_attempts=0, locked_until=NULL WHERE id=$1', [id, await bcrypt.hash(pw, 12)]);
      await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
      msg = `تمت إعادة تعيين كلمة المرور. كلمة المرور المؤقتة (تظهر مرة واحدة): ${pw}`;
    }
    if (req.body.unlock === '1') await c.query('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1', [id]);
    if (req.body.reset_2fa === '1') await c.query('UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=$1', [id]);
    if (!active) await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
    await audit.log(req, 'update', 'user', id, { before: { is_active: b.is_active, roles: oldRoles }, after: { is_active: active, roles: roleIds, reset_password: req.body.reset_password === '1', reset_2fa: req.body.reset_2fa === '1' } }, c);
  });
  flash(req, 'success', msg);
  res.redirect(`/admin/users/${id}`);
}));

// ---------- الأدوار والصلاحيات ----------
router.get('/admin/roles/:id(\\d+)', can('users.manage'), h(async (req, res) => {
  const role = await db.one('SELECT * FROM roles WHERE id=$1', [U.intId(req.params.id)]);
  if (!role) throw new U.UserError('الدور غير موجود', 404);
  const perms = await db.many('SELECT * FROM permissions ORDER BY grp, code');
  const mine = new Set((await db.many('SELECT permission_code FROM role_permissions WHERE role_id=$1', [role.id])).map((r) => r.permission_code));
  res.render('admin/role', { title: 'صلاحيات الدور', role, perms, mine });
}));

router.post('/admin/roles', can('users.manage'), h(async (req, res) => {
  const name = U.str(req.body.name, { required: true, max: 80, label: 'اسم الدور' });
  const code = 'custom_' + crypto.randomBytes(3).toString('hex');
  const r = await db.one('INSERT INTO roles (code, name, description) VALUES ($1,$2,$3) RETURNING id', [code, name, U.str(req.body.description, { max: 300 })]);
  await audit.log(req, 'create', 'role', r.id, { after: { name } });
  res.redirect(`/admin/roles/${r.id}`);
}));

router.post('/admin/roles/:id(\\d+)', can('users.manage'), h(async (req, res) => {
  const id = U.intId(req.params.id);
  const all = (await db.many('SELECT code FROM permissions')).map((p) => p.code);
  const chosen = [].concat(req.body.perms || []).filter((p) => all.includes(p));
  await db.tx(async (c) => {
    const role = await c.one('SELECT * FROM roles WHERE id=$1', [id]);
    if (!role) throw new U.UserError('الدور غير موجود', 404);
    if (role.code === 'admin' && !chosen.includes('users.manage')) throw new U.UserError('لا يمكن إزالة صلاحية إدارة المستخدمين من دور مدير النظام');
    const before = (await c.many('SELECT permission_code FROM role_permissions WHERE role_id=$1', [id])).map((r) => r.permission_code);
    await c.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
    for (const p of chosen) await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)', [id, p]);
    if ((await adminsLeft(c, 0)) === 0) throw new U.UserError('يجب أن يبقى مستخدم نشط واحد على الأقل لديه صلاحية إدارة المستخدمين');
    await audit.log(req, 'permissions_changed', 'role', id, { before: { perms: before }, after: { perms: chosen } }, c);
  });
  flash(req, 'success', 'تم حفظ صلاحيات الدور؛ تسري فورًا على جميع المستخدمين المرتبطين به');
  res.redirect(`/admin/roles/${id}`);
}));

// ---------- الإعدادات ----------
router.get('/admin/settings', can('settings.manage'), h(async (req, res) => {
  const s = await settings.all();
  const types = await db.many('SELECT * FROM donation_types ORDER BY is_system DESC, name');
  const cats = await db.many('SELECT * FROM expense_categories ORDER BY name');
  res.render('admin/settings', { title: 'إعدادات النظام', s, types, cats });
}));

const logoUpload = memoryUpload(2).single('logo');
// تنزيل نسخة احتياطية من البيانات (Excel) — لمدير النظام
router.get('/admin/backup.xlsx', can('settings.manage'), h(async (req, res) => {
  const buf = await require('../lib/databackup').buildWorkbook(res.locals.org);
  await audit.log(req, 'backup_download', 'system', '', { after: { bytes: buf.byteLength } });
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="kafala-backup-${stamp}.xlsx"`).set('Cache-Control', 'no-store').send(Buffer.from(buf));
}));

router.post('/admin/settings/org', can('settings.manage'), logoUpload, h(async (req, res) => {
  const cur = await settings.get('org');
  const org = {
    ...cur,
    name: U.str(req.body.name, { required: true, max: 150, label: 'اسم الجمعية' }),
    subtitle: U.str(req.body.subtitle, { max: 200 }) || '',
    registration: U.str(req.body.registration, { max: 120 }) || '',
    default_city: U.str(req.body.default_city, { max: 80 }) || '',
    system_name: U.str(req.body.system_name, { required: true, max: 100, label: 'اسم النظام' }),
    program_name: U.str(req.body.program_name, { max: 100 }) || '',
    phone: U.str(req.body.phone, { max: 60 }) || '',
    address: U.str(req.body.address, { max: 200 }) || '',
    currency: U.str(req.body.currency, { required: true, max: 10, label: 'العملة' }),
  };
  if (req.file) {
    const b = req.file.buffer;
    if (!b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new U.UserError('الشعار يجب أن يكون صورة PNG');
    await replaceFile(db, 'branding/logo.png', b, 'image/png');
    org.logo = '/branding/logo.png?v=' + Date.now();
  }
  if (req.body.reset_logo === '1') org.logo = null;
  await settings.set('org', org, req.user.id);
  await audit.log(req, 'settings_org', 'system_settings', 'org', { before: cur, after: org });
  flash(req, 'success', 'تم حفظ بيانات الجمعية');
  res.redirect('/admin/settings');
}));

router.post('/admin/settings/rules', can('settings.manage'), h(async (req, res) => {
  const b = req.body;
  const curE = await settings.get('eligibility'); const curF = await settings.get('finance'); const curD = await settings.get('documents');
  const int = (v, lo, hi, label) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new U.UserError(`${label} يجب أن يكون بين ${lo} و${hi}`); return n; };
  const statuses = elig.STATUSES;
  const e = {
    ...curE,
    male_review_age: int(b.male_review_age, 14, 30, 'سن مراجعة الذكور'),
    alert_months_before: String(b.alert_months_before || '3,1').split(/[,،\s]+/).filter(Boolean).map((x) => int(x, 1, 12, 'أشهر التنبيه')),
    proof_expiry_alert_days: int(b.proof_expiry_alert_days, 1, 180, 'أيام تنبيه انتهاء الإثبات'),
    document_expiry_alert_days: int(b.document_expiry_alert_days, 1, 180, 'أيام تنبيه انتهاء المستندات'),
    paying_statuses: [].concat(b.paying_statuses || []).filter((s) => statuses.includes(s)),
    female_marriage_new_status: U.oneOf(b.female_marriage_new_status, statuses, { label: 'حالة الأنثى بعد اعتماد الزواج' }),
  };
  if (!e.paying_statuses.length) throw new U.UserError('اختر حالة استحقاق واحدة على الأقل يُصرف لها');
  const f = {
    ...curF,
    separation_of_duties: b.separation_of_duties === '1', disbursement_requires_approval: b.disbursement_requires_approval === '1',
    allow_partial_disbursement: b.allow_partial_disbursement === '1', allow_general_fund_for_kafala: b.allow_general_fund_for_kafala === '1', auto_generate: b.auto_generate === '1',
  };
  const docTypes = ['guardian_id', 'member_id', 'birth_certificate', 'orphan_proof', 'guardianship', 'bank_document'];
  const d = { ...curD, max_size_mb: int(b.max_size_mb, 1, 25, 'الحجم الأقصى'),
    required_family: [].concat(b.required_family || []).filter((x) => docTypes.includes(x)),
    required_member: [].concat(b.required_member || []).filter((x) => docTypes.includes(x)) };
  await db.tx(async (c) => {
    await settings.set('eligibility', e, req.user.id, c); await settings.set('finance', f, req.user.id, c); await settings.set('documents', d, req.user.id, c);
    await audit.log(req, 'settings_rules', 'system_settings', 'rules', { before: { eligibility: curE, finance: curF, documents: curD }, after: { eligibility: e, finance: f, documents: d } }, c);
  });
  await elig.runEngine({ user: req.user }).catch(() => {});
  flash(req, 'success', 'تم حفظ قواعد النظام وإعادة تقييم التنبيهات. التغييرات لا تعدّل الكشوف السابقة.');
  res.redirect('/admin/settings');
}));

router.post('/admin/settings/donation-types', can('settings.manage'), h(async (req, res) => {
  const name = U.str(req.body.name, { required: true, max: 80, label: 'اسم النوع' });
  const fund = U.oneOf(req.body.fund_code, ['general', 'orphans'], { label: 'الصندوق' });
  const code = 'custom_' + crypto.randomBytes(3).toString('hex');
  await db.query('INSERT INTO donation_types (code, name, fund_code) VALUES ($1,$2,$3)', [code, name, fund]);
  await audit.log(req, 'create', 'donation_type', code, { after: { name, fund } });
  flash(req, 'success', 'تمت إضافة نوع التبرع');
  res.redirect('/admin/settings#types');
}));

router.post('/admin/settings/donation-types/:code/toggle', can('settings.manage'), h(async (req, res) => {
  const r = await db.one('UPDATE donation_types SET is_active = NOT is_active WHERE code=$1 AND NOT is_system RETURNING is_active', [req.params.code]);
  if (!r) throw new U.UserError('لا يمكن تعطيل الأنواع الأساسية');
  await audit.log(req, 'toggle', 'donation_type', req.params.code, { after: r });
  res.redirect('/admin/settings#types');
}));

router.post('/admin/settings/expense-categories', can('settings.manage'), h(async (req, res) => {
  const name = U.str(req.body.name, { required: true, max: 80, label: 'اسم التصنيف' });
  const funds = req.body.allow_restricted === '1' ? ['general', 'orphans'] : ['general'];
  const code = 'custom_' + crypto.randomBytes(3).toString('hex');
  await db.query('INSERT INTO expense_categories (code, name, allowed_funds) VALUES ($1,$2,$3)', [code, name, funds]);
  await audit.log(req, 'create', 'expense_category', code, { after: { name, funds } });
  flash(req, 'success', 'تمت إضافة التصنيف');
  res.redirect('/admin/settings#cats');
}));

// ---------- سجل التدقيق ----------
router.get('/admin/audit', can('audit.view'), h(async (req, res) => {
  const w = new Where();
  if (req.query.user) w.add('a.username ILIKE ?', '%' + req.query.user + '%');
  if (req.query.entity) w.add('a.entity = ?', req.query.entity);
  if (req.query.entity_id) w.add('a.entity_id = ?', req.query.entity_id);
  if (req.query.action) w.add('a.action ILIKE ?', '%' + req.query.action + '%');
  if (U.validDate(req.query.from)) w.add('a.at >= ?::date', req.query.from);
  if (U.validDate(req.query.to)) w.add("a.at < ?::date + interval '1 day'", req.query.to);
  const p = await paged(req, `SELECT a.* FROM audit_logs a ${w.sql}`, w.params, 'a.id DESC', 50);
  const entities = await db.many('SELECT DISTINCT entity FROM audit_logs ORDER BY entity');
  res.render('admin/audit', { title: 'سجل التدقيق', p, entities });
}));

module.exports = router;

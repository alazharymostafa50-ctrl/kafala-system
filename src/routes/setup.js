'use strict';
/**
 * التفعيل الأول: إنشاء حساب مدير النظام من المتصفح عند عدم وجود أي مستخدم.
 * محمي بمفتاح تفعيل يُضبط في متغير البيئة OWNER_SETUP_KEY، ويتعطل نهائيًا بعد إنشاء أول حساب.
 * وفيه أيضًا مسار المهمة المجدولة للاستضافة السحابية.
 */
const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const audit = require('../lib/audit');
const { h, flash } = require('../middleware');
const { UserError } = require('../lib/util');

const hasUsers = async () => !!(await db.one('SELECT 1 FROM users LIMIT 1'));
const safeEq = (a, b) => { const x = Buffer.from(String(a).trim()); const y = Buffer.from(String(b).trim()); return x.length === y.length && crypto.timingSafeEqual(x, y); };
let fails = 0; let failT = 0;

router.use(h(async (req, res, next) => {
  // توجيه صفحة الدخول إلى التفعيل ما دام لا يوجد أي مستخدم
  if (req.path === '/login' && req.method === 'GET' && !(await hasUsers())) return res.redirect('/setup');
  next();
}));

router.get('/setup', h(async (req, res) => {
  if (await hasUsers()) return res.redirect('/login');
  res.render('auth/setup', { title: 'تفعيل النظام', configured: !!process.env.OWNER_SETUP_KEY });
}));

router.post('/setup', h(async (req, res) => {
  if (await hasUsers()) return res.redirect('/login');
  const back = (msg) => { flash(req, 'error', msg); res.redirect('/setup'); };
  if (Date.now() - failT > 15 * 60 * 1000) fails = 0;
  if (fails >= 10) return back('محاولات كثيرة. انتظر 15 دقيقة.');
  const key = process.env.OWNER_SETUP_KEY;
  if (!key || key.length < 12) return back('مفتاح التفعيل غير مضبوط على الخادم.');
  if (!safeEq(String(req.body.setup_key || '').trim(), key)) { fails++; failT = Date.now(); return back('مفتاح التفعيل غير صحيح'); }
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return back('اسم المستخدم يجب أن يكون 3-40 حرفًا إنجليزيًا أو أرقامًا');
  const fullName = String(req.body.full_name || '').trim();
  if (!fullName) return back('الاسم الكامل مطلوب');
  try { require('./auth').passwordPolicy(req.body.password); } catch (e) { return back(e.message); }
  if (req.body.password !== req.body.confirm_password) return back('تأكيد كلمة المرور غير مطابق');
  const hash = await bcrypt.hash(req.body.password, 12);
  const created = await db.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('kafala-setup'))");
    if (await c.one('SELECT 1 FROM users LIMIT 1')) return null;
    const u = await c.one('INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [username, fullName, hash]);
    await c.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code='admin'`, [u.id]);
    await audit.log({ ip: req.ip, user: { id: u.id, username } }, 'setup_first_admin', 'user', u.id, {}, c);
    return u;
  });
  if (!created) return res.redirect('/login');
  flash(req, 'success', 'تم تفعيل النظام وإنشاء حساب مدير النظام. سجّل الدخول الآن.');
  res.redirect('/login');
}));

/**
 * استعادة حساب مدير النظام (عند نسيان كلمة المرور أو قفل الحساب).
 * تتطلب مفتاح التفعيل OWNER_SETUP_KEY، وتعمل فقط لحسابات لها صلاحية إدارة المستخدمين.
 */
router.get('/recover', h(async (req, res) => {
  res.render('auth/recover', { title: 'استعادة حساب المدير', configured: !!process.env.OWNER_SETUP_KEY });
}));

router.post('/recover', h(async (req, res) => {
  const back = (msg) => { flash(req, 'error', msg); res.redirect('/recover'); };
  if (Date.now() - failT > 15 * 60 * 1000) fails = 0;
  if (fails >= 10) return back('محاولات كثيرة. انتظر 15 دقيقة.');
  const key = process.env.OWNER_SETUP_KEY;
  if (!key || key.length < 12) return back('مفتاح التفعيل غير مضبوط على الخادم.');
  if (!safeEq(String(req.body.setup_key || '').trim(), key)) { fails++; failT = Date.now(); return back('مفتاح التفعيل غير صحيح'); }
  const username = String(req.body.username || '').trim().toLowerCase();
  const u = await db.one(`SELECT u.id, u.username FROM users u WHERE lower(u.username)=$1 AND EXISTS (
    SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND rp.permission_code='users.manage')`, [username]);
  if (!u) {
    // صاحب مفتاح التفعيل هو مالك النظام؛ نعرض له أسماء حسابات المديرين ليختار الصحيح
    const admins = await db.many(`SELECT DISTINCT u.username FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
      WHERE rp.permission_code='users.manage' ORDER BY 1`);
    return back(`لا يوجد حساب مدير نظام بالاسم «${username}». الحسابات الموجودة: ${admins.map((a) => a.username).join('، ') || 'لا يوجد'} — اكتب أحدها كما هو.`);
  }
  try { require('./auth').passwordPolicy(req.body.password); } catch (e) { return back(e.message); }
  if (req.body.password !== req.body.confirm_password) return back('تأكيد كلمة المرور غير مطابق');
  const hash = await bcrypt.hash(req.body.password, 12);
  await db.tx(async (c) => {
    await c.query(`UPDATE users SET password_hash=$2, is_active=TRUE, failed_attempts=0, locked_until=NULL, must_change_password=FALSE,
      totp_enabled = CASE WHEN $3 THEN FALSE ELSE totp_enabled END, totp_secret = CASE WHEN $3 THEN NULL ELSE totp_secret END, updated_at=now() WHERE id=$1`,
    [u.id, hash, req.body.reset_2fa === '1']);
    await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [u.id]);
    await audit.log({ ip: req.ip, user: u }, 'admin_recovered', 'user', u.id, { after: { reset_2fa: req.body.reset_2fa === '1' } }, c);
  });
  flash(req, 'success', `تم تعيين كلمة مرور جديدة للحساب «${u.username}» وفك أي قفل عليه. سجّل الدخول الآن.`);
  res.redirect('/login');
}));

// فحص الحالة: يوضح هل الخادم وقاعدة البيانات يعملان (بدون أي بيانات حساسة)
router.get('/health', h(async (req, res) => {
  const t = Date.now();
  let dbOk = false; let err = null; let users = null;
  try { users = (await db.one('SELECT count(*)::int AS n FROM users')).n; dbOk = true; } catch (e) { err = e.code || e.message.slice(0, 120); }
  // تتبع مؤقت لسلسلة إعادة التوجيه لمسار عام (للتشخيص فقط)
  let trace = null;
  if (typeof req.query.trace === 'string' && /^\/[a-z/-]{0,30}$/.test(req.query.trace)) {
    trace = [];
    let url = `https://${req.get('host')}${req.query.trace}`;
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'kafala-health-trace' } });
        trace.push({ url: url.replace(/^https:\/\/[^/]+/, ''), status: r.status, location: r.headers.get('location'), server: r.headers.get('server'),
          vercel: r.headers.get('x-vercel-id'), matched: r.headers.get('x-matched-path'), cache: r.headers.get('x-vercel-cache'), cookie: !!r.headers.get('set-cookie') });
        const loc = r.headers.get('location');
        if (!loc) break;
        url = loc.startsWith('http') ? loc : `https://${req.get('host')}${loc}`;
      } catch (e) { trace.push({ error: e.message }); break; }
    }
  }
  res.set('Cache-Control', 'no-store').json({ trace, ok: dbOk, db: dbOk, db_ms: Date.now() - t, users, setup_key: !!process.env.OWNER_SETUP_KEY,
    region: process.env.VERCEL_REGION || null, version: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7), error: err });
}));

// المهمة المجدولة اليومية (Vercel Cron) — تتطلب CRON_SECRET
router.get('/cron/engine', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEq(req.get('authorization') || '', 'Bearer ' + secret)) throw new UserError('غير موجود', 404);
  const stats = await require('../lib/scheduler').runIfStale({ force: true });
  res.json({ ok: true, stats });
}));

module.exports = router;

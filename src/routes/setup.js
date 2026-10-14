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
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
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

// المهمة المجدولة اليومية (Vercel Cron) — تتطلب CRON_SECRET
router.get('/cron/engine', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEq(req.get('authorization') || '', 'Bearer ' + secret)) throw new UserError('غير موجود', 404);
  const stats = await require('../lib/scheduler').runIfStale({ force: true });
  res.json({ ok: true, stats });
}));

module.exports = router;

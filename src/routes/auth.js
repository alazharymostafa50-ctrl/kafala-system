'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const audit = require('../lib/audit');
const totp = require('../lib/totp');
const { h, flash, requireLogin } = require('../middleware');
const { UserError } = require('../lib/util');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// تحديد محاولات الدخول لكل عنوان IP (في الذاكرة)
const ipHits = new Map();
function ipRec(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  ipHits.set(ip, rec);
  return rec;
}
// يُحتسب الفشل فقط؛ أكثر من 30 محاولة فاشلة خلال 15 دقيقة من نفس العنوان تُحظر مؤقتًا
const ipLimited = (ip) => ipRec(ip).n >= 30;
const ipFail = (ip) => { ipRec(ip).n++; };

function passwordPolicy(p) {
  if (typeof p !== 'string' || p.length < 10) throw new UserError('كلمة المرور يجب ألا تقل عن 10 أحرف');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new UserError('كلمة المرور يجب أن تحتوي على أحرف وأرقام');
  if (p.length > 128) throw new UserError('كلمة المرور طويلة جدًا');
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'تسجيل الدخول', step: req.session.pending2fa ? 'totp' : 'password' });
});

router.post('/login', h(async (req, res) => {
  const fail = (msg) => { ipFail(req.ip); flash(req, 'error', msg); res.redirect('/login'); };
  if (ipLimited(req.ip)) return fail('محاولات كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم حاول مجددًا.');

  // الخطوة الثانية: رمز المصادقة الثنائية
  if (req.session.pending2fa) {
    const u = await db.one('SELECT * FROM users WHERE id=$1 AND is_active', [req.session.pending2fa]);
    if (!u) { req.session.pending2fa = null; return fail('انتهت الجلسة، سجّل الدخول من جديد'); }
    if (!totp.verify(u.totp_secret, (req.body.code || '').trim())) {
      await registerFail(u, req);
      return fail('رمز التحقق غير صحيح');
    }
    return completeLogin(req, res, u);
  }

  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = await db.one('SELECT * FROM users WHERE lower(username)=$1', [username]);
  if (!u) { await bcrypt.compare(password, '$2b$12$Ap0xQGrSEWVpjnrC1JL9FeiqlFNKuxazqQjD4yAYMHzGNQbmo1uwm'); return fail('اسم المستخدم أو كلمة المرور غير صحيحة'); }
  if (!u.is_active) return fail('الحساب موقوف. تواصل مع مدير النظام.');
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return fail('تم قفل الحساب مؤقتًا بسبب محاولات فاشلة متكررة. حاول بعد ' + LOCK_MINUTES + ' دقيقة.');
  }
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) { await registerFail(u, req); return fail('اسم المستخدم أو كلمة المرور غير صحيحة'); }

  if (u.totp_enabled) {
    await new Promise((r) => req.session.regenerate(r));
    req.session.pending2fa = u.id;
    return res.redirect('/login');
  }
  return completeLogin(req, res, u);
}));

async function registerFail(u, req) {
  const fails = u.failed_attempts + 1;
  const lock = fails >= MAX_FAILS;
  await db.query(`UPDATE users SET failed_attempts=$2, locked_until=$3 WHERE id=$1`,
    [u.id, lock ? 0 : fails, lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : u.locked_until]);
  await audit.log({ ip: req.ip, user: { id: u.id, username: u.username } }, lock ? 'login_locked' : 'login_failed', 'user', u.id);
}

async function completeLogin(req, res, u) {
  const returnTo = req.session.returnTo;
  await new Promise((r, j) => req.session.regenerate((e) => (e ? j(e) : r())));
  req.session.userId = u.id;
  await db.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
  await audit.log({ ip: req.ip, user: u }, 'login', 'user', u.id);
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
}

router.post('/logout', h(async (req, res) => {
  if (req.user) await audit.log(req, 'logout', 'user', req.user.id);
  req.session.destroy(() => { res.clearCookie('kafala.sid'); res.redirect('/login'); });
}));

router.get('/account/password', requireLogin, (req, res) => res.render('auth/password', { title: 'تغيير كلمة المرور' }));
router.post('/account/password', requireLogin, h(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.current_password || ''), u.password_hash))) throw new UserError('كلمة المرور الحالية غير صحيحة');
  passwordPolicy(req.body.new_password);
  if (req.body.new_password !== req.body.confirm_password) throw new UserError('تأكيد كلمة المرور غير مطابق');
  const hash = await bcrypt.hash(req.body.new_password, 12);
  await db.query('UPDATE users SET password_hash=$2, must_change_password=FALSE, updated_at=now() WHERE id=$1', [u.id, hash]);
  // إنهاء الجلسات الأخرى للمستخدم
  await db.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1 AND sid <> $2`, [u.id, req.sessionID]);
  await audit.log(req, 'password_changed', 'user', u.id);
  flash(req, 'success', 'تم تغيير كلمة المرور بنجاح');
  res.redirect('/');
}));

// إعداد المصادقة الثنائية
router.get('/account/2fa', requireLogin, h(async (req, res) => {
  if (!req.session.totpSetup) req.session.totpSetup = totp.generateSecret();
  const QR = require('qrcode');
  const url = totp.otpauthUrl(req.session.totpSetup, req.user.username, res.locals.org.system_name || 'Kafala');
  const qr = await QR.toDataURL(url, { margin: 1, width: 220 });
  res.render('auth/twofa', { title: 'المصادقة الثنائية', secret: req.session.totpSetup, qr });
}));
router.post('/account/2fa', requireLogin, h(async (req, res) => {
  if (req.body.action === 'disable') {
    const u = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await bcrypt.compare(String(req.body.current_password || ''), u.password_hash))) throw new UserError('كلمة المرور غير صحيحة');
    await db.query('UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=$1', [req.user.id]);
    await audit.log(req, '2fa_disabled', 'user', req.user.id);
    flash(req, 'success', 'تم إيقاف المصادقة الثنائية');
    return res.redirect('/account/2fa');
  }
  const secret = req.session.totpSetup;
  if (!secret || !totp.verify(secret, String(req.body.code || '').trim())) throw new UserError('رمز التحقق غير صحيح، تأكد من وقت الجوال');
  await db.query('UPDATE users SET totp_enabled=TRUE, totp_secret=$2 WHERE id=$1', [req.user.id, secret]);
  delete req.session.totpSetup;
  await audit.log(req, '2fa_enabled', 'user', req.user.id);
  flash(req, 'success', 'تم تفعيل المصادقة الثنائية لحسابك');
  res.redirect('/');
}));

module.exports = router;
module.exports.passwordPolicy = passwordPolicy;

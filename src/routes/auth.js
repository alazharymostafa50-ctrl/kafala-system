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
    req.session.pendingRemember = req.body.remember === '1';
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

const REMEMBER_DAYS = 30;
async function completeLogin(req, res, u) {
  const returnTo = req.session.returnTo;
  const remember = req.session.pending2fa ? !!req.session.pendingRemember : req.body.remember === '1';
  await new Promise((r, j) => req.session.regenerate((e) => (e ? j(e) : r())));
  req.session.userId = u.id;
  // «تذكرني»: جلسة تبقى 30 يومًا (تتجدد مع الاستخدام)؛ وإلا تنتهي بعد مدة الخمول المعتادة
  if (remember) { req.session.cookie.maxAge = REMEMBER_DAYS * 24 * 60 * 60 * 1000; req.session.remember = true; }
  await db.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
  await audit.log({ ip: req.ip, user: u }, 'login', 'user', u.id, { after: { remember } });
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/choose');
}

router.post('/logout', h(async (req, res) => {
  if (req.user) await audit.log(req, 'logout', 'user', req.user.id);
  req.session.destroy(() => { res.clearCookie('kafala.sid'); res.redirect('/login'); });
}));

router.get('/account/password', requireLogin, h(async (req, res) => {
  const rc = await db.one('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [req.user.id]);
  res.render('auth/password', { title: 'تغيير كلمة المرور', codesLeft: rc.n });
}));
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

// ---------- أكواد الاسترجاع (لاستعادة كلمة المرور دون مفتاح التفعيل) ----------
const crypto = require('crypto');
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_COUNT = 8;
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function newCode() {
  const b = crypto.randomBytes(8);
  const s = [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}

router.post('/account/recovery-codes', requireLogin, h(async (req, res) => {
  const u = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.current_password || ''), u.password_hash))) throw new UserError('كلمة المرور الحالية غير صحيحة');
  const codes = Array.from({ length: RECOVERY_COUNT }, newCode);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normCode(c), 10)));
  await db.tx(async (c) => {
    await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [req.user.id]);
    for (const hsh of hashes) await c.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [req.user.id, hsh]);
  });
  await audit.log(req, 'recovery_codes_generated', 'user', req.user.id);
  res.render('auth/recovery-codes', { title: 'أكواد استرجاع كلمة المرور', codes });
}));

router.get('/forgot', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/forgot', { title: 'نسيت كلمة المرور' });
});
router.post('/forgot', h(async (req, res) => {
  const fail = (msg) => { ipFail(req.ip); flash(req, 'error', msg); res.redirect('/forgot'); };
  if (ipLimited(req.ip)) return fail('محاولات كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم حاول مجددًا.');
  const username = String(req.body.username || '').trim().toLowerCase();
  const code = normCode(req.body.code);
  const u = await db.one('SELECT * FROM users WHERE lower(username)=$1 AND is_active', [username]);
  const rows = u ? await db.many('SELECT id, code_hash FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [u.id]) : [];
  let hit = null;
  for (const r of rows) { if (code.length === 8 && await bcrypt.compare(code, r.code_hash)) { hit = r; break; } }
  if (!u || !hit) {
    if (u) await audit.log({ ip: req.ip, user: { id: u.id, username: u.username } }, 'recovery_code_failed', 'user', u.id);
    return fail('اسم المستخدم أو كود الاسترجاع غير صحيح');
  }
  try { passwordPolicy(req.body.password); } catch (e) { flash(req, 'error', e.message); return res.redirect('/forgot'); }
  if (req.body.password !== req.body.confirm_password) { flash(req, 'error', 'تأكيد كلمة المرور غير مطابق'); return res.redirect('/forgot'); }
  const hash = await bcrypt.hash(req.body.password, 12);
  await db.tx(async (c) => {
    const used = await c.one('UPDATE user_recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id', [hit.id]);
    if (!used) throw new UserError('هذا الكود استُخدم من قبل');
    await c.query('UPDATE users SET password_hash=$2, must_change_password=FALSE, failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1', [u.id, hash]);
    await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [u.id]);
  });
  const left = await db.one('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [u.id]);
  await audit.log({ ip: req.ip, user: { id: u.id, username: u.username } }, 'password_reset_by_recovery_code', 'user', u.id, { after: { codes_left: left.n } });
  flash(req, 'success', `تم تعيين كلمة المرور الجديدة. سجّل الدخول الآن. (متبقي لك ${left.n} أكواد استرجاع)`);
  res.redirect('/login');
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

router._resetIpLimits = () => ipHits.clear(); // للاختبارات فقط
module.exports = router;
module.exports.passwordPolicy = passwordPolicy;

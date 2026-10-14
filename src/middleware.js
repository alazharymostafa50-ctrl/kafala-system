'use strict';
const crypto = require('crypto');
const db = require('./db');
const settings = require('./lib/settings');
const labels = require('./lib/labels');
const U = require('./lib/util');
// رقم إصدار الملفات الثابتة لتحديثها في المتصفح بعد كل نشر
const ASSET_V = (process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 8);

/** تغليف المعالجات غير المتزامنة */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** تحميل المستخدم وصلاحياته من قاعدة البيانات في كل طلب (لتطبيق السحب الفوري للصلاحيات) */
const loadUser = h(async (req, res, next) => {
  req.user = null; req.perms = new Set();
  const uid = req.session?.userId;
  if (uid && !req.session.pending2fa) {
    const u = await db.one('SELECT id, username, full_name, is_active, must_change_password, totp_enabled FROM users WHERE id=$1', [uid]);
    if (!u || !u.is_active) { req.session.destroy(() => {}); return res.redirect('/login'); }
    const perms = await db.many(
      `SELECT DISTINCT rp.permission_code AS c FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1`, [uid]);
    const roles = await db.many('SELECT r.code, r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [uid]);
    req.user = { ...u, roles };
    req.perms = new Set(perms.map((p) => p.c));
  }
  next();
});

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
    return res.redirect('/account/password');
  }
  next();
}

/** التحقق من الصلاحية على الخادم */
function can(...codes) {
  return (req, res, next) => {
    if (codes.some((c) => req.perms.has(c))) return next();
    const err = new U.UserError('ليست لديك صلاحية لتنفيذ هذا الإجراء أو عرض هذه الصفحة', 403);
    next(err);
  };
}

/** حماية CSRF بنمط الرمز المتزامن */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/form-data');
  const sent = req.body?._csrf || req.headers['x-csrf-token'] || (isMultipart ? req.query._csrf : undefined);
  const a = Buffer.from(String(sent || '')); const b = Buffer.from(req.session.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new U.UserError('انتهت صلاحية النموذج أو الطلب غير موثوق. أعد تحميل الصفحة وحاول مجددًا.', 403));
  }
  next();
}

/** متغيرات مشتركة للقوالب */
const locals = h(async (req, res, next) => {
  const s = await settings.all();
  res.locals.org = { ...s.org, logo: s.org?.logo || '/static/img/logo.png' };
  res.locals.user = req.user;
  res.locals.can = (c) => req.perms.has(c);
  res.locals.L = labels;
  res.locals.icon = require('./lib/icons').icon;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.locals.esc = esc;
  res.locals.badge = (g, v) => `<span class="badge ${labels.tone(g, v)}">${esc(labels.label(g, v))}</span>`;
  res.locals.money = (v) => `<span class="num">${U.fmtMoney(v)}</span>`;
  res.locals.reports = require('./lib/reports-meta');
  res.locals.U = U;
  res.locals.v = ASSET_V;
  res.locals.fmt = U.fmtMoney;
  res.locals.cur = s.org?.currency || '';
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.flash = req.session.flash || null;
  res.locals.oldForm = req.session.oldForm || {};
  delete req.session.flash; delete req.session.oldForm;
  res.locals.old = (k, d = '') => (res.locals.oldForm[k] !== undefined ? res.locals.oldForm[k] : (d ?? ''));
  res.locals.notifCount = 0;
  if (req.user) {
    const n = await db.one('SELECT count(*)::int AS c FROM notifications WHERE resolved_at IS NULL');
    res.locals.notifCount = n.c;
  }
  next();
});

function flash(req, type, msg) { req.session.flash = { type, msg }; }

/** إرجاع المستخدم إلى الصفحة السابقة مع رسالة */
function back(req, res, fallback = '/') {
  const ref = req.get('Referer');
  let target = fallback;
  if (ref) { try { const u = new URL(ref); if (u.host === req.get('host')) target = u.pathname + u.search; } catch (_) { /* تجاهل */ } }
  res.redirect(target);
}

function errorHandler(err, req, res, _next) {
  const mapped = { LIMIT_FILE_SIZE: 400, LIMIT_UNEXPECTED_FILE: 400, 23505: 409, 23514: 409, P0001: 409 };
  const status = err.status || mapped[err.code] || 500;
  let msg = err.userFacing ? err.message : null;
  if (!msg && err.code === 'LIMIT_UNEXPECTED_FILE') msg = 'حقل ملف غير متوقع';
  if (!msg && err.code === 'LIMIT_FILE_SIZE') msg = 'حجم الملف أكبر من الحد المسموح';
  if (!msg && err.code === '23505') msg = 'السجل موجود مسبقًا أو العملية مكررة (منع التكرار)';
  if (!msg && err.code === '23514') msg = 'القيم المدخلة تخالف قواعد النظام (مثل تجاوز المبلغ المستحق)';
  if (!msg && err.code === 'P0001') msg = err.message;
  if (!msg) {
    console.error(`[${new Date().toISOString()}]`, req.method, req.originalUrl, err);
    msg = 'حدث خطأ غير متوقع. تم تسجيل الخطأ، حاول مرة أخرى أو تواصل مع مدير النظام.';
  }
  if (req.method === 'POST' && status < 500 && req.user && status !== 403) {
    const { _csrf, password, new_password, current_password, ...rest } = req.body || {};
    req.session.oldForm = rest;
    flash(req, 'error', msg);
    return back(req, res, '/');
  }
  res.status(status);
  if (req.accepts('html')) return res.render('error', { title: 'خطأ', status, msg });
  res.json({ error: msg });
}

module.exports = { h, loadUser, requireLogin, can, csrf, locals, flash, back, errorHandler };

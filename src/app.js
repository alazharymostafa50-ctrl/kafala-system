'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const db = require('./db');
const M = require('./middleware');

function createApp({ sessionSecret = process.env.SESSION_SECRET } = {}) {
  const app = express();
  const prod = process.env.NODE_ENV === 'production';
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('مفتاح الجلسات مطلوب ويجب ألا يقل عن 32 حرفًا');
  }
  if (prod && /change-me|dev-only/i.test(sessionSecret)) {
    throw new Error('SESSION_SECRET في بيئة الإنتاج يجب أن يكون قيمة عشوائية جديدة وليس القيمة التجريبية');
  }
  if (prod) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'], 'frame-src': ["'self'"], 'object-src': ["'self'"],
        'upgrade-insecure-requests': prod ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: prod,
  }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: prod ? '7d' : 0 }));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'favicon.ico')));
  // الشعار المرفوع من الإعدادات (عام لأنه يظهر في صفحة الدخول)
  app.get('/branding/logo.png', M.h(async (req, res) => {
    const f = await require('./lib/uploads').getFile('branding/logo.png');
    if (!f) return res.redirect('/static/img/logo.png');
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=300').send(f.data);
  }));

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    store: new PgStore({ pool: db.pool, tableName: 'user_sessions', pruneSessionInterval: process.env.VERCEL ? false : 15 * 60 }),
    name: 'kafala.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: Number(process.env.SESSION_MINUTES || 120) * 60 * 1000 },
  }));
  app.use(M.loadUser);
  app.use(M.csrf);
  app.use(M.locals);
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.use(require('./routes/setup'));
  app.use(require('./routes/auth'));
  app.use(M.requireLogin);
  app.use(require('./lib/scheduler').lazyEngine);
  app.use(require('./routes/dashboard'));
  app.use(require('./routes/poor'));
  app.use(require('./routes/trash'));
  app.use(require('./routes/families'));
  app.use(require('./routes/documents'));
  app.use(require('./routes/eligibility'));
  app.use(require('./routes/sponsors'));
  app.use(require('./routes/donations'));
  app.use(require('./routes/expenses'));
  app.use(require('./routes/entitlements'));
  app.use(require('./routes/finance'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/imports'));
  app.use(require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'غير موجود', status: 404, msg: 'الصفحة المطلوبة غير موجودة' }));
  app.use(M.errorHandler);
  return app;
}

/** تجهيز التطبيق: الترحيلات ثم مفتاح الجلسات (من البيئة أو مولّد ومحفوظ في قاعدة البيانات) */
async function bootApp() {
  await require('../scripts/migrate').migrate({ quiet: true });
  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    const crypto = require('crypto');
    await db.query('INSERT INTO app_secrets (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', ['session_secret', crypto.randomBytes(48).toString('hex')]);
    secret = (await db.one('SELECT value FROM app_secrets WHERE key=$1', ['session_secret'])).value;
  }
  return createApp({ sessionSecret: secret });
}

module.exports = { createApp, bootApp };

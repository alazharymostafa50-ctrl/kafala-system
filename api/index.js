'use strict';
// نقطة التشغيل على Vercel: تجهيز التطبيق مرة واحدة لكل نسخة ثم تمرير الطلبات إليه
const { bootApp } = require('../src/app');

let appPromise = null;
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
module.exports = async (req, res) => {
  if (!appPromise) appPromise = bootApp().catch((e) => { appPromise = null; throw e; });
  let app;
  try { app = await appPromise; } catch (e) {
    console.error('فشل تجهيز النظام:', e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const noDb = !require('../src/db').DB_URL;
    return res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">
      <h2>النظام غير جاهز بعد</h2><p>${noDb ? 'لم تُربط قاعدة البيانات بالمشروع بعد (DATABASE_URL غير موجود).' : 'تعذر الاتصال بقاعدة البيانات أو تجهيزها. راجع سجلات النشر.'}</p></body></html>`);
  }
  // Vercel يضيف دوال مساعدة خاصة به على الطلب والاستجابة (مثل res.redirect بالرمز 307)،
  // وهي تحجب دوال Express؛ فتحويل 307 يعيد إرسال النموذج نفسه ويسبب حلقة تحويل لا نهائية.
  // نزيلها ليعمل Express بسلوكه المعتاد (302 بعد إرسال النماذج).
  for (const k of ['redirect', 'status', 'send', 'json']) {
    if (Object.prototype.hasOwnProperty.call(res, k)) { try { delete res[k]; } catch (_) { /* تجاهل */ } }
  }
  for (const k of ['query', 'cookies', 'body']) {
    if (Object.prototype.hasOwnProperty.call(req, k)) { try { delete req[k]; } catch (_) { /* تجاهل */ } }
  }
  const t = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t;
    if (ms > 3000 || res.statusCode >= 500) console.log(`[slow/err] ${req.method} ${req.url} → ${res.statusCode} in ${ms}ms`);
    const p = (req.originalUrl || req.url || '').split('?')[0];
    if (/^\/(static|favicon|branding)/.test(p) || p === '/health') return;
    const db = require('../src/db');
    const sess = req.session ? (req.session.userId ? 'user' : req.session.pending2fa ? 'pending2fa' : 'anon') : 'none';
    db.query('INSERT INTO request_debug (method, path, status, location, has_cookie, session, ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.method, p.slice(0, 100), res.statusCode, String(res.getHeader('location') || '').slice(0, 100) || null, /kafala\.sid=/.test(req.headers.cookie || ''), sess, ms])
      .then(() => db.query('DELETE FROM request_debug WHERE id < (SELECT max(id) - 200 FROM request_debug)')).catch(() => {});
  });
  return app(req, res);
};

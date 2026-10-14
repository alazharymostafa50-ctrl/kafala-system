'use strict';
// نقطة التشغيل على Vercel: تجهيز التطبيق مرة واحدة لكل نسخة ثم تمرير الطلبات إليه
const { bootApp } = require('../src/app');

let appPromise = null;
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
  return app(req, res);
};

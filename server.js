'use strict';
require('dotenv').config({ quiet: true });
const { bootApp } = require('./src/app');
const { runIfStale } = require('./src/lib/scheduler');

(async () => {
  const app = await bootApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`النظام يعمل على http://localhost:${port}`));
  // تشغيل محرك الاستحقاق والتنبيهات عند البدء ثم كل 6 ساعات
  const run = () => runIfStale({ force: true }).then((s) => console.log('محرك الاستحقاق:', s)).catch((e) => console.error('محرك الاستحقاق فشل:', e.message));
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
})().catch((e) => { console.error(e); process.exit(1); });

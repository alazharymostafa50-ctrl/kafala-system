'use strict';
// تشغيل محرك الاستحقاق والتنبيهات دوريًا دون خادم دائم (مناسب للاستضافة السحابية)
const db = require('../db');
const elig = require('./eligibility');

const EVERY_HOURS = 6;
let lastCheck = 0;

/** يشغّل المحرك إن مرّ أكثر من 6 ساعات على آخر تشغيل؛ تشغيل واحد فقط حتى مع تعدد النسخ */
async function runIfStale({ force = false } = {}) {
  const claim = await db.one(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('engine_last_run', '{}'::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET updated_at = now()
       WHERE $1 OR app_state.updated_at < now() - make_interval(hours => $2)
     RETURNING key`, [force, EVERY_HOURS]);
  if (!claim) return null;
  const stats = await elig.runEngine();
  await db.query(`UPDATE app_state SET value=$1 WHERE key='engine_last_run'`, [JSON.stringify(stats)]);
  await db.query('DELETE FROM user_sessions WHERE expire < now()');
  return stats;
}

/** يفحص الحاجة للتشغيل عند الطلبات (مرة كل 5 دقائق لكل نسخة على الأكثر) */
function lazyEngine(req, res, next) {
  if (req.method !== 'GET' || Date.now() - lastCheck < 5 * 60 * 1000) return next();
  lastCheck = Date.now();
  runIfStale().catch((e) => console.error('محرك الاستحقاق:', e.message)).finally(() => next());
}

module.exports = { runIfStale, lazyEngine };

'use strict';
const { Pool, types } = require('pg');

// إرجاع التواريخ كنص (YYYY-MM-DD) لتفادي انزياح المنطقة الزمنية
types.setTypeParser(1082, (v) => v);
// المبالغ NUMERIC تبقى نصوصًا ونتعامل معها عبر وحدة money

/**
 * رابط قاعدة البيانات: DATABASE_URL أو أي متغير يضيفه تكامل Neon/Vercel
 * (حتى لو أُضيفت له بادئة مخصصة مثل STORAGE_DATABASE_URL)، مع تفضيل الاتصال المجمّع.
 */
function resolveDbUrl() {
  const e = process.env;
  if (e.DATABASE_URL) return e.DATABASE_URL;
  if (e.POSTGRES_URL) return e.POSTGRES_URL;
  const cands = Object.keys(e).filter((k) => /^postgres(ql)?:\/\//.test(e[k] || '') && /URL/.test(k));
  const pick = cands.find((k) => /_DATABASE_URL$/.test(k)) || cands.find((k) => /_POSTGRES_URL$/.test(k))
    || cands.find((k) => !/UNPOOLED|NON_POOLING|NO_SSL/.test(k)) || cands[0];
  return pick ? e[pick] : undefined;
}
const DB_URL = resolveDbUrl();

// على الاستضافة السحابية (Vercel/Neon) تُستخدم اتصالات قليلة لكل نسخة
const serverless = !!process.env.VERCEL;
const pool = new Pool({
  connectionString: DB_URL,
  max: Number(process.env.DB_POOL_MAX || (serverless ? 3 : 10)),
  idleTimeoutMillis: serverless ? 5000 : 10000,
  connectionTimeoutMillis: 15000,
});
pool.on('error', (e) => console.error('PG pool error:', e.message));

async function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

/** تنفيذ مجموعة عمليات داخل معاملة واحدة */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = {
      query: (t, p) => client.query(t, p),
      one: async (t, p) => (await client.query(t, p)).rows[0] || null,
      many: async (t, p) => (await client.query(t, p)).rows,
    };
    const result = await fn(c);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx, DB_URL };

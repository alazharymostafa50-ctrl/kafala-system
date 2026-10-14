'use strict';
const { Pool, types } = require('pg');

// إرجاع التواريخ كنص (YYYY-MM-DD) لتفادي انزياح المنطقة الزمنية
types.setTypeParser(1082, (v) => v);
// المبالغ NUMERIC تبقى نصوصًا ونتعامل معها عبر وحدة money

// على الاستضافة السحابية (Vercel/Neon) تُستخدم اتصالات قليلة لكل نسخة
const serverless = !!process.env.VERCEL;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
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

module.exports = { pool, query, one, many, tx };
